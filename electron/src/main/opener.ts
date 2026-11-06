/**
 * vscode.open / vscode.openWith (spec D6): what Notes can show opens in Notes, the rest with the OS.
 * - a note folder (has outline.note), or its outline.note → that note
 * - <note>/<id>.out / <note>/<id>.md that is an item of that note's outline.note → the item inside
 *   its note (an In-App link through the extension's own fractal.navigateInAppLink when the note is in
 *   the active notes list; otherwise the note is just opened)
 * - viewType 'default' (= "open as text"), anything else local → the OS default app
 * - http / https / mailto → the OS browser / mail client; other schemes are refused
 * Read-only: outline.note is only parsed here.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { OpenerAdapter, ShellAdapter, ShimLogger } from '../vscode-shim/adapters';

export interface OpenerDeps {
    shell: ShellAdapter;
    log: ShimLogger;
    executeCommand(id: string, ...args: unknown[]): Promise<unknown>;
    /** Note folders of the active notes list (the In-App link resolver only knows registered notes). */
    registeredNotes(): Promise<string[]>;
}

function isDir(p: string): boolean {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function readItems(noteDir: string): Record<string, { ext?: string; type?: string }> | undefined {
    try {
        const s = JSON.parse(fs.readFileSync(path.join(noteDir, 'outline.note'), 'utf8')) as { items?: unknown };
        return s && typeof s.items === 'object' && s.items ? (s.items as Record<string, { ext?: string; type?: string }>) : undefined;
    } catch {
        return undefined;
    }
}

function noteLink(folderName: string, kind: 'out' | 'md', id: string): string {
    const f = encodeURIComponent(folderName);
    return kind === 'md' ? `fractal://note/${f}/md/${encodeURIComponent(id)}` : `fractal://note/${f}/${encodeURIComponent(id)}`;
}

export function createOpener(d: OpenerDeps): OpenerAdapter {
    const openInNote = async (noteDir: string, link?: string) => {
        const registered = (await d.registeredNotes()).map((p) => path.resolve(p));
        if (link && registered.includes(path.resolve(noteDir))) {
            await d.executeCommand('fractal.navigateInAppLink', link);
        } else {
            await d.executeCommand('fractal.openNotesFolder', noteDir);
        }
    };

    return {
        open: async ({ command, uri, viewType }) => {
            if (uri.scheme === 'file') {
                const p = uri.fsPath;
                if (viewType !== 'default') {
                    if (isDir(p) && fs.existsSync(path.join(p, 'outline.note'))) {
                        await d.executeCommand('fractal.openNotesFolder', p);
                        return;
                    }
                    const dir = path.dirname(p);
                    const base = path.basename(p);
                    if (base === 'outline.note') {
                        await d.executeCommand('fractal.openNotesFolder', dir);
                        return;
                    }
                    const m = /^(.+)\.(out|md)$/i.exec(base);
                    if (m) {
                        const items = readItems(dir);
                        const item = items?.[m[1]];
                        const kind = m[2].toLowerCase() as 'out' | 'md';
                        if (item && (kind === 'md' ? item.ext === 'md' : !item.ext || item.ext === 'out')) {
                            await openInNote(dir, noteLink(path.basename(dir), kind, m[1]));
                            return;
                        }
                    }
                }
                const err = await d.shell.openPath(p);
                if (err) {
                    d.log.warn(`[opener] ${command}(${p}${viewType ? `, ${viewType}` : ''}) failed: ${err}`);
                }
                return;
            }
            const scheme = uri.scheme.toLowerCase();
            if (scheme === 'http' || scheme === 'https' || scheme === 'mailto') {
                await d.shell.openExternal(encodeURI(uri.toString(true)));
                return;
            }
            d.log.warn(`[opener] ${command}: refusing to open a ${scheme}: URI`);
        },
    };
}
