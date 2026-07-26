/**
 * ai_skills 検索強化 unit — sprint 20260727-065214-clipper-i18n-skills-search
 * TC-SS-01〜11 (testcases.md §B)
 *
 * - H1 ミラー 3 者一致（正典 out/shared/md-h1-utils.js vs search mjs vs md mjs）= ADRL-0002 の番人
 * - --outline-name / --h1 / AND 合成（searchFolder を fixture で直接駆動）
 * - mjs は import guard 済み（import で main() が走らない）
 *
 * 前提: out/shared/md-h1-utils.js が存在（無ければ `npm run compile`）。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SEARCH_MJS = path.join(ROOT, 'ai_skills/fractal-search/scripts/fractal-search.mjs');
const MD_MJS = path.join(ROOT, 'ai_skills/fractal-edit/scripts/fractal-md.mjs');
const CANON = path.join(ROOT, 'out/shared/md-h1-utils.js');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let search: any, fmd: any, canon: any;

test.beforeAll(async () => {
    expect(fs.existsSync(CANON), 'out/shared/md-h1-utils.js が必要（npm run compile）').toBe(true);
    search = await import(SEARCH_MJS);
    fmd = await import(MD_MJS);
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    canon = require(CANON);
});

// ---- fixture ----
function makeFixture(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-skills-search-'));
    // outline.note: noteTitle
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        noteTitle: 'Alpha Note',
        items: {
            out1: { title: 'Project Plan', type: 'file', ext: 'out' },
            out2: { title: 'Meeting Log', type: 'file', ext: 'out' },
        },
        rootOrder: ['out1', 'out2'],
    }));
    // out1: page node ×2（csharp md / roadmap md）+ tag node
    fs.writeFileSync(path.join(dir, 'out1.out'), JSON.stringify({
        version: 1, title: 'Project Plan', pageDir: '.',
        rootIds: ['n1', 'n2', 'n3'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: 'csharp page', isPage: true, pageId: 'page-cs' },
            n2: { id: 'n2', parentId: null, children: [], text: 'roadmap page', isPage: true, pageId: 'page-rm' },
            n3: { id: 'n3', parentId: null, children: [], text: 'todo item #work', checked: false },
        },
    }));
    // out2: 1 node
    fs.writeFileSync(path.join(dir, 'out2.out'), JSON.stringify({
        version: 1, title: 'Meeting Log', pageDir: '.',
        rootIds: ['m1'],
        nodes: { m1: { id: 'm1', parentId: null, children: [], text: 'weekly sync notes' } },
    }));
    // page mds（flat 直下）。page-cs はフェンス trap（フェンス内 # fake の後に実 H1 `# C#`）
    fs.writeFileSync(path.join(dir, 'page-cs.md'),
        '```\n# fake heading in fence\n```\n\n# C#\n\nsharp language deep dive\n');
    fs.writeFileSync(path.join(dir, 'page-rm.md'),
        '# Roadmap 2026\n\nmilestones and deliverables\n');
    // note 直下 md（outliner 非所属）
    fs.writeFileSync(path.join(dir, 'loose.md'), '# Loose Doc\n\nstandalone content\n');
    return dir;
}

/** searchFolder 相当を CLI 経由でなく main 相当の状態組み立てで駆動するのは内部関数非公開のため、
 *  ここでは CLI をサブプロセス実行する（--folder 指定・--no-cache で決定論）。 */
function runCli(args: string[]): { code: number; stdout: string } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { execFileSync } = require('child_process');
    try {
        const out = execFileSync('node', [SEARCH_MJS, ...args], { encoding: 'utf-8' });
        return { code: 0, stdout: out };
    } catch (e: any) {
        return { code: e.status ?? 1, stdout: (e.stdout || '') + (e.stderr || '') };
    }
}

test.describe('H1 ミラー（ADRL-0002）', () => {
    test('TC-SS-01 ★load-bearing: 3 者一致（正典 ts / search mjs / md mjs）', () => {
        const inputs = [
            '# C#', '# F# and C#', '# Title #', '# Title ###', '#NoSpace',
            '# .gitignore #', '#  spaced  ', '## H2 not H1', 'plain line', '# CR line\r',
        ];
        for (const line of inputs) {
            const a = canon.parseAtxH1Text(line);
            const b = search.parseAtxH1TextMjs(line);
            const c = fmd.parseAtxH1TextMjs(line);
            expect(b, `search mjs mismatch for ${JSON.stringify(line)}`).toBe(a);
            expect(c, `md mjs mismatch for ${JSON.stringify(line)}`).toBe(a);
        }
        // 本文レベル（フェンス skip + CRLF）も 3 者一致
        const bodies = [
            '```\n# fake\n```\n\n# Real H1\n', 'no heading here\n',
            '# First\n\n# Second\n', 'text\r\n# CRLF H1\r\nbody\r\n',
        ];
        for (const md of bodies) {
            const a = canon.extractFirstH1(md);
            const b = search.extractFirstH1Mjs(md);
            const c = fmd.extractFirstH1Mjs(md);
            expect(b, `search mjs body mismatch`).toBe(a);
            expect(c, `md mjs body mismatch`).toBe(a);
        }
    });

    test('TC-SS-02 extractFirstH1Mjs: フェンス skip・最初のみ・無ければ null', () => {
        expect(search.extractFirstH1Mjs('```\n# in fence\n```\n# After\n')).toBe('After');
        expect(search.extractFirstH1Mjs('# One\n# Two\n')).toBe('One');
        expect(search.extractFirstH1Mjs('## only h2\nbody\n')).toBe(null);
    });

    test('TC-SS-10 ★load-bearing counterfactual: 旧簡易 regex はフェンス内 H1 を誤検出（新実装は正しい）', () => {
        const md = '```\n# fake heading in fence\n```\n\n# C#\n\nbody\n';
        // 旧実装（fractal-md の置換前ロジック）を再現 → 'fake heading in fence' を返す = バグ
        const legacyMatch = md.match(/^# (.+)$/m);
        const legacy = legacyMatch ? legacyMatch[1].trim() : null;
        expect(legacy).toBe('fake heading in fence'); // pre-fix はフェンス内を拾う（RED 相当の実証）
        // 新実装（正典ミラー）は実 H1 を返し、末尾 # も保持
        expect(fmd.extractFirstH1Mjs(md)).toBe('C#');
    });

    test('TC-SS-11 import 副作用なし（import guard 維持）: export が関数として取得でき main が走っていない', () => {
        expect(typeof search.parseAtxH1TextMjs).toBe('function');
        expect(typeof search.matchesH1Filter).toBe('function');
        expect(typeof search.matchesOutlineName).toBe('function');
        expect(typeof fmd.extractFirstH1Mjs).toBe('function');
    });

    test('TC-SS-12 ★load-bearing: symlink 経由の CLI 実行で main が走る（TASK-B5 guard realpath 対応）', () => {
        // install.sh の claude/cursor/antigravity 配置は symlink。旧 guard
        // （import.meta.url === pathToFileURL(argv[1]).href）は Node が main entry を realpath
        // 解決するため symlink 起動で不一致 → silent no-op（exit 0・出力なし）だった。
        // 修正後: argv[1] を realpathSync してから比較 → symlink でも main が走る。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { execFileSync } = require('child_process');
        const linkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fr-skill-link-'));
        const link = path.join(linkDir, 'fractal-search.mjs');
        fs.symlinkSync(SEARCH_MJS, link);
        try {
            // counterfactual 前提: symlink パス経由で起動（旧 guard なら出力ゼロで exit 0 になる）
            const out = execFileSync('node', [link, '--list-folders'], { encoding: 'utf-8' });
            expect(out.length).toBeGreaterThan(0);                    // 旧 guard: '' = RED
            expect(out).toContain('Discovered Fractal notes folders'); // main が実際に走った
            // 全 6 mjs の guard が realpath 対応版に統一されていることを静的確認
            const mjsFiles = [
                'ai_skills/fractal-search/scripts/fractal-search.mjs',
                'ai_skills/fractal-edit/scripts/fractal-md.mjs',
                'ai_skills/fractal-edit/scripts/fractal-attach.mjs',
                'ai_skills/fractal-edit/scripts/fractal-modify.mjs',
                'ai_skills/fractal-doctor/scripts/fractal-doctor.mjs',
                'ai_skills/fractal-summary/scripts/fractal-summary.mjs',
            ];
            for (const f of mjsFiles) {
                const src = fs.readFileSync(path.join(ROOT, f), 'utf-8');
                expect(src, `${f}: realpath guard`).toContain('fs.realpathSync(entry)');
                expect(src, `${f}: 旧素比較 guard の残存`)
                    .not.toContain('import.meta.url === pathToFileURL(process.argv[1]).href');
            }
        } finally {
            fs.rmSync(linkDir, { recursive: true, force: true });
        }
    });
});

test.describe('検索フィルタ（CLI 駆動・fixture）', () => {
    let dir: string;
    test.beforeAll(() => { dir = makeFixture(); });
    test.afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('TC-SS-03 --list-notes × --note-name: 一致 note のみ / 不一致は error exit', () => {
        const hit = runCli(['--list-notes', '--note-name', 'alpha', '--folder', dir, '--json', '--no-cache']);
        expect(hit.code).toBe(0);
        const j = JSON.parse(hit.stdout);
        expect(j.notes.length).toBe(2); // out1 + out2
        const miss = runCli(['--list-notes', '--note-name', 'zzz-nothing', '--folder', dir, '--json', '--no-cache']);
        expect(miss.code).not.toBe(0); // 「no note matched」エラー（既存挙動）
    });

    test('TC-SS-04 --list-folders --json に name (noteTitle) と dirName が入る', () => {
        const r = runCli(['--list-folders', '--folder', dir, '--json']);
        expect(r.code).toBe(0);
        const j = JSON.parse(r.stdout);
        expect(j.folders[0].name).toBe('Alpha Note');
        expect(j.folders[0].dirName).toBe(path.basename(dir));
    });

    test('TC-SS-05 --outline-name 単独: title 部分一致（大小無視）の outliner 一覧', () => {
        const r = runCli(['--outline-name', 'plan', '--folder', dir, '--json', '--no-cache']);
        expect(r.code).toBe(0);
        const j = JSON.parse(r.stdout);
        const outlines = j.results.filter((x: any) => x.kind === 'outline');
        expect(outlines.length).toBe(1);
        expect(outlines[0].outlineTitle).toBe('Project Plan');
    });

    test('TC-SS-06 --h1 単独: 先頭 H1 部分一致の md 一覧（page + loose md）', () => {
        const r = runCli(['--h1', 'c#', '--folder', dir, '--json', '--no-cache']);
        expect(r.code).toBe(0);
        const j = JSON.parse(r.stdout);
        const hits = j.results.filter((x: any) => x.kind === 'page-h1' || x.kind === 'md-h1');
        expect(hits.length).toBe(1);
        expect(hits[0].h1).toBe('C#');
        expect(hits[0].pageId).toBe('page-cs');
        // loose md も対象（--h1 'loose doc'）
        const r2 = runCli(['--h1', 'loose', '--folder', dir, '--json', '--no-cache']);
        const j2 = JSON.parse(r2.stdout);
        const loose = j2.results.filter((x: any) => x.kind === 'md-h1');
        expect(loose.length).toBe(1);
        expect(loose[0].h1).toBe('Loose Doc');
    });

    test('TC-SS-07 ★AND 合成 + counterfactual（1 条件外すと増える）', () => {
        // note-name × outline-name × query: 全条件交差
        const all = runCli(['--note-name', 'alpha', '--outline-name', 'plan', '--query', 'milestones',
            '--folder', dir, '--json', '--no-cache']);
        const jAll = JSON.parse(all.stdout);
        const pages = jAll.results.filter((x: any) => x.kind === 'page');
        expect(pages.length).toBe(1); // page-rm（Project Plan 内・本文 milestones）
        expect(pages[0].pageId).toBe('page-rm');
        // counterfactual A: --outline-name を外す → loose/others も対象になり件数が増えるか同等以上
        const noOutline = runCli(['--query', 'milestones', '--folder', dir, '--json', '--no-cache']);
        const jNo = JSON.parse(noOutline.stdout);
        expect(jNo.results.length).toBeGreaterThanOrEqual(jAll.results.length);
        // counterfactual B: --outline-name 'meeting' に変えると Project Plan の page はヒットしない
        const other = runCli(['--outline-name', 'meeting', '--query', 'milestones',
            '--folder', dir, '--json', '--no-cache']);
        const jOther = JSON.parse(other.stdout);
        expect(jOther.results.filter((x: any) => x.kind === 'page').length).toBe(0);
    });

    test('TC-SS-08 --h1 + --query: H1 マッチ md 内の本文マッチ行のみ', () => {
        const r = runCli(['--h1', 'roadmap', '--query', 'deliverables', '--folder', dir, '--json', '--no-cache']);
        const j = JSON.parse(r.stdout);
        const pages = j.results.filter((x: any) => x.kind === 'page');
        expect(pages.length).toBe(1);
        expect(pages[0].pageId).toBe('page-rm');
        expect(pages[0].h1).toBe('Roadmap 2026');
        // H1 は合うが本文が合わない → 0 件
        const r2 = runCli(['--h1', 'roadmap', '--query', 'no-such-word', '--folder', dir, '--json', '--no-cache']);
        const j2 = JSON.parse(r2.stdout);
        expect(j2.results.filter((x: any) => x.kind === 'page').length).toBe(0);
    });

    test('TC-SS-09 後方互換: --query 単独 / --tag / --find-outline が従来 shape', () => {
        const q = runCli(['--query', 'weekly', '--folder', dir, '--json', '--no-cache']);
        const jq = JSON.parse(q.stdout);
        expect(jq.results.some((x: any) => x.kind === 'outline-node' && x.nodeText === 'weekly sync notes')).toBe(true);
        const tag = runCli(['--tag', 'work', '--folder', dir, '--json', '--no-cache']);
        const jt = JSON.parse(tag.stdout);
        expect(jt.results.some((x: any) => x.nodeId === 'n3')).toBe(true);
        const fo = runCli(['--find-outline', 'Meeting', '--folder', dir, '--json', '--no-cache']);
        const jf = JSON.parse(fo.stdout);
        expect(jf.matchedCount).toBe(1);
        expect(jf.notes[0].title).toBe('Meeting Log');
    });
});
