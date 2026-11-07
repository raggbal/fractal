/**
 * viewer-theme-follow.spec.ts — standalone の viewer のタブ（fractal.fileViewer*）が、開いたまま fractal.theme を変えても
 * 追従すること（docs/design/modern-2026.md §7.14 / §12.5）。notes / outliner の面は HTML を作り直すが、viewer は
 * 拡大率・位置を失わないよう data-fr-theme だけを差し替える。
 *
 *   TC-VTF-01 本番の HTML（getFileViewerHtml）: fractalTheme の message で data-fr-theme が替わる。3 つ以外の値は受けない。
 *             viewer の中身（#viewer-root）は作り直さない
 *   TC-VTF-02 fileViewerProvider: fractal.theme の変更でだけ新しい値（旧い値は読み替えた値）を送り、タブを閉じたら止める
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;

/** vscode を stub にして src の TS を読む（読み終えたら元に戻し、src の cache を捨てる） */
function requireWithVscode(modulePath: string, stub: unknown): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Mod = require('module');
    const origLoad = Mod._load;
    const purge = () => { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; } } };
    purge();
    Mod._load = function (request: string, ...rest: unknown[]) {
        if (request === 'vscode') { return stub; }
        return origLoad.call(this, request, ...rest);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Mod._load = origLoad;
        purge();
    }
}

const uriStub = {
    file: (p: string) => ({ fsPath: p, path: p, toString: () => 'file://' + p }),
    joinPath: (base: { fsPath?: string }, ...parts: string[]) => {
        const fsPath = path.join((base && base.fsPath) || '', ...parts);
        return { fsPath, toString: () => 'file://' + fsPath };
    },
};

function webviewStub() {
    return {
        options: {},
        html: '',
        cspSource: 'https://csp.example',
        asWebviewUri: (u: { fsPath: string }) => ({ toString: () => 'vscode-resource://' + u.fsPath }),
    };
}

test('TC-VTF-01 viewer のタブの HTML: fractalTheme の message で data-fr-theme だけが替わる', async ({ page }) => {
    const stub = { Uri: uriStub, workspace: { getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'theme' ? 'light' : d) }) } };
    const { getFileViewerHtml } = requireWithVscode('../../src/fileViewerContent', stub);
    const html: string = getFileViewerHtml(webviewStub(), { fsPath: '/ext' }, { fsPath: '/note/files/doc.pdf' }, 'pdf');
    expect(html).toContain('<html data-fr-theme="light">');
    // 本物の origin で開く（opaque origin "null" の message は bootstrap の capture 遮断が落とす — TC-FV-47）
    await page.route('http://fractal-viewer.test/**', (r) => r.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: html }));
    await page.goto('http://fractal-viewer.test/viewer.html');
    const theme = () => page.evaluate(() => document.documentElement.getAttribute('data-fr-theme'));
    expect(await theme()).toBe('light');
    await page.evaluate(() => { (document.getElementById('viewer-root') as HTMLElement).dataset.marker = 'kept'; });

    await page.evaluate(() => window.postMessage({ type: 'fractalTheme', theme: 'dark' }, '*'));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-fr-theme') === 'dark');
    // 3 つ（light / dark / auto）以外の値・別の type は受けない
    await page.evaluate(() => {
        window.postMessage({ type: 'fractalTheme', theme: 'x" onload="alert(1)' }, '*');
        window.postMessage({ type: 'fractalTheme', theme: 'night' }, '*');
        window.postMessage({ type: 'somethingElse', theme: 'light' }, '*');
    });
    await page.evaluate(() => new Promise((r) => setTimeout(r, 50)));
    expect(await theme()).toBe('dark');
    await page.evaluate(() => window.postMessage({ type: 'fractalTheme', theme: 'auto' }, '*'));
    await page.waitForFunction(() => document.documentElement.getAttribute('data-fr-theme') === 'auto');
    // viewer の中身は作り直さない（HTML の差し替えでなく属性だけ）
    expect(await page.evaluate(() => (document.getElementById('viewer-root') as HTMLElement).dataset.marker)).toBe('kept');
});

test('TC-VTF-02 fileViewerProvider: fractal.theme を変えると開いている viewer に送り、閉じたら止める', async () => {
    let theme = 'light';
    const listeners: ((e: { affectsConfiguration: (k: string) => boolean }) => void)[] = [];
    const stub = {
        Uri: uriStub,
        workspace: {
            getConfiguration: () => ({ get: (k: string, d: unknown) => (k === 'theme' ? theme : d) }),
            onDidChangeConfiguration: (fn: (e: { affectsConfiguration: (k: string) => boolean }) => void) => {
                listeners.push(fn);
                return { dispose: () => { const i = listeners.indexOf(fn); if (i >= 0) { listeners.splice(i, 1); } } };
            },
            fs: { stat: async () => ({ size: 1024 }) },
        },
        window: { showWarningMessage: () => undefined, registerCustomEditorProvider: () => ({ dispose: () => undefined }) },
        env: { openExternal: async () => true, clipboard: { writeText: async () => undefined } },
        commands: { executeCommand: async () => undefined },
    };
    const { FileViewerProvider } = requireWithVscode('../../src/fileViewerProvider', stub);
    const posted: unknown[] = [];
    let onDispose: (() => void) | null = null;
    const webview = Object.assign(webviewStub(), {
        onDidReceiveMessage: () => ({ dispose: () => undefined }),
        postMessage: async (m: unknown) => { posted.push(m); return true; },
    });
    const panel = { webview, onDidDispose: (fn: () => void) => { onDispose = fn; return { dispose: () => undefined }; } };
    const provider = new FileViewerProvider({ extensionUri: { fsPath: '/ext' }, subscriptions: [] });
    await provider.resolveCustomEditor({ uri: uriStub.file('/note/files/doc.pdf') }, panel);
    expect(webview.html).toContain('data-fr-theme="light"');
    expect(listeners.length, '設定の変更を 1 つ聞いている').toBe(1);

    const fire = (key: string) => listeners.slice().forEach((fn) => fn({ affectsConfiguration: (k: string) => k === key }));
    fire('fractal.fontSize');
    expect(posted, 'fractal.theme 以外の変更では送らない').toEqual([]);
    theme = 'dark';
    fire('fractal.theme');
    expect(posted).toEqual([{ type: 'fractalTheme', theme: 'dark' }]);
    theme = 'night';   // 旧い値は HTML を作るときと同じく読み替える（migrateLegacyTheme）
    fire('fractal.theme');
    expect(posted[1]).toEqual({ type: 'fractalTheme', theme: 'dark' });

    expect(onDispose, 'タブを閉じたときの後片付けを登録している').not.toBeNull();
    onDispose!();
    expect(listeners.length, 'タブを閉じたら設定の変更を聞かない').toBe(0);
});
