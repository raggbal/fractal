/**
 * linkedfd 内の同名衝突を連番正典に統一（3 択廃止）+ 同一位置 copy の連番複製
 * sprint 20260930-192647-linkedfd-conflict-rename-and-paste-sibling
 * FR-FLV-16 rev4 / FR-CBD-07 rev3 / FR-FNM-01 / NFR-FNM-01 / ADRL-0132 / ADRL-0133
 *
 * TC-FNM-01〜11（host unit）。番人:
 * - `absDst === absSrc` の no-op を mode 不問に戻すと TC-FNM-01/02/10 が落ちる
 * - move の同名拒否（folderViewNameConflict）を戻すと TC-FNM-04/06/11 が落ちる
 * - treatAsDir を copy / move / Duplicate のどれかから外すと TC-FNM-03/07/08 が落ちる
 * - 宛先 trash 退避（上書き）を残すと TC-FNM-09 が落ちる
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

/** linkedfd root（空）+ note を作り、host 関数を呼ぶための deps を用意する。 */
function setup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fnm-root-'));
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fnm-note-'));
    const fm = new NotesFileManager(noteDir);
    fm.loadStructure();
    const linkId = fm.registerFolderLink(root);
    const calls: any = { error: [], trash: [], info: [], lists: [] as string[] };
    const deps: any = {
        showErrorMessage: (m: string) => calls.error.push(m),
        showInformationMessage: (m: string) => calls.info.push(m),
        t: (k: string) => k,
        trashDelete: async (p: string, rec: boolean) => {
            calls.trash.push({ p, rec });
            fs.rmSync(p, { recursive: true, force: true });
        },
        deleteFile: async (p: string, rec: boolean) => { fs.rmSync(p, { recursive: rec, force: true }); },
        toDisplayUri: (p: string) => p,
        confirmLarge: () => true,
        notifyLimitExceeded: () => { /* noop */ },
        notifyOutcome: () => { /* noop */ },
        renameFs: fs.renameSync,
    };
    const sender = {
        postMessage: (m: any) => { if (m && m.type === 'folderViewListResult') { calls.lists.push(m.relPath ?? m.dirRelPath ?? ''); } },
    };
    const w = (rel: string, body: string) => {
        fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
        fs.writeFileSync(path.join(root, rel), body);
    };
    const r = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
    const ex = (rel: string) => fs.existsSync(path.join(root, rel));
    return {
        mod, fm, linkId, root, deps, calls, sender, w, r, ex,
        mv: (src: string, dst: string, mode: 'move' | 'copy' = 'move') =>
            mod.folderViewMove(fm, linkId, src, dst, deps, sender, deps, mode),
        batch: (srcs: string[], dst: string, mode: 'move' | 'copy' = 'move') =>
            mod.folderViewMoveBatch(fm, linkId, srcs, dst, mode, deps, sender, deps),
        cleanup: () => {
            fs.rmSync(root, { recursive: true, force: true });
            fs.rmSync(noteDir, { recursive: true, force: true });
        },
    };
}

test.describe('同一位置 copy は連番複製（FR-CBD-07 rev3 / ADRL-0133）', () => {
    test('TC-FNM-01: 同一フォルダへの copy（ファイル）で連番複製される', async () => {
        const t = setup();
        try {
            t.w('docs/img.png', 'P');
            const ok = await t.mv('docs/img.png', 'docs', 'copy');
            expect(ok, '同一位置 copy が no-op で終わった').toBe(true);
            expect(t.r('docs/img-1.png')).toBe('P');
            expect(t.r('docs/img.png')).toBe('P');
            // 一覧が再送される（webview の表示更新 + 進行中フラグ解除の既存契機）
            expect(t.calls.lists, `docs の一覧が再送されていない: ${JSON.stringify(t.calls.lists)}`).toContain('docs');
        } finally { t.cleanup(); }
    });

    test('TC-FNM-02: 同一フォルダへの copy（md）で随伴資産ごと連番複製される', async () => {
        const t = setup();
        try {
            t.w('docs/a.md', '# A\n\n![](images/x.png)\n');
            t.w('docs/images/x.png', 'IMG');
            const ok = await t.mv('docs/a.md', 'docs', 'copy');
            expect(ok, '同一位置 copy（md）が no-op で終わった').toBe(true);
            expect(t.ex('docs/a-1.md'), 'a-1.md が作られていない').toBe(true);
            expect(t.r('docs/a.md')).toBe('# A\n\n![](images/x.png)\n');
            expect(t.r('docs/images/x.png')).toBe('IMG');
            // 複製の画像参照が実在ファイルを指す
            const body = t.r('docs/a-1.md');
            const m = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
            expect(m, '複製本文に画像参照が無い').not.toBeNull();
            expect(fs.existsSync(path.join(t.root, 'docs', m![1])), `参照先 ${m![1]} が無い`).toBe(true);
        } finally { t.cleanup(); }
    });

    test('TC-FNM-03: 同一フォルダへの copy（フォルダ）で中身ごと連番・自己再帰しない', async () => {
        const t = setup();
        try {
            t.w('docs/assets.bak/a.txt', 'A');
            t.w('docs/assets.bak/sub/b.txt', 'B');
            await t.batch(['docs/assets.bak'], 'docs', 'copy');
            expect(t.ex('docs/assets.bak-1/a.txt'), 'assets.bak-1 になっていない（treatAsDir 抜け）').toBe(true);
            expect(t.r('docs/assets.bak-1/sub/b.txt')).toBe('B');
            expect(t.ex('docs/assets-1.bak')).toBe(false);
            expect(t.ex('docs/assets.bak-1/assets.bak-1')).toBe(false);
            expect(t.r('docs/assets.bak/a.txt')).toBe('A');
        } finally { t.cleanup(); }
    });

    test('TC-FNM-10: 同一フォルダへ 2 回続けて copy すると連番が進む', async () => {
        const t = setup();
        try {
            t.w('docs/img.png', 'P');
            await t.mv('docs/img.png', 'docs', 'copy');
            await t.mv('docs/img.png', 'docs', 'copy');
            expect(t.r('docs/img-1.png')).toBe('P');
            expect(t.r('docs/img-2.png')).toBe('P');
            expect(t.r('docs/img.png')).toBe('P');
        } finally { t.cleanup(); }
    });
});

test.describe('move の同名は連番で移動（FR-FLV-16 rev4 / ADRL-0132）', () => {
    test('TC-FNM-04: 単数ファイル move の同名は連番で移動する', async () => {
        const t = setup();
        try {
            t.w('src/a.png', 'NEW');
            t.w('B/a.png', 'OLD');
            const ok = await t.mv('src/a.png', 'B');
            expect(ok, '同名で移動が拒否された').toBe(true);
            expect(t.r('B/a-1.png')).toBe('NEW');
            expect(t.r('B/a.png')).toBe('OLD');
            expect(t.ex('src/a.png')).toBe(false);
            expect(t.calls.error, `エラー通知が出た: ${t.calls.error.join(',')}`).toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-FNM-05: 単数 md move の同名は随伴転送で連番（既存挙動の維持）', async () => {
        const t = setup();
        try {
            t.w('src/a.md', '# NEW\n');
            t.w('B/a.md', '# OLD\n');
            const ok = await t.mv('src/a.md', 'B');
            expect(ok).toBe(true);
            expect(t.r('B/a-1.md')).toBe('# NEW\n');
            expect(t.r('B/a.md')).toBe('# OLD\n');
            expect(t.ex('src/a.md')).toBe(false);
        } finally { t.cleanup(); }
    });

    test('TC-FNM-06: 複数 move で一部だけ衝突しても全件移動・ダイアログなし', async () => {
        const t = setup();
        try {
            t.w('src/x.txt', 'X');
            t.w('src/y.txt', 'Y');
            t.w('B/x.txt', 'OLD');
            const r = await t.batch(['src/x.txt', 'src/y.txt'], 'B');
            expect(r.verdict).toBe('ok');
            expect(r.outcome.succeeded).toBe(2);
            expect(t.r('B/x-1.txt')).toBe('X');
            expect(t.r('B/y.txt')).toBe('Y');
            expect(t.r('B/x.txt')).toBe('OLD');
        } finally { t.cleanup(); }
    });

    test('TC-FNM-07: フォルダ move の同名は連番（ドット入りは拡張子扱いしない）', async () => {
        const t = setup();
        try {
            t.w('src/assets/1.txt', '1');
            t.w('src/assets.bak/2.txt', '2');
            t.w('B/assets/keep.txt', 'K1');
            t.w('B/assets.bak/keep.txt', 'K2');
            const r = await t.batch(['src/assets', 'src/assets.bak'], 'B');
            expect(r.outcome.succeeded).toBe(2);
            expect(t.r('B/assets-1/1.txt')).toBe('1');
            expect(t.r('B/assets.bak-1/2.txt')).toBe('2');
            expect(fs.readdirSync(path.join(t.root, 'B', 'assets'))).toEqual(['keep.txt']);
            expect(fs.readdirSync(path.join(t.root, 'B', 'assets.bak'))).toEqual(['keep.txt']);
        } finally { t.cleanup(); }
    });

    test('TC-FNM-08: Duplicate のフォルダは treatAsDir で連番', async () => {
        const t = setup();
        try {
            t.w('docs/assets.bak/a.txt', 'A');
            await t.mod.folderViewDuplicate(t.fm, t.linkId, 'docs/assets.bak', t.deps, t.sender);
            expect(t.ex('docs/assets.bak-1/a.txt'), 'assets.bak-1 になっていない').toBe(true);
            expect(t.ex('docs/assets-1.bak')).toBe(false);
        } finally { t.cleanup(); }
    });

    test('TC-FNM-09: 同名衝突で既存エントリが置き換わらない（trash も呼ばれない）', async () => {
        const t = setup();
        try {
            t.w('src/a.png', 'NEW');
            t.w('B/a.png', 'OLD');
            t.w('src/assets/1.txt', '1');
            t.w('B/assets/keep.txt', 'K');
            await t.mv('src/a.png', 'B');
            await t.batch(['src/assets'], 'B');
            expect(t.r('B/a.png')).toBe('OLD');
            expect(fs.readdirSync(path.join(t.root, 'B', 'assets'))).toEqual(['keep.txt']);
            expect(t.calls.trash, '宛先を trash 退避した（上書き経路が残っている）').toEqual([]);
        } finally { t.cleanup(); }
    });

    test('TC-FNM-11: 複数ドットのファイル名は最後の拡張子の前に連番', async () => {
        const t = setup();
        try {
            t.w('src/report.v2.pdf', 'NEW');
            t.w('B/report.v2.pdf', 'OLD');
            const ok = await t.mv('src/report.v2.pdf', 'B');
            expect(ok).toBe(true);
            expect(t.r('B/report.v2-1.pdf')).toBe('NEW');
        } finally { t.cleanup(); }
    });
});

test.describe('その場複製の通し確認（US-002 / FR-CBD-07 rev3）', () => {
    test('TC-IPP-05: webview が渡す引数（宛先 = コピー元の親）で host に同一フォルダ複製ができる', async () => {
        const t = setup();
        try {
            t.w('a.md', '# A\n');
            t.w('assets/x.txt', 'X');
            // TC-IPP-01 の bridge 引数: ('fl1', 'a.md', '', 'copy') / TC-IPP-02: (['assets'], '', 'copy')
            expect(await t.mv('a.md', '', 'copy')).toBe(true);
            await t.batch(['assets'], '', 'copy');
            expect(t.r('a-1.md')).toBe('# A\n');
            expect(t.r('assets-1/x.txt')).toBe('X');
            expect(t.r('a.md')).toBe('# A\n');
            expect(t.r('assets/x.txt')).toBe('X');
        } finally { t.cleanup(); }
    });
});

/** src/ 配下の .ts / .js を列挙する（TC-RMV 用のソース走査）。 */
function listSrcFiles(dir: string): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { out.push(...listSrcFiles(p)); }
        else if (/\.(ts|js)$/.test(e.name)) { out.push(p); }
    }
    return out;
}
const SRC_DIR = path.join(__dirname, '..', '..', 'src');

test.describe('3 択撤去の完全性（NFR-FNM-02 / ADRL-0132）', () => {
    test('TC-RMV-01: 3 択関連シンボルが src に残っていない', () => {
        const hits: string[] = [];
        for (const f of listSrcFiles(SRC_DIR)) {
            const body = fs.readFileSync(f, 'utf8');
            for (const sym of ['ConflictPolicy', 'detectNameConflicts', 'promptConflict']) {
                if (body.includes(sym)) { hits.push(`${path.relative(SRC_DIR, f)}: ${sym}`); }
            }
        }
        expect(hits, `3 択の残骸: ${hits.join(' / ')}`).toEqual([]);
    });

    test('TC-RMV-02: i18n の 3 択キー 5 個が messages.ts と 7 locale に残っていない（folderViewNameConflict は残る）', () => {
        const files = ['messages.ts', ...['en', 'ja', 'ko', 'zh-cn', 'zh-tw', 'fr', 'es'].map((l) => `locales/${l}.ts`)];
        for (const rel of files) {
            const body = fs.readFileSync(path.join(SRC_DIR, 'i18n', rel), 'utf8');
            for (const k of ['conflictPromptBody', 'conflictOverwrite', 'conflictOverwriteAll', 'conflictRename', 'conflictRenameAll']) {
                expect(new RegExp(`\\b${k}\\b`).test(body), `${rel} に ${k} が残っている`).toBe(false);
            }
            expect(/\bfolderViewNameConflict\b/.test(body), `${rel} から folderViewNameConflict を消してしまった（New Folder / Rename が使う）`).toBe(true);
        }
    });

    test('TC-RMV-03: 件数確認 modal（showModalChoice）は生きている', () => {
        // provider の deps は resolveCustomEditor のクロージャ内で組まれ seam が無いため、
        // 既存の番人（i18n-sendto-keys.spec.ts の QUAL3-3）と同じくソースで構造を確認する。
        const code = fs.readFileSync(path.join(SRC_DIR, 'notesEditorProvider.ts'), 'utf8')
            .replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
        expect((code.match(/showWarningMessage\([\s\S]{0,200}?\{ modal: true \}/g) || []).length,
            'modal の実装が 1 箇所でない').toBe(1);
        expect(/const showModalChoice = /.test(code), 'showModalChoice を消してしまった').toBe(true);
        expect(/confirmLargeWith[\s\S]{0,600}?showModalChoice\(/.test(code), 'confirmLarge が showModalChoice を使っていない').toBe(true);
    });
});
