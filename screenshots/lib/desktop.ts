/**
 * デスクトップアプリ（Electron）の撮影: 起動・ウィンドウの大きさ・ウィンドウの画像。
 * 起動は test/e2e-electron-app/harness.ts と同じ（既定は FRACTAL_E2E_DEV=1 = リポジトリの electron/ を素の Electron で）。
 * HOME は一時フォルダ（アプリが本物の ~/.fractal を読まない）にし、--use-mock-keychain でキーチェーンに触らない
 * （HOME を変えたままキーチェーンに触ると、macOS が「キーチェーンが見つからない」画面を出す）。
 */
import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { launchEnv, launchTarget } from '../../test/e2e-electron-app/harness';
import { assertWindowSize, image, rmrf } from './demo';

export interface DesktopFixture {
    /** アプリの HOME（.fractal/default.fractal を置く） */
    home: string;
    /** --fractal-user-data（User/settings.json を置く） */
    userData: string;
}

/** 一時 HOME と userData を root の下に作り直す。theme は fractal.theme */
export function makeDesktopFixture(root: string, theme: 'light' | 'dark'): DesktopFixture {
    rmrf(root);
    const home = path.join(root, 'home');
    const userData = path.join(root, 'userData');
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({ 'fractal.theme': theme }));
    return { home, userData };
}

export async function launchDesktop(fx: DesktopFixture): Promise<ElectronApplication> {
    const target = launchTarget();
    if (!target.executablePath || !fs.existsSync(target.executablePath)) {
        throw new Error(`the desktop app is not there: ${target.executablePath || '(none)'} — run \`cd electron && npm ci\` (or npm run build:e2e with FRACTAL_E2E_DEV=0)`);
    }
    const app = await electron.launch({
        executablePath: target.executablePath,
        args: [...target.args, '--use-mock-keychain', `--fractal-user-data=${fx.userData}`],
        env: launchEnv(fx),
        timeout: 90000,
    });
    await app.firstWindow({ timeout: 90000 });
    return app;
}

/** ウィンドウの中身を w x h にする（画面に入らなければ止める — assertWindowSize） */
export async function setWindowSize(app: ElectronApplication, w: number, h: number): Promise<void> {
    const sizes = await app.evaluate(async ({ BaseWindow }, s) => {
        for (const win of BaseWindow.getAllWindows()) {
            win.setContentSize(s.w, s.h);
        }
        await new Promise((r) => setTimeout(r, 300));
        return BaseWindow.getAllWindows().map((win: { getContentSize(): number[] }) => win.getContentSize());
    }, { w, h });
    for (const got of sizes) {
        assertWindowSize(got, { w, h });
    }
}

/** サイドバーの Notes の行（ラベルが label） */
export function noteRow(sidebar: Page, label: string) {
    return sidebar.locator('.pane[data-view="notesExplorer"] .row', { has: sidebar.locator('.label', { hasText: new RegExp(`^${label}$`) }) });
}

/** ウィンドウの見えているビュー（サイドバー・note）を main プロセスで撮り、1 枚に並べて file に書く */
export async function shootDesktopWindow(app: ElectronApplication, file: string): Promise<void> {
    const parts = await app.evaluate(async ({ BaseWindow }) => {
        type View = { getBounds(): { x: number; y: number; width: number; height: number }; getVisible(): boolean; webContents?: { getURL(): string; capturePage(): Promise<{ toPNG(): Buffer }> } };
        const win = BaseWindow.getAllWindows().find((w: { contentView: { children: unknown } }) =>
            (w.contentView.children as View[]).some((c) => !!c.webContents && c.webContents.getURL().startsWith('fractal-ui://sidebar/')));
        const out: Array<{ x: number; y: number; w: number; h: number; png: string }> = [];
        for (const v of (win ? win.contentView.children : []) as unknown as View[]) {
            if (!v.getVisible() || !v.webContents) {
                continue;
            }
            const b = v.getBounds();
            const img = await v.webContents.capturePage();
            out.push({ x: b.x, y: b.y, w: b.width, h: b.height, png: img.toPNG().toString('base64') });
        }
        return out;
    });
    if (parts.length === 0) {
        throw new Error('no window to shoot');
    }
    const dir = file + '.parts';
    rmrf(dir);
    fs.mkdirSync(dir, { recursive: true });
    const spec = parts.map((p, i) => {
        const part = path.join(dir, `${i}.png`);
        fs.writeFileSync(part, Buffer.from(p.png, 'base64'));
        return { file: part, x: p.x, y: p.y, w: p.w, h: p.h };
    });
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
    image('stitch', path.join(dir, 'spec.json'), file);
    rmrf(dir);
}
