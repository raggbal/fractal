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
import * as fs from 'fs';
import * as path from 'path';
import { extractDocText } from '../../src/shared/doc-text-extract';

const ROOT = path.join(__dirname, '..', '..');
const FIX = path.join(ROOT, 'test', 'fixtures', 'doc-search');
const MJS = path.join(ROOT, 'ai_skills', 'fractal-search', 'scripts', 'ooxml-extract.mjs');

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
