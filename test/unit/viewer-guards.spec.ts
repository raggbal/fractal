/**
 * viewer-guards.spec.ts — viewer 拡張の番人 spec（grep 型）
 *
 * sprint 20260823-165314-viewer-office-text-image。
 *  - TC-VEX-20（TASK-05）: gate runner 配線番人 — build-viewer-modules が run-parallel-tests.sh と
 *    package.json（test:build:all / compile）に配線されている（外すと stale モジュールで gate だけ fail する
 *    既知クラス = generator_failures 2026-08-15(d)/2026-08-17）
 *  - TC-VEX-12/14/15 は TASK-17 で追記（全 kind dir が揃ってから全体対象化）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');

test('TC-VEX-20: gate runner + build チェーンに build-viewer-modules が配線されている', () => {
    expect(fs.existsSync(path.join(ROOT, 'scripts', 'build-viewer-modules.js')), 'scripts/build-viewer-modules.js が無い').toBe(true);
    const runner = read('test/run-parallel-tests.sh');
    expect(runner, 'run-parallel-tests.sh に build-viewer-modules 行が無い').toContain('build-viewer-modules');
    const pkg = JSON.parse(read('package.json'));
    expect(pkg.scripts['test:build:all'], 'test:build:all に build-viewer-modules が無い').toContain('build-viewer-modules');
    expect(pkg.scripts.compile, 'compile チェーンに build-viewer-modules が無い').toContain('build-viewer-modules');
});

// ── TASK-17: 全 kind dir が揃ったので全体対象の番人を起動 ──────────────────

/** src/webview/viewer-<kind> 配下の全ファイルを再帰列挙 */
function viewerModuleFiles(): string[] {
    const base = path.join(ROOT, 'src', 'webview');
    const out: string[] = [];
    for (const dir of fs.readdirSync(base)) {
        if (!/^viewer-/.test(dir)) { continue; }
        if (!fs.statSync(path.join(base, dir)).isDirectory()) { continue; } // viewer-side-panel.js 等の単ファイルは対象外
        const walk = (d: string) => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { walk(p); } else { out.push(p); }
            }
        };
        walk(path.join(base, dir));
    }
    return out;
}

test('TC-VEX-12: innerHTML 番人 — viewer-*/ に innerHTML / insertAdjacentHTML / outerHTML 代入が 0 件（INV-2）', () => {
    const files = viewerModuleFiles().filter((p) => /\.(mjs|js|ts)$/.test(p));
    expect(files.length).toBeGreaterThan(10); // 対象が空なら番人自体が壊れている
    for (const p of files) {
        const src = fs.readFileSync(p, 'utf8');
        expect(/\binnerHTML\b|\binsertAdjacentHTML\b|\bouterHTML\s*=/.test(src),
            `${path.relative(ROOT, p)} に HTML 文字列注入 API がある`).toBe(false);
    }
});

test('TC-VEX-14: 正典不変更 — doc-text-extract.ts と ai_skills ミラーが main と一致（INV-1）', () => {
    // sprint ブランチ上で main の内容と一致 = 本 sprint が正典に diff を入れていない
    const { execSync } = require('child_process');
    for (const rel of ['src/shared/doc-text-extract.ts', 'ai_skills/fractal-search/scripts/ooxml-extract.mjs']) {
        const now = fs.readFileSync(path.join(ROOT, rel), 'utf8');
        const main = execSync(`git show main:${rel}`, { cwd: ROOT, maxBuffer: 16 * 1024 * 1024 }).toString('utf8');
        expect(now === main, `${rel} が main から変更されている（正典は不可侵 — INV-1）`).toBe(true);
    }
});

test('TC-VEX-15: 判定一元化 — viewer-*/ と file-viewer.js に拡張子リテラル分岐が無い（INV-5）', () => {
    const files = viewerModuleFiles().filter((p) => /\.(mjs|js|ts)$/.test(p));
    files.push(path.join(ROOT, 'src', 'webview', 'file-viewer.js'));
    for (const p of files) {
        const src = fs.readFileSync(p, 'utf8');
        expect(/\.docx\b|\.xlsx\b|\.pptx\b/i.test(src),
            `${path.relative(ROOT, p)} に office 拡張子リテラルがある（判定は isViewerTarget に一元化 — ADRL-0066）`).toBe(false);
    }
});
