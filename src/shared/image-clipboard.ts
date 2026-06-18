/**
 * Image fullscreen overlay の「Copy Image」「Open in New Tab」ハンドラ。
 *
 * Copy Image: 画像をピクセル化された PNG として OS clipboard へコピーする。
 *   - macOS: osascript で `set the clipboard to (read POSIX file ... as «class PNGf»)`
 *   - それ以外: PowerShell / xclip で fallback
 *   - 失敗時はパスを clipboard.writeText に fallback して情報メッセージで通知
 *
 * Open in New Tab: VS Code 標準の `vscode.open` で画像を新規タブとして開く
 *   (内蔵 image preview)
 */
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { spawn } from 'child_process';

function copyImageMacOS(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const escaped = absPath.replace(/"/g, '\\"');
        const script = `set the clipboard to (read (POSIX file "${escaped}") as «class PNGf»)`;
        const proc = spawn('osascript', ['-e', script]);
        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`osascript exited ${code}: ${stderr.trim()}`));
            }
        });
    });
}

function copyImageWindows(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const escaped = absPath.replace(/'/g, "''");
        const script = `Add-Type -AssemblyName System.Windows.Forms; ` +
            `$img = [System.Drawing.Image]::FromFile('${escaped}'); ` +
            `[System.Windows.Forms.Clipboard]::SetImage($img); ` +
            `$img.Dispose()`;
        const proc = spawn('powershell.exe', ['-NoProfile', '-Command', script]);
        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`powershell exited ${code}: ${stderr.trim()}`));
            }
        });
    });
}

function copyImageLinux(absPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const ext = path.extname(absPath).toLowerCase();
        const mime =
            ext === '.png' ? 'image/png'
            : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
            : ext === '.gif' ? 'image/gif'
            : ext === '.bmp' ? 'image/bmp'
            : ext === '.webp' ? 'image/webp'
            : 'image/png';
        const proc = spawn('xclip', ['-selection', 'clipboard', '-t', mime, '-i', absPath]);
        let stderr = '';
        proc.stderr.on('data', (chunk) => { stderr += String(chunk); });
        proc.on('error', reject);
        proc.on('close', (code) => {
            if (code === 0) {
                resolve();
            } else {
                reject(new Error(`xclip exited ${code}: ${stderr.trim()}`));
            }
        });
    });
}

export async function copyImageToClipboard(absPath: string): Promise<void> {
    if (!absPath) {
        vscode.window.showWarningMessage('Fractal: image path missing');
        return;
    }
    if (!fs.existsSync(absPath)) {
        vscode.window.showWarningMessage(`Fractal: image not found — ${absPath}`);
        return;
    }
    try {
        if (process.platform === 'darwin') {
            await copyImageMacOS(absPath);
        } else if (process.platform === 'win32') {
            await copyImageWindows(absPath);
        } else {
            await copyImageLinux(absPath);
        }
    } catch (err) {
        // fallback: copy path as text and inform
        await vscode.env.clipboard.writeText(absPath);
        vscode.window.showInformationMessage(
            `Fractal: copied image path (binary copy failed: ${(err as Error).message})`
        );
    }
}

export async function openImageInNewTab(absPath: string): Promise<void> {
    if (!absPath) {
        vscode.window.showWarningMessage('Fractal: image path missing');
        return;
    }
    if (!fs.existsSync(absPath)) {
        vscode.window.showWarningMessage(`Fractal: image not found — ${absPath}`);
        return;
    }
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath));
}
