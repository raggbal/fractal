/**
 * drawio-external.ts — .drawio.svg / .drawio.png を外部アプリで開く。
 *
 * 「Open in External」ボタンの host 側実装。.svg の OS 関連付けは通常ブラウザなので、
 * openExternal だけだと draw.io Desktop を入れていてもブラウザで開いてしまう。
 * → draw.io Desktop があればそれ優先、無ければ OS デフォルトへフォールバック:
 *   - macOS:   `open -a draw.io <path>`（LaunchServices がアプリ名で解決）
 *   - Windows: 標準インストール先の draw.io.exe を直接起動
 *   - Linux:   PATH 上の `drawio` コマンドを起動
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { execFile, spawn } from 'child_process';

/** mac `open` 用: コマンドの終了を待って成否を返す（`open` は即 exit するので待ってよい） */
function tryExec(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            execFile(cmd, args, (err) => resolve(!err));
        } catch {
            resolve(false);
        }
    });
}

/** GUI アプリ直接起動用: detach して「起動できたか」だけを即判定する。
 *  execFile はプロセス終了まで callback が来ない（GUI だと閉じるまで）ため使わない。 */
function trySpawnDetached(cmd: string, args: string[]): Promise<boolean> {
    return new Promise((resolve) => {
        try {
            const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
            child.once('spawn', () => { child.unref(); resolve(true); });
            child.once('error', () => resolve(false)); // ENOENT（未インストール）等
        } catch {
            resolve(false);
        }
    });
}

/** Windows: draw.io Desktop の標準インストール先（ユーザー / 全ユーザー）を探す */
function findDrawioExeWin(): string | null {
    const candidates = [
        // ユーザーインストール（既定）
        process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs', 'draw.io', 'draw.io.exe'),
        // 全ユーザーインストール
        process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'draw.io', 'draw.io.exe'),
        process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)']!, 'draw.io', 'draw.io.exe'),
    ].filter((p): p is string => !!p);
    for (const p of candidates) {
        try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
    }
    return null;
}

export async function openDrawioExternal(absPath: string): Promise<void> {
    if (!absPath || !fs.existsSync(absPath)) {
        vscode.window.showWarningMessage(`Fractal: file not found — ${absPath}`);
        return;
    }
    if (process.platform === 'darwin') {
        if (await tryExec('open', ['-a', 'draw.io', absPath])) return;
    } else if (process.platform === 'win32') {
        const exe = findDrawioExeWin();
        if (exe && await trySpawnDetached(exe, [absPath])) return;
    } else {
        // Linux: PATH 上の drawio（.deb/.rpm/snap alias の標準コマンド名）
        if (await trySpawnDetached('drawio', [absPath])) return;
    }
    // draw.io 未インストール / 起動失敗 → OS デフォルト（従来挙動）
    await vscode.env.openExternal(vscode.Uri.file(absPath));
}
