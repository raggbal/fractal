/**
 * trash.ts — MCP の削除は OS のゴミ箱へ移す（spec 20261027-1700-mcp-full-ops D6）。
 *
 * 拡張機能は vscode.workspace.fs.delete({ useTrash: true }) でゴミ箱へ移す。MCP には vscode が無いので
 * OS のゴミ箱を使う実装を NotesFileManager.trashImpl に注入する。どれも使えないときは削除を拒否する
 * （完全削除にはしない）。
 *
 * - macOS: /usr/bin/trash（macOS 15 以降に標準）→ 無ければ Finder（osascript）
 * - Linux: gio trash → trash-put
 * - Windows: PowerShell（Microsoft.VisualBasic の SendToRecycleBin）
 * - 環境変数 FRACTAL_TRASH_DIR があれば、そのフォルダへ移す（テスト・ゴミ箱の無い環境用。消さずに退避するだけ）
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { ToolError } from './guard';

const TIMEOUT_MS = 30_000;

function run(cmd: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { timeout: TIMEOUT_MS }, (err, _stdout, stderr) => {
            if (err) { reject(new Error(`${path.basename(cmd)} failed: ${String(stderr || err.message).trim()}`)); } else { resolve(); }
        });
    });
}

function which(cmd: string): string | null {
    for (const dir of String(process.env.PATH || '').split(path.delimiter)) {
        if (!dir) { continue; }
        const p = path.join(dir, cmd);
        try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* 次 */ }
    }
    return null;
}

type Backend = { name: string; trash: (absPath: string) => Promise<void> };

function moveIntoDir(dir: string): Backend {
    return {
        name: `dir:${dir}`,
        trash: async (absPath: string) => {
            fs.mkdirSync(dir, { recursive: true });
            let dest = path.join(dir, `${Date.now().toString(36)}-${path.basename(absPath)}`);
            for (let i = 1; fs.existsSync(dest); i++) { dest = path.join(dir, `${Date.now().toString(36)}-${i}-${path.basename(absPath)}`); }
            try {
                fs.renameSync(absPath, dest);
            } catch (e: any) {
                if (e && e.code === 'EXDEV') {
                    fs.cpSync(absPath, dest, { recursive: true });
                    fs.rmSync(absPath, { recursive: true, force: true });
                } else { throw e; }
            }
        },
    };
}

let cached: Backend | null | undefined;

/** 使えるゴミ箱の実装（無ければ null） */
export function trashBackend(): Backend | null {
    const envDir = process.env.FRACTAL_TRASH_DIR;
    if (envDir) { return moveIntoDir(path.resolve(envDir)); }
    if (cached !== undefined) { return cached; }
    cached = null;
    if (process.platform === 'darwin') {
        if (fs.existsSync('/usr/bin/trash')) {
            cached = { name: '/usr/bin/trash', trash: (p) => run('/usr/bin/trash', [p]) };
        } else if (fs.existsSync('/usr/bin/osascript')) {
            cached = {
                name: 'Finder',
                trash: (p) => run('/usr/bin/osascript', ['-e', `tell application "Finder" to delete POSIX file "${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`]),
            };
        }
    } else if (process.platform === 'linux') {
        const gio = which('gio');
        const trashPut = which('trash-put');
        if (gio) { cached = { name: 'gio trash', trash: (p) => run(gio, ['trash', '--', p]) }; }
        else if (trashPut) { cached = { name: 'trash-put', trash: (p) => run(trashPut, ['--', p]) }; }
    } else if (process.platform === 'win32') {
        const ps = which('powershell.exe') || which('powershell');
        if (ps) {
            cached = {
                name: 'Recycle Bin',
                trash: (p) => {
                    const lit = p.replace(/'/g, "''");
                    const isDir = (() => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })();
                    const fn = isDir ? 'DeleteDirectory' : 'DeleteFile';
                    return run(ps, ['-NoProfile', '-NonInteractive', '-Command',
                        `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${fn}('${lit}','OnlyErrorDialogs','SendToRecycleBin')`]);
                },
            };
        }
    }
    return cached;
}

/** ゴミ箱が使えなければ TRASH_UNAVAILABLE（削除系の操作は書き始める前にこれを呼ぶ） */
export function requireTrash(): Backend {
    const b = trashBackend();
    if (!b) {
        throw new ToolError('TRASH_UNAVAILABLE',
            'この環境では OS のゴミ箱が使えないため、削除しません（完全削除はしない方針です）。macOS は /usr/bin/trash か Finder、Linux は gio か trash-put、Windows は PowerShell が必要です。');
    }
    return b;
}

/** 1 件をゴミ箱へ（無ければ何もしない） */
export async function moveToOsTrash(absPath: string): Promise<void> {
    if (!fs.existsSync(absPath)) { return; }
    await requireTrash().trash(absPath);
}
