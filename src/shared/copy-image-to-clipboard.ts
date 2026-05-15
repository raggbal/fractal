/**
 * Copy an image file to the OS clipboard as an image (not a path).
 *
 * Behavior:
 *   - macOS:   sips → tmp PNG → osascript ("«class PNGf»")
 *   - Linux:   xclip -selection clipboard -t image/png -i <png>  (convert to PNG via ImageMagick if needed)
 *   - Windows: PowerShell System.Windows.Forms.Clipboard.SetImage
 *
 * Throws when the platform tooling is missing or the file is unreadable —
 * callers should surface the error to the user.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

function quoteAppleScriptPath(p: string): string {
    // AppleScript "POSIX file" 文字列内の \ と " をエスケープ
    return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function copyImageMac(filePath: string): Promise<void> {
    // sips で PNG に正規化 (SVG は sips では扱えないので別経路: そのまま osascript で読む)
    const ext = path.extname(filePath).toLowerCase();
    const isAlreadyPng = ext === '.png';

    let pngPath = filePath;
    let tmpToDelete: string | null = null;

    if (!isAlreadyPng) {
        // SVG は sips が rasterize できないので、cgsips→なし: AppleScript で PNGf 読込は raster 限定。
        // SVG は qlmanage で PNG プレビューを作る (失敗時は別 fallback)。
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-clip-'));
        tmpToDelete = tmpDir;
        const outPng = path.join(tmpDir, 'out.png');

        if (ext === '.svg') {
            // qlmanage -t -s 2048 -o <dir> <svg>  → <dir>/<basename>.svg.png
            const basename = path.basename(filePath);
            try {
                await execFileAsync('qlmanage', ['-t', '-s', '2048', '-o', tmpDir, filePath]);
                const generated = path.join(tmpDir, basename + '.png');
                if (!fs.existsSync(generated)) {
                    throw new Error('qlmanage did not produce a PNG');
                }
                fs.renameSync(generated, outPng);
            } catch (e) {
                cleanupDir(tmpToDelete);
                throw new Error('SVG → PNG conversion failed (qlmanage): ' + (e as Error).message);
            }
        } else {
            // sips で PNG 変換 (JPEG / GIF / WEBP / TIFF / BMP 等)
            try {
                await execFileAsync('sips', ['-s', 'format', 'png', filePath, '--out', outPng]);
            } catch (e) {
                cleanupDir(tmpToDelete);
                throw new Error('Image conversion failed (sips): ' + (e as Error).message);
            }
        }
        pngPath = outPng;
    }

    const escaped = quoteAppleScriptPath(pngPath);
    const script =
        `set theFile to (POSIX file "${escaped}")\n` +
        `set the clipboard to (read theFile as «class PNGf»)`;

    try {
        await execFileAsync('osascript', ['-e', script]);
    } finally {
        if (tmpToDelete) cleanupDir(tmpToDelete);
    }
}

async function copyImageLinux(filePath: string): Promise<void> {
    const ext = path.extname(filePath).toLowerCase();
    let pngPath = filePath;
    let tmpToDelete: string | null = null;

    if (ext !== '.png') {
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-clip-'));
        tmpToDelete = tmpDir;
        const outPng = path.join(tmpDir, 'out.png');
        try {
            // ImageMagick: convert (or magick) → PNG
            try {
                await execFileAsync('convert', [filePath, outPng]);
            } catch {
                await execFileAsync('magick', [filePath, outPng]);
            }
        } catch (e) {
            cleanupDir(tmpToDelete);
            throw new Error('Image conversion failed (ImageMagick): ' + (e as Error).message);
        }
        pngPath = outPng;
    }

    try {
        // xclip でクリップボードへ
        await execFileAsync('xclip', ['-selection', 'clipboard', '-t', 'image/png', '-i', pngPath]);
    } catch (e) {
        // fallback: wl-copy (Wayland)
        try {
            const data = fs.readFileSync(pngPath);
            const child = execFile('wl-copy', ['--type', 'image/png']);
            child.stdin?.write(data);
            child.stdin?.end();
            await new Promise<void>((resolve, reject) => {
                child.on('exit', (code) => {
                    if (code === 0) resolve();
                    else reject(new Error('wl-copy exited ' + code));
                });
                child.on('error', reject);
            });
        } catch (e2) {
            throw new Error('Linux clipboard tool not available (xclip/wl-copy): ' + (e as Error).message);
        }
    } finally {
        if (tmpToDelete) cleanupDir(tmpToDelete);
    }
}

async function copyImageWindows(filePath: string): Promise<void> {
    // PowerShell で System.Windows.Forms.Clipboard.SetImage
    // SVG は System.Drawing.Image で開けないので非対応 (パスは Copy Path で取得可能)
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.svg') {
        throw new Error('SVG copy is not supported on Windows; use Copy Path instead.');
    }
    const psFile = filePath.replace(/'/g, "''");
    const script =
        `Add-Type -AssemblyName System.Windows.Forms;` +
        `Add-Type -AssemblyName System.Drawing;` +
        `$img = [System.Drawing.Image]::FromFile('${psFile}');` +
        `[System.Windows.Forms.Clipboard]::SetImage($img);` +
        `$img.Dispose();`;
    await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
}

function cleanupDir(dir: string): void {
    try {
        fs.rmSync(dir, { recursive: true, force: true });
    } catch {
        /* ignore */
    }
}

export async function copyImageToOSClipboard(filePath: string): Promise<void> {
    if (!filePath) throw new Error('No file path');
    if (!fs.existsSync(filePath)) throw new Error('File not found: ' + filePath);

    switch (process.platform) {
        case 'darwin':
            return copyImageMac(filePath);
        case 'win32':
            return copyImageWindows(filePath);
        default:
            return copyImageLinux(filePath);
    }
}
