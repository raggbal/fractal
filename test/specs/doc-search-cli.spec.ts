/**
 * doc-search-cli.spec.ts — CLI（fractal-search.mjs）の添付中身検索 + extension⇄CLI ミラー同期
 *
 * sprint 20260813-133248-search-doc-content / TASK-05(一致 TC 一次)・TASK-07(CLI 統合)・TASK-09(最終確定)。
 * design/system.md §6 / ADRL-0059(ミラー) / ADRL-0040(clamp) / testcases.md E・F 節。
 *
 * 検証対象:
 *  - TC-DS-26: extension⇄CLI 一致番人 — 全 OOXML fixture で正典 ts と ミラー mjs の lines 完全一致
 *  - TC-DS-38: CLI 側ソースの import 検査（node: builtins + 相対のみ = npm 依存 0）
 *  - TC-DS-21..25, 39: CLI 統合（TASK-07 で追加）
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { extractDocText } from '../../src/shared/doc-text-extract';

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'doc-search');
const MJS = path.join(ROOT, 'ai_skills', 'fractal-search', 'scripts', 'ooxml-extract.mjs');
const CLI = path.join(ROOT, 'ai_skills', 'fractal-search', 'scripts', 'fractal-search.mjs');
const VENDOR = path.join(ROOT, 'ai_skills', 'fractal-search', 'vendor', 'pdfjs-bundle.cjs');

/** note フォルダ fixture: outline.note の items 台帳 + files/ 実体 */
function mkNoteWithAttachments(attachments: Array<{ id: string; filename: string; title?: string; bytesFrom?: string }>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-cli-'));
    const filesDir = path.join(dir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    const items: Record<string, unknown> = {};
    const rootIds: string[] = [];
    for (const a of attachments) {
        items[a.id] = { type: 'file', ext: 'file', filename: a.filename, title: a.title || a.filename };
        rootIds.push(a.id);
        if (a.bytesFrom) {
            // traversal filename（../x 等）は files/ 外に書かず放置（clamp テストは実体不要）
            const safe = path.join(filesDir, a.filename);
            if (safe.startsWith(filesDir + path.sep)) {
                fs.mkdirSync(path.dirname(safe), { recursive: true });
                fs.copyFileSync(path.join(FIX, a.bytesFrom), safe);
            }
        }
    }
    // outline.note は top-level に rootIds/items（loadNoteStructure / buildFolderChainMap の実形式）
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ noteTitle: 'CLI Test Note', rootIds, items }));
    return dir;
}

function runCli(args: string[], cacheDir: string): { stdout: string; json?: any } {
    const stdout = execFileSync('node', [CLI, ...args, '--cache-dir', cacheDir], { encoding: 'utf8' });
    return { stdout };
}

function runCliJson(args: string[], cacheDir: string): any {
    const out = execFileSync('node', [CLI, ...args, '--json', '--cache-dir', cacheDir], { encoding: 'utf8' });
    return JSON.parse(out);
}

const OOXML_FIXTURES = [
    'docx-pydocx.docx', 'docx-textutil.docx', 'docx-soffice.docx', 'docx-stored.docx',
    'xlsx-openpyxl-inline.xlsx', 'xlsx-rph.xlsx', 'xlsx-soffice-sst.xlsx',
    'pptx-pypptx.pptx', 'pptx-soffice.pptx',
];

test.describe('extension⇄CLI ミラー同期（ADRL-0059）', () => {

    test('TC-DS-26: 全 OOXML fixture で正典 ts とミラー mjs の lines 完全一致', async () => {
        const mjs = await import(MJS);
        for (const name of OOXML_FIXTURES) {
            const buf = fs.readFileSync(path.join(FIX, name));
            const ext = path.extname(name).toLowerCase();
            const canonical = await extractDocText(buf, ext);
            const mirror = await mjs.extractDocTextMjs(buf, ext);
            expect(mirror.lines, `${name}: mirror lines must equal canonical`).toEqual(canonical.lines);
            expect(mirror.truncated, `${name}: truncated flag`).toBe(canonical.truncated);
            expect(mirror.skipReason, `${name}: skipReason`).toBe(canonical.skipReason);
        }
        // 非 ZIP の skipReason も一致（encrypted_or_not_zip）
        const bad = fs.readFileSync(path.join(FIX, 'not-a-zip.docx'));
        const c = await extractDocText(bad, '.docx');
        const m = (await import(MJS)).extractDocTextMjs && await mjs.extractDocTextMjs(bad, '.docx');
        expect(m.skipReason).toBe(c.skipReason);
        expect(c.skipReason).toBe('encrypted_or_not_zip');
    });

    test('TC-DS-38: CLI 側ソースは node: builtins + 相対 import のみ（npm 依存 0）', () => {
        const files = [
            MJS,
            path.join(ROOT, 'ai_skills', 'fractal-search', 'scripts', 'fractal-search.mjs'),
        ];
        for (const file of files) {
            const src = fs.readFileSync(file, 'utf8');
            // 静的 import / export from の指定子を全数列挙
            const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/g)]
                .map((m) => m[1]);
            for (const s of specs) {
                const ok = s.startsWith('node:') || s.startsWith('./') || s.startsWith('../');
                expect(ok, `${path.basename(file)}: import "${s}" must be node: builtin or relative`).toBe(true);
            }
            // 生 require はあってよいが npm パッケージ名の require は不可（vendor への相対 require は可）
            const reqs = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
            for (const s of reqs) {
                const ok = s.startsWith('node:') || s.startsWith('./') || s.startsWith('../');
                expect(ok, `${path.basename(file)}: require "${s}" must be node: builtin or relative`).toBe(true);
            }
        }
    });
});

test.describe('CLI 添付中身検索（FR-DS-06 / TASK-07）', () => {
    // TC-DS-23 が vendor/pdfjs-bundle.cjs（グローバル実体）を一時退避するため、
    // fullyParallel だと TC-DS-39（vendor 実在前提）と並列干渉して flaky になる —
    // この describe 内は宣言順の直列実行に固定する
    test.describe.configure({ mode: 'default' });
    let tmpDirs: string[] = [];
    const track = (d: string) => { tmpDirs.push(d); return d; };
    const mkCacheDir = () => track(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-cache-')));
    test.afterEach(() => {
        for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true }); }
        tmpDirs = [];
    });

    test('TC-DS-21: scope 指定なしで docx 添付ヒット（kind:file）/ --scope out では非対象', () => {
        const note = track(mkNoteWithAttachments([
            { id: 'att1', filename: 'meeting.docx', title: '会議資料', bytesFrom: 'docx-pydocx.docx' },
        ]));
        const json = runCliJson(['--query', '吾輩は猫である', '--folder', note], mkCacheDir());
        const fileHits = json.results.filter((r: any) => r.kind === 'file');
        expect(fileHits.length).toBe(1);
        expect(fileHits[0].fileId).toBe('files/meeting.docx');   // rev.2: files/ 相対パス同定
        expect(fileHits[0].fileTitle).toBe('会議資料');           // 台帳 title 逆引き
        expect(fileHits[0].matches.length).toBeGreaterThan(0);

        // 既存 scope（node,outline 相当の 'outline'）では添付非対象
        const jsonScoped = runCliJson(['--query', '吾輩は猫である', '--folder', note, '--scope', 'outline'], mkCacheDir());
        expect(jsonScoped.results.filter((r: any) => r.kind === 'file').length).toBe(0);
    });

    test('TC-DS-22: --scope file で添付のみ検索', () => {
        const note = track(mkNoteWithAttachments([
            { id: 'att1', filename: 'meeting.docx', bytesFrom: 'docx-pydocx.docx' },
        ]));
        // note 直下に同語を含む md も置く（scope=file なら md はヒットしない）
        fs.writeFileSync(path.join(note, 'note.md'), '吾輩は猫である。名前はまだ無い。');
        const json = runCliJson(['--query', '吾輩は猫である', '--folder', note, '--scope', 'file'], mkCacheDir());
        expect(json.results.every((r: any) => r.kind === 'file')).toBe(true);
        expect(json.results.length).toBe(1);
    });

    test('TC-DS-39: CLI + PDF 成功系 — vendor 実在状態で日本語 PDF 語がヒット', () => {
        expect(fs.existsSync(VENDOR), 'vendor bundle must be committed').toBe(true);
        const note = track(mkNoteWithAttachments([
            { id: 'pdf1', filename: 'report.pdf', title: 'レポート', bytesFrom: 'fixture-ja-en.pdf' },
        ]));
        const json = runCliJson(['--query', '富士山麓に鸚鵡鳴く', '--folder', note, '--scope', 'file'], mkCacheDir());
        const hits = json.results.filter((r: any) => r.kind === 'file');
        expect(hits.length).toBe(1);
        expect(hits[0].fileId).toBe('files/report.pdf');   // rev.2: files/ 相対パス同定
    });

    test('TC-DS-50: 台帳未登録 file（node 📎 / md 📎 添付相当）が walk でヒット（rev.2 の核・CLI 対称）', () => {
        // items 台帳に登録しない = node.filePath / md 📎 添付の実体状態
        const note = track(mkNoteWithAttachments([]));
        fs.copyFileSync(path.join(FIX, 'docx-textutil.docx'), path.join(note, 'files', 'embedded.docx'));
        const json = runCliJson(['--query', '国境の長いトンネル', '--folder', note, '--scope', 'file'], mkCacheDir());
        const hits = json.results.filter((r: any) => r.kind === 'file');
        // counterfactual: 台帳走査（rev.1）に戻すと 0 件 = RED
        expect(hits.length).toBe(1);
        expect(hits[0].fileId).toBe('files/embedded.docx');
        expect(hits[0].fileTitle).toBe('embedded.docx');
    });

    test('TC-DS-48(CLI): symlink 非追従 — files/ 外を指す symlink は対象にならない', () => {
        const note = track(mkNoteWithAttachments([]));
        const outside = path.join(note, 'outside.docx');
        fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), outside);
        fs.symlinkSync(outside, path.join(note, 'files', 'link.docx'));
        fs.symlinkSync(note, path.join(note, 'files', 'linkdir'));
        const json = runCliJson(['--query', '吾輩は猫である', '--folder', note, '--scope', 'file'], mkCacheDir());
        // counterfactual: walk が symlink を追うと外の docx がヒット = RED
        expect(json.results.filter((r: any) => r.kind === 'file').length).toBe(0);
    });

    test('TC-DS-23: vendor 欠損 → PDF skip・docx ヒット・exit 0', () => {
        const note = track(mkNoteWithAttachments([
            { id: 'pdf1', filename: 'report.pdf', bytesFrom: 'fixture-ja-en.pdf' },
            { id: 'doc1', filename: 'memo.docx', bytesFrom: 'docx-textutil.docx' },
        ]));
        // vendor を一時退避（finally で必ず復元）
        const backup = VENDOR + '.bak-tc23';
        fs.renameSync(VENDOR, backup);
        try {
            // PDF 語 → ヒット 0 だが exit 0（execFileSync が throw しない）
            const j1 = runCliJson(['--query', '富士山麓に鸚鵡鳴く', '--folder', note, '--scope', 'file'], mkCacheDir());
            expect(j1.results.filter((r: any) => r.kind === 'file').length).toBe(0);
            // docx はヒット（OOXML はゼロ依存で vendor 非依存）
            const j2 = runCliJson(['--query', '国境の長いトンネル', '--folder', note, '--scope', 'file'], mkCacheDir());
            expect(j2.results.filter((r: any) => r.kind === 'file').length).toBe(1);
        } finally {
            fs.renameSync(backup, VENDOR);
        }
    });

    test('TC-DS-24: traversal 番人 — filename=../../etc/evil.docx が files/ 外に到達しない', () => {
        const note = track(mkNoteWithAttachments([
            { id: 'evil', filename: '../../evil.docx', title: 'evil' },
        ]));
        // files/ の外（note の親 = tmp）に「ヒットするはずの」docx を置く — clamp が無ければ読める位置。
        // ⚠️ 親ディレクトリ（/tmp）を track に入れない — track は afterEach の再帰削除対象（誤用すると /tmp 全消しになる）
        const outside = path.join(note, '..', 'evil.docx');
        fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), outside);
        try {
            const json = runCliJson(['--query', '吾輩は猫である', '--folder', note, '--scope', 'file'], mkCacheDir());
            // rev.2: walk は files/ 実体しか列挙しない — 台帳の traversal filename は構造的に無効
            // （rev.1 では safeResolveUnderDirMjs の clamp が防御していた。walk の escape 防御は TC-DS-48(CLI)）
            expect(json.results.filter((r: any) => r.kind === 'file').length).toBe(0);
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });

    test('TC-DS-25: キャッシュ — 2 回目は fileCacheHit / CACHE_VERSION 6（旧版 invalidate — sprint 20260815 で 5→6）', () => {
        const note = track(mkNoteWithAttachments([
            { id: 'att1', filename: 'meeting.docx', bytesFrom: 'docx-pydocx.docx' },
        ]));
        const cacheDir = mkCacheDir();
        const j1 = runCliJson(['--query', '吾輩は猫である', '--folder', note], cacheDir);
        expect(j1.cache.fileCacheMiss).toBe(1);
        expect(j1.cache.fileCacheHit).toBe(0);
        const j2 = runCliJson(['--query', '吾輩は猫である', '--folder', note], cacheDir);
        expect(j2.cache.fileCacheHit).toBe(1);
        expect(j2.cache.fileCacheMiss).toBe(0);
        expect(j2.results.filter((r: any) => r.kind === 'file').length).toBe(1);

        // 旧 version の古いキャッシュは invalidate され再 parse になる
        const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
        expect(cacheFiles.length).toBe(1);
        const cachePath = path.join(cacheDir, cacheFiles[0]);
        const obj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        expect(obj.version).toBe(6);
        obj.version = 5;
        fs.writeFileSync(cachePath, JSON.stringify(obj));
        const j3 = runCliJson(['--query', '吾輩は猫である', '--folder', note], cacheDir);
        expect(j3.cache.fileCacheMiss).toBe(1);   // 旧 version キャッシュは捨てられ再抽出
    });
});

test.describe('位置メタ（TASK-18 / FR-DS-09）', () => {
    test.describe.configure({ mode: 'default' });
    let tmpDirs: string[] = [];
    const track = (d: string) => { tmpDirs.push(d); return d; };
    const mkCacheDir = () => track(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-loc-cache-')));
    test.afterEach(() => {
        for (const d of tmpDirs) { fs.rmSync(d, { recursive: true, force: true }); }
        tmpDirs = [];
    });

    test('TC-DS-56: CLI ヒットに loc（xlsx = シート名!セル / pptx = slide n / pdf = p.n）が載る', () => {
        const note = track(mkNoteWithAttachments([]));
        fs.copyFileSync(path.join(FIX, 'xlsx-soffice-sst.xlsx'), path.join(note, 'files', 'book.xlsx'));
        fs.copyFileSync(path.join(FIX, 'pptx-pypptx.pptx'), path.join(note, 'files', 'deck.pptx'));
        fs.copyFileSync(path.join(FIX, 'fixture-ja-en.pdf'), path.join(note, 'files', 'doc.pdf'));

        const jx = runCliJson(['--query', '東京タワー', '--folder', note, '--scope', 'file'], mkCacheDir());
        const xlsxHit = jx.results.find((r: any) => r.fileName === 'book.xlsx');
        expect(xlsxHit.matches[0].loc).toMatch(/^データ![A-Z]+\d+$/);

        const jp = runCliJson(['--query', '三枚目 Third', '--folder', note, '--scope', 'file'], mkCacheDir());
        const pptxHit = jp.results.find((r: any) => r.fileName === 'deck.pptx');
        expect(pptxHit.matches[0].loc).toBe('slide 3');

        const jd = runCliJson(['--query', '富士山麓に鸚鵡鳴く', '--folder', note, '--scope', 'file'], mkCacheDir());
        const pdfHit = jd.results.find((r: any) => r.fileName === 'doc.pdf');
        expect(pdfHit.matches[0].loc).toBe('p.1');

        // テキスト表示にも loc（L<n> の代わり）
        const txt = runCli(['--query', '東京タワー', '--folder', note, '--scope', 'file'], mkCacheDir());
        expect(txt.stdout).toMatch(/データ![A-Z]+\d+:/);
    });
});

test.describe('クエリ NFKC 正規化（TASK-21）', () => {
    test('TC-DS-61(CLI): 全角括弧（）入りクエリが添付にヒット', () => {
        const note = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-nfkc-cli-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-nfkc-cli-cache-'));
        try {
            fs.mkdirSync(path.join(note, 'files'), { recursive: true });
            // 全角括弧入り docx を合成（extension TC-DS-61 と同型）
            const docXml = '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>TCN（トポロジ変化通知）が頻発</w:t></w:r></w:p></w:body></w:document>';
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const zlib2 = require('zlib');
            const deflated = zlib2.deflateRawSync(Buffer.from(docXml));
            const name = Buffer.from('word/document.xml');
            const lh = Buffer.alloc(30);
            lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8);
            lh.writeUInt32LE(deflated.length, 18); lh.writeUInt32LE(Buffer.byteLength(docXml), 22);
            lh.writeUInt16LE(name.length, 26);
            const cd = Buffer.alloc(46);
            cd.writeUInt32LE(0x02014b50, 0); cd.writeUInt16LE(8, 10);
            cd.writeUInt32LE(deflated.length, 20); cd.writeUInt32LE(Buffer.byteLength(docXml), 24);
            cd.writeUInt16LE(name.length, 28); cd.writeUInt32LE(0, 42);
            const eocd = Buffer.alloc(22);
            eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10);
            eocd.writeUInt32LE(46 + name.length, 12); eocd.writeUInt32LE(30 + name.length + deflated.length, 16);
            fs.writeFileSync(path.join(note, 'files', 'tcn.docx'), Buffer.concat([lh, name, deflated, cd, name, eocd]));
            fs.writeFileSync(path.join(note, 'outline.note'), JSON.stringify({ noteTitle: 'T', rootIds: [], items: {} }));

            // 全角括弧クエリ（counterfactual: クエリ正規化なしだと 0 件 = RED）
            const j1 = JSON.parse(execFileSync('node', [CLI, '--query', 'TCN（トポロジ変化通知）', '--folder', note, '--scope', 'file', '--json', '--cache-dir', cacheDir], { encoding: 'utf8' }));
            expect(j1.results.filter((r: any) => r.kind === 'file').length).toBe(1);
        } finally {
            fs.rmSync(note, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});

test.describe('テキスト系ミラー + CLI E2E（sprint 20260815 / FR-DS-06 rev.3）', () => {

    test('TC-DS-70: ミラー一致番人 — テキスト 6 種で正典 ts とミラー mjs の lines + skipReason 完全一致', async () => {
        const mjs = await import(MJS);
        const utf8Text = '議事録テキスト（全角）と English mixed\n2 行目';
        const leBody = Buffer.from(utf8Text, 'utf16le');
        const beBody = Buffer.from(leBody); beBody.swap16();
        const htmlText = '<html><head><script>const x = "秘匿";</script></head><body><div class="k">議事録</div><td>東京</td><td>大阪</td>&amp;&nbsp;</body></html>';
        const textFixtures: Array<{ name: string; buf: Buffer; ext: string }> = [
            { name: 'utf8-plain', buf: Buffer.from(utf8Text, 'utf8'), ext: '.txt' },
            { name: 'utf8-bom', buf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(utf8Text, 'utf8')]), ext: '.txt' },
            { name: 'utf16le-bom', buf: Buffer.concat([Buffer.from([0xff, 0xfe]), leBody]), ext: '.txt' },
            { name: 'utf16be-bom', buf: Buffer.concat([Buffer.from([0xfe, 0xff]), beBody]), ext: '.txt' },
            { name: 'nul-binary', buf: Buffer.concat([Buffer.from('head'), Buffer.from([0x00, 0x01]), Buffer.from('tail')]), ext: '.bin' },
            { name: 'html', buf: Buffer.from(htmlText, 'utf8'), ext: '.html' },
        ];
        for (const f of textFixtures) {
            const tsRes = await extractDocText(f.buf, f.ext);
            const mjsRes = await mjs.extractDocTextMjs(f.buf, f.ext);
            // counterfactual: 片側の sniff 分岐 / html 処理を 1 つ落とすと不一致で RED
            expect(mjsRes.skipReason, `${f.name}: skipReason 一致`).toBe(tsRes.skipReason);
            expect(mjsRes.lines, `${f.name}: lines 完全一致`).toEqual(tsRes.lines);
            expect(mjsRes.noCache, `${f.name}: noCache 契約一致`).toBe(tsRes.noCache);
        }
    });

    test('TC-DS-74: CLI E2E — .txt が default scope でヒット / --scope out は不変 / CACHE_VERSION 6 invalidate', async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-txt-cache-'));
        const note = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-txt-note-'));
        try {
            fs.mkdirSync(path.join(note, 'files'), { recursive: true });
            fs.writeFileSync(path.join(note, 'files', 'memo.txt'), '会議の議事録テスト内容', 'utf8');
            fs.writeFileSync(path.join(note, 'outline.note'), JSON.stringify({ noteTitle: 'T', rootIds: [], items: {} }));

            // scope 指定なし（default = all）で kind:'file' ヒット
            const j1 = JSON.parse(execFileSync('node', [CLI, '--query', '議事録テスト', '--folder', note, '--json', '--cache-dir', cacheDir], { encoding: 'utf8' }));
            expect(j1.results.filter((r: any) => r.kind === 'file').length).toBe(1);

            // --scope out では添付は対象外（既存 scope 不変）
            const j2 = JSON.parse(execFileSync('node', [CLI, '--query', '議事録テスト', '--folder', note, '--scope', 'out', '--json', '--cache-dir', cacheDir], { encoding: 'utf8' }));
            expect(j2.results.filter((r: any) => r.kind === 'file').length).toBe(0);

            // CACHE_VERSION invalidate: version 5 のキャッシュ（旧 unsupported_ext 記録）を手書き → 再判定でヒット
            const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
            for (const cf of cacheFiles) {
                const entry = JSON.parse(fs.readFileSync(path.join(cacheDir, cf), 'utf8'));
                entry.version = 5;
                const st = fs.statSync(path.join(note, 'files', 'memo.txt'));
                entry.files['files/memo.txt'] = {
                    mtimeMs: st.mtimeMs, size: st.size,
                    data: { lines: [], truncated: false, skipReason: 'unsupported_ext' },
                };
                fs.writeFileSync(path.join(cacheDir, cf), JSON.stringify(entry));
            }
            const j3 = JSON.parse(execFileSync('node', [CLI, '--query', '議事録テスト', '--folder', note, '--json', '--cache-dir', cacheDir], { encoding: 'utf8' }));
            // counterfactual: CACHE_VERSION を 5 に戻すと旧 skip 記録が生きて 0 件 = RED
            expect(j3.results.filter((r: any) => r.kind === 'file').length).toBe(1);
        } finally {
            fs.rmSync(note, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });

    test('TC-DS-76: 秘密非複製番人（CLI 版）— テキスト本文が CLI キャッシュに書かれない（NFR-DS-08）', async () => {
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sec-cache-'));
        const note = fs.mkdtempSync(path.join(os.tmpdir(), 'cli-sec-note-'));
        try {
            const marker = 'SECRETMARKER123XYZ';
            fs.mkdirSync(path.join(note, 'files'), { recursive: true });
            fs.writeFileSync(path.join(note, 'files', 'credentials.env'), `API_KEY=${marker}\n`, 'utf8');
            // 比較対照: docx（専用抽出 = キャッシュされる）も並べ、書き分けを確認
            fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), path.join(note, 'files', 'doc.docx'));
            fs.writeFileSync(path.join(note, 'outline.note'), JSON.stringify({ noteTitle: 'T', rootIds: [], items: {} }));

            // キャッシュ有効のまま検索（ヒット自体は機能する）
            const j = JSON.parse(execFileSync('node', [CLI, '--query', marker, '--folder', note, '--json', '--cache-dir', cacheDir], { encoding: 'utf8' }));
            expect(j.results.filter((r: any) => r.kind === 'file').length).toBe(1);

            // counterfactual: noCache 条件を外すと cache.files に平文複製されて RED
            const leaked = fs.readdirSync(cacheDir)
                .map((f) => fs.readFileSync(path.join(cacheDir, f), 'utf8'))
                .some((content) => content.includes(marker));
            expect(leaked, 'テキスト本文が CLI キャッシュに平文複製されない').toBe(false);

            // 対照: docx の抽出結果はキャッシュされる（専用抽出 = 従来どおり）
            execFileSync('node', [CLI, '--query', '吾輩は猫である', '--folder', note, '--json', '--cache-dir', cacheDir], { encoding: 'utf8' });
            const docxCached = fs.readdirSync(cacheDir)
                .map((f) => fs.readFileSync(path.join(cacheDir, f), 'utf8'))
                .some((content) => content.includes('吾輩は猫である'));
            expect(docxCached, '専用抽出（docx）はキャッシュされる — 二分の対照').toBe(true);
        } finally {
            fs.rmSync(note, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
