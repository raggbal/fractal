/**
 * drop-stream-host.ts — VSCode-side glue for streaming D&D.
 *
 * Owns: per-panel DropStreamRegistry, withProgress notification, and the
 * post-completion `dropFilesResult` shape so the existing webview code path
 * (outliner.js -> case 'dropFilesResult') treats streamed files identically
 * to small-file imports.
 */

import * as vscode from 'vscode';
import { DropStreamRegistry, DropStreamSession, FinishResult } from './drop-stream';

interface ProgressReport {
    increment?: number;
    message?: string;
}

interface ActiveSessionUI {
    progress: vscode.Progress<ProgressReport>;
    cancelToken: vscode.CancellationTokenSource;
    resolveFinished: () => void;
    files: Map<string, { name: string; size: number; bytesWritten: number; lastReportPct: number }>;
    finished: FinishResult[];
    targetNodeId: string | null;
    position: string;
    expectedFiles: number;
    completedFiles: number;
}

export interface DropStreamHostDeps {
    /** Returns directories the same way `dropFilesImport` resolves them. */
    resolveDirs: () => { fileDir: string; outDir: string };
    /** Send a message back to the webview. */
    postMessage: (msg: Record<string, unknown>) => void;
    /** Optional: called when ANY files in a session failed/were cancelled. */
    onFailed?: (names: string[]) => void;
}

export class DropStreamHost {
    private registry = new DropStreamRegistry();
    private ui = new Map<string, ActiveSessionUI>();

    constructor(private deps: DropStreamHostDeps) {}

    /**
     * Forward a webview message. Returns true if handled (caller should `break`).
     */
    async handle(message: { type: string } & Record<string, unknown>): Promise<boolean> {
        switch (message.type) {
            case 'dropStreamBegin':       await this.onBegin(message as never); return true;
            case 'dropStreamChunk':       await this.onChunk(message as never); return true;
            case 'dropStreamFileEnd':     await this.onFileEnd(message as never); return true;
            case 'dropStreamSessionEnd':  await this.onSessionEnd(message as never); return true;
            case 'dropStreamCancel':      await this.onCancel(message as never); return true;
            default:
                return false;
        }
    }

    /** Cancel/cleanup everything (call from disposable). */
    disposeAll(): void {
        for (const ui of this.ui.values()) {
            ui.cancelToken.cancel();
            ui.resolveFinished();
        }
        this.ui.clear();
    }

    private async onBegin(msg: {
        sessionId: string; fileId: string; name: string; size: number;
        targetNodeId: string | null; position: string;
        totalFiles: number; isFirst: boolean;
    }): Promise<void> {
        const { fileDir, outDir } = this.deps.resolveDirs();

        // First begin in a session creates the registry entry + progress UI.
        let session = this.registry.get(msg.sessionId);
        if (!session) {
            session = this.registry.create(msg.sessionId, fileDir, outDir);
        }

        if (!this.ui.has(msg.sessionId)) {
            await this.startProgress(msg.sessionId, msg.totalFiles, msg.targetNodeId, msg.position);
        }
        const ui = this.ui.get(msg.sessionId);
        if (!ui) return;

        try {
            const begin = session.begin(msg.fileId, msg.name, msg.size);
            ui.files.set(msg.fileId, { name: msg.name, size: msg.size, bytesWritten: 0, lastReportPct: 0 });
            ui.progress.report({ message: `${msg.name} (0%)` });
            this.deps.postMessage({
                type: 'dropStreamReady',
                sessionId: msg.sessionId,
                fileId: msg.fileId,
                relativePath: begin.relativePath
            });
        } catch (err) {
            this.deps.postMessage({
                type: 'dropStreamFailed',
                sessionId: msg.sessionId,
                fileId: msg.fileId,
                error: String(err)
            });
        }
    }

    private async onChunk(msg: {
        sessionId: string; fileId: string; seq: number; bytesB64: string;
    }): Promise<void> {
        const session = this.registry.get(msg.sessionId);
        const ui = this.ui.get(msg.sessionId);
        if (!session || !ui) return;

        // VSCode webview postMessage JSON-serializes payloads, so chunks travel
        // as base64 strings. Decode here into the raw bytes the writer needs.
        const buf = Buffer.from(msg.bytesB64, 'base64');

        try {
            const written = await session.chunk(msg.fileId, buf);
            if (written === null) return;
            const fileUi = ui.files.get(msg.fileId);
            if (fileUi) {
                fileUi.bytesWritten = written;
                const pct = fileUi.size > 0 ? Math.floor((written / fileUi.size) * 100) : 0;
                if (pct !== fileUi.lastReportPct) {
                    fileUi.lastReportPct = pct;
                    ui.progress.report({ message: `${fileUi.name} (${pct}%)` });
                }
            }
            this.deps.postMessage({
                type: 'dropStreamAck',
                sessionId: msg.sessionId,
                fileId: msg.fileId,
                seq: msg.seq,
                bytesWritten: written
            });
        } catch (err) {
            session.cancel(msg.fileId);
            this.deps.postMessage({
                type: 'dropStreamFailed',
                sessionId: msg.sessionId,
                fileId: msg.fileId,
                error: String(err)
            });
        }
    }

    private async onFileEnd(msg: { sessionId: string; fileId: string }): Promise<void> {
        const session = this.registry.get(msg.sessionId);
        const ui = this.ui.get(msg.sessionId);
        if (!session || !ui) return;
        try {
            const result = await session.end(msg.fileId);
            if (!result) return;
            ui.finished.push(result);
            ui.completedFiles++;
            const fileUi = ui.files.get(msg.fileId);
            if (fileUi) ui.progress.report({ message: `${fileUi.name} (100%)` });
        } catch (err) {
            this.deps.postMessage({
                type: 'dropStreamFailed',
                sessionId: msg.sessionId,
                fileId: msg.fileId,
                error: String(err)
            });
        }
    }

    private async onSessionEnd(msg: { sessionId: string }): Promise<void> {
        const ui = this.ui.get(msg.sessionId);
        if (!ui) return;
        // Emit a dropFilesResult so existing webview logic inserts nodes.
        const results = ui.finished.map(f => ({
            kind: 'file' as const,
            ok: true as const,
            title: f.title,
            filePath: f.filePath
        }));
        if (results.length > 0) {
            this.deps.postMessage({
                type: 'dropFilesResult',
                results,
                targetNodeId: ui.targetNodeId,
                position: ui.position
            });
        }
        ui.resolveFinished();
        this.ui.delete(msg.sessionId);
        this.registry.drop(msg.sessionId);
    }

    private async onCancel(msg: { sessionId: string }): Promise<void> {
        const ui = this.ui.get(msg.sessionId);
        const session = this.registry.get(msg.sessionId);
        if (session) session.cancelAll();
        if (ui) {
            this.deps.onFailed?.(Array.from(ui.files.values()).map(f => f.name));
            ui.resolveFinished();
        }
        this.ui.delete(msg.sessionId);
        this.registry.drop(msg.sessionId);
    }

    private startProgress(
        sessionId: string,
        totalFiles: number,
        targetNodeId: string | null,
        position: string
    ): Promise<void> {
        const cts = new vscode.CancellationTokenSource();
        return new Promise<void>((startResolve) => {
            vscode.window.withProgress(
                {
                    location: vscode.ProgressLocation.Notification,
                    title: totalFiles === 1
                        ? 'Importing dropped file'
                        : `Importing ${totalFiles} dropped files`,
                    cancellable: true
                },
                (progress, token) => new Promise<void>((finishResolve) => {
                    const ui: ActiveSessionUI = {
                        progress,
                        cancelToken: cts,
                        resolveFinished: finishResolve,
                        files: new Map(),
                        finished: [],
                        targetNodeId,
                        position,
                        expectedFiles: totalFiles,
                        completedFiles: 0
                    };
                    this.ui.set(sessionId, ui);
                    token.onCancellationRequested(() => {
                        this.deps.postMessage({ type: 'dropStreamCancel', sessionId });
                        this.onCancel({ sessionId });
                    });
                    startResolve();
                })
            );
        });
    }
}
