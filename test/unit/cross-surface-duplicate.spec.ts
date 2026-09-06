/**
 * TASK-17 — 面間 D&D の複製化（linkedfd ⇄ note ツリーの 2 方向）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-DCP-01/02/03 / ADRL-0106）
 *
 * TC-DCP-01..10 / 12 / 13。
 *
 * 番人の形（design/tdd.md）: **`fs.existsSync(source)` + 台帳 item の実在**を assert する。
 * `trashDelete` は本番（`vscode.workspace.fs.delete`）と同じく **実際に実体を消す** stub にしている —
 * 「message が送られた」だけの assert は fs の実状態を保証しないため。
 *
 * 🔴 counterfactual: `finalizeSourceSide` の `'duplicate'` 分岐を消す（= `'move'` に倒す）と
 * TC-DCP-01/02/03/05/06 が RED。逆に `'move'` 側の 3 経路を `'duplicate'` にすると
 * TC-DCP-07/08/09/10 が RED（過剰適用の検出器）。
 */
import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
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

/**
 * deps。`trashDelete` は **実際に unlink する**（本番 `vscode.workspace.fs.delete` 相当）。
 * spy 呼び出し回数も残すが、番人の主軸は fs の実状態。
 */
function makeMoveDeps() {
    const calls: { errors: string[]; trash: { absPath: string; recursive: boolean }[] } = { errors: [], trash: [] };
    const deps = {
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_key: string) => undefined as any,
        trashDelete: async (absPath: string, recursive: boolean) => {
            calls.trash.push({ absPath, recursive });
            try { fs.rmSync(absPath, { recursive, force: true }); } catch { /* best effort（本番と同じ） */ }
        },
        toDisplayUri: (absPath: string) => 'vscode-resource://' + absPath,
    };
    return { deps, calls };
}
function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => messages.push(m) }, messages };
}

/** 資産持ち md 一式（main.md + images/pic.png + files/spec.pdf + sub.md）。 */
function mkAssetSet(dir: string): void {
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'spec.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(dir, 'sub.md'), '# Sub\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'main.md'),
        '# Main Title\n![i](images/pic.png)\n[📎 spec.pdf](files/spec.pdf)\n[[Sub]](sub.md)\n', 'utf8');
}
function sha(p: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function setup() {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dcp-fv-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    const cleanup = () => {
        for (const d of [noteDir, root]) {
            try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
            try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
        }
    };
    return { mod, m, id, root, noteDir, cleanup };
}

test.describe('FR-DCP-01: linkedfd → note ツリーは複製', () => {
    test('TC-DCP-01 md 転送後も linkedfd 側の 4 件（md / 画像 / 📎 / subpage）が残る', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        mkAssetSet(s.root);
        try {
            expect(await s.mod.folderViewMoveToTree(s.m, s.id, 'main.md', null, 0, deps as any, sender as any)).toBe(true);

            // note 側に登録されている（複製自体は成立している = 「何もしない」実装ではない）
            const mdItems = (Object.values(s.m.getStructure().items) as any[]).filter((it) => it.ext === 'md');
            expect(mdItems.length, 'note ツリーに md item が登録されていない').toBe(1);
            expect(fs.existsSync(path.join(s.noteDir, 'main.md')), 'note 側に md 実体が無い').toBe(true);
            expect(fs.existsSync(path.join(s.noteDir, 'files', 'spec.pdf')), 'note 側に随伴 📎 が無い').toBe(true);

            // ★ linkedfd 側が 4 件すべて残る
            for (const rel of ['main.md', 'sub.md', 'images/pic.png', 'files/spec.pdf']) {
                expect(fs.existsSync(path.join(s.root, rel)),
                    `linkedfd の ${rel} が消えた（複製ではなく移動になっている）`).toBe(true);
            }
        } finally { s.cleanup(); }
    });

    test('TC-DCP-02 非 md（pdf）転送後も linkedfd 側が残る', async () => {
        const s = setup();
        const { deps } = makeMoveDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(s.root, 'b.pdf'), 'PDF-B', 'utf8');
        try {
            expect(await s.mod.folderViewMoveToTree(s.m, s.id, 'b.pdf', null, 0, deps as any, sender as any)).toBe(true);
            expect(fs.existsSync(path.join(s.noteDir, 'files', 'b.pdf')), 'note の files/ に複製が無い').toBe(true);
            expect(fs.existsSync(path.join(s.root, 'b.pdf')), 'linkedfd の b.pdf が消えた').toBe(true);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-03 随伴資産の削除フェーズが 1 度も発火しない（実行の実測）', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        mkAssetSet(s.root);
        try {
            await s.mod.folderViewMoveToTree(s.m, s.id, 'main.md', null, 0, deps as any, sender as any);
            // cleanupFvMoveSource / trashSourceBestEffort の唯一の外部効果が trashDelete なので、
            // 呼び出しゼロ = 削除フェーズが発火していない（source pin ではなく実行の実測）
            expect(calls.trash.length,
                `削除フェーズが発火した: ${calls.trash.map((t) => t.absPath).join(', ')}`).toBe(0);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-04 複製失敗時に source が 1 バイトも変わらない', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        fs.writeFileSync(path.join(s.root, 'b.pdf'), 'PDF-B', 'utf8');
        const before = sha(path.join(s.root, 'b.pdf'));
        try {
            // note 側 files/ を作れなくする（note ディレクトリを書込不可に）
            fs.mkdirSync(path.join(s.noteDir, 'files'), { recursive: true });
            fs.chmodSync(path.join(s.noteDir, 'files'), 0o500);
            let writable = true;
            try { fs.writeFileSync(path.join(s.noteDir, 'files', '.probe'), 'x'); } catch { writable = false; }
            expect(writable, 'fixture 前提: chmod 500 で書込不能（root 実行では成立しない）').toBe(false);

            await s.mod.folderViewMoveToTree(s.m, s.id, 'b.pdf', null, 0, deps as any, sender as any);

            // ★ FR-DCP-01 の要点: source は元より一切変化しない（「従来と同じ失敗時 source 不触」）
            expect(fs.existsSync(path.join(s.root, 'b.pdf')), 'source が消えた').toBe(true);
            expect(sha(path.join(s.root, 'b.pdf')), 'source の内容が変わった').toBe(before);
            expect(calls.trash.length, '失敗時に trash が走った').toBe(0);
            // note 側に実体は作られていない
            expect(fs.existsSync(path.join(s.noteDir, 'files', 'b.pdf')), '書込不能なのに実体ができた').toBe(false);

            // ⚠️ **既存の欠陥をここで固定する（本 TASK のスコープ外 — 隠さずに明示する）**:
            // `NotesFileManager.registerTreeFile`（notes-file-manager.ts:241-245）は writeFileSync の
            // 例外を console.error で飲んだうえで **台帳 item だけを登録して id を返す**。そのため
            // 実体ゼロの item が残り、`folderViewMoveToTree` にも失敗が伝わらず**エラー通知が出ない**。
            // FR-DCP-01 の受け入れ条件は「エラー通知」を含むが、これは fv→tree の複製化とは独立した
            // 既存の失敗ハンドリング欠陥で、修正には `notes-file-manager.ts`（本 TASK の変更ファイル外）の
            // 契約変更（戻り値を成否にする / 失敗時ロールバック）が必要。
            // この assert が **将来 false になったら通知が実装された**ということなので、その時点で
            // 上の説明ごと更新する（「通知が無いのが正しい」と読ませないため反転条件で書く）。
            expect(calls.errors.length,
                'エラー通知が実装された — registerTreeFile の失敗ハンドリングが直った可能性。'
                + 'この TC のコメントと期待値を更新すること').toBe(0);
            const orphan = (Object.values(s.m.getStructure().items) as any[]).filter((it) => it.ext === 'file');
            expect(orphan.length,
                '既存欠陥の記録: 実体が書けなくても台帳 item は 1 件登録される'
                + '（registerTreeFile が例外を飲むため）').toBe(1);
        } finally {
            try { fs.chmodSync(path.join(s.noteDir, 'files'), 0o755); } catch { /* ignore */ }
            s.cleanup();
        }
    });
});

test.describe('FR-DCP-02: note ツリー → linkedfd は複製', () => {
    test('TC-DCP-05 非 md 転送後も台帳 item と note 側実体が残る', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        try {
            // note の files/b.pdf を tree item として登録
            s.m.registerTreeFile('b.pdf', 'b.pdf', null, 0, Buffer.from('PDF-B'));
            const itemId = (Object.values(s.m.getStructure().items) as any[])
                .find((it) => it.ext === 'file')?.id;
            expect(itemId, '前提: tree file item が登録できていない').toBeTruthy();
            const noteAbs = s.m.getTreeFilePath(itemId!);
            expect(noteAbs && fs.existsSync(noteAbs)).toBe(true);

            expect(await s.mod.folderViewMoveIn(s.m, s.id, '', 'file', itemId!, deps as any, sender as any)).toBe(true);

            // linkedfd 側に複製ができている
            expect(fs.existsSync(path.join(s.root, 'b.pdf')), 'linkedfd に複製が無い').toBe(true);
            // ★ note 側の台帳 item が実在
            expect(s.m.getStructure().items[itemId!], '台帳 item が除去された').toBeTruthy();
            // ★ note 側の実体も残る
            expect(fs.existsSync(noteAbs!), 'note 側の実体が trash された').toBe(true);
            expect(calls.trash.length, 'trash が走った').toBe(0);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-06 md 転送後も note 側の md / item / 随伴資産すべてが残る', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        mkAssetSet(s.noteDir);
        try {
            s.m.registerExistingMdFile('main', 'Main Title', null, 0);
            expect(await s.mod.folderViewMoveIn(s.m, s.id, '', 'md', 'main', deps as any, sender as any)).toBe(true);

            // linkedfd 側は隣接レイアウトへ変換された複製
            const destMd = fs.readdirSync(s.root).find((n) => n.endsWith('.md') && n.includes('Main'));
            expect(destMd, 'linkedfd に md 複製が無い').toBeTruthy();
            expect(fs.existsSync(path.join(s.root, 'files', 'spec.pdf')), 'linkedfd に随伴 📎 が無い').toBe(true);

            // ★ note 側が丸ごと残る
            expect(s.m.getStructure().items['main'], 'note 台帳の md item が除去された').toBeTruthy();
            for (const rel of ['main.md', 'sub.md', 'images/pic.png', 'files/spec.pdf']) {
                expect(fs.existsSync(path.join(s.noteDir, rel)), `note 側の ${rel} が消えた`).toBe(true);
            }
            expect(calls.trash.length, 'trash が走った').toBe(0);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-13 複製失敗時に note 側が不変（TC-DCP-04 と対称）', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        try {
            s.m.registerTreeFile('b.pdf', 'b.pdf', null, 0, Buffer.from('PDF-B'));
            const itemId = (Object.values(s.m.getStructure().items) as any[])
                .find((it) => it.ext === 'file')?.id;
            const noteAbs = s.m.getTreeFilePath(itemId!)!;
            const before = sha(noteAbs);

            // linkedfd の dest を書込不能に
            fs.chmodSync(s.root, 0o500);
            let writable = true;
            try { fs.writeFileSync(path.join(s.root, '.probe'), 'x'); } catch { writable = false; }
            expect(writable, 'fixture 前提: chmod 500 で書込不能（root 実行では成立しない）').toBe(false);

            const ok = await s.mod.folderViewMoveIn(s.m, s.id, '', 'file', itemId!, deps as any, sender as any);
            expect(ok, '書込不能なのに成功を返した').toBe(false);
            expect(calls.errors.length, 'エラー通知が無い').toBeGreaterThan(0);
            expect(s.m.getStructure().items[itemId!], '失敗時に台帳 item が除去された').toBeTruthy();
            expect(sha(noteAbs), '失敗時に note 側実体が変わった').toBe(before);
            expect(calls.trash.length, '失敗時に trash が走った').toBe(0);
            // linkedfd 側に中途半端な実体が残っていない
            fs.chmodSync(s.root, 0o755);
            expect(fs.existsSync(path.join(s.root, 'b.pdf')), '失敗したのに dest に実体が残った').toBe(false);
        } finally {
            try { fs.chmodSync(s.root, 0o755); } catch { /* ignore */ }
            s.cleanup();
        }
    });
});

test.describe('FR-DCP-03 / NFR-DCP-04: 移動のまま残る経路（過剰適用の検出器）', () => {
    test('TC-DCP-07 fv → sidepanel md は移動のまま（随伴資産も削除される）', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender, messages } = makeSender();
        mkAssetSet(s.root);
        const target = path.join(s.noteDir, 'target.md');
        fs.writeFileSync(target, '# Target\n', 'utf8');
        try {
            expect(await s.mod.folderViewMoveIntoMd(s.m, s.id, 'main.md', target, deps as any, sender as any)).toBe(true);
            // subpage リンク挿入指示
            expect(messages.some((m) => m.type === 'insertSubpageLink'), 'リンク挿入指示が無い').toBe(true);
            // ★ linkedfd 側の md が消えている（移動）
            expect(fs.existsSync(path.join(s.root, 'main.md')),
                'fv→sidepanel md が複製になった（過剰適用）').toBe(false);
            // FR-ACD-01 の随伴削除も発火している
            expect(calls.trash.some((t) => t.absPath === path.join(s.root, 'images', 'pic.png')),
                '随伴画像の削除フェーズが止まっている').toBe(true);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-08 sidepanel md → fv は移動のまま', async () => {
        const s = setup();
        const { deps, calls } = makeMoveDeps();
        const { sender } = makeSender();
        // note 側の md に 📎 リンクを持たせ、その添付を fv へ移す
        fs.mkdirSync(path.join(s.noteDir, 'files'), { recursive: true });
        fs.writeFileSync(path.join(s.noteDir, 'files', 'att.pdf'), 'ATT', 'utf8');
        const srcMd = path.join(s.noteDir, 'doc.md');
        fs.writeFileSync(srcMd, '# Doc\n[📎 att.pdf](files/att.pdf)\n', 'utf8');
        try {
            const ok = await s.mod.folderViewMoveFromMd(s.m, s.id, '',
                { href: 'files/att.pdf', sourceMdPath: srcMd }, deps as any, sender as any);
            expect(ok, 'folderViewMoveFromMd が失敗した').toBe(true);
            expect(fs.existsSync(path.join(s.root, 'att.pdf')), 'fv に複製が無い').toBe(true);
            // ★ note 側の実体が消える（移動）
            expect(calls.trash.length, 'md→fv が複製になった（過剰適用）').toBeGreaterThan(0);
            expect(fs.existsSync(path.join(s.noteDir, 'files', 'att.pdf')),
                'md→fv で元実体が残った（移動でなくなった）').toBe(false);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-09 fv 内フォルダ間は移動のまま（ADRL-0102）', async () => {
        const s = setup();
        const { deps } = makeMoveDeps();
        const { sender } = makeSender();
        fs.mkdirSync(path.join(s.root, 'sub1'), { recursive: true });
        fs.mkdirSync(path.join(s.root, 'sub2'), { recursive: true });
        fs.writeFileSync(path.join(s.root, 'sub1', 'a.md'), '# A\n', 'utf8');
        try {
            const ok = await s.mod.folderViewMove(s.m, s.id, 'sub1/a.md', 'sub2', deps as any, sender as any, deps as any);
            expect(ok, 'folderViewMove が失敗した').toBe(true);
            expect(fs.existsSync(path.join(s.root, 'sub2', 'a.md')), 'dest に無い').toBe(true);
            expect(fs.existsSync(path.join(s.root, 'sub1', 'a.md')),
                'fv 内 D&D が複製になった（ADRL-0102 違反・過剰適用）').toBe(false);
        } finally { s.cleanup(); }
    });

    test('TC-DCP-10 移動のまま残る 3 経路すべてで削除が実行経路上にある', async () => {
        // 「行番号 assert」ではなく各経路を 1 回通して削除の実行を確認する（行番号は編集でずれる）
        const routes: { name: string; run: () => Promise<boolean> }[] = [];
        const results: { name: string; removed: boolean }[] = [];

        // ① folderViewMoveIntoMd
        {
            const s = setup();
            const { deps } = makeMoveDeps();
            const { sender } = makeSender();
            mkAssetSet(s.root);
            const target = path.join(s.noteDir, 'target.md');
            fs.writeFileSync(target, '# T\n', 'utf8');
            await s.mod.folderViewMoveIntoMd(s.m, s.id, 'main.md', target, deps as any, sender as any);
            results.push({ name: 'folderViewMoveIntoMd', removed: !fs.existsSync(path.join(s.root, 'main.md')) });
            s.cleanup();
        }
        // ② folderViewMoveFromMd
        {
            const s = setup();
            const { deps } = makeMoveDeps();
            const { sender } = makeSender();
            fs.mkdirSync(path.join(s.noteDir, 'files'), { recursive: true });
            fs.writeFileSync(path.join(s.noteDir, 'files', 'att.pdf'), 'ATT', 'utf8');
            const srcMd = path.join(s.noteDir, 'doc.md');
            fs.writeFileSync(srcMd, '# Doc\n[📎 att.pdf](files/att.pdf)\n', 'utf8');
            await s.mod.folderViewMoveFromMd(s.m, s.id, '',
                { href: 'files/att.pdf', sourceMdPath: srcMd }, deps as any, sender as any);
            results.push({ name: 'folderViewMoveFromMd', removed: !fs.existsSync(path.join(s.noteDir, 'files', 'att.pdf')) });
            s.cleanup();
        }
        // ③ folderViewMove
        {
            const s = setup();
            const { deps } = makeMoveDeps();
            const { sender } = makeSender();
            fs.mkdirSync(path.join(s.root, 'sub1'), { recursive: true });
            fs.mkdirSync(path.join(s.root, 'sub2'), { recursive: true });
            fs.writeFileSync(path.join(s.root, 'sub1', 'a.md'), '# A\n', 'utf8');
            await s.mod.folderViewMove(s.m, s.id, 'sub1/a.md', 'sub2', deps as any, sender as any, deps as any);
            results.push({ name: 'folderViewMove', removed: !fs.existsSync(path.join(s.root, 'sub1', 'a.md')) });
            s.cleanup();
        }

        for (const r of results) {
            expect(r.removed, `${r.name} の source 削除が実行経路から外れた（過剰適用）`).toBe(true);
        }
        expect(results.length, '検査した経路数').toBe(3);
        void routes;
    });
});

test.describe('NFR-DCP-03: JSDoc の語彙訂正', () => {
    test('TC-DCP-12 2 関数の JSDoc に「移動」を説明する語が残っていない', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'shared', 'notes-message-handler.ts'), 'utf8');
        const lines = src.split('\n');
        const banned = /移動|move semantics|元を trash|source を削除|元実体を削除|台帳から除去/;

        for (const fn of ['export async function folderViewMoveToTree', 'export async function folderViewMoveIn(']) {
            const at = lines.findIndex((l) => l.startsWith(fn));
            expect(at, `${fn} が見つからない（改名された？ NFR-DCP-03 は改名を禁止している）`).toBeGreaterThan(-1);
            // 直上の JSDoc ブロックを遡って取る
            let end = at - 1;
            while (end >= 0 && !lines[end].trim().endsWith('*/')) { end -= 1; }
            let start = end;
            while (start >= 0 && !lines[start].trim().startsWith('/**')) { start -= 1; }
            expect(start, `${fn} の直上に JSDoc が無い`).toBeGreaterThan(-1);
            const doc = lines.slice(start, end + 1);
            const hits = doc.filter((l) => banned.test(l));
            expect(hits, `${fn} の JSDoc に移動を説明する語が残っている:\n${hits.join('\n')}`).toEqual([]);
            // 複製であることが読み取れる（空にして逃げていない）
            expect(doc.some((l) => l.includes('複製')), `${fn} の JSDoc が複製と言っていない`).toBe(true);
        }

        // 型名は温存されている（挙動説明語ではないため改名しない）
        expect(src.includes('FolderMoveDeps'), '型名 FolderMoveDeps が改名された').toBe(true);
    });
});
