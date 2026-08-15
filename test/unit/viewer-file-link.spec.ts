/**
 * viewer-file-link.spec.ts — In-App file link（FR-FV-09 / ADRL-0068）
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-16 / testcases.md H-4 節。
 * ハーネス: TS 直 import（inapp-link-utils.js は CommonJS export・vscode 非依存）。
 *
 * TC-FV-55: build/parse 往復 + 判定順（file 分岐が node 分岐より先 — outFileId='file' 誤解釈の回避）
 * TC-FV-56: 既存 4 形式（page/md/node/out）の parse 非破壊（regression 番人）
 * TC-FV-57: traversal 番人 — fileId=..%2F.. が getTreeFilePath の clamp（safeResolveUnderDir 内蔵）で
 *           note の files/ 外に到達しない。counterfactual: clamp なしの path.join 直書きは base 外を返して RED
 * TC-FV-58: 構文破壊文字を含む filename（Report (2).pdf / a]b.pdf）で生成した [title](link) が
 *           実 markdown link parser で往復して title/url を保持（designer_failures 2026-08-09）
 *
 * TC-FV-60（TASK-18 / reviewer iteration 3 CONS-2）: 受信側ルーティング番人 —
 *           navigateToLink の fileId 分岐が note 面 viewer 経路（tryShowNoteViewer → showNoteViewer post）
 *           に到達し、既存 md/node/out 分岐（notesNavigateInAppLink）が不変であること。
 *           テストダブルは**明示メソッド recorder**（Proxy 禁止 — generator_failures 2026-08-09）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const linkUtils = require(path.join(ROOT, 'src', 'shared', 'inapp-link-utils.js'));

test.describe('In-App file link（FR-FV-09）', () => {

    test('TC-FV-55: buildFileLink → parseFractalLink 往復 + file 分岐が node より先', () => {
        const link = linkUtils.buildFileLink('note1', 'uuid-1');
        expect(link).toBe('fractal://note/note1/file/uuid-1');
        expect(linkUtils.parseFractalLink(link)).toEqual({ noteFolderName: 'note1', fileId: 'uuid-1' });

        // 判定順: {folder}/file/{id} の 3 セグメント形が node link（outFileId='file'）に誤解釈されない
        const parsed = linkUtils.parseFractalLink('fractal://note/n/file/x');
        expect(parsed).toEqual({ noteFolderName: 'n', fileId: 'x' });
        expect(parsed.outFileId).toBeUndefined();
        expect(parsed.nodeId).toBeUndefined();

        // encode 往復（folder / id に空白・日本語）
        const enc = linkUtils.buildFileLink('メモ 帳', 'id with space');
        expect(linkUtils.parseFractalLink(enc)).toEqual({ noteFolderName: 'メモ 帳', fileId: 'id with space' });
    });

    test('TC-FV-56: 既存 4 形式（page/md/node/out）の parse 非破壊', () => {
        expect(linkUtils.parseFractalLink('fractal://note/n/out1/page/p1'))
            .toEqual({ noteFolderName: 'n', outFileId: 'out1', pageId: 'p1' });
        expect(linkUtils.parseFractalLink('fractal://note/n/md/m1'))
            .toEqual({ noteFolderName: 'n', mdFileId: 'm1' });
        expect(linkUtils.parseFractalLink('fractal://note/n/out1/node1'))
            .toEqual({ noteFolderName: 'n', outFileId: 'out1', nodeId: 'node1' });
        expect(linkUtils.parseFractalLink('fractal://note/n/out1'))
            .toEqual({ noteFolderName: 'n', outFileId: 'out1' });
        expect(linkUtils.parseFractalLink('not-a-link')).toBeNull();
    });

    test('TC-FV-57: traversal 番人 — getTreeFilePath 経由は files/ 外に到達しない（counterfactual: path.join 直書きは base 外）', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { NotesFileManager } = require(path.join(ROOT, 'out', 'shared', 'notes-file-manager.js'));
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-link-'));
        try {
            const noteDir = path.join(tmp, 'note1');
            fs.mkdirSync(path.join(noteDir, 'files'), { recursive: true });
            // 秘匿ファイル（files/ 外 = 到達してはならない先）
            fs.writeFileSync(path.join(tmp, 'secret.pdf'), 'SECRET');
            const fm = new NotesFileManager(noteDir);
            const structure = fm.getStructure();
            // traversal 型 id を items に直接注入（外部入力で filename が汚染されたケースの模擬）
            const evilId = 'evil-id';
            structure.items[evilId] = { id: evilId, type: 'file', ext: 'file', title: 'evil', filename: '../../secret.pdf' };
            fm.saveStructure(structure);

            // 本命: getTreeFilePath は clamp（safeResolveUnderDir）内蔵 → null（files/ 外に出ない）
            const resolved = fm.getTreeFilePath(evilId);
            expect(resolved).toBeNull();

            // counterfactual 実測: clamp を外した path.join 直書きは base 外（secret.pdf）に到達してしまう
            const filesDir = path.join(noteDir, 'files');
            const unclamped = path.resolve(path.join(filesDir, '../../secret.pdf'));
            expect(unclamped.startsWith(filesDir + path.sep)).toBe(false);   // clamp なしだと外に出る = RED の根拠
            expect(fs.existsSync(unclamped)).toBe(true);                      // 実在する秘匿先（攻撃が成立しうる実体）
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });

    test('TC-FV-58: 構文破壊文字入り filename の [title](link) が markdown link parser で往復する', () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const parser = require(path.join(ROOT, 'src', 'shared', 'markdown-link-parser.js'));

        for (const filename of ['Report (2).pdf', 'a]b.pdf', 'Screenshot (1).png']) {
            // 生成側規則（design §10 / notes-file-panel.js:601 precedent）: title は [] を strip
            const title = filename.replace(/[\[\]]/g, '');
            const link = linkUtils.buildFileLink('note1', 'uuid-9');
            const md = `[${title}](${link})`;
            const links = parser.parseMarkdownLinks(md);
            expect(links.length, `${filename}: リンクとして解析されない`).toBe(1);
            expect(links[0].alt).toBe(title);
            expect(links[0].url).toBe(link);
        }
    });
});

/**
 * TC-FV-60: navigateToLink の受信側ルーティング番人（TASK-18 / CONS-2）
 *
 * `grep -rn "tryShowNoteViewer|navigateToLink" test/` = 0 件だった穴を埋める
 * （TC-FV-55〜58 は送信側 + pure 関数のみ = 配線の片端）。
 */
test.describe('navigateToLink のルーティング（FR-FV-09 受信側 / TC-FV-60）', () => {

    /** vscode モジュールを stub して host を require（先例: test/unit/dailynotes-flat-archive.spec.ts:24） */
    function requireProviderWithVscodeStub(vscodeStub: any): any {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Module = require('module');
        const origLoad = Module._load;
        Module._load = function (request: string) {
            if (request === 'vscode') { return vscodeStub; }
            // eslint-disable-next-line prefer-rest-params
            return origLoad.apply(this, arguments as any);
        };
        try {
            return require(path.join(ROOT, 'src', 'notesEditorProvider'));
        } finally {
            Module._load = origLoad;
        }
    }

    /**
     * 明示メソッド recorder（**Proxy 禁止** — generator_failures 2026-08-09: 任意メソッド名に
     * 応答する Proxy は「メソッド不在で静かに落ちる」欠落を構造的に検出できない）。
     * navigateToLink / tryShowNoteViewer が実際に触るメンバーだけを持つ。
     */
    function makeEntry(noteDir: string, resolvedFilePath: string | null) {
        const posted: any[] = [];
        const revealed: any[] = [];
        const webviewUris: string[] = [];
        return {
            posted, revealed, webviewUris,
            entry: {
                panel: {
                    reveal: (col: any) => { revealed.push(col); },
                    webview: {
                        asWebviewUri: (uri: any) => {
                            webviewUris.push(uri.fsPath);
                            return { toString: () => `vscode-resource://${uri.fsPath}` };
                        },
                    },
                },
                postMessage: (msg: any) => { posted.push(msg); },
                fileManager: {
                    getTreeFilePath: (_id: string) => resolvedFilePath,
                    getMainFolderPath: () => noteDir,
                    getMdFilePath: (id: string) => path.join(noteDir, `${id}.md`),
                },
            },
        };
    }

    function makeVscodeStub() {
        const warnings: string[] = [];
        const externals: string[] = [];
        return {
            warnings, externals,
            stub: {
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => { /* noop */ } },
                window: { showWarningMessage: (m: string) => { warnings.push(m); } },
                env: { openExternal: async (uri: any) => { externals.push(uri.fsPath); } },
                ViewColumn: { One: 1 },
                EventEmitter: class { },
            },
        };
    }

    test('TC-FV-60: fileId 分岐 → showNoteViewer（note 面 viewer）／対象外は openExternal 縮退／md・node 分岐は不変', async () => {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fv-nav-'));
        try {
            const noteDir = path.join(tmp, 'note1');
            fs.mkdirSync(path.join(noteDir, 'files'), { recursive: true });
            const htmlPath = path.join(noteDir, 'files', 'doc.html');
            fs.writeFileSync(htmlPath, '<p>hi</p>');
            const zipPath = path.join(noteDir, 'files', 'a.zip');
            fs.writeFileSync(zipPath, 'PK');

            const v = makeVscodeStub();
            const { NotesEditorProvider } = requireProviderWithVscodeStub(v.stub);
            const nav = NotesEditorProvider.prototype.navigateToLink;
            // fake this: openPanels + tryShowNoteViewer は**実 prototype メソッド**を配線する
            // （stub に差し替えない = isViewerTarget / 50MB ガード / message 形が実コードで走る。
            //   TS の private は compile-time のみなので runtime では prototype 上に在る）
            const makeThis = (entry: any) => ({
                openPanels: new Map([[noteDir, entry]]),
                tryShowNoteViewer: NotesEditorProvider.prototype.tryShowNoteViewer,
            });

            // ① viewer 対象（.html）→ tryShowNoteViewer 経路 = showNoteViewer を post（openExternal を呼ばない）
            const r1 = makeEntry(noteDir, htmlPath);
            await nav.call(makeThis(r1.entry), noteDir, { fileId: 'uuid-1' });
            expect(r1.revealed.length, 'panel.reveal が呼ばれる').toBe(1);
            const shown = r1.posted.filter((m) => m.type === 'showNoteViewer');
            expect(shown.length, 'file link から note 面 viewer に到達する（受信側配線）').toBe(1);
            expect(shown[0].kind).toBe('html');
            expect(shown[0].filePath).toBe(htmlPath);
            expect(shown[0].fileName).toBe('doc.html');
            expect(shown[0].fileUri).toContain(htmlPath);
            expect(r1.posted.some((m) => m.type === 'notesNavigateInAppLink'),
                'file link は md/node 経路（notesNavigateInAppLink）に流れない').toBe(false);
            expect(v.externals.length, 'viewer 対象は openExternal に落ちない').toBe(0);

            // ② viewer 対象外（.zip）→ 従来の openExternal 縮退（FR-FV-07 / ARCH-5）
            const r2 = makeEntry(noteDir, zipPath);
            await nav.call(makeThis(r2.entry), noteDir, { fileId: 'uuid-2' });
            expect(r2.posted.filter((m) => m.type === 'showNoteViewer').length, '対象外は viewer を開かない').toBe(0);
            expect(v.externals, '対象外は openExternal に縮退').toEqual([zipPath]);

            // ③ 実体が無い fileId → 警告のみ（viewer も openExternal も呼ばない）
            const r3 = makeEntry(noteDir, path.join(noteDir, 'files', 'missing.html'));
            await nav.call(makeThis(r3.entry), noteDir, { fileId: 'uuid-3' });
            expect(r3.posted.length, '不在 file は何も post しない').toBe(0);
            expect(v.warnings.length, '警告が出る').toBe(1);
            expect(v.externals.length, '不在 file で openExternal しない').toBe(1);   // ② の 1 件のまま

            // ④ 既存 md 分岐は不変（notesNavigateInAppLink + mdFilePath）
            const r4 = makeEntry(noteDir, null);
            await nav.call(makeThis(r4.entry), noteDir, { mdFileId: 'm1' });
            expect(r4.posted.length).toBe(1);
            expect(r4.posted[0].type).toBe('notesNavigateInAppLink');
            expect(r4.posted[0].mdFilePath).toBe(path.join(noteDir, 'm1.md'));
            expect(r4.posted.some((m) => m.type === 'showNoteViewer'), 'md 分岐は viewer を開かない').toBe(false);

            // ⑤ 既存 node/out 分岐も不変
            const r5 = makeEntry(noteDir, null);
            await nav.call(makeThis(r5.entry), noteDir, { outFileId: 'out1', nodeId: 'node1' });
            expect(r5.posted).toEqual([{ type: 'notesNavigateInAppLink', outFileId: 'out1', nodeId: 'node1' }]);
        } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
        }
    });
});
