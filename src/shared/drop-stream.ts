/**
 * drop-stream.ts — Streaming D&D for large files (> 50MB).
 *
 * The webview side cannot pass an absolute filesystem path (probe v0.207.95
 * confirmed `file.path === undefined` and `webUtils === undefined` on macOS
 * VSCode). Files are therefore chunked via `File.stream()` and shipped over
 * `postMessage` 4MiB at a time. This module is the host-side sink:
 *
 *   1. webview sends `dropStreamBegin` { sessionId, fileId, name, size }
 *   2. host opens a write stream into fileDir, replies `dropStreamReady`
 *      so the webview pumps the next chunk (back-pressure)
 *   3. webview sends `dropStreamChunk` { sessionId, fileId, seq, bytes }
 *   4. host writes, replies `dropStreamAck` { seq } (also acts as progress tick)
 *   5. webview sends `dropStreamEnd` { sessionId, fileId } → host closes the
 *      stream and replies `dropStreamFinished` with the relative filePath
 *      that goes straight into node.filePath.
 *
 * Cancellation: webview sends `dropStreamCancel` (or session aborts) → host
 * closes & deletes the partial file.
 *
 * No `vscode` import here so the module can be unit-tested against a real
 * filesystem.
 */

import * as fs from 'fs';
import * as path from 'path';

export interface StreamSession {
    fileId: string;
    name: string;
    size: number;
    destPath: string;        // absolute, final
    relativePath: string;    // relative to outDir (matches node.filePath)
    stream: fs.WriteStream;
    bytesWritten: number;
    closed: boolean;
}

export interface BeginResult {
    ok: true;
    fileId: string;
    relativePath: string;
}

export interface FinishResult {
    fileId: string;
    title: string;
    filePath: string; // relative to outDir
}

/**
 * Generate a unique filename in `dir`, preserving extension and adding `-N` on
 * collision. Mirrors the helper in file-import.ts so the streaming path
 * produces filenames that look identical to the buffered path.
 */
function uniqueName(dir: string, originalName: string): string {
    const safeName = path.basename(originalName);
    if (safeName !== originalName || originalName.includes('..')) {
        throw new Error(`Invalid file name: ${originalName}`);
    }
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ext = path.extname(safeName);
    const base = path.basename(safeName, ext);
    let candidate = safeName;
    let suffix = 0;
    while (fs.existsSync(path.join(dir, candidate))) {
        suffix++;
        candidate = `${base}-${suffix}${ext}`;
    }
    return candidate;
}

export class DropStreamSession {
    private files = new Map<string, StreamSession>();

    constructor(
        public readonly sessionId: string,
        public readonly fileDir: string,
        public readonly outDir: string
    ) {}

    begin(fileId: string, name: string, size: number): BeginResult {
        if (this.files.has(fileId)) {
            throw new Error(`fileId already in use: ${fileId}`);
        }
        const finalName = uniqueName(this.fileDir, name);
        const destPath = path.join(this.fileDir, finalName);
        const stream = fs.createWriteStream(destPath);
        const relativePath = path.relative(this.outDir, destPath).replace(/\\/g, '/');
        this.files.set(fileId, {
            fileId,
            name: finalName,
            size,
            destPath,
            relativePath,
            stream,
            bytesWritten: 0,
            closed: false
        });
        return { ok: true, fileId, relativePath };
    }

    /** Returns updated bytesWritten, or null if the session has been cancelled / ended. */
    async chunk(fileId: string, bytes: Uint8Array | Buffer): Promise<number | null> {
        const sess = this.files.get(fileId);
        if (!sess || sess.closed) return null;
        const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
        await new Promise<void>((resolve, reject) => {
            const ok = sess.stream.write(buf, (err) => {
                if (err) reject(err); else resolve();
            });
            if (!ok) {
                // Wait for drain to maintain back-pressure
                sess.stream.once('drain', () => resolve());
            }
        });
        sess.bytesWritten += buf.byteLength;
        return sess.bytesWritten;
    }

    async end(fileId: string): Promise<FinishResult | null> {
        const sess = this.files.get(fileId);
        if (!sess || sess.closed) return null;
        sess.closed = true;
        await new Promise<void>((resolve, reject) => {
            sess.stream.end((err?: Error | null) => {
                if (err) reject(err); else resolve();
            });
        });
        // Detach from active map so cancel() is a no-op afterwards
        this.files.delete(fileId);
        return {
            fileId,
            title: sess.name,
            filePath: sess.relativePath
        };
    }

    cancel(fileId?: string): void {
        const targets = fileId ? [fileId] : Array.from(this.files.keys());
        for (const id of targets) {
            const sess = this.files.get(id);
            if (!sess) continue;
            sess.closed = true;
            try { sess.stream.destroy(); } catch { /* ignore */ }
            try { fs.unlinkSync(sess.destPath); } catch { /* ignore */ }
            this.files.delete(id);
        }
    }

    cancelAll(): void {
        this.cancel();
    }

    getProgress(fileId: string): number {
        const sess = this.files.get(fileId);
        return sess ? sess.bytesWritten : 0;
    }
}

/**
 * Per-webview registry of active stream sessions, keyed by sessionId.
 * One drop = one session = potentially many fileIds.
 */
export class DropStreamRegistry {
    private sessions = new Map<string, DropStreamSession>();

    create(sessionId: string, fileDir: string, outDir: string): DropStreamSession {
        if (this.sessions.has(sessionId)) {
            throw new Error(`stream session already active: ${sessionId}`);
        }
        const sess = new DropStreamSession(sessionId, fileDir, outDir);
        this.sessions.set(sessionId, sess);
        return sess;
    }

    get(sessionId: string): DropStreamSession | undefined {
        return this.sessions.get(sessionId);
    }

    drop(sessionId: string): void {
        const sess = this.sessions.get(sessionId);
        if (!sess) return;
        sess.cancelAll();
        this.sessions.delete(sessionId);
    }
}
