/**
 * TASK-10 — A-2: linkedfd → note ツリーの複数フォルダ複製
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 * FR-FDP-05 / ADRL-0128 / NFR-FDP-02 / INV-4
 *
 * TC-R2-1: 2 フォルダが複製され元が残る
 * TC-R2-2: フォルダ内 md の参照画像が随伴し note 側で解決できる
 * TC-R2-3: フォルダ外を指す参照は複製せず原文を温存する
 * TC-R2-4: root 外を指す symlink 経由で root 外を読まない
 * TC-R2-5: showHidden ON でフォルダ内 dotfile が欠落しない
 *
 * 番人: 受け皿を旧 `registerFolderIntoTreeAt`（symlink 追従・入口 1 回だけ clamp・資産随伴なし・
 * dotfile 無条件除外）に戻すと TC-R2-2 / TC-R2-4 / TC-R2-5 が落ちる。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
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
const fx = require('../fixtures/folder-payload/index');

function deps() {
    const calls: any = { error: [], info: [], limit: [], outcome: [] };
    return {
        calls,
        d: {
            showErrorMessage: (m: string) => calls.error.push(m),
            showInformationMessage: (m: string) => calls.info.push(m),
            t: (k: string) => k,
            trashDelete: async () => { /* noop */ },
            toDisplayUri: (p: string) => p,
            confirmLarge: () => true,
            notifyLimitExceeded: (e: string) => calls.limit.push(e),
            notifyOutcome: (o: any) => calls.outcome.push(o),
            renameFs: fs.renameSync,
        },
    };
}
const sender = () => { const msgs: any[] = []; return { s: { postMessage: (m: any) => msgs.push(m) }, msgs }; };

/** note 側の台帳から「タイトル → 種別」の一覧を作る（フォルダ構造の再現確認用）。 */
function ledgerTitles(fm: any): Array<{ title: string; type: string }> {
    const st = fm.getStructure();
    return Object.keys(st.items).map((id) => ({ title: st.items[id].title, type: st.items[id].type }));
}

test.describe('TASK-10 A-2 linkedfd → note ツリーのフォルダ複製', () => {
    test('TC-R2-1: 2 フォルダが複製され linkedfd 側は不変（複製意味論）', async () => {
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const dp = fx.makeDeepFolder(2);
        fs.mkdirSync(path.join(dp.root, 'second'), { recursive: true });
        fs.writeFileSync(path.join(dp.root, 'second', 's.txt'), 'S');
        const note = fx.makeLinkedNote(NotesFileManager, dp.root);
        try {
            const { d } = deps(); const { s } = sender();
            const r = await mod.folderViewMoveToTreeBatch(
                note.fm, note.folderLinkId,
                [{ relPath: 'deep' }, { relPath: 'second' }],
                null, 0, d as any, s);
            expect(r.verdict).toBe('ok');
            expect(r.outcome.succeeded, '2 フォルダが複製されていない').toBe(2);
            const titles = ledgerTitles(note.fm);
            expect(titles.some((x) => x.title === 'deep' && x.type === 'folder')).toBe(true);
            expect(titles.some((x) => x.title === 'second' && x.type === 'folder')).toBe(true);
            // linkedfd 側は残る（複製 = FR-DCP-01 / ADRL-0106）
            expect(fs.existsSync(path.join(dp.root, 'deep'))).toBe(true);
            expect(fs.existsSync(path.join(dp.root, 'second', 's.txt'))).toBe(true);
        } finally { note.cleanup(); dp.cleanup(); }
    });

    test('TC-R2-2: フォルダ内 md の参照画像が随伴する', async () => {
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const md = fx.makeMdWithAssets();
        const note = fx.makeLinkedNote(NotesFileManager, md.root);
        try {
            const { d } = deps(); const { s } = sender();
            const ok = await mod.folderViewMoveToTree(note.fm, note.folderLinkId, 'deep', null, 0, d as any, s);
            expect(ok).toBe(true);
            // note 側に画像が複製されている（旧実装は本文をそのまま登録して随伴しなかった）
            const noteDir = note.fm.getMainFolderPath();
            const all: string[] = [];
            const rec = (dir: string) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, e.name);
                    if (e.isDirectory()) { rec(p); } else { all.push(e.name); }
                }
            };
            rec(noteDir);
            expect(all.some((n) => /img.*\.png$/i.test(n)),
                `フォルダ内 md の参照画像が note 側に随伴していない: ${all.join(',')}`).toBe(true);
        } finally { note.cleanup(); md.cleanup(); }
    });

    test('TC-R2-4: root 外を指す symlink 経由で root 外を読まない（containment）', async () => {
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const sym = fx.makeSymlinkEscape();
        const note = fx.makeLinkedNote(NotesFileManager, sym.root);
        try {
            const { d } = deps(); const { s } = sender();
            const ok = await mod.folderViewMoveToTree(note.fm, note.folderLinkId, 'withlink', null, 0, d as any, s);
            expect(ok).toBe(true);
            const noteDir = note.fm.getMainFolderPath();
            const all: string[] = [];
            const rec = (dir: string) => {
                for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                    const p = path.join(dir, e.name);
                    if (e.isDirectory()) { rec(p); } else { all.push(e.name); }
                }
            };
            rec(noteDir);
            expect(all.includes('secret.txt'),
                'linkedfd root 外のファイルが note へ複製された（containment 破り = NFR-FDP-02 違反）').toBe(false);
            // symlink 自身も台帳に載らない
            expect(ledgerTitles(note.fm).some((x) => x.title === 'link-out')).toBe(false);
        } finally { note.cleanup(); sym.cleanup(); }
    });

    test('TC-R2-5: showHidden ON でフォルダ内 dotfile が欠落しない', async () => {
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const dot = fx.makeDotfiles();
        fx.setShowHidden(dot.root, true);
        const note = fx.makeLinkedNote(NotesFileManager, dot.root);
        try {
            const { d } = deps(); const { s } = sender();
            const ok = await mod.folderViewMoveToTree(note.fm, note.folderLinkId, 'dotted', null, 0, d as any, s);
            expect(ok).toBe(true);
            const titles = ledgerTitles(note.fm).map((x) => x.title);
            expect(titles.includes('.hidden.txt'),
                `showHidden ON なのに dotfile が黙って消えた（旧実装の欠陥 3）: ${titles.join(',')}`).toBe(true);
        } finally { note.cleanup(); dot.cleanup(); }
    });

    test('TC-R2-5b: showHidden OFF なら dotfile は除外される（既定挙動）', async () => {
        const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const dot = fx.makeDotfiles();
        const note = fx.makeLinkedNote(NotesFileManager, dot.root);
        try {
            const { d } = deps(); const { s } = sender();
            await mod.folderViewMoveToTree(note.fm, note.folderLinkId, 'dotted', null, 0, d as any, s);
            const titles = ledgerTitles(note.fm).map((x) => x.title);
            expect(titles.includes('.hidden.txt')).toBe(false);
            expect(titles.includes('visible.txt')).toBe(true);
        } finally { note.cleanup(); dot.cleanup(); }
    });
});
