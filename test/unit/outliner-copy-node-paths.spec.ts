/**
 * TC-OCM-01（locale 静的部）/ TC-OCM-03（host 側）— copy path 系の host 配線
 * （sprint 20260818-183407 FR-OCM-01）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
    }
}
function requireWithVscodeStub(modulePath: string, clipboardSink: string[]): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showWarningMessage: () => {} },
                env: { clipboard: { writeText: (t: string) => { clipboardSink.push(t); } } },
                ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

const LOCALE_FILES = ['en', 'ja', 'es', 'fr', 'ko', 'zh-cn', 'zh-tw'];

test('TC-OCM-01s 全 7 locale の outlinerCopyPagePath 値が Copy Md Path 系に更新済み（旧 Page Path 訳の残存なし）', () => {
    // en は字面 'Copy Md Path'、他 locale は「ページ」相当語が「md」相当へ変わったことを
    // 「旧値と不一致 + 'md'（大小無視）を含む」で検査する
    const oldValues: Record<string, string> = {
        en: 'Copy Page Path', ja: 'ページパスをコピー', es: 'Copiar ruta de página',
        fr: 'Copier le chemin de la page', ko: '페이지 경로 복사', 'zh-cn': '复制页面路径', 'zh-tw': '複製頁面路徑',
    };
    for (const loc of LOCALE_FILES) {
        const body = fs.readFileSync(path.join(__dirname, `../../src/i18n/locales/${loc}.ts`), 'utf8');
        const m = body.match(/outlinerCopyPagePath:\s*'([^']+)'/) || body.match(/outlinerCopyPagePath:\s*"([^"]+)"/);
        expect(m, `${loc}: outlinerCopyPagePath 不在`).toBeTruthy();
        expect(m![1]).not.toBe(oldValues[loc]);
        expect(m![1].toLowerCase()).toContain('md');
    }
});

test('TC-OCM-01k 新設 outlinerCopyPath キーが interface + 7 locale の 8 ヒット（NFR-BAT-02）', () => {
    const files = ['messages.ts', ...LOCALE_FILES.map((l) => `locales/${l}.ts`)];
    for (const f of files) {
        const body = fs.readFileSync(path.join(__dirname, `../../src/i18n/${f}`), 'utf8');
        expect(/\boutlinerCopyPath\b/.test(body), `outlinerCopyPath が ${f} に未登録`).toBe(true);
    }
});

test('TC-OCM-03h notes 側 copyNodePaths: entries（page+file 混在）を document order の絶対パスで clipboard へ', async () => {
    const clipboard: string[] = [];
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler', clipboard).handleNotesMessage;

    // 実 fs fixture（note フォルダ + out + page md + files/）
    const note = fs.mkdtempSync(path.join(os.tmpdir(), 'ocm-host-'));
    fs.writeFileSync(path.join(note, 'pg1.md'), '# P1\n');
    fs.mkdirSync(path.join(note, 'files'), { recursive: true });
    fs.writeFileSync(path.join(note, 'files', 'a.pdf'), 'A');
    const outPath = path.join(note, 'x.out');
    fs.writeFileSync(outPath, JSON.stringify({
        version: 1, rootIds: ['p1', 'f1'],
        nodes: {
            p1: { id: 'p1', isPage: true, pageId: 'pg1', children: [] },
            f1: { id: 'f1', filePath: 'files/a.pdf', children: [] },
        },
    }));

    const fm = {
        getCurrentFilePath: () => outPath,
        getPageFilePath: (pid: string) => path.join(note, `${pid}.md`),
    };
    const platformCalls: any[] = [];
    const platform = {
        showInformationMessage: () => {}, showErrorMessage: () => {},
        copyNodePaths: (entries: any[], outFilePath: string) => { platformCalls.push({ entries, outFilePath }); },
    } as any;
    await handleNotesMessage(
        { type: 'copyNodePaths', entries: [{ kind: 'page', pageId: 'pg1' }, { kind: 'file', nodeId: 'f1' }] },
        fm as any, { postMessage: () => {} } as any, platform
    );
    // dispatch: platform に entries + currentFilePath が渡る（旧実装ではハンドラ case 不在 = RED）
    expect(platformCalls.length).toBe(1);
    expect(platformCalls[0].outFilePath).toBe(outPath);
    expect(platformCalls[0].entries.length).toBe(2);
});
