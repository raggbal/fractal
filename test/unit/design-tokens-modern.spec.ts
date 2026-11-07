/**
 * design-tokens-modern.spec.ts — デザイン token の機械の番人（docs/design/modern-2026.md §10.5 の G1〜G5）
 *
 * 計算後の色を 1 つずつ e2e で見るのではなく、token の「定義そのもの」を読んで構造と数字を確かめる:
 *   G1 テーマの 3 ブロック（light / dark / auto + OS dark）が同じ key を持ち、dark と auto-dark が同じ値
 *   G2 文字 × 面、ボタン・tag・指標の組がコントラストの基準（文字 4.5:1・指標 3:1）以上（§4。式は付録 A）
 *   G2c 線・pill の段差（WCAG の対象外の「見え方の目安」）が下限以上 — 浮く面の中の区切り線・focus 行の上の tag 等
 *   G3 chrome の src に VS Code のテーマの色（var(--vscode-…)）が無い（VS Code の UI として描く 2 ファイルを除く。
 *      書体・文字の大きさの変数は色でないので対象外 — text viewer は利用者の editor の書体と大きさに従う）
 *   G4 参照している --fr-* がすべて tokens.css で定義されている（--fr-bg-selection は逆に定義しない — ADRL-0115）
 *   G5 tokens.css に color-mix( / light-dark( が無い（計算後の値の形が変わる・Chromium 114 で動かない — §9 D5）
 *
 * どれも、わざと壊したときに落ちることを 1 度確かめてから入れた（各 test の「壊し方」）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const TOKENS_PATH = 'src/webview/tokens.css';

// ───────────────────────────── tokens.css の読み取り ─────────────────────────────

function stripComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

/** `from` 以降で最初に出る `{` から対応する `}` までの中身 */
function blockBody(css: string, from: number): string {
    const open = css.indexOf('{', from);
    if (open < 0) { throw new Error('block not found'); }
    let depth = 0;
    for (let i = open; i < css.length; i++) {
        if (css[i] === '{') { depth++; }
        if (css[i] === '}') {
            depth--;
            if (depth === 0) { return css.slice(open + 1, i); }
        }
    }
    throw new Error('unbalanced block');
}

/** `name: value;` の並びを key → value の表にする（1 行に複数の宣言があってもよい） */
function declarations(body: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const part of body.split(';')) {
        const m = /^\s*([a-zA-Z-][\w-]*)\s*:\s*([\s\S]+?)\s*$/.exec(part);
        if (m) { out.set(m[1], m[2].replace(/\s+/g, ' ')); }
    }
    return out;
}

interface TokenBlocks { ramp: Map<string, string>; light: Map<string, string>; dark: Map<string, string>; autoDark: Map<string, string>; }

function tokenBlocks(css: string = read(TOKENS_PATH)): TokenBlocks {
    const c = stripComments(css);
    const lightAt = c.indexOf(':root[data-fr-theme="light"]');
    const darkAt = c.indexOf(':root[data-fr-theme="dark"]');
    const mediaAt = c.indexOf('@media (prefers-color-scheme: dark)');
    const autoAt = c.indexOf(':root[data-fr-theme="auto"]', mediaAt);
    const rampAt = c.indexOf('--fr-accent-600');
    expect(lightAt, 'light のブロックが無い').toBeGreaterThan(0);
    expect(darkAt, 'dark のブロックが無い').toBeGreaterThan(0);
    expect(mediaAt, 'auto + OS dark のブロックが無い').toBeGreaterThan(0);
    expect(autoAt, 'auto + OS dark のブロックが無い').toBeGreaterThan(mediaAt);
    expect(rampAt, 'accent ramp が無い').toBeGreaterThan(0);
    const rampStart = c.lastIndexOf(':root', rampAt);
    return {
        ramp: declarations(blockBody(c, rampStart)),
        light: declarations(blockBody(c, lightAt)),
        dark: declarations(blockBody(c, darkAt)),
        autoDark: declarations(blockBody(c, autoAt)),
    };
}

// ───────────────────────────── 色の計算（付録 A） ─────────────────────────────

type RGBA = { r: number; g: number; b: number; a: number };

function parseColor(v: string): RGBA {
    const s = v.trim();
    let m = /^#([0-9a-fA-F]{6})$/.exec(s);
    if (m) {
        const n = parseInt(m[1], 16);
        return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
    }
    m = /^#([0-9a-fA-F]{3})$/.exec(s);
    if (m) {
        const [r, g, b] = m[1].split('').map((h) => parseInt(h + h, 16));
        return { r, g, b, a: 1 };
    }
    m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(s);
    if (m) { return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] }; }
    throw new Error('色として読めない: ' + v);
}

/** var() を同じテーマの表（無ければ ramp）で展開した値 */
function resolve(theme: Map<string, string>, ramp: Map<string, string>, name: string, depth = 0): string {
    if (depth > 10) { throw new Error('var() の循環: ' + name); }
    const raw = theme.get(name) ?? ramp.get(name);
    if (raw === undefined) { throw new Error('未定義の token: ' + name); }
    return raw.replace(/var\(\s*(--[\w-]+)\s*\)/g, (_, n) => resolve(theme, ramp, n, depth + 1));
}

function lin(c: number): number {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
function luminance(c: RGBA): number {
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}
function contrast(a: RGBA, b: RGBA): number {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}
/** 半透明を下の面に重ねる（測る前に必ず合成する — 付録 A の over） */
function over(top: RGBA, base: RGBA): RGBA {
    const a = top.a;
    return {
        r: Math.round(top.r * a + base.r * (1 - a)),
        g: Math.round(top.g * a + base.g * (1 - a)),
        b: Math.round(top.b * a + base.b * (1 - a)),
        a: 1,
    };
}

/** css の中で selector の規則（`selector {`）の中身。無ければ null */
function ruleBody(css: string, selector: string): string | null {
    const c = stripComments(css);
    const at = c.indexOf(selector + ' {');
    if (at < 0) { return null; }
    return blockBody(c, at);
}

// ───────────────────────────── G1 ─────────────────────────────

test('G1 テーマの 3 ブロックが同じ key を持ち、dark と auto + OS dark が同じ値', () => {
    const { light, dark, autoDark } = tokenBlocks();
    const keys = (m: Map<string, string>) => Array.from(m.keys()).sort();
    expect(light.size, 'light のブロックが空').toBeGreaterThan(50);
    expect(keys(dark), 'dark と auto + OS dark で key が違う（3 回の書き写しの漏れ）').toEqual(keys(autoDark));
    expect(keys(light), 'light と dark で key が違う（片方のテーマだけ token が無い）').toEqual(keys(dark));
    const diff = keys(dark).filter((k) => dark.get(k) !== autoDark.get(k)).map((k) => `${k}: ${dark.get(k)} ≠ ${autoDark.get(k)}`);
    expect(diff, 'dark と auto + OS dark で値が違う').toEqual([]);
    // native の checkbox / select / scrollbar の色もテーマに合わせる（§3.14-3）
    expect(light.get('color-scheme')).toBe('light');
    expect(dark.get('color-scheme')).toBe('dark');
    // 壊し方: auto + OS dark の --fr-color-bg-app を 1 文字変える → 値の diff で落ちる
});

// ───────────────────────────── G2 ─────────────────────────────

/** WCAG の基準: 意味のある文字 4.5:1、指標（focus ring・drop 線・checkbox・mindmap の枝）3:1 */
const TEXT = 4.5;
const INDICATOR = 3.0;

/** outliner の node 選択の amber（ADRL-0115。outliner.css に rgba の直書きで置く — light / dark で別の alpha） */
function amber(theme: 'light' | 'dark'): RGBA {
    const lines = read('src/webview/outliner.css').split('\n').filter((l) => /--outliner-selection-bg\s*:/.test(l));
    const vals = lines.map((l) => parseColor(/:\s*(rgba?\([^)]*\))/.exec(l)![1]));
    // 1 行目 = light（@layer fr-legacy の :root）、2・3 行目 = dark / auto + OS dark
    return theme === 'light' ? vals[0] : vals[1];
}

/** outliner.css の .outliner-chip-remove の休みの不透明度 */
function chipRemoveOpacity(): number {
    const body = ruleBody(read('src/webview/outliner.css'), '.outliner-chip-remove');
    expect(body, '.outliner-chip-remove の規則が無い').not.toBeNull();
    const m = /opacity\s*:\s*([\d.]+)/.exec(body!);
    return m ? +m[1] : 1;
}

/** styles.css の dark の hljs の色（[data-fr-theme="dark"] .hljs-xxx { color: #… }） */
function hljsDarkColors(): [string, string][] {
    const out: [string, string][] = [];
    for (const m of read('src/webview/styles.css').matchAll(/\[data-fr-theme="dark"\] \.(hljs-[\w-]+)\s*\{\s*color:\s*(#[0-9a-fA-F]{6})/g)) {
        out.push([m[1], m[2]]);
    }
    expect(out.length, 'dark の hljs の色が見つからない').toBeGreaterThan(8);
    return out;
}

function pairsFor(themeName: 'light' | 'dark', blocks: TokenBlocks): { name: string; fg: RGBA; bg: RGBA; min: number }[] {
    const theme = themeName === 'light' ? blocks.light : blocks.dark;
    const c = (n: string) => parseColor(resolve(theme, blocks.ramp, n));
    const app = c('--fr-color-bg-app');
    const panel = c('--fr-color-bg-panel');
    const elevated = c('--fr-color-bg-elevated');
    const surfaces: Record<string, RGBA> = {
        '本文': app,
        'sidebar': panel,
        '浮く面': elevated,
        'field/本文': over(c('--fr-color-fill-subtle'), app),
        'field/sidebar': over(c('--fr-color-fill-subtle'), panel),
        'hover/sidebar': over(c('--fr-color-fill-hover'), panel),
        'hover/浮く面': over(c('--fr-color-fill-hover'), elevated),
        'active/sidebar': over(c('--fr-color-fill-active'), panel),
        '選択': over(c('--fr-color-selection-bg'), app),
        'inline code': over(c('--fr-color-code-bg'), app),
        'code block': over(c('--fr-color-code-block-bg'), app),
    };
    const texts = ['--fr-color-text-primary', '--fr-color-text-secondary', '--fr-color-text-tertiary',
        '--fr-color-primary-strong', '--fr-color-danger', '--fr-color-success-text', '--fr-color-warning-text'];
    const out: { name: string; fg: RGBA; bg: RGBA; min: number }[] = [];
    for (const t of texts) {
        for (const [sname, s] of Object.entries(surfaces)) { out.push({ name: `${t} × ${sname}`, fg: c(t), bg: s, min: TEXT }); }
    }
    const white = parseColor('#FFFFFF');
    const combo = (name: string, fg: RGBA, bg: RGBA, min: number) => out.push({ name, fg, bg, min });
    combo('主ボタン（primary-fg / primary）', c('--fr-color-primary-fg'), c('--fr-color-primary'), TEXT);
    combo('主ボタン hover', c('--fr-color-primary-fg'), c('--fr-color-primary-hover'), TEXT);
    combo('主ボタン 押下', c('--fr-color-primary-fg'), c('--fr-color-primary-active'), TEXT);
    combo('危険ボタン（白 / danger-solid）', white, c('--fr-color-danger-solid'), TEXT);
    combo('toast（text-inverse / bg-inverse）', c('--fr-color-text-inverse'), c('--fr-color-bg-inverse'), TEXT);
    combo('tag（primary-strong / primary-soft）', c('--fr-color-primary-strong'), c('--fr-color-primary-soft'), TEXT);
    combo('tag の hover・focus 行の上の tag（primary-strong-hover / primary-soft-hover）', c('--fr-color-primary-strong-hover'), c('--fr-color-primary-soft-hover'), TEXT);
    combo('success-text / success-soft', c('--fr-color-success-text'), c('--fr-color-success-soft'), TEXT);
    combo('warning-text / warning-soft', c('--fr-color-warning-text'), c('--fr-color-warning-soft'), TEXT);
    combo('danger / danger-soft（危険項目の hover）', c('--fr-color-danger'), c('--fr-color-danger-soft'), TEXT);
    combo('本文 / ::selection', c('--fr-color-text-primary'), over(c('--fr-color-text-selection'), app), TEXT);
    combo('本文 / search-hit', c('--fr-color-text-primary'), over(c('--fr-color-search-hit'), app), TEXT);
    combo('本文 / search-current', c('--fr-color-text-primary'), over(c('--fr-color-search-current'), app), TEXT);
    combo('本文 / outliner の amber 選択', c('--fr-color-text-primary'), over(amber(themeName), app), TEXT);
    combo('subtext（secondary）/ amber 選択', c('--fr-color-text-secondary'), over(amber(themeName), app), TEXT);
    combo('subtext（secondary）/ focus 行', c('--fr-color-text-secondary'), over(c('--fr-color-selection-bg'), app), TEXT);
    combo('menu の shortcut（hover 行では secondary）', c('--fr-color-text-secondary'), surfaces['hover/浮く面'], TEXT);
    combo('primary（drop 線・resize バー・checkbox）/ 本文', c('--fr-color-primary'), app, INDICATOR);
    combo('primary / sidebar', c('--fr-color-primary'), panel, INDICATOR);
    combo('focus-ring / 本文', c('--fr-color-focus-ring'), app, INDICATOR);
    combo('focus-ring / sidebar', c('--fr-color-focus-ring'), panel, INDICATOR);
    combo('focus-ring / 浮く面', c('--fr-color-focus-ring'), elevated, INDICATOR);
    combo('connector（mindmap の枝）/ 本文', c('--fr-color-connector'), app, INDICATOR);
    // 検索の結果から飛んだ先の flash（md の段落・outliner の行・note tree の行）。tree の行は強い方で始まる
    combo('本文 / jump-flash', c('--fr-color-text-primary'), over(c('--fr-color-jump-flash'), app), TEXT);
    combo('本文 / jump-flash-strong', c('--fr-color-text-primary'), over(c('--fr-color-jump-flash-strong'), app), TEXT);
    combo('sidebar の文字 / jump-flash-strong', c('--fr-color-text-primary'), over(c('--fr-color-jump-flash-strong'), panel), TEXT);
    // 危険な項目の hover（danger-soft）の上の shortcut（hover した行では secondary）
    combo('危険な項目の shortcut（secondary / danger-soft）', c('--fr-color-text-secondary'), c('--fr-color-danger-soft'), TEXT);
    const removeOpacity = chipRemoveOpacity();
    for (const color of ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'zinc']) {
        combo(`chip ${color}`, c(`--fr-chip-${color}-fg`), c(`--fr-chip-${color}-bg`), TEXT);
        // chip の × は押せる部品（指標 3:1）。不透明度は outliner.css の .outliner-chip-remove の値
        combo(`chip ${color} の ×（不透明度 ${removeOpacity}）`, over({ ...c(`--fr-chip-${color}-fg`), a: removeOpacity }, c(`--fr-chip-${color}-bg`)), c(`--fr-chip-${color}-bg`), INDICATOR);
    }
    // md の code block の中の hljs の色（styles.css の GitHub dark の値）。dark の code block の地を変えたら確かめる。
    // light は GitHub light の値のまま（中身の色なので変えない — §3.9。keyword / tag は 4.3:1 前後）
    if (themeName === 'dark') {
        for (const [cls, hex] of hljsDarkColors()) {
            combo(`hljs ${cls}（dark）/ code block`, parseColor(hex), over(c('--fr-color-code-block-bg'), app), TEXT);
        }
    }
    return out;
}

/**
 * dark で 4.5:1 に届かない 4 組（§4.3）。どれも部品の決まりで「その組を作らない」:
 * hover した menu 行の shortcut と選択行の補足は secondary に切り替え、危険な項目の hover は danger-soft にする。
 * ここに無い組が基準を割ったら落ちる。ここにある組が基準を満たすようになっても落ちる（表を最新に保つ）
 */
const AVOIDED_DARK = [
    '--fr-color-text-tertiary × hover/浮く面',
    '--fr-color-text-tertiary × 選択',
    '--fr-color-danger × hover/浮く面',
    '--fr-color-danger × 選択',
];

test('G2 文字 × 面とボタン・tag・指標の組がコントラストの基準以上（light / dark）', () => {
    const blocks = tokenBlocks();
    for (const themeName of ['light', 'dark'] as const) {
        const rows = pairsFor(themeName, blocks).map((p) => ({ ...p, ratio: contrast(p.fg, p.bg) }));
        expect(rows.length).toBeGreaterThan(90);
        const avoided = themeName === 'dark' ? AVOIDED_DARK : [];
        const failing = rows.filter((r) => r.ratio < r.min && !avoided.includes(r.name))
            .map((r) => `${themeName}: ${r.name} = ${r.ratio.toFixed(2)} < ${r.min}`);
        expect(failing, '基準に届かない組（値を変えたら付録 A の式で確かめる）').toEqual([]);
        const stale = avoided.filter((n) => { const r = rows.find((x) => x.name === n); return !r || r.ratio >= r.min; });
        expect(stale, `逃がしの表（AVOIDED_DARK）が古い — 基準を満たすようになった組: ${stale.join(', ')}`).toEqual([]);
    }
    // 壊し方: light の --fr-color-text-tertiary を以前の #9BA0A8 に戻す → 「text-tertiary × 本文 = 2.51」などで落ちる
});

test('G2b 逃がしの組を作らない決まりが CSS に入っている（hover した menu 行の shortcut は secondary・危険な項目の hover は danger-soft）', () => {
    const outliner = read('src/webview/outliner.css');
    const styles = read('src/webview/styles.css');
    expect(outliner).toMatch(/\.outliner-context-menu-item:hover:not\(\.disabled\) \.context-menu-shortcut\s*\{\s*color: var\(--fr-color-text-secondary\)/);
    expect(styles).toMatch(/\.editor-context-menu-item:hover:not\(\.disabled\) \.context-menu-shortcut\s*\{\s*color: var\(--fr-color-text-secondary\)/);
    const notes = read('src/shared/notes-body-html.js');
    expect(notes).toMatch(/\.file-panel-context-item\.danger:hover \{ background: var\(--fr-color-danger-soft/);
    expect(read('src/shared/notes-folder-view.js')).toMatch(/\.fv-menu-item\.danger:hover \{ background: var\(--fr-color-danger-soft\)/);
    // 8 つの menu の危険な項目は同じ見た目（§7.6）: outliner の右クリック（Delete Node 等）と mindmap の group の menu（Delete Group）
    expect(outliner).toMatch(/\.outliner-context-menu-item\.danger \{ color: var\(--fr-color-danger\); \}/);
    expect(outliner).toMatch(/\.outliner-context-menu-item\.danger:hover:not\(\.disabled\) \{ background: var\(--fr-color-danger-soft\); \}/);
    const mindmap = read('src/webview/mindmap.css');
    expect(mindmap).toMatch(/\.mindmap-ctx-item\.danger \{ color: var\(--fr-color-danger\); \}/);
    expect(mindmap).toMatch(/\.mindmap-ctx-item\.danger:hover \{ background: var\(--fr-color-danger-soft\); \}/);
    // 壊し方: outliner.css の .outliner-context-menu-item.danger:hover を fill-hover に → 落ちる
});

/** 見え方の目安（WCAG の対象外）の下限。線は 1.2:1（light の divider / 本文 = 1.23 と同じ見え方）、pill の段差は 1.15:1 */
const LINE_STEP = 1.2;
const PILL_STEP = 1.15;

test('G2c 線と pill の段差（見え方の目安）が下限以上 — 浮く面の中の区切り・focus 行の上の tag', () => {
    const blocks = tokenBlocks();
    for (const themeName of ['light', 'dark'] as const) {
        const theme = themeName === 'light' ? blocks.light : blocks.dark;
        const c = (n: string) => parseColor(resolve(theme, blocks.ramp, n));
        const app = c('--fr-color-bg-app');
        const rows: [string, RGBA, RGBA, number][] = [
            ['divider / 本文（面の境目・ヘッダーの下）', c('--fr-color-divider'), app, LINE_STEP],
            ['border / 浮く面（menu・popover・浮く toolbar の中の区切り）', c('--fr-color-border'), c('--fr-color-bg-elevated'), LINE_STEP],
            ['primary-soft-hover / primary-soft（tag の hover、focus 行・選択した node の上の tag の pill）', c('--fr-color-primary-soft-hover'), c('--fr-color-primary-soft'), PILL_STEP],
            ['selection-bg / 本文（focus 行・複数選択の塗り）', over(c('--fr-color-selection-bg'), app), app, PILL_STEP],
        ];
        const failing = rows.map(([n, a, b, min]) => ({ n, r: contrast(a, b), min })).filter((x) => x.r < x.min)
            .map((x) => `${themeName}: ${x.n} = ${x.r.toFixed(3)} < ${x.min}`);
        expect(failing).toEqual([]);
    }
    // 壊し方: dark の --fr-accent-soft-hover-dark を以前の #273A5A に戻す → 「primary-soft-hover / primary-soft = 1.064」で落ちる
});

test('G2d 浮く面の中の区切り線は border で引く（divider は dark の浮く面 #2A2A2E の上で 1.06:1 になり見えない）', () => {
    const styles = read('src/webview/styles.css');
    const outliner = read('src/webview/outliner.css');
    const rules: [string, string, string][] = [
        ['outliner.css', outliner, '.outliner-context-menu-separator'],
        ['outliner.css', outliner, '.outliner-col-ctx-sep'],
        ['styles.css', styles, '.editor-context-menu-separator'],
        ['styles.css', styles, '.table-toolbar .separator'],
        ['styles.css', styles, '.command-palette-search'],
        ['styles.css', styles, '.attachments-panel-header'],
        ['styles.css', styles, '.action-panel-confirm-btn'],
    ];
    const bad: string[] = [];
    for (const [file, css, sel] of rules) {
        const body = ruleBody(css, sel);
        if (body === null) { bad.push(`${file} ${sel}: 規則が無い`); continue; }
        if (!body.includes('var(--fr-color-border)') || body.includes('--fr-color-divider')) { bad.push(`${file} ${sel}: ${body.replace(/\s+/g, ' ').trim()}`); }
    }
    expect(bad).toEqual([]);
    // 壊し方: styles.css の .editor-context-menu-separator を var(--fr-color-divider) に戻す → 落ちる
});

// ───────────────────────────── G3 ─────────────────────────────

/** VS Code の UI として描く webview（Fractal の画面ではない）だけは VS Code のテーマの色を読んでよい */
const VSCODE_UI_FILES = new Set(['src/sync-conflict-dialog.ts', 'src/notesMigrationGate.ts']);

function srcFiles(dir = 'src'): string[] {
    const out: string[] = [];
    for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = path.posix.join(dir, e.name);
        if (e.isDirectory()) { out.push(...srcFiles(rel)); continue; }
        if (/\.(css|js|mjs|ts)$/.test(e.name)) { out.push(rel); }
    }
    return out;
}

/** 色でない VS Code の変数（利用者の editor の書体と文字の大きさ）。text viewer の中身はこれに従う（§5.4） */
const VSCODE_FONT_VARS = new Set(['editor-font-family', 'editor-font-size', 'editor-font-weight', 'font-family', 'font-size', 'font-weight']);

test('G3 chrome の src に VS Code のテーマの色（var(--vscode-…)）が無い', () => {
    const hits: string[] = [];
    for (const f of srcFiles()) {
        if (VSCODE_UI_FILES.has(f)) { continue; }
        read(f).split('\n').forEach((line, i) => {
            const names = Array.from(line.matchAll(/var\(--vscode-([\w-]+)/g)).map((m) => m[1]);
            if (names.some((n) => !VSCODE_FONT_VARS.has(n))) { hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 120)}`); }
        });
    }
    expect(hits, 'Fractal の画面が VS Code のテーマの色を読んでいる（docs/design/modern-2026.md P7）').toEqual([]);
    // 壊し方: outliner.css の .outliner-drop-indicator を var(--vscode-focusBorder, #007acc) に戻す → 落ちる
});

// ───────────────────────────── G4 ─────────────────────────────

test('G4 参照している --fr-* がすべて tokens.css で定義されている（--fr-bg-selection は定義しない）', () => {
    const tokens = stripComments(read(TOKENS_PATH));
    const defined = new Set(Array.from(tokens.matchAll(/(--fr-[\w-]+)\s*:/g)).map((m) => m[1]));
    const missing: string[] = [];
    for (const f of srcFiles()) {
        for (const m of read(f).matchAll(/var\(\s*(--fr-[\w-]+)/g)) {
            if (!defined.has(m[1])) { missing.push(`${f}: ${m[1]}`); }
        }
    }
    expect(Array.from(new Set(missing)), '存在しない token 名を参照している（2 つ目の命名体系を作らない — §10.3）').toEqual([]);
    // ADRL-0115 / TC-OSM-34: 定義すると mindmap / outliner の選択色が連動してしまう
    expect(defined.has('--fr-bg-selection'), '--fr-bg-selection を定義している').toBe(false);
    // 壊し方: mindmap.css の .mindmap-node-box の color を var(--fr-text, #222) に戻す → 「--fr-text」で落ちる
});

// ───────────────────────────── G5 ─────────────────────────────

test('G5 tokens.css に color-mix( / light-dark( が無い（値は 16 進か rgb / rgba の直書き）', () => {
    const tokens = stripComments(read(TOKENS_PATH));
    expect(tokens.includes('color-mix('), 'color-mix() は計算後の値が color(srgb …) で返り rgb() を前提にした test が壊れる').toBe(false);
    expect(tokens.includes('light-dark('), 'light-dark() は VS Code ^1.85（Chromium 114）で動かない').toBe(false);
    // テーマの値（色）は 16 進・rgb / rgba・var() 参照・transparent のどれか
    const { light, dark } = tokenBlocks();
    const bad: string[] = [];
    for (const [name, m] of [['light', light], ['dark', dark]] as const) {
        for (const [k, v] of m) {
            if (!/^--fr-(color|chip)-/.test(k)) { continue; }
            if (!/^(#[0-9a-fA-F]{3,8}|rgba?\([^()]*(var\(--fr-[\w-]+\)[^()]*)?\)|var\(--fr-[\w-]+\)|transparent)$/.test(v)) { bad.push(`${name} ${k}: ${v}`); }
        }
    }
    expect(bad).toEqual([]);
    // 壊し方: light の --fr-color-fill-hover を color-mix(in srgb, #18181B 5.5%, transparent) にする → 落ちる
});
