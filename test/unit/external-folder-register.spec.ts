/**
 * 外部フォルダ → note ツリー登録の 3 欠陥修正（2026-09-16）
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 *
 * `registerFolderIntoTree`（Finder / VS Code Explorer からのフォルダ D&D）は linkedfd 経由の
 * A-2（`registerFolderTreeFromFs`）と**非対称**な 3 欠陥を持っていた。
 * ADRL-0128 の「1 箇所修正で 2 経路が直る」を実際に両経路へ適用した記録。
 *
 * EXT-1: symlink を追従しない（意図しないツリーを取り込まない）
 * EXT-2: フォルダ内 md の参照画像が随伴する（旧実装は本文をそのまま登録して随伴なし）
 * EXT-3: プリフライトと実登録が同じ dirent 規則で数える（ズレない）
 *
 * 番人: `withFileTypes` + `isSymbolicLink()` skip を `statSync` に戻すと EXT-1 / EXT-3 が落ちる。
 * `transferMdWithAssets` の呼び出しを `registerMarkdownFile(content)` に戻すと EXT-2 が落ちる。
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

function setup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-note-'));
    const fm = new NotesFileManager(noteDir);
    fm.loadStructure();
    const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-src-'));
    return {
        mod, fm, noteDir, ext,
        titles: () => {
            const st = fm.getStructure();
            return Object.keys(st.items).map((id) => st.items[id].title);
        },
        noteFilesRel: () => {
            const out: string[] = [];
            const rec = (d: string) => {
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) { rec(p); } else { out.push(path.relative(noteDir, p)); }
                }
            };
            rec(noteDir);
            return out;
        },
        noteFiles: () => {
            const out: string[] = [];
            const rec = (d: string) => {
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) { rec(p); } else { out.push(e.name); }
                }
            };
            rec(noteDir);
            return out;
        },
        cleanup: () => { for (const d of [noteDir, ext]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } } },
    };
}

test.describe('外部フォルダ → note ツリー登録（3 欠陥の修正）', () => {
    test('EXT-1: symlink を追従せず、意図しないツリーを取り込まない', () => {
        const t = setup();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ext-out-'));
        try {
            fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
            const drop = path.join(t.ext, 'dropped');
            fs.mkdirSync(drop, { recursive: true });
            fs.writeFileSync(path.join(drop, 'ok.txt'), 'OK');
            fs.symlinkSync(outside, path.join(drop, 'link-out'), 'dir');

            const made = t.mod.registerFolderIntoTree(t.fm, drop, null, 0);
            expect(made, '登録に失敗した').toBeGreaterThan(0);
            const titles = t.titles();
            expect(titles.includes('ok.txt')).toBe(true);
            expect(titles.includes('secret.txt'),
                `symlink を追従して外部ツリーを取り込んだ: ${titles.join(',')}`).toBe(false);
            expect(titles.includes('link-out'), 'symlink 自身が登録された').toBe(false);
        } finally { fs.rmSync(outside, { recursive: true, force: true }); t.cleanup(); }
    });

    test('EXT-2: フォルダ内 md の参照リンクが note 側で解決する（随伴 + リンク書換）', () => {
        const t = setup();
        try {
            const drop = path.join(t.ext, 'dropped');
            fs.mkdirSync(drop, { recursive: true });
            fs.writeFileSync(path.join(drop, 'pic.png'), 'PNGDATA');
            fs.writeFileSync(path.join(drop, 'note.md'), '# Note\n![i](pic.png)\n');

            const made = t.mod.registerFolderIntoTree(t.fm, drop, null, 0);
            expect(made).toBeGreaterThan(0);

            // 🔴 「png がどこかに存在する」では番人にならない（実測）:
            //    旧実装でも png は **別の tree file item** として `files/` に登録されるので存在はする。
            //    しかし md の本文は `![i](pic.png)` のままで、md の位置から解決すると**リンク切れ**だった。
            //    検証すべきは「**md のリンクが実体に解決するか**」= 随伴 + リンク書換が働いたか。
            const mdRel = t.noteFilesRel().find((f) => /\.md$/i.test(f));
            expect(mdRel, 'md が登録されていない').toBeTruthy();
            const mdAbs = path.join(t.noteDir, mdRel as string);
            const body = fs.readFileSync(mdAbs, 'utf8');
            const m = body.match(/!\[[^\]]*\]\(([^)]+)\)/);
            expect(m, `md に画像リンクが無い: ${body}`).toBeTruthy();
            const linked = path.resolve(path.dirname(mdAbs), (m as RegExpMatchArray)[1]);
            expect(fs.existsSync(linked),
                `md のリンクが解決しない（随伴 / リンク書換が無い = 旧実装の欠陥 2）: `
                + `link="${(m as RegExpMatchArray)[1]}" → ${linked}`).toBe(true);
        } finally { t.cleanup(); }
    });

    test('EXT-3: プリフライトと実登録が同じ dirent 規則で数える', () => {
        const t = setup();
        try {
            const drop = path.join(t.ext, 'dropped');
            fs.mkdirSync(path.join(drop, 'sub'), { recursive: true });
            fs.writeFileSync(path.join(drop, 'a.txt'), 'A');
            fs.writeFileSync(path.join(drop, 'sub', 'b.txt'), 'B');
            // symlink はどちらの規則でも数えない（追従したらプリフライトが多く数えてズレる）
            fs.symlinkSync(path.join(drop, 'sub'), path.join(drop, 'loop'), 'dir');

            expect(t.mod.checkFolderRegisterLimits(drop, { maxFiles: 2, maxDepth: 20 }),
                'symlink を追従して余計に数えた（プリフライトと実登録がズレる）').toBe('ok');
            expect(t.mod.checkFolderRegisterLimits(drop, { maxFiles: 1, maxDepth: 20 })).toBe('too_many');
        } finally { t.cleanup(); }
    });

    test('EXT-4: dotfile は従来どおり除外（外部経路に showHidden 設定は無い）', () => {
        const t = setup();
        try {
            const drop = path.join(t.ext, 'dropped');
            fs.mkdirSync(drop, { recursive: true });
            fs.writeFileSync(path.join(drop, 'v.txt'), 'V');
            fs.writeFileSync(path.join(drop, '.hidden.txt'), 'H');
            t.mod.registerFolderIntoTree(t.fm, drop, null, 0);
            const titles = t.titles();
            expect(titles.includes('v.txt')).toBe(true);
            expect(titles.includes('.hidden.txt'), '外部経路で dotfile が入った（設定が無いので除外が正）').toBe(false);
        } finally { t.cleanup(); }
    });
});
