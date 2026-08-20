/**
 * TC-MLG-01/02 — TOC アンカー生成の多言語対応（sprint 20260818-183407 FR-MLG-01）
 *
 * 旧文字クラス /[^\w\s　-鿿\u{20000}-\u{2fa1f}\-]/gu はハングル・アクセント Latin・
 * 半角カナ・全角英数を欠落させる（research-risk §1-1 確定）。
 * 新クラス /[^\p{L}\p{N}_\s\-]/gu は既存保持域（ASCII \w / U+3000-9FFF / U+20000-2FA1F / '-'）を
 * すべて包含する純増（TC-MLG-02 が byte 互換の番人）。
 *
 * counterfactual: 旧クラスに戻すと TC-MLG-01 の한글アンカーが '-'（全欠落）= RED。
 */
import { test, expect } from '@playwright/test';
import { extractToc } from '../../src/shared/toc-utils';

function anchorOf(md: string): string {
    const toc = extractToc(md);
    expect(toc.length).toBe(1);
    return toc[0].anchor;
}

test('TC-MLG-01a ハングル見出しのアンカーが欠落しない', () => {
    // 旧実装: '한글 제목' → ハングル全欠落 → '-'（一意性喪失）
    expect(anchorOf('# 한글 제목')).toBe('한글-제목');
});

test('TC-MLG-01b アクセント付き Latin（フランス語）が欠落しない', () => {
    // 旧実装: 'Résumé' → é 欠落 → 'rsum'
    expect(anchorOf('# Résumé')).toBe('résumé');
});

test('TC-MLG-01c 半角カナ・全角英数が欠落しない', () => {
    // 旧実装: 'ｱﾝｶｰ' → 全欠落 → ''
    expect(anchorOf('# ｱﾝｶｰ')).toBe('ｱﾝｶｰ');
    // 旧実装: '全角ＡＢＣ１' → 'ＡＢＣ１' 欠落 → '全角'
    expect(anchorOf('# 全角ＡＢＣ１')).toBe('全角ａｂｃ１'); // toLowerCase は全角にも効く
});

test('TC-MLG-01d 異なるハングル見出しのアンカーが一意', () => {
    const toc = extractToc('# 첫째 장\n\n# 둘째 장\n');
    expect(toc.length).toBe(2);
    expect(toc[0].anchor).not.toBe(toc[1].anchor);
    expect(toc[0].anchor.length).toBeGreaterThan(1);
});

test('TC-MLG-02 既存保持域のアンカーは変更前実装と byte 一致（後方互換 pin）', () => {
    // 期待値 = 変更前実装（/[^\w\s　-鿿\u{20000}-\u{2fa1f}\-]/gu）の実出力 fixture。
    // 新クラスは純増のみ = これらの出力は 1 byte も変わってはならない。
    expect(anchorOf('# Hello World')).toBe('hello-world');
    expect(anchorOf('# 日本語見出し')).toBe('日本語見出し');
    expect(anchorOf('# ひらがな カタカナ')).toBe('ひらがな-カタカナ');
    expect(anchorOf('# Test 見出し 1')).toBe('test-見出し-1');
    expect(anchorOf('# C# and F#')).toBe('c-and-f');       // 記号 # は従来どおり除去
    expect(anchorOf('# hy-phen_and_underscore')).toBe('hy-phen_and_underscore');
    expect(anchorOf('# 中文标题')).toBe('中文标题');
});

test('TC-MLG-02b コードブロック内 # の非誤検出（既存挙動 pin）', () => {
    const toc = extractToc('```\n# not heading\n```\n# real\n');
    expect(toc.length).toBe(1);
    expect(toc[0].anchor).toBe('real');
});

/**
 * TC-MLG-03/04/06 — wholeWord 検索の CJK / アクセント対応（FR-MLG-02・ADRL-0080）
 *
 * 規則: クエリが CJK（Han/Hiragana/Katakana/Hangul）を含む → wholeWord 素通し（部分一致）/
 * それ以外 → Unicode lookaround 境界（u フラグ）。u フラグで不正になる pattern（useRegex 等）は
 * 従来 \b に fallback（クラッシュさせない）。
 * 単一真実 = src/shared/whole-word.js（host ts / webview / CLI ミラーの 3 面が共有・ADRL-0059 同型）。
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const wholeWord = require('../../src/shared/whole-word.js');
import { NotesFileManager } from '../../src/shared/notes-file-manager';

test('TC-MLG-03a CJK クエリは wholeWord でも部分一致（「深度」が「測定深度は」にヒット）', () => {
    const re = wholeWord.buildWholeWordRegex('深度', '深度', 'g');
    expect(re.test('測定深度は 10m')).toBe(true);
});

test('TC-MLG-03b アクセント Latin: café がヒットし cafés にはヒットしない', () => {
    const re = wholeWord.buildWholeWordRegex('café', 'café', 'gi');
    expect(re.test('un café au lait')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('les cafés')).toBe(false);
});

test('TC-MLG-03c ASCII の従来挙動不変（word は単語境界のみヒット）', () => {
    const re = wholeWord.buildWholeWordRegex('word', 'word', 'gi');
    expect(re.test('a word here')).toBe(true);
    re.lastIndex = 0;
    expect(re.test('keyword')).toBe(false);
    re.lastIndex = 0;
    expect(re.test('words')).toBe(false);
});

test('TC-MLG-03d ハングルクエリも素通し（부분 일치）', () => {
    const re = wholeWord.buildWholeWordRegex('한글', '한글', 'g');
    expect(re.test('이것은한글입니다')).toBe(true);
});

test('TC-MLG-04 host 配線: NotesFileManager.buildSearchRegex が helper を通る（CJK wholeWord ヒット）', () => {
    const buildSearchRegex = (NotesFileManager.prototype as any)['buildSearchRegex'];
    expect(typeof buildSearchRegex).toBe('function');
    const reCjk = buildSearchRegex.call({}, '深度', { useRegex: false, wholeWord: true, caseSensitive: false });
    // counterfactual: 旧 \b 実装だと CJK クエリは一切マッチしない = RED
    expect(reCjk.test('測定深度は 10m')).toBe(true);
    const reAscii = buildSearchRegex.call({}, 'word', { useRegex: false, wholeWord: true, caseSensitive: false });
    expect(reAscii.test('keyword')).toBe(false);
    expect(reAscii.test('a word here')).toBe(true);
});

test('TC-MLG-04b CLI ミラー一致（fractal-search.mjs buildRegex — extension⇄CLI 同挙動の番人）', async () => {
    const cli = await import('../../ai_skills/fractal-search/scripts/fractal-search.mjs' as string).catch(() => null);
    // CLI は main() 実行ガード付きの想定。import 不可なら子プロセス評価に切替える前に構造を確認する
    if (!cli || typeof (cli as any).buildRegex !== 'function') {
        // buildRegex が export されていない場合は同挙動をソース関数抽出でなく実行で検証できないため、
        // export の追加が実装要件（このテストが RED である間は未配線）
        expect(cli && typeof (cli as any).buildRegex === 'function').toBe(true);
        return;
    }
    const cliRe = (cli as any).buildRegex('深度', { regex: false, caseSensitive: false, wholeWord: true });
    expect(cliRe.test('測定深度は 10m')).toBe(true);
    const cliAscii = (cli as any).buildRegex('word', { regex: false, caseSensitive: false, wholeWord: true });
    expect(cliAscii.test('keyword')).toBe(false);
});

test("TC-MLG-06 'u' フラグ安全性: escape 済みメタ文字クエリで SyntaxError を出さない + useRegex の u 不正 pattern は \\b fallback", () => {
    const esc = (q: string) => q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // 代表メタ文字・ハイフン・スラッシュ入りクエリ（escape 出力が u-mode 合法であること）
    for (const q of ['a.b*c', 'x+y?z', '(paren)', '[brack]', 'pi|pe', 'hy-phen', 'sla/sh', 'back\\slash', '$dollar^']) {
        const re = wholeWord.buildWholeWordRegex(esc(q), q, 'gi');
        expect(re).toBeInstanceOf(RegExp);
        re.lastIndex = 0;
        expect(re.test(`xx ${q} yy`)).toBe(true); // 境界付きでヒット
    }
    // useRegex 相当: u-mode で不正な escape（\- は u で SyntaxError）→ throw せず \b fallback で動く
    const re2 = wholeWord.buildWholeWordRegex('a\\-b', 'a\\-b', 'gi');
    expect(re2).toBeInstanceOf(RegExp);
    expect(re2.test('x a-b y')).toBe(true);
});

/**
 * TC-MLG-05 (静的部) — notes-tab-manager.js の raw 英語 label 残存なし + i18n キー 8 ヒット
 * （FR-MLG-03。動的部 = メニュー文言の ja 表示は test/specs/tab-menu-i18n.spec.ts）
 */
import * as fs from 'fs';
import * as path from 'path';

const TAB_KEYS = ['tabOpenInStandalone', 'tabOpenInOsDefaultApp', 'tabDuplicate', 'tabCloseOthers', 'tabCloseAria', 'tabNewAria', 'tabUntitled'];

test('TC-MLG-05a notes-tab-manager.js の label が i18n キー参照になっている（grep 番人）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-tab-manager.js'), 'utf8');
    // 直書き第一引数（addTabMenuItem(menu, '英語')）・直書き aria-label・直書き 'Untitled' return の禁止。
    // 既存規約（notes-file-panel）どおり `i18n.<key> || '英語'` のフォールバック形は許容（キー登録は 05b が番人）。
    expect(/addTabMenuItem\(menu,\s*'/.test(src), 'menu label が直書き').toBe(false);
    expect(/setAttribute\('aria-label',\s*'/.test(src), 'aria-label が直書き').toBe(false);
    expect(/return\s+'Untitled'/.test(src), "'Untitled' が直書き return").toBe(false);
    // 全キーが参照されている
    for (const key of TAB_KEYS) {
        expect(new RegExp(`\\b${key}\\b`).test(src), `${key} 参照なし`).toBe(true);
    }
});

test('TC-MLG-05b 新設タブ menu キーが interface + 7 locale の 8 ヒット（NFR-BAT-02）', () => {
    const i18nDir = path.join(__dirname, '../../src/i18n');
    const files = [
        'messages.ts',
        'locales/en.ts', 'locales/ja.ts', 'locales/es.ts', 'locales/fr.ts',
        'locales/ko.ts', 'locales/zh-cn.ts', 'locales/zh-tw.ts',
    ];
    for (const key of TAB_KEYS) {
        for (const f of files) {
            const body = fs.readFileSync(path.join(i18nDir, f), 'utf8');
            expect(new RegExp(`\\b${key}\\b`).test(body), `${key} が ${f} に未登録`).toBe(true);
        }
    }
});
