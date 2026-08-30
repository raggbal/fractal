/**
 * Sprint 20260827-172802-outliner-import-fdview-dnd-assets TASK-03 — A: Import folder のコピー統合
 * FR-OIF-02/04・NFR-OIF-01。runFolderImport（deps 注入 seam）を実 fs tmpdir + core spy で検証。
 *
 * seam の理由: showOpenDialog / 確認 modal / 失敗通知 は VS Code 依存、コピーは既存 core
 * （importMdFilesCore / importFilesCore）流用。orchestration を deps 注入 export に切り出すことで
 * 「上限超過なら core を 1 度も呼ばない」「キャンセルは完全 no-op」を behavioral に踏める
 * （designer_failures 2026-08-07: counterfactual TC を要求する箇所には seam を先に切る）。
 *
 * TC-OIF-03（コピー統合）/ TC-OIF-03b（NFR-OIF-01 定量）/ TC-OIF-05（200 超確認）/
 * TC-OIF-07（上限超過）/ TC-OIF-08（キャンセル）+ 配線 pin（notes-message-handler の委譲）。
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

/** tmp note（pages/ + pages/images/ + files/。outDir = note dir = .out と同階層の想定） */
function makeNote(prefix: string) {
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const pageDir = path.join(noteDir, 'pages');
    const imageDir = path.join(pageDir, 'images');
    const fileDir = path.join(noteDir, 'files');
    fs.mkdirSync(imageDir, { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });
    return { noteDir, pageDir, imageDir, fileDir, outDir: noteDir };
}

function makeDeps(
    note: ReturnType<typeof makeNote>,
    root: string | undefined,
    opts?: { confirm?: boolean; limits?: { maxFiles?: number; maxDepth?: number; confirmThreshold?: number } }
) {
    const mdMod = requireWithVscodeStub('../../src/shared/markdown-import');
    const fileMod = requireWithVscodeStub('../../src/shared/file-import');
    const calls = {
        pick: 0, confirm: [] as number[], limit: [] as string[], skipped: [] as number[],
        md: 0, file: 0,
    };
    const deps = {
        pickFolder: () => { calls.pick++; return root; },
        confirmLarge: (total: number) => { calls.confirm.push(total); return opts?.confirm ?? true; },
        notifyLimitExceeded: (error: string) => { calls.limit.push(error); },
        notifySkipped: (n: number) => { calls.skipped.push(n); },
        pageDir: note.pageDir, imageDir: note.imageDir, fileDir: note.fileDir, outDir: note.outDir,
        // core は spy でラップ（上限超過時に「1 度も呼ばれない」を実測するため）
        importMd: (items: any[], pageDir: string, imageDir: string) => {
            calls.md++; return mdMod.importMdFilesCore(items, pageDir, imageDir);
        },
        importFile: (items: any[], fileDir: string, outDir: string) => {
            calls.file++; return fileMod.importFilesCore(items, fileDir, outDir);
        },
        limits: opts?.limits,
    };
    return { deps, calls };
}

/** ディレクトリ木の指紋（元フォルダ不変の assert 用。chmod 000 でも stat は取れる） */
function snapshot(dir: string): string[] {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
        const ents = fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
        for (const e of ents) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { out.push(`d ${r}`); walk(path.join(d, e.name), r); }
            else { out.push(`f ${r} ${fs.statSync(path.join(d, e.name)).size}`); }
        }
    };
    walk(dir, '');
    return out;
}

const countFiles = (dir: string): number => fs.readdirSync(dir).filter((n) => n !== 'images').length;

test.describe('FR-OIF-02/04: Import folder のコピー統合（runFolderImport）', () => {

    test('TC-OIF-03: md→pages/・file→files/ uniquify・読取不能は skip 集計・元フォルダ不変', async () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-import');
        const note = makeNote('fic-note-');
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'fic-src-'));
        fs.mkdirSync(path.join(src, 'sub'));
        fs.writeFileSync(path.join(src, 'sub', 'b.md'), '# Bravo\n');
        fs.writeFileSync(path.join(src, 'sub', 'note.txt'), 'TXT');
        fs.writeFileSync(path.join(src, 'a.md'), '# Alpha\n');
        fs.writeFileSync(path.join(src, 'report.pdf'), 'NEW');
        // files/ に同名既存 → uniquify されること
        fs.writeFileSync(path.join(note.fileDir, 'report.pdf'), 'EXISTING');
        // 読取不能な 1 ファイル（fixture 前提を明示 assert する: root 実行では成立しない）
        const locked = path.join(src, 'locked.bin');
        fs.writeFileSync(locked, 'SECRET');
        fs.chmodSync(locked, 0o000);
        let lockedReadable = true;
        try { fs.readFileSync(locked); } catch { lockedReadable = false; }
        expect(lockedReadable, 'fixture 前提: chmod 000 が読取不能（root 実行では成立しない）').toBe(false);

        const before = snapshot(src);
        const { deps, calls } = makeDeps(note, src);
        const res = await mod.runFolderImport(deps as any);

        expect(res.status, '取り込み実行').toBe('imported');
        expect(res.skipped, '読取不能 1 件が skip 集計').toBe(1);
        expect(calls.skipped, 'skip 通知 1 回（件数付き）').toEqual([1]);
        expect(calls.confirm, '200 以下なので確認 modal なし').toHaveLength(0);

        // 仕様変更 2026-08-29（ユーザー裁定）: **選んだフォルダ自身も node にする**ので、
        // 最上位は選択フォルダ 1 個の dir entry になり、その children が中身になる
        expect(res.entries.map((e: any) => `${e.kind}:${e.name}`))
            .toEqual([`dir:${path.basename(src)}`]);
        const root = res.entries[0];
        expect(root.children.map((e: any) => `${e.kind}:${e.name}`), 'walk 順（フォルダ先行 → 名前昇順）')
            .toEqual(['dir:sub', 'md:a.md', 'file:report.pdf']);
        expect(JSON.stringify(res.entries), '読取不能ファイルは entries に載らない').not.toContain('locked.bin');

        const sub = root.children[0];
        expect(sub.children.map((e: any) => `${e.kind}:${e.name}`)).toEqual(['md:b.md', 'file:note.txt']);

        // md: pages/<pageId>.md 実体 + entry の pageId が一致
        const aMd = root.children[1];
        const bMd = sub.children[0];
        for (const [entry, needle] of [[aMd, 'Alpha'], [bMd, 'Bravo']] as Array<[any, string]>) {
            expect(typeof entry.pageId, 'md entry は pageId を持つ').toBe('string');
            const pagePath = path.join(note.pageDir, `${entry.pageId}.md`);
            expect(fs.existsSync(pagePath), `pages/${entry.pageId}.md 実体`).toBe(true);
            expect(fs.readFileSync(pagePath, 'utf8'), '本文が移送される').toContain(needle);
        }
        expect(aMd.pageId).not.toBe(bMd.pageId);

        // file: uniquify コピー + outDir 相対 filePath
        const pdf = root.children[2];
        expect(pdf.filePath, 'uniquify 連番で outDir 相対').toBe('files/report-1.pdf');
        expect(fs.readFileSync(path.join(note.fileDir, 'report-1.pdf'), 'utf8')).toBe('NEW');
        expect(fs.readFileSync(path.join(note.fileDir, 'report.pdf'), 'utf8'), '既存は無傷').toBe('EXISTING');
        const txt = sub.children[1];
        expect(txt.filePath).toBe('files/note.txt');
        expect(fs.readFileSync(path.join(note.fileDir, 'note.txt'), 'utf8')).toBe('TXT');

        // ADRL-0103: 実体は note へ「コピー」— 元フォルダは 1 バイトも変わらない
        expect(snapshot(src), '元フォルダ不変').toEqual(before);
    });

    test('TC-OIF-03b: 200 エントリ相当 fixture の実行時間 < 10s（NFR-OIF-01 定量 FIT-1）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-import');
        const note = makeNote('ficperf-note-');
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ficperf-src-'));
        for (let d = 0; d < 10; d++) {
            const dir = path.join(src, `d${d}`);
            fs.mkdirSync(dir);
            for (let i = 0; i < 10; i++) { fs.writeFileSync(path.join(dir, `m${i}.md`), `# doc ${d}-${i}\n`); }
            for (let i = 0; i < 10; i++) { fs.writeFileSync(path.join(dir, `f${i}.bin`), `data-${d}-${i}`); }
        }
        const { deps } = makeDeps(note, src); // 210 エントリ → confirm=true 既定

        const started = Date.now();
        const res = await mod.runFolderImport(deps as any);
        const elapsed = Date.now() - started;

        expect(res.status).toBe('imported');
        expect(res.skipped).toBe(0);
        expect(res.entries, '最上位は選択フォルダ 1 個').toHaveLength(1);
        const perfRoot = res.entries[0];
        expect(perfRoot.children).toHaveLength(10);
        expect(perfRoot.children.reduce((n: number, e: any) => n + e.children.length, 0), '200 ファイル分の entry').toBe(200);
        expect(countFiles(note.pageDir), 'md 100 本が pages/ へ').toBe(100);
        expect(countFiles(note.fileDir), 'file 100 本が files/ へ').toBe(100);
        expect(elapsed, `210 エントリ取り込みが 10s 未満（実測 ${elapsed}ms）`).toBeLessThan(10000);
    });

    test('TC-OIF-09: 読めない dir の消失分も skipped に合算して通知する（reviewer SECGOV-1）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-import');
        const note = makeNote('ficdir-note-');
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ficdir-src-'));
        fs.writeFileSync(path.join(src, 'ok.md'), '# ok\n');
        const locked = path.join(src, 'locked');
        fs.mkdirSync(locked);
        fs.writeFileSync(path.join(locked, 'inner.txt'), 'HIDDEN');
        fs.chmodSync(locked, 0o000);
        let listable = true;
        try { fs.readdirSync(locked); } catch { listable = false; }
        expect(listable, 'fixture 前提: chmod 000 の dir が列挙不能（root 実行では成立しない）').toBe(false);

        const { deps, calls } = makeDeps(note, src);
        const res = await mod.runFolderImport(deps as any);

        expect(res.status, '読める分は取り込む（部分成功）').toBe('imported');
        expect(res.skipped, '読めなかった dir 1 件が skipped に載る').toBe(1);
        expect(calls.skipped, 'skip 通知が件数付きで 1 回').toEqual([1]);
        // 読める側は通常どおり取り込まれ、dir node 自体は空で再現される
        expect(res.entries, '最上位は選択フォルダ 1 個').toHaveLength(1);
        expect(res.entries[0].children.map((e: any) => `${e.kind}:${e.name}`)).toEqual(['dir:locked', 'md:ok.md']);
        expect(res.entries[0].children[0].children, '読めない dir の children は空').toEqual([]);
        expect(countFiles(note.pageDir), 'ok.md は pages/ へ').toBe(1);
    });

    test('TC-OIF-05: totalCount 201 で確認 modal → false で no-op / true で実行', async () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-import');
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'ficconf-src-'));
        for (let i = 0; i < 201; i++) {
            fs.writeFileSync(path.join(src, `f${String(i).padStart(3, '0')}.txt`), `x${i}`);
        }

        // false: コピー 0（core 未呼び出し・note 側 0 件）
        const noteA = makeNote('ficconf-noteA-');
        const a = makeDeps(noteA, src, { confirm: false });
        const declined = await mod.runFolderImport(a.deps as any);
        expect(a.calls.confirm, '閾値 200 超で件数付き確認').toEqual([201]);
        expect(declined.status).toBe('declined');
        expect(declined.entries, 'キャンセルで entries なし').toHaveLength(0);
        expect(a.calls.md + a.calls.file, 'コピー core を呼ばない').toBe(0);
        expect(countFiles(noteA.fileDir)).toBe(0);
        expect(countFiles(noteA.pageDir)).toBe(0);

        // true: 実行
        const noteB = makeNote('ficconf-noteB-');
        const b = makeDeps(noteB, src, { confirm: true });
        const imported = await mod.runFolderImport(b.deps as any);
        expect(b.calls.confirm).toEqual([201]);
        expect(imported.status).toBe('imported');
        expect(imported.entries, '最上位は選択フォルダ 1 個').toHaveLength(1);
        expect(imported.entries[0].children, '中身 201 件はその子').toHaveLength(201);
        expect(countFiles(noteB.fileDir), '201 件コピー').toBe(201);
    });

    test('TC-OIF-07: 上限超過（too_many / too_deep）は失敗通知 1 回・core 0 回・results なし', async () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-import');

        // too_many: maxFiles=1 に対しファイル 2 本
        const noteA = makeNote('ficlim-noteA-');
        const srcA = fs.mkdtempSync(path.join(os.tmpdir(), 'ficlim-srcA-'));
        fs.writeFileSync(path.join(srcA, 'a.md'), '# a\n');
        fs.writeFileSync(path.join(srcA, 'b.bin'), 'B');
        const a = makeDeps(noteA, srcA, { limits: { maxFiles: 1 } });
        const many = await mod.runFolderImport(a.deps as any);
        expect(many.status).toBe('aborted');
        expect(many.error).toBe('too_many');
        expect(a.calls.limit, '失敗通知は 1 回だけ').toEqual(['too_many']);
        expect(a.calls.md + a.calls.file, 'コピー core を 1 度も呼ばない').toBe(0);
        expect(many.entries, 'webview への results なし（entries 空）').toHaveLength(0);
        expect(a.calls.skipped, 'skip 通知もしない').toHaveLength(0);
        expect(countFiles(noteA.pageDir) + countFiles(noteA.fileDir), '原状不変（コピー 0）').toBe(0);

        // too_deep: maxDepth=2 に対し 3 階層
        const noteB = makeNote('ficlim-noteB-');
        const srcB = fs.mkdtempSync(path.join(os.tmpdir(), 'ficlim-srcB-'));
        fs.mkdirSync(path.join(srcB, 'x', 'y'), { recursive: true });
        fs.writeFileSync(path.join(srcB, 'x', 'y', 'deep.md'), '# deep\n');
        const b = makeDeps(noteB, srcB, { limits: { maxDepth: 2 } });
        const deep = await mod.runFolderImport(b.deps as any);
        expect(deep.status).toBe('aborted');
        expect(deep.error).toBe('too_deep');
        expect(b.calls.limit).toEqual(['too_deep']);
        expect(b.calls.md + b.calls.file).toBe(0);
        expect(deep.entries).toHaveLength(0);
        expect(countFiles(noteB.pageDir) + countFiles(noteB.fileDir)).toBe(0);
    });

    test('TC-OIF-08: フォルダ選択キャンセル = 完全 no-op（コピー・通知 0）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-import');
        const note = makeNote('fccancel-note-');
        // pickFolder が undefined を返す = walk 対象の root が存在しないので walk も構造的に 0 回
        const { deps, calls } = makeDeps(note, undefined);

        const res = await mod.runFolderImport(deps as any);

        expect(res.status).toBe('cancelled');
        expect(res.entries).toHaveLength(0);
        expect(res.skipped).toBe(0);
        expect(calls.pick, 'ダイアログは 1 回開く').toBe(1);
        expect(calls.confirm, '確認 modal なし').toHaveLength(0);
        expect(calls.limit, '失敗通知なし').toHaveLength(0);
        expect(calls.skipped, 'skip 通知なし').toHaveLength(0);
        expect(calls.md + calls.file, 'コピー core を呼ばない').toBe(0);
        expect(countFiles(note.pageDir) + countFiles(note.fileDir), 'note 側に何も書かない').toBe(0);
    });

    test('TASK-03 配線 pin: importFolderDialog message が platform へ委譲される', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const received: Array<[string | null, any]> = [];
        const sender = { postMessage: () => {} };
        const platform = {
            importFolderDialog: (targetNodeId: string | null, s: any) => { received.push([targetNodeId, s]); },
        };
        // この case は fileManager を参照しない（dialog + walk は platform 側）ため空 stub で足りる
        await mod.handleNotesMessage(
            { type: 'importFolderDialog', targetNodeId: 'node-7' }, {} as any, sender as any, platform as any
        );
        expect(received, 'targetNodeId と sender を素通しで委譲').toEqual([['node-7', sender]]);
    });
});
