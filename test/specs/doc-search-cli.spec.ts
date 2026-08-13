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
        expect(fileHits[0].fileId).toBe('att1');
        expect(fileHits[0].fileTitle).toBe('会議資料');
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
        expect(hits[0].fileId).toBe('pdf1');
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
            // clamp により evil item は解決 null → skip（counterfactual: clamp を外すと外の docx を読んでヒット = RED）
            expect(json.results.filter((r: any) => r.kind === 'file').length).toBe(0);
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });

    test('TC-DS-25: キャッシュ — 2 回目は fileCacheHit / CACHE_VERSION 4（旧 v3 invalidate）', () => {
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

        // CACHE_VERSION 4: version=3 の古いキャッシュは invalidate され再 parse になる
        const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json'));
        expect(cacheFiles.length).toBe(1);
        const cachePath = path.join(cacheDir, cacheFiles[0]);
        const obj = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
        expect(obj.version).toBe(4);
        obj.version = 3;
        fs.writeFileSync(cachePath, JSON.stringify(obj));
        const j3 = runCliJson(['--query', '吾輩は猫である', '--folder', note], cacheDir);
        expect(j3.cache.fileCacheMiss).toBe(1);   // v3 キャッシュは捨てられ再抽出
    });
});
