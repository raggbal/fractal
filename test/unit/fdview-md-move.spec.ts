/**
 * Sprint 20260827-172802-outliner-import-fdview-dnd-assets TASK-01 — FR-FLV-16 改訂（ADRL-0102）
 * folder view 内の md D&D を随伴転送（transferMdWithAssets + cleanupFvMoveSource）へ。
 * 非 md は従来どおり fs.rename（TC-FVM-04 が回帰 pin）。
 * TC-FVM-01..06。trashDelete は recorder（実削除しない no-op — TC-FLV-13 と同じ pin 方式:
 * 「削除は注入 trash 経由のみ」を、実体残存 + calls 記録で assert する）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}

function requireWithVscodeStub(modulePath: string, stub?: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return stub || {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
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

function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => { messages.push(m); } }, messages };
}

function makeDeps() {
    const calls: { errors: string[]; trash: string[]; renames: Array<[string, string]> } =
        { errors: [], trash: [], renames: [] };
    const deps = {
        showInputBox: async () => undefined,
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_key: string) => undefined as any,
        trashDelete: async (absPath: string) => { calls.trash.push(path.resolve(absPath)); },
        openMdInSidePanel: () => {}, openViewerPanel: () => {}, openExternal: () => {},
        ensureResourceRoot: () => {},
        renameFs: (absSrc: string, absDst: string) => { calls.renames.push([absSrc, absDst]); fs.renameSync(absSrc, absDst); },
        revealInOS: () => {}, clipboardWriteText: () => {},
    };
    // md 分岐用（FolderMoveDeps 形 — provider は folderMoveDeps を渡す。unit は同 recorder を共有）
    const moveDeps = {
        showErrorMessage: deps.showErrorMessage,
        t: deps.t,
        trashDelete: deps.trashDelete,
        toDisplayUri: (p: string) => p,
    };
    return { deps, moveDeps, calls };
}

/** linkedfd fixture: projA{memo.md(images/pic.png, files/spec.pdf, sub.md 参照), projB} */
function setupFixture() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fvmm-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fvmm-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    const projA = path.join(root, 'projA');
    fs.mkdirSync(path.join(projA, 'images'), { recursive: true });
    fs.mkdirSync(path.join(projA, 'files'), { recursive: true });
    fs.mkdirSync(path.join(root, 'projB'));
    fs.writeFileSync(path.join(projA, 'images', 'pic.png'), 'PNGDATA');
    fs.writeFileSync(path.join(projA, 'files', 'spec.pdf'), 'PDFDATA');
    fs.writeFileSync(path.join(projA, 'sub.md'), '# sub\n');
    fs.writeFileSync(path.join(projA, 'memo.md'),   // subpage は `[[label]](url)` 記法（参照リンク `[]()` は随伴しない = ADR-0009 ゲート反転）
        '# memo\n![](images/pic.png)\n[📎 spec.pdf](files/spec.pdf)\n[[sub]](sub.md)\n');
    return { mod, m, id, root, projA };
}

const findCopied = (dir: string, re: RegExp): string[] =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => re.test(n)) : [];

test.describe('FR-FLV-16 改訂: fv 内 md D&D の随伴移動（ADRL-0102）', () => {

    test('TC-FVM-01: md D&D で画像/📎/subpage が随伴・リンク書換・source は trash 対象', async () => {
        const { mod, m, id, root, projA } = setupFixture();
        const { deps, moveDeps, calls } = makeDeps();
        const { sender } = makeSender();

        const ok = await mod.folderViewMove(m, id, 'projA/memo.md', 'projB', deps as any, sender as any, moveDeps as any);
        expect(ok, 'md 分岐が成立').toBe(true);

        const projB = path.join(root, 'projB');
        const destMd = path.join(projB, 'memo.md');
        expect(fs.existsSync(destMd), 'dest に md').toBe(true);
        const imgs = findCopied(path.join(projB, 'images'), /pic\.png$/);
        expect(imgs.length, 'dest images/ に画像コピー').toBe(1);
        expect(fs.existsSync(path.join(projB, 'files', 'spec.pdf')), 'dest files/ に 📎（元名維持）').toBe(true);
        expect(fs.existsSync(path.join(projB, 'sub.md')), 'subpage 随伴').toBe(true);
        const body = fs.readFileSync(destMd, 'utf8');
        expect(body, '画像リンク書換').toContain(`images/${imgs[0]}`);
        expect(body, '📎 リンク解決可').toContain('files/spec.pdf');
        // source 側は全て trash 対象（recorder no-op なので実体は残る = 直接 fs 削除経路なしの pin）
        for (const p of ['memo.md', path.join('images', 'pic.png'), path.join('files', 'spec.pdf'), 'sub.md']) {
            expect(calls.trash, `source ${p} が trash 対象`).toContain(path.resolve(projA, p));
        }
        expect(calls.renames, 'md 分岐は rename を使わない').toHaveLength(0);
    });

    test('TC-FVM-02: 移動元の他 md が参照する共有資産は温存（残留参照）', async () => {
        const { mod, m, id, projA } = setupFixture();
        fs.writeFileSync(path.join(projA, 'other.md'), '# other\n![](images/pic.png)\n');
        const { deps, moveDeps, calls } = makeDeps();
        const { sender } = makeSender();

        expect(await mod.folderViewMove(m, id, 'projA/memo.md', 'projB', deps as any, sender as any, moveDeps as any)).toBe(true);
        expect(calls.trash, 'md 本体は trash 対象').toContain(path.resolve(projA, 'memo.md'));
        expect(calls.trash, '共有 pic.png は温存').not.toContain(path.resolve(projA, 'images', 'pic.png'));
        expect(fs.readFileSync(path.join(projA, 'other.md'), 'utf8'), 'other.md 無傷').toContain('images/pic.png');
    });

    test('TC-FVM-03: 随伴コピー 1 件失敗 → source は一切削除しない（全成功ゲートを破りにいく）', async () => {
        const { mod, m, id, root, projA } = setupFixture();
        const { deps, moveDeps, calls } = makeDeps();
        const { sender } = makeSender();
        // destFileDir(projB/files) を read-only の「ファイル」として先置き → 📎 コピーが失敗
        fs.writeFileSync(path.join(root, 'projB', 'files'), 'not-a-dir');

        await mod.folderViewMove(m, id, 'projA/memo.md', 'projB', deps as any, sender as any, moveDeps as any);
        // 全成功ゲート: 部分失敗なら source（md 含め）trash 0 + 失敗通知
        expect(calls.trash, '部分失敗で source 削除ゼロ').toHaveLength(0);
        expect(calls.errors.length, '失敗が通知される').toBeGreaterThan(0);
        expect(fs.existsSync(path.join(projA, 'memo.md')), 'source md 無傷').toBe(true);
        expect(fs.existsSync(path.join(projA, 'images', 'pic.png')), 'source 画像無傷').toBe(true);
    });

    test('TC-FVM-04: 非 md（.txt / フォルダ）は従来どおり rename 経路（回帰 pin）', async () => {
        const { mod, m, id, root } = setupFixture();
        const { deps, moveDeps, calls } = makeDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(root, 'plain.txt'), 'T');
        fs.mkdirSync(path.join(root, 'somedir'));

        expect(await mod.folderViewMove(m, id, 'plain.txt', 'projB', deps as any, sender as any, moveDeps as any)).toBe(true);
        expect(calls.renames, '.txt は rename 1 発').toHaveLength(1);
        expect(fs.readFileSync(path.join(root, 'projB', 'plain.txt'), 'utf8')).toBe('T');
        expect(calls.trash, '非 md は trash 不使用').toHaveLength(0);

        expect(await mod.folderViewMove(m, id, 'somedir', 'projB', deps as any, sender as any, moveDeps as any)).toBe(true);
        expect(calls.renames).toHaveLength(2);
        // 同名衝突は従来どおり中断（rename 経路の既存ガード不変）
        fs.writeFileSync(path.join(root, 'plain.txt'), 'v2');
        expect(await mod.folderViewMove(m, id, 'plain.txt', 'projB', deps as any, sender as any, moveDeps as any)).toBe(false);
        expect(fs.readFileSync(path.join(root, 'plain.txt'), 'utf8'), '元無傷').toBe('v2');
    });

    test('TC-FVM-05: md の同名衝突は uniquify で共存（rename 経路の中断と対照）', async () => {
        const { mod, m, id, root } = setupFixture();
        const { deps, moveDeps } = makeDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(root, 'projB', 'memo.md'), '# existing\n');

        expect(await mod.folderViewMove(m, id, 'projA/memo.md', 'projB', deps as any, sender as any, moveDeps as any)).toBe(true);
        const mds = findCopied(path.join(root, 'projB'), /^memo.*\.md$/);
        expect(mds.length, '既存 + 連番の 2 本が共存').toBe(2);
        expect(fs.readFileSync(path.join(root, 'projB', 'memo.md'), 'utf8'), '既存は無傷').toBe('# existing\n');
    });

    test('TC-FVM-06: md を自分の隣接 images/ へ D&D（B2 エッジ）— 例外なく完走・部分状態なし', async ({}, testInfo) => {
        const { mod, m, id, projA } = setupFixture();
        const { deps, moveDeps, calls } = makeDeps();
        const { sender } = makeSender();

        const ok = await mod.folderViewMove(m, id, 'projA/memo.md', 'projA/images', deps as any, sender as any, moveDeps as any);
        // 成立（通常処理）or 安全中断のどちらでも可 — ただし部分状態を残さない
        if (ok) {
            const destMd = path.join(projA, 'images', 'memo.md');
            expect(fs.existsSync(destMd), 'dest md 実在').toBe(true);
            expect(fs.readFileSync(destMd, 'utf8').length).toBeGreaterThan(0);
        } else {
            expect(calls.trash, '中断なら削除ゼロ').toHaveLength(0);
            expect(fs.existsSync(path.join(projA, 'memo.md')), '中断なら source 無傷').toBe(true);
        }
    });
});
