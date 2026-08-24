/**
 * viewer-pptx-license.spec.ts — pptx 移植のライセンス・出自番人（TC-PPV-09 / NFR-VEX-08 / ADR-0010）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-04（+ TASK-11 で escapeHtml/genTextBody 条件を強化）。
 *  - viewer-pptx/ の全 .mjs 冒頭に「Ported from pptxtojson」ヘッダ or 自作宣言（fractal original）
 *  - vendor/LICENSE-pptxtojson（MIT 全文）が存在
 *  - PPTist（AGPL）由来識別子の混入ゼロ（プロセス防御の機械面）
 *  - TASK-11 以降: escapeHtml 0 件・genTextBody の HTML 文字列 return 0 件（構造化 runs 化 — XSS 経路遮断）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const DIR = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-pptx');
const files = () => fs.readdirSync(DIR).filter((f) => f.endsWith('.mjs'));

test('TC-PPV-09: 全 .mjs に出自ヘッダ（Ported from pptxtojson or fractal original）', () => {
    expect(files().length).toBeGreaterThanOrEqual(17);
    for (const f of files()) {
        const head = fs.readFileSync(path.join(DIR, f), 'utf8').slice(0, 800);
        const ok = head.includes('Ported from pptxtojson') || head.includes('fractal original');
        expect(ok, `${f} に出自ヘッダが無い`).toBe(true);
        if (head.includes('Ported from pptxtojson')) {
            expect(head, `${f} に出典 commit hash が無い`).toContain('2b12fceb1d1ca4e1436480afa485567dbd1101c4');
            expect(head, `${f} に MIT 表記が無い`).toContain('MIT License');
        }
    }
});

test('TC-PPV-09: LICENSE-pptxtojson（MIT 全文）の正典 + vendor 複製配線が存在', () => {
    // 正典 = src/webview/viewer-pptx/LICENSE-pptxtojson（vendor/ は git 管理外の生成物のため —
    // research の「vendor 静的 commit」前提を実装時に訂正。vsix へは copy-vendor.js が複製）
    const lic = fs.readFileSync(path.join(DIR, 'LICENSE-pptxtojson'), 'utf8');
    expect(lic).toContain('MIT License');
    expect(lic).toContain('pipipi-pikachu');
    const copyVendor = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'copy-vendor.js'), 'utf8');
    expect(copyVendor, 'copy-vendor.js に vendor 複製配線が無い').toContain('LICENSE-pptxtojson');
});

test('TC-PPV-09: PPTist（AGPL）由来識別子の混入ゼロ', () => {
    for (const f of files()) {
        const src = fs.readFileSync(path.join(DIR, f), 'utf8');
        expect(src.toLowerCase().includes('pptist'), `${f} に PPTist 参照`).toBe(false);
    }
});

test('TC-PPV-09: 構造化 runs 化後の XSS 番人（escapeHtml 0 件・HTML 文字列 return 0 件）', () => {
    // TASK-11 完了: 全ファイルで escapeHtml の**実体**（定義 / import / 呼び出し）ゼロ。
    // 「Modified for fractal: escapeHtml 廃止」の注記コメントは許容（識別子形でマッチ）。
    for (const f of files()) {
        const src = fs.readFileSync(path.join(DIR, f), 'utf8');
        const used = /function\s+escapeHtml|escapeHtml\s*\(|escapeHtml\s*,|\{\s*escapeHtml/.test(src);
        expect(used, `${f} に escapeHtml の実体`).toBe(false);
    }
    // 構造化 runs 化の番人: genTextBody が HTML 文字列を組んでいない（<span/<p の文字列連結ゼロ）
    const textSrc = fs.readFileSync(path.join(DIR, 'text.mjs'), 'utf8');
    expect(/`<(span|p|li|ul|ol)/.test(textSrc), 'text.mjs に HTML 文字列組み立て').toBe(false);
});
