/**
 * VS Code の撮影: 撮影用のプロファイル（--user-data-dir・--extensions-dir）で /Applications の VS Code を起動する。
 * HOME は本物のまま（キーチェーンが HOME にある。HOME を変えると macOS が「キーチェーンが見つからない」画面を出す）。
 * Fractal の Notes は作業フォルダの .fractal に向けるので（vscode_profile.py）、本物の ~/.fractal・note には触らない。
 */
import { _electron as electron, type ElectronApplication, type Frame, type Page } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { assertWindowSize, copyDemoNotes, NoteName, REPO_ROOT, rmrf, SHOTS_DIR, sleep, writeRegistry } from './demo';

export const VSCODE_APP = process.env.VSCODE_APP || '/Applications/Visual Studio Code.app';
const VSCODE_EXE = path.join(VSCODE_APP, 'Contents', 'MacOS', 'Code');
const VSCODE_CLI = path.join(VSCODE_APP, 'Contents', 'Resources', 'app', 'bin', 'code');

export interface VsCodeProfile {
    root: string;
    /** --user-data-dir（場面ごとに作り直す） */
    ud: string;
    /** --extensions-dir（撮る前に vsix を入れる） */
    ext: string;
    /** note のコピー（<root>/Notes/<name>） */
    notesDir: string;
    /** note の一覧（<root>/.fractal/default.fractal） */
    registry: string;
}

export function vscodeProfile(root: string): VsCodeProfile {
    fs.mkdirSync(root, { recursive: true });
    return {
        root,
        ud: path.join(root, 'ud'),
        ext: path.join(root, 'ext'),
        notesDir: path.join(root, 'Notes'),
        registry: path.join(root, '.fractal', 'default.fractal'),
    };
}

/** VS Code・その CLI に渡す環境（呼び出し元の VS Code・Electron・Node の指定を持ち込まない。
 *  VSCODE_IPC_HOOK_CLI が残っていると、CLI が動いている本物の VS Code に拡張機能を入れてしまう） */
function cleanEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
        if (typeof v === 'string' && !k.startsWith('VSCODE_') && !k.startsWith('ELECTRON_') && k !== 'NODE_OPTIONS') {
            env[k] = v;
        }
    }
    return env;
}

/** 今のソースから vsix を作る（vscode:prepublish = npm run compile も走る） */
export function buildVsix(dir: string): string {
    const out = path.join(dir, 'fractal-shots.vsix');
    rmrf(out);
    execFileSync('npx', ['--yes', '@vscode/vsce', 'package', '--out', out], { cwd: REPO_ROOT, stdio: 'inherit' });
    return out;
}

/** 撮影用の --extensions-dir に vsix だけを入れる */
export function installExtension(p: VsCodeProfile, vsix: string): void {
    if (!fs.existsSync(VSCODE_CLI)) {
        throw new Error(`VS Code is not there: ${VSCODE_APP} (set VSCODE_APP)`);
    }
    rmrf(p.ext);
    execFileSync(VSCODE_CLI, ['--user-data-dir', p.ud, '--extensions-dir', p.ext, '--install-extension', vsix, '--force'], { env: cleanEnv(), stdio: 'inherit' });
}

/** note のコピーと .fractal を作り直す */
export function resetNotes(p: VsCodeProfile): Record<NoteName, string> {
    const notes = copyDemoNotes(p.notesDir);
    writeRegistry(p.registry, [notes.projects, notes.webapp1]);
    return notes;
}

/** プロファイル（設定と Fractal の globalState）を作り直す */
export function resetProfile(p: VsCodeProfile): void {
    const settings = JSON.parse(fs.readFileSync(path.join(SHOTS_DIR, 'vscode-settings.json'), 'utf8'));
    // 画像・添付を読んでよいフォルダ（既定は HOME の下だけ。note のコピーは作業フォルダにある）
    settings['fractal.resourceRoots'] = [p.root];
    const file = path.join(p.root, 'settings.json');
    fs.writeFileSync(file, JSON.stringify(settings, null, 2));
    execFileSync('python3', ['-I', path.join(SHOTS_DIR, 'lib', 'vscode_profile.py'), p.ud, file, p.registry], { stdio: 'inherit' });
}

/** この撮影用プロファイルで動いている VS Code のプロセス */
function running(p: VsCodeProfile): number[] {
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try {
        return execFileSync('pgrep', ['-f', `${esc(VSCODE_EXE)}.*--user-data-dir=${esc(p.ud)}`]).toString().trim().split('\n').filter(Boolean).map(Number);
    } catch {
        return [];
    }
}

export async function launchVsCode(p: VsCodeProfile, size: { w: number; h: number }): Promise<{ app: ElectronApplication; page: Page }> {
    if (running(p).length) {
        throw new Error('a VS Code with the screenshot profile is still running');
    }
    const app = await electron.launch({
        executablePath: VSCODE_EXE,
        args: [`--user-data-dir=${p.ud}`, `--extensions-dir=${p.ext}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--new-window'],
        env: cleanEnv(),
        timeout: 90000,
    });
    const page = await app.firstWindow({ timeout: 90000 });
    await page.waitForSelector('.monaco-workbench', { timeout: 60000 });
    await app.evaluate(({ BrowserWindow }, s) => {
        const w = BrowserWindow.getAllWindows()[0];
        w.setContentSize(s.w, s.h);
        w.center();
    }, size);
    await sleep(2500);
    assertWindowSize(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getContentSize()), size);
    const dpr = await page.evaluate(() => window.devicePixelRatio);
    if (dpr !== 2) {
        console.warn(`devicePixelRatio is ${dpr} (the README images are taken at 2 — use the Retina display)`);
    }
    // VS Code は前のビューを覚えている: Fractal のアイコンは、そのビューが出ていないときだけ押す（出ているときに押すと隠れる）
    const item = page.locator('.activitybar .action-item:has(.action-label[aria-label^="Fractal"])').first();
    if (!(await item.evaluate((e) => e.classList.contains('checked')))) {
        await item.locator('.action-label').click();
    }
    await page.locator('.sidebar .pane-header', { hasText: 'Notes' }).first().waitFor({ state: 'visible', timeout: 20000 });
    await sleep(1200);
    return { app, page };
}

/** 確かめずに終わらせ、この撮影用プロファイルのプロセスが残っていないことを待つ */
export async function quitVsCode(p: VsCodeProfile, app: ElectronApplication): Promise<void> {
    try {
        await app.evaluate(({ app: a }) => {
            setTimeout(() => a.exit(0), 50);
        });
    } catch {
        /* もう終わっている */
    }
    const end = Date.now() + 15000;
    while (running(p).length && Date.now() < end) {
        await sleep(300);
    }
    for (const pid of running(p)) {
        try {
            process.kill(pid, 'SIGKILL');
        } catch {
            /* もう無い */
        }
    }
    await sleep(500);
}

/** サイドバーの Notes の note（フォルダ名 dirName）を開き、その webview の frame を返す */
export async function openNote(page: Page, dirName: string): Promise<Frame> {
    await page.locator(`.sidebar .monaco-list-row[aria-label*="/Notes/${dirName},"]`).first().click();
    const end = Date.now() + 40000;
    while (Date.now() < end) {
        for (const f of page.frames()) {
            try {
                if (await f.locator('.notes-file-panel').count()) {
                    await sleep(1500);
                    return f;
                }
            } catch {
                /* 外れた frame */
            }
        }
        await sleep(300);
    }
    throw new Error(`the note ${dirName} did not open`);
}

/** フォーカス・ホバーの跡を消す（入力欄から外し、マウスを下の端へ） */
export async function park(page: Page, f: Frame): Promise<void> {
    await f.evaluate(() => (document.activeElement as HTMLElement | null)?.blur?.());
    const vp = page.viewportSize() || { width: 1500, height: 900 };
    await page.mouse.move(vp.width / 2, vp.height - 4);
    await sleep(700);
}

/** webview だけを切り出して撮る */
export async function shootWebview(page: Page, f: Frame, file: string): Promise<void> {
    const el = await f.frameElement();
    const box = await el.boundingBox();
    if (!box) {
        throw new Error('the webview has no box');
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file, clip: box });
}

/** ウィンドウ全体を撮る */
export async function shootVsCodeWindow(page: Page, file: string): Promise<void> {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    await page.screenshot({ path: file });
}
