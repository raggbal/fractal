/**
 * TASK-26（host 層）— linkedfd →「Outliner に送る」の取り込み経路
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-SND-01/02 / §6-1）
 *
 * TC-SND-02（フォルダ構造の再現）/ TC-SND-03（closure 抑止が同一経路）/
 * TC-SND-06（上限・集計通知）/ TC-SND-14（ファイル + フォルダ混在）。
 *
 * webview 層（root 先頭挿入の順序 / 対象決定 / snapshot 1 回）は
 * `test/specs/send-to-outliner.spec.ts` が担う。
 */
import { test, expect } from '@playwright/test';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { makeImportFolderFixture, makeDestNote } from '../utils/fixture-import-folder';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../../src/shared/folder-import');

/** entries 木を平坦化して `<path>/<kind>:<name>` にする。 */
function flatten(entries: any[], prefix = ''): string[] {
    const out: string[] = [];
    for (const e of entries) {
        out.push(`${prefix}${e.kind}:${e.name}`);
        if (e.kind === 'dir') { out.push(...flatten(e.children, `${prefix}${e.name}/`)); }
    }
    return out;
}

function makeDeps(destDir: string, roots: string[], opts?: { confirm?: boolean }) {
    const calls = { confirm: [] as number[], limit: [] as string[], skipped: [] as number[] };
    return {
        calls,
        deps: {
            roots,
            confirmLarge: (n: number) => { calls.confirm.push(n); return opts?.confirm !== false; },
            notifyLimitExceeded: (e: string) => { calls.limit.push(e); },
            notifySkipped: (n: number) => { calls.skipped.push(n); },
            pageDir: path.join(destDir, 'pages'),
            imageDir: path.join(destDir, 'images'),
            fileDir: path.join(destDir, 'files'),
            outDir: destDir,
        },
    };
}

test.describe('TC-SND-02/03 フォルダを送る（Import folder と同一経路）', () => {
    test('TC-SND-02 選んだフォルダ自身が node になり構造が子 node で再現される', async () => {
        const fx = makeImportFolderFixture('deep');
        const dest = makeDestNote();
        try {
            const { deps } = makeDeps(dest.dir, [fx.target]);
            const outcome = await fi.runSendToOutliner(deps);
            expect(outcome.status).toBe('imported');
            const flat = flatten(outcome.entries);
            // 選んだフォルダ自身（fixture の target = docs）が root 相当の dir entry
            expect(outcome.entries.length, 'root entry が 1 件でない').toBe(1);
            expect(outcome.entries[0].kind).toBe('dir');
            expect(outcome.entries[0].name, '選んだフォルダ自身が node になっていない').toBe(path.basename(fx.target));
            // 中間 dir 3 段が再現される
            for (const seg of ['dir:deep', 'dir:a', 'dir:b']) {
                expect(flat.some((x) => x.endsWith(seg)), `${seg} が無い`).toBe(true);
            }
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-SND-03 closure 抑止が Import folder と同じ結果になる', async () => {
        const fx = makeImportFolderFixture('basic');
        const destSend = makeDestNote();
        const destImport = makeDestNote();
        try {
            // 送る経路
            const { deps } = makeDeps(destSend.dir, [fx.target]);
            const sent = await fi.runSendToOutliner(deps);
            // Import folder 経路
            const imported = await fi.runFolderImport({
                pickFolder: () => fx.target,
                confirmLarge: () => true,
                notifyLimitExceeded: () => { /* noop */ },
                notifySkipped: () => { /* noop */ },
                pageDir: path.join(destImport.dir, 'pages'),
                imageDir: path.join(destImport.dir, 'images'),
                fileDir: path.join(destImport.dir, 'files'),
                outDir: destImport.dir,
            });

            // ⚠️ pageId は uuid なので name/kind/階層で比較する
            expect(flatten(sent.entries), '送る経路と Import folder で node 木が違う（closure 抑止が二重実装）')
                .toEqual(flatten(imported.entries));
            // closure の実体に node ができていない
            const flat = flatten(sent.entries);
            expect(flat.some((x) => x.endsWith('dir:files')), 'closure だけの files/ に node ができた').toBe(false);
            expect(flat.some((x) => x.endsWith('file:spec.pdf')), 'closure の spec.pdf に node ができた').toBe(false);
            expect(flat.some((x) => x.endsWith('dir:images')), 'closure 外を持つ images/ の node が無い').toBe(true);
        } finally { fx.cleanup(); destSend.cleanup(); destImport.cleanup(); }
    });
});

test.describe('TC-SND-14 ファイル + フォルダ混在（US-207 の代表シナリオ）', () => {
    test('選択順に dir entry と file entry が並び、ファイルは親 dir node で包まれない', async () => {
        const fx = makeImportFolderFixture('basic');
        const dest = makeDestNote();
        try {
            // linkedfd に単体ファイルを置く（fixture の target の隣）
            const memo = path.join(path.dirname(fx.target), 'memo.txt');
            fs.writeFileSync(memo, 'MEMO', 'utf8');

            // 選択順 = [docs/（フォルダ）, memo.txt（ファイル）]
            const { deps } = makeDeps(dest.dir, [fx.target, memo]);
            const outcome = await fi.runSendToOutliner(deps);
            expect(outcome.status).toBe('imported');

            // 1. 選択順で並ぶ
            expect(outcome.entries.map((e: any) => `${e.kind}:${e.name}`),
                `選択順が崩れている: ${JSON.stringify(outcome.entries.map((e: any) => e.name))}`)
                .toEqual([`dir:${path.basename(fx.target)}`, 'file:memo.txt']);
            // 2. ファイルは親 dir で包まれない（親フォルダの node を作らない）
            expect(outcome.entries[1].kind, 'ファイルが dir でラップされた').toBe('file');
            // 3. closure 抑止はフォルダ側だけに効き、ファイルは素通し
            const flat = flatten(outcome.entries);
            expect(flat.some((x) => x.endsWith('dir:files')), 'closure だけの files/ に node ができた').toBe(false);
            // 実体が dest に届いている
            expect(fs.existsSync(path.join(dest.dir, 'files', 'memo.txt')), 'memo.txt の実体が無い').toBe(true);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('md ファイル単体を送ると page 添付 node になり随伴資産も複製される', async () => {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-md-'));
        const dest = makeDestNote();
        try {
            fs.mkdirSync(path.join(src, 'images'), { recursive: true });
            fs.writeFileSync(path.join(src, 'images', 'p.png'), 'PNG', 'utf8');
            const md = path.join(src, 'note.md');
            fs.writeFileSync(md, '# Note\n![p](images/p.png)\n', 'utf8');

            const { deps } = makeDeps(dest.dir, [md]);
            const outcome = await fi.runSendToOutliner(deps);
            expect(outcome.entries.length).toBe(1);
            expect(outcome.entries[0].kind, 'md が md entry になっていない').toBe('md');
            expect(outcome.entries[0].pageId, 'pageId が無い').toBeTruthy();
            // 随伴資産（画像）が複製されている
            const pageAbs = path.join(dest.dir, 'pages', `${outcome.entries[0].pageId}.md`);
            expect(fs.existsSync(pageAbs), 'page md が無い').toBe(true);
            const body = fs.readFileSync(pageAbs, 'utf8');
            const m = /!\[[^\]]*\]\(([^)\s]+)\)/.exec(body);
            expect(m, '画像参照が消えた').toBeTruthy();
            const abs = path.resolve(path.dirname(pageAbs), decodeURIComponent(m![1]));
            expect(fs.existsSync(abs), `リンク切れ: ${m![1]}`).toBe(true);
        } finally {
            fs.rmSync(src, { recursive: true, force: true });
            dest.cleanup();
        }
    });
});

test.describe('TC-SND-06 上限と部分失敗（NFR-MSEL-02/03）', () => {
    test('200 超で確認 modal / キャンセルで 0 件', async () => {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-many-'));
        const dest = makeDestNote();
        try {
            for (let i = 0; i < 201; i++) { fs.writeFileSync(path.join(src, `f${i}.txt`), 'x', 'utf8'); }
            const { deps, calls } = makeDeps(dest.dir, [src], { confirm: false });
            const outcome = await fi.runSendToOutliner(deps);
            expect(calls.confirm, `modal が出ていない / 件数が違う: ${calls.confirm.join(',')}`).toEqual([201]);
            // キャンセル = 取り込まない（entries 0 件）
            expect(outcome.entries.length, 'キャンセルなのに取り込まれた').toBe(0);
            // makeDestNote が空の files/ を先に作るので **中身**で見る
            expect(fs.readdirSync(path.join(dest.dir, 'files')), 'キャンセルなのに実体が作られた').toEqual([]);
        } finally { fs.rmSync(src, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('2001 件は列挙段階で中断（コピー 0 + 上限通知 1 回）', async () => {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-over-'));
        const dest = makeDestNote();
        try {
            for (let i = 0; i < 2001; i++) { fs.writeFileSync(path.join(src, `f${i}.txt`), 'x', 'utf8'); }
            const { deps, calls } = makeDeps(dest.dir, [src]);
            const outcome = await fi.runSendToOutliner(deps);
            expect(outcome.status).toBe('aborted');
            expect(outcome.entries.length, '中断なのに取り込まれた').toBe(0);
            expect(calls.limit, `上限通知が 1 回でない: ${calls.limit.join(',')}`).toEqual(['too_many']);
            expect(fs.readdirSync(path.join(dest.dir, 'files')), '中断なのに実体が作られた').toEqual([]);
        } finally { fs.rmSync(src, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('個別失敗は skip して続行し集計通知が 1 回だけ（複数 root でも 1 回）', async () => {
        const src = fs.mkdtempSync(path.join(os.tmpdir(), 'snd-skip-'));
        const dest = makeDestNote();
        try {
            // 読めないファイルを 2 つの root にまたがって置く
            fs.mkdirSync(path.join(src, 'd1'), { recursive: true });
            fs.mkdirSync(path.join(src, 'd2'), { recursive: true });
            for (const d of ['d1', 'd2']) {
                fs.writeFileSync(path.join(src, d, 'ok.txt'), 'OK', 'utf8');
                const bad = path.join(src, d, 'bad.bin');
                fs.writeFileSync(bad, 'BAD', 'utf8');
                fs.chmodSync(bad, 0o000);
            }
            let readable = true;
            try { fs.readFileSync(path.join(src, 'd1', 'bad.bin')); } catch { readable = false; }
            if (readable) { test.skip(true, 'chmod 000 が効かない環境（root 実行）'); }

            const { deps, calls } = makeDeps(dest.dir, [path.join(src, 'd1'), path.join(src, 'd2')]);
            const outcome = await fi.runSendToOutliner(deps);
            expect(outcome.status).toBe('imported');
            // 読めた分は取り込まれている
            const flat = flatten(outcome.entries);
            expect(flat.filter((x) => x.endsWith('file:ok.txt')).length, 'ok.txt が両方取り込まれていない').toBe(2);
            // NFR-MSEL-03: **root ごとではなく全体で 1 回**
            expect(calls.skipped.length, `集計通知が ${calls.skipped.length} 回（1 回であるべき）`).toBe(1);
            expect(calls.skipped[0], 'skip 件数が合算されていない').toBe(2);
        } finally {
            for (const d of ['d1', 'd2']) {
                try { fs.chmodSync(path.join(src, d, 'bad.bin'), 0o644); } catch { /* ignore */ }
            }
            fs.rmSync(src, { recursive: true, force: true });
            dest.cleanup();
        }
    });
});

test.describe('TC-SND-09 既存物を 1 バイトも上書きしない（送る経路 / TASK-31）', () => {
    /**
     * FR-SND-03: `runSendNodesToFolderLink` は Export folder と同一の `runFolderExport` を通すので
     * uniquify / 既存不変は `TC-EXF-10` / `TC-EXF-16`（`test/unit/folder-export-plan.spec.ts`）が
     * 守っている。ただし **`pickDestinationOverride` で宛先を固定する経路は本 sprint の新規**なので、
     * 「宛先固定化のときに uniquify を迂回していない」ことをこの経路で 1 本踏む
     * （reviewer iteration 1 LEDG-1: 代替番人がどれか明示されていなかった）。
     */
    test('folder link root に同名の file / dir があっても既存が sha256 で不変・送った分は -N 退避', async () => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Module = require('module');
        const origLoad = Module._load;
        const SRCP = path.join(__dirname, '..', '..', 'src') + path.sep;
        const purge = () => { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRCP)) { delete require.cache[k]; } } };
        purge();
        const shown: string[] = [];
        Module._load = function (request: string) {
            if (request === 'vscode') {
                return {
                    workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                    Uri: { file: (p2: string) => ({ fsPath: p2 }), joinPath: () => ({}) },
                    commands: { executeCommand: () => {} },
                    window: {
                        showErrorMessage: (m: string) => { shown.push(m); },
                        showInformationMessage: () => {},
                        showWarningMessage: () => undefined,   // 確認 modal = キャンセル相当（200 以下なので出ない）
                        showOpenDialog: async () => { throw new Error('dialog は出てはいけない（宛先固定のはず）'); },
                    },
                    env: {}, ViewColumn: {}, EventEmitter: class {},
                };
            }
            // eslint-disable-next-line prefer-rest-params
            return origLoad.apply(this, arguments as any);
        };
        let feh: any;
        try { feh = require('../../src/shared/folder-export-host'); } finally { Module._load = origLoad; }

        const note = fs.mkdtempSync(path.join(os.tmpdir(), 'snd09-note-'));
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'snd09-fl-'));
        try {
            fs.mkdirSync(path.join(note, 'pages'), { recursive: true });
            fs.mkdirSync(path.join(note, 'files'), { recursive: true });
            fs.mkdirSync(path.join(note, 'images'), { recursive: true });

            // 出力先に「送る対象と同名の既存物」を先に置く（file と dir の両型）
            fs.writeFileSync(path.join(dest, 'Leaf.md'), 'PRE-EXISTING-FILE', 'utf8');
            fs.mkdirSync(path.join(dest, 'Parent'), { recursive: true });
            fs.writeFileSync(path.join(dest, 'Parent', 'keep.txt'), 'PRE-EXISTING-IN-DIR', 'utf8');
            const shaFile = crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, 'Leaf.md'))).digest('hex');
            const shaInDir = crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, 'Parent', 'keep.txt'))).digest('hex');

            // 子なし node = `<text>.md` / 子あり node = フォルダ（FR-EXF-02）
            const tree = [
                { id: 'l', text: 'Leaf', subtext: '', pageId: null, filePath: null, images: [], children: [] },
                { id: 'p', text: 'Parent', subtext: '', pageId: null, filePath: null, images: [],
                    children: [{ id: 'c', text: 'Child', subtext: '', pageId: null, filePath: null, images: [], children: [] }] },
            ];
            const outcome = await feh.runSendNodesToFolderLink({
                tree,
                srcOutDir: note,
                srcPagesDir: path.join(note, 'pages'),
                srcFileDir: path.join(note, 'files'),
                srcImageDir: path.join(note, 'images'),
                destRoot: dest,
            });
            expect(outcome.status, `送信が失敗した: ${shown.join(' / ')}`).toBe('exported');

            // ★ 既存物が 1 バイトも変わらない
            expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, 'Leaf.md'))).digest('hex'),
                '既存 file が上書きされた').toBe(shaFile);
            expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(dest, 'Parent', 'keep.txt'))).digest('hex'),
                '既存 dir の中身が上書き / マージされた').toBe(shaInDir);

            // ★ 送った分は -N 退避されている（uniquify を迂回していない）
            const names = fs.readdirSync(dest).sort();
            expect(names.some((n) => /^Leaf-\d+\.md$/.test(n)),
                `送った md が -N 退避されていない: ${names.join(', ')}`).toBe(true);
            expect(names.some((n) => /^Parent-\d+$/.test(n) && fs.statSync(path.join(dest, n)).isDirectory()),
                `送った dir が -N 退避されていない: ${names.join(', ')}`).toBe(true);
        } finally {
            purge();
            fs.rmSync(note, { recursive: true, force: true });
            fs.rmSync(dest, { recursive: true, force: true });
        }
    });
});

/**
 * TC-SND-06b — 複数 root の**合計**で件数上限を判定する（TASK-36 / reviewer iteration 2 QUAL2-1）
 *
 * 🔴 iteration 2 の欠陥: `runSendToOutliner` は root ごとに `runFolderImport` を呼ぶため
 * **各 root の件数でしか閾値判定せず、合計が閾値を跨いでも素通り**していた
 * （実測: 3 root × 150 件 = 450 件が確認 modal なしで取り込まれた）。
 * 逆方向（`runFolderExport`）は `countEntries(tree)` で全体合算しており非対称だった。
 */
test.describe('TC-SND-06b 複数 root の合計で件数判定（NFR-MSEL-02）', () => {
    /** N 個の root（各 count 件）を作る。 */
    function makeRoots(base: string, n: number, count: number): string[] {
        const roots: string[] = [];
        for (let d = 0; d < n; d++) {
            const r = path.join(base, `d${d}`);
            fs.mkdirSync(r, { recursive: true });
            for (let i = 0; i < count; i++) { fs.writeFileSync(path.join(r, `f${i}.txt`), 'x', 'utf8'); }
            roots.push(r);
        }
        return roots;
    }

    function runWith(dest: string, roots: string[], opts?: { confirm?: boolean }) {
        const calls = { confirm: [] as number[], limit: [] as string[], skipped: [] as number[] };
        return {
            calls,
            run: () => fi.runSendToOutliner({
                roots,
                confirmLarge: (n: number) => { calls.confirm.push(n); return opts?.confirm !== false; },
                notifyLimitExceeded: (e: string) => { calls.limit.push(e); },
                notifySkipped: (n: number) => { calls.skipped.push(n); },
                pageDir: path.join(dest, 'pages'), imageDir: path.join(dest, 'images'),
                fileDir: path.join(dest, 'files'), outDir: dest,
            }),
        };
    }

    test('3 root × 150 件 = 450 件で確認 modal が 1 回だけ出る（root ごとに出ない）', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snd06b-'));
        const dest = makeDestNote();
        try {
            const roots = makeRoots(base, 3, 150);
            const { calls, run } = runWith(dest.dir, roots, { confirm: true });
            const outcome = await run();

            // ★ 合計 450 件で 1 回だけ modal（root 単位判定なら 0 回になる）
            expect(calls.confirm, `modal の呼び出しが期待どおりでない: ${JSON.stringify(calls.confirm)}`)
                .toEqual([450]);
            expect(outcome.status).toBe('imported');
            expect(fs.readdirSync(path.join(dest.dir, 'files')).length, '続行したのに全件入っていない').toBe(450);
        } finally { fs.rmSync(base, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('3 root × 150 件でキャンセルすると 0 件処理（部分実行しない）', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snd06b-c-'));
        const dest = makeDestNote();
        try {
            const roots = makeRoots(base, 3, 150);
            const { calls, run } = runWith(dest.dir, roots, { confirm: false });
            const outcome = await run();

            expect(calls.confirm, 'modal が 1 回でない').toEqual([450]);
            expect(outcome.entries.length, 'キャンセルなのに取り込まれた').toBe(0);
            expect(fs.readdirSync(path.join(dest.dir, 'files')), 'キャンセルなのに実体が作られた').toEqual([]);
        } finally { fs.rmSync(base, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('3 root × 700 件 = 2100 件は中断（0 件処理）+ 上限通知 1 回', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snd06b-o-'));
        const dest = makeDestNote();
        try {
            const roots = makeRoots(base, 3, 700);
            const { calls, run } = runWith(dest.dir, roots);
            const outcome = await run();

            expect(outcome.status, '合計 2100 件で中断されていない').toBe('aborted');
            expect(calls.limit, `上限通知が 1 回でない: ${calls.limit.join(',')}`).toEqual(['too_many']);
            expect(calls.confirm.length, '上限超過で modal が出た').toBe(0);
            expect(fs.readdirSync(path.join(dest.dir, 'files')), '中断なのに実体が作られた').toEqual([]);
        } finally { fs.rmSync(base, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('各 root が 200 件超でも modal は 1 回だけ（root ごとに複数回出ない）', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snd06b-m-'));
        const dest = makeDestNote();
        try {
            const roots = makeRoots(base, 2, 210);   // 各 210 件（どちらも単独で閾値超え）
            const { calls, run } = runWith(dest.dir, roots, { confirm: true });
            await run();
            expect(calls.confirm.length,
                `modal が ${calls.confirm.length} 回出た（合計 1 回であるべき）`).toBe(1);
            expect(calls.confirm[0], '合計件数で聞いていない').toBe(420);
        } finally { fs.rmSync(base, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('ファイル単体を含む混在でも合計に数える', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'snd06b-x-'));
        const dest = makeDestNote();
        try {
            const roots = makeRoots(base, 1, 199);
            // 単体ファイル 2 件を足して合計 201 件（= 閾値超え）
            for (const n of ['solo1.txt', 'solo2.txt']) {
                const f = path.join(base, n);
                fs.writeFileSync(f, 'x', 'utf8');
                roots.push(f);
            }
            const { calls, run } = runWith(dest.dir, roots, { confirm: true });
            await run();
            expect(calls.confirm, 'dir 199 + file 2 = 201 件で modal が出ていない').toEqual([201]);
        } finally { fs.rmSync(base, { recursive: true, force: true }); dest.cleanup(); }
    });
});


/**
 * TC-SND-15（再オープン 2026-09-03 / TASK-46 / FR-SND-01 追加受け入れ条件）— `.out` 未オープンなら通知 1 回・取り込み 0
 *
 * 初版の host は currentFile が `.out` でないとき無通知で早期 return し「無反応」に見えた。
 * 判定は vscode 非依存の `resolveSendToOutlinerTarget`（folder-import-host.ts）に置き、provider はその結果で
 * 通知 / 続行を分ける。provider 本体は巨大クロージャで behavioral 起動不能（TC-MSEL-26b と同じ制約）なので
 * (a) helper の挙動 と (b) provider の配線（source pin: helper を呼び・通知し・取り込みを呼ばない）を pin する。
 */
const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    const purge = () => { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; } } };
    purge();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return { window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {}, showOpenDialog: async () => undefined },
                workspace: { getConfiguration: () => ({ get: () => undefined }) }, Uri: { file: (p: string) => ({ fsPath: p }) } };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purge(); }
}

test.describe('TC-SND-15 「Outliner に送る」の前提検査（.out 未オープン）', () => {
    test('(a) resolveSendToOutlinerTarget: md / 未オープンは no_outline、.out は ok', () => {
        const host = requireWithVscodeStub('../../src/shared/folder-import-host');
        expect(host.resolveSendToOutlinerTarget(null)).toEqual({ ok: false, reason: 'no_outline' });
        expect(host.resolveSendToOutlinerTarget(undefined)).toEqual({ ok: false, reason: 'no_outline' });
        expect(host.resolveSendToOutlinerTarget('/n/a.md')).toEqual({ ok: false, reason: 'no_outline' });
        expect(host.resolveSendToOutlinerTarget('/n/o.OUT')).toEqual({ ok: true, outPath: '/n/o.OUT' });
        expect(host.resolveSendToOutlinerTarget('/n/o.out')).toEqual({ ok: true, outPath: '/n/o.out' });
    });

    test('(b) provider: sendFolderViewToOutliner が helper で判定し、未オープンなら sendToOutlinerNoOutline を 1 回通知して取り込みを呼ばない（source pin）', () => {
        const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'notesEditorProvider.ts'), 'utf8');
        const at = src.indexOf('sendFolderViewToOutliner: async');
        expect(at, 'sendFolderViewToOutliner が provider に無い').toBeGreaterThan(-1);
        const win = src.slice(at, at + 2500);
        const helperAt = win.indexOf('resolveSendToOutlinerTarget(');
        const runAt = win.indexOf('runSendToOutlinerWithDialogs(');
        expect(helperAt, 'helper を呼んでいない（無通知の早期 return のまま）').toBeGreaterThan(-1);
        expect(runAt).toBeGreaterThan(-1);
        expect(helperAt, 'helper の判定が取り込み呼び出しより後にある').toBeLessThan(runAt);
        expect(win.includes("t('sendToOutlinerNoOutline')"), '未オープン通知の i18n key を使っていない').toBe(true);
        // 旧形（無通知の早期 return）が残っていない
        expect(/currentOutFilePath\.endsWith\('\.out'\)\)\s*\{\s*return;\s*\}/.test(win), '無通知の早期 return が残っている').toBe(false);
    });
});
