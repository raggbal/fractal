/**
 * design-modern-review-fixes.spec.ts — modern-2026（docs/design/modern-2026.md）のレビュー指摘の直し（§12.5）を、
 * 本番と同じ CSS / JS を読むハーネスで振る舞いとして確かめる。
 *
 *   TC-DMR-01 タブの × にキーボードで来たら見える（不透明度 0 のままだと ring も × も描かれない）
 *   TC-DMR-02 先頭の選択タブは左に線を引かない（sidebar の右の線と 2 本にならない）。2 番目以降の選択タブは引く
 *   TC-DMR-03 linkedfd の行の左右の端（塗りの外の 6px）も行として当たる（drop が root へ・右クリックが空き領域の menu にならない）
 *   TC-DMR-04 drawio の画像の上のボタンは画像の幅の中に収まる（はみ出さず折り返す）
 *   TC-DMR-05 code block の言語の名前は block の右上の角にある（隠れているボタンの箱の分だけ浮かない）
 *   TC-DMR-06 PDF の清書: 画面が dark のとき mermaid の図は light の theme で描き直す（message の経路）。画面の次の描画には漏れない
 *   TC-DMR-07 focus 行・選択した mindmap の node の上の tag は、行・node の地と見分けられる（dark / light）
 *   TC-DMR-08 outliner の右クリックの Delete Node は危険な項目の見た目（他の menu と同じ）
 *   TC-DMR-09 md の Outline の下の語数は切れない（幅が足りなければ「· 」の後ろで折り返す）
 */
import { test, expect, Page } from '@playwright/test';
import * as path from 'path';

/** rgb()/rgba() の文字列 → WCAG の相対輝度の比 */
function rgbOf(s: string): [number, number, number] {
    const m = /rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/.exec(s);
    if (!m) { throw new Error('rgb として読めない: ' + s); }
    return [+m[1], +m[2], +m[3]];
}
function contrast(a: string, b: string): number {
    const lin = (c: number) => { const v = c / 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    const lum = (rgb: [number, number, number]) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
    const [hi, lo] = [lum(rgbOf(a)), lum(rgbOf(b))].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
}

async function bootNotes(page: Page) {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

async function bootNotesWithTabs(page: Page) {
    await bootNotes(page);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, rootIds: ['n1'], nodes: { n1: { id: 'n1', text: 'a', children: [] } } });
        (window as any).__testApi.initTabManager();
        const tm = (window as any).__notesTabManager;
        tm.initFirstTab('/note/a.out', 'out');
        tm.openInNewTab('/note/b.md', 'md');
        tm.openInNewTab('/note/c.out', 'out');
    });
}

test('TC-DMR-01 タブの × にキーボードで来たら見える（不透明度 1・ring）', async ({ page }) => {
    await bootNotesWithTabs(page);
    // 先頭のタブを選ぶ → 2・3 番目のタブの × は休みでは隠れている
    await page.evaluate(() => {
        const first = document.querySelector('#notesTabBar .notes-tab') as HTMLElement;
        (window as any).__notesTabManager.activateTab(first.dataset.tabId);
    });
    await page.mouse.move(1, 700);
    const hiddenAtRest = await page.evaluate(() => getComputedStyle(document.querySelectorAll('#notesTabBar .notes-tab-close')[2]).opacity);
    expect(hiddenAtRest, '休みの非選択タブの × は隠れている（§7.9 の決まりは変えない）').toBe('0');
    await page.locator('#notesTabBar .notes-tab-add').focus();
    await page.keyboard.press('Shift+Tab');
    const r = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement;
        const tab = a.closest('.notes-tab') as HTMLElement | null;
        const cs = getComputedStyle(a);
        return { isClose: a.classList.contains('notes-tab-close'), inactive: !!tab && tab.dataset.active !== 'true', fv: a.matches(':focus-visible'), opacity: cs.opacity, outline: cs.outlineStyle + ' ' + cs.outlineWidth };
    });
    expect(r.isClose, 'Shift+Tab で非選択タブの × に来る').toBe(true);
    expect(r.inactive).toBe(true);
    expect(r.fv).toBe(true);
    expect(r.opacity, 'キーボードの focus では × を見せる').toBe('1');
    expect(r.outline).toBe('solid 2px');
});

test('TC-DMR-02 先頭の選択タブは左に線を引かない（sidebar の線と 2 本にならない）', async ({ page }) => {
    await bootNotesWithTabs(page);
    const borders = await page.evaluate(() => {
        const tm = (window as any).__notesTabManager;
        const tabs = () => Array.from(document.querySelectorAll('#notesTabBar .notes-tab')) as HTMLElement[];
        tm.activateTab(tabs()[0].dataset.tabId);
        const first = getComputedStyle(tabs()[0]);
        const firstOut = { left: first.borderLeftColor, right: first.borderRightColor };
        tm.activateTab(tabs()[1].dataset.tabId);
        const second = getComputedStyle(tabs()[1]);
        const probe = document.createElement('div'); probe.style.color = 'var(--fr-color-divider)'; document.body.appendChild(probe);
        const divider = getComputedStyle(probe).color; probe.remove();
        return { first: firstOut, second: { left: second.borderLeftColor, right: second.borderRightColor }, divider };
    });
    expect(borders.first.left, '先頭の選択タブの左の線は透明').toBe('rgba(0, 0, 0, 0)');
    expect(borders.first.right).toBe(borders.divider);
    expect(borders.second.left, '2 番目の選択タブは左右に divider（strip と区切る）').toBe(borders.divider);
    expect(borders.second.right).toBe(borders.divider);
});

test('TC-DMR-03 linkedfd の行は左右の端（塗りの外の 6px）も行として当たる', async ({ page }) => {
    await bootNotes(page);
    await page.evaluate(() => {
        (window as any).__folderViewDispatcher.showFolderView('fl1', 'Docs');
        window.postMessage({
            type: 'folderViewListResult', folderLinkId: 'fl1', relPath: '',
            entries: [
                { name: 'dirA', relPath: 'dirA', isDir: true },
                { name: 'b.md', relPath: 'b.md', isDir: false },
            ],
        }, '*');
    });
    await page.waitForSelector('.fv-row[data-rel="b.md"]', { timeout: 5000 });
    const r = await page.evaluate(() => {
        const tree = (document.querySelector('.fv-tree') as HTMLElement).getBoundingClientRect();
        const row = document.querySelector('.fv-row[data-rel="b.md"]') as HTMLElement;
        row.classList.add('fv-selected');
        const rr = row.getBoundingClientRect();
        const y = rr.top + rr.height / 2;
        const hit = (x: number) => { const el = document.elementFromPoint(x, y) as HTMLElement | null; const rowEl = el && el.closest('.fv-row') as HTMLElement | null; return rowEl ? rowEl.dataset.rel : (el ? el.className : null); };
        const cs = getComputedStyle(row);
        return { left: hit(tree.left + 2), right: hit(tree.right - 2), rowLeft: rr.left - tree.left, rowRight: tree.right - rr.right, clip: cs.backgroundClip, borderLeft: cs.borderLeftWidth };
    });
    expect(r.left, '左端 2px が行に当たる（margin の時代は .fv-tree = root への drop・空き領域の menu）').toBe('b.md');
    expect(r.right).toBe('b.md');
    expect(r.rowLeft).toBeLessThan(1);
    expect(r.rowRight).toBeLessThan(1);
    // 塗りは今までどおり端から 6px 内側（透明な縁 + background-clip）
    expect(r.clip).toBe('padding-box');
    expect(r.borderLeft).toBe('6px');
});

test('TC-DMR-04 drawio の画像の上のボタンは画像の幅の中に収まる（折り返す・重ならない）', async ({ page }) => {
    const html = path.resolve(__dirname, '../../test/html/standalone-editor.html');
    await page.goto('file://' + html);
    await page.waitForFunction(() => (window as any).__testApi);
    await page.evaluate(() => {
        const editor = document.querySelector('.editor') as HTMLElement;
        const img = document.createElement('img');
        img.src = '/tmp/x/diagram.drawio.svg';
        (img as any).dataset.markdownPath = 'files/diagram.drawio.svg';
        img.style.width = '260px'; img.style.height = '90px'; img.style.display = 'block';
        editor.prepend(img);
    });
    // 画像の左下の角に乗せる（真ん中は 2 行目に折り返したボタンが覆う）
    await page.locator('img[src$="diagram.drawio.svg"]').hover({ position: { x: 6, y: 84 } });
    await page.waitForTimeout(100);
    const r = await page.evaluate(() => {
        const img = (document.querySelector('img[src$="diagram.drawio.svg"]') as HTMLElement).getBoundingClientRect();
        const btns = (Array.from(document.querySelectorAll('.drawio-open-btn')) as HTMLElement[]).filter((b) => b.style.display !== 'none')
            .map((b) => { const x = b.getBoundingClientRect(); return { l: x.left, r: x.right, t: x.top, b: x.bottom, w: x.width }; });
        return { img: { l: img.left, r: img.right, t: img.top }, btns };
    });
    expect(r.btns.length).toBe(4);
    const total = r.btns.reduce((s, b) => s + b.w, 0);
    expect(total, '4 つを 1 行に並べると画像より広い（この test の前提）').toBeGreaterThan(r.img.r - r.img.l);
    for (const b of r.btns) {
        expect(b.l, 'ボタンは画像の左端を越えない').toBeGreaterThanOrEqual(r.img.l);
        expect(b.r, 'ボタンは画像の右端を越えない').toBeLessThanOrEqual(r.img.r);
        expect(b.t).toBeGreaterThanOrEqual(r.img.t);
    }
    for (let i = 0; i < r.btns.length; i++) {
        for (let j = i + 1; j < r.btns.length; j++) {
            const a = r.btns[i], c = r.btns[j];
            const overlap = a.l < c.r && c.l < a.r && a.t < c.b && c.t < a.b;
            expect(overlap, `ボタン ${i} と ${j} が重ならない`).toBe(false);
        }
    }
});

test('TC-DMR-05 code block の言語の名前は block の右上の角にある', async ({ page }) => {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => (window as any).__testApi.setMarkdown('# t\n\n```ts\nconst a = 1;\n```\n'));
    await page.waitForSelector('.editor pre .code-lang-tag');
    await page.mouse.move(2, 2);   // block の外（ボタンは隠れている状態）
    await page.waitForTimeout(150);
    const r = await page.evaluate(() => {
        const pre = document.querySelector('.editor pre') as HTMLElement;
        const lang = pre.querySelector('.code-lang-tag') as HTMLElement;
        const copy = pre.querySelector('.code-copy-btn') as HTMLElement;
        const p = pre.getBoundingClientRect(), l = lang.getBoundingClientRect(), c = copy.getBoundingClientRect();
        return { gapRight: p.right - l.right, gapTop: l.top - p.top, copyHidden: getComputedStyle(copy).opacity, copyLeftOfLang: c.right <= l.left + 0.5 };
    });
    expect(r.copyHidden, '前提: block の外では Copy は隠れている').toBe('0');
    expect(r.gapRight, '言語の名前の右端は block の右端から 4px（+ 縁 1px）— 以前は約 78px 離れていた').toBeLessThanOrEqual(8);
    expect(r.gapTop).toBeLessThanOrEqual(8);
    expect(r.copyLeftOfLang, '隠れているボタンは言語の名前の左に並ぶ').toBe(true);
});

test('TC-DMR-06 PDF の清書: 画面が dark のとき mermaid の図は light で描き直す（requestPdfHtml の経路）', async ({ page }) => {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready && (window as any).PdfExport);
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-fr-theme', 'dark');
        document.documentElement.setAttribute('data-theme', 'dark');
        (window as any).__testApi.setMarkdown('# t\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n');
    });
    await page.waitForFunction(() => document.querySelector('.editor .mermaid-diagram svg'), null, { timeout: 15000 });
    // 画面の図は dark の theme（node の地 #1f2020）
    expect(await page.evaluate(() => (window as any).__fractalMermaidTheme)).toBe('dark');
    expect(await page.evaluate(() => document.querySelector('.editor .mermaid-diagram svg')!.outerHTML)).toContain('#1f2020');
    // 本番の経路: host の requestPdfHtml → pdfHtmlResult
    const html: string = await page.evaluate(() => new Promise<string>((resolve) => {
        (window as any).__pdfExportPost = (m: any) => { if (m && m.type === 'pdfHtmlResult') { resolve(m.html || ''); } };
        window.postMessage({ type: 'requestPdfHtml', requestId: 'dmr-06', target: 'auto' }, '*');
    }));
    expect(html, 'PDF の図は light の theme（node の地 #ECECFF）').toContain('#ECECFF');
    expect(html, 'PDF に dark の図が残らない').not.toContain('#1f2020');
    // 元の画面の DOM は変えない（NFR-PDF-04）
    expect(await page.evaluate(() => document.querySelector('.editor .mermaid-diagram svg')!.outerHTML)).toContain('#1f2020');
    // 描き直しの theme は画面の次の描画に漏れない（init directive はその 1 回だけ）
    await page.evaluate(() => (window as any).__testApi.setMarkdown('# t2\n\n```mermaid\ngraph LR\n  C[One] --> D[Two]\n```\n'));
    await page.waitForFunction(() => { const s = document.querySelector('.editor .mermaid-diagram svg'); return s && s.outerHTML.indexOf('One') >= 0; }, null, { timeout: 15000 });
    expect(await page.evaluate(() => document.querySelector('.editor .mermaid-diagram svg')!.outerHTML)).toContain('#1f2020');
});

test('TC-DMR-06b PDF の清書: 画面が light の theme なら描き直さない（入力のまま）', async ({ page }) => {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready && (window as any).PdfExport);
    await page.evaluate(() => {
        document.documentElement.setAttribute('data-fr-theme', 'light');
        document.documentElement.setAttribute('data-theme', 'light');
        (window as any).__testApi.setMarkdown('# t\n\n```mermaid\ngraph TD\n  A[Start] --> B[End]\n```\n');
    });
    await page.waitForFunction(() => document.querySelector('.editor .mermaid-diagram svg'), null, { timeout: 15000 });
    const r = await page.evaluate(async () => {
        const built = (window as any).PdfExport.buildPdfExportHtml(document.querySelector('.editor'));
        const out = await (window as any).PdfExport.relightMermaidForPrint(built.html);
        return { theme: (window as any).__fractalMermaidTheme, same: out === built.html };
    });
    expect(r.theme).toBe('default');
    expect(r.same).toBe(true);
});

for (const theme of ['light', 'dark'] as const) {
    test(`TC-DMR-07 focus 行・選択した mindmap の node の上の tag は地と見分けられる（${theme}）`, async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await page.evaluate((th) => {
            document.documentElement.setAttribute('data-fr-theme', th);
            (window as any).__testApi.initOutliner({ version: 1, title: 't', rootIds: ['n1', 'n2'], nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: '全文検索 #perf' },
                n2: { id: 'n2', parentId: null, children: [], text: 'b' },
            } });
        }, theme);
        await page.locator('.outliner-node[data-id="n1"] .outliner-text').first().click();   // n1 を focus 行に
        await page.waitForTimeout(100);
        const r = await page.evaluate(() => {
            const row = document.querySelector('.outliner-node.is-focused') as HTMLElement | null;
            const tag = row && row.querySelector('.outliner-tag') as HTMLElement | null;
            // mindmap の選択した node（node の文字は outliner と同じ renderInlineText — tag は .outliner-tag）
            const box = document.createElement('div');
            box.className = 'mindmap-node-box is-selected';
            box.innerHTML = '<div class="mindmap-node-text">x <span class="outliner-tag">#sync</span></div>';
            document.body.appendChild(box);
            const mmTag = box.querySelector('.outliner-tag') as HTMLElement;
            const out = {
                focused: !!row, rowBg: row ? getComputedStyle(row).backgroundColor : '', tagBg: tag ? getComputedStyle(tag).backgroundColor : '', tagFg: tag ? getComputedStyle(tag).color : '',
                boxBg: getComputedStyle(box).backgroundColor, mmTagBg: getComputedStyle(mmTag).backgroundColor, mmTagFg: getComputedStyle(mmTag).color,
            };
            box.remove();
            return out;
        });
        expect(r.focused, 'n1 が focus 行').toBe(true);
        expect(r.tagBg, 'focus 行の上の tag に pill がある').not.toBe('');
        expect(contrast(r.tagBg, r.rowBg), 'focus 行の上の tag の pill と行の地の段差（以前の dark は 1.06:1 で消えていた）').toBeGreaterThanOrEqual(1.15);
        expect(contrast(r.tagFg, r.tagBg), 'その pill の上の tag の文字').toBeGreaterThanOrEqual(4.5);
        expect(contrast(r.mmTagBg, r.boxBg), '選択した mindmap の node の上の tag の pill（以前は地と同じ色）').toBeGreaterThanOrEqual(1.15);
        expect(contrast(r.mmTagFg, r.mmTagBg)).toBeGreaterThanOrEqual(4.5);
    });
}

test('TC-DMR-08 outliner の右クリックの Delete Node は危険な項目の見た目（文字 danger・hover danger-soft）', async ({ page }) => {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
    await page.evaluate(() => {
        (window as any).__testApi.initOutliner({ version: 1, title: 't', rootIds: ['n1', 'n2'], nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: 'a' },
            n2: { id: 'n2', parentId: null, children: [], text: 'b' },
        } });
    });
    await page.locator('.outliner-node[data-id="n2"] .outliner-text').first().click({ button: 'right' });
    await page.waitForSelector('.outliner-context-menu', { state: 'visible' });
    const item = page.locator('.outliner-context-menu .outliner-context-menu-item', { hasText: 'Delete Node' });
    await expect(item).toHaveClass(/\bdanger\b/);
    const others = await page.evaluate(() => Array.from(document.querySelectorAll('.outliner-context-menu-item.danger')).map((e) => (e.querySelector('.context-menu-label') as HTMLElement).textContent));
    expect(others, '危険な項目だけに付く（削除・取り外し）').toEqual(['Delete Node']);
    await item.hover();
    const r = await page.evaluate(() => {
        const el = Array.from(document.querySelectorAll('.outliner-context-menu-item.danger'))[0] as HTMLElement;
        const probe = (prop: string, v: string) => { const d = document.createElement('div'); (d.style as any)[prop] = v; document.body.appendChild(d); const x = (getComputedStyle(d) as any)[prop]; d.remove(); return x; };
        return { color: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor, danger: probe('color', 'var(--fr-color-danger)'), soft: probe('backgroundColor', 'var(--fr-color-danger-soft)') };
    });
    expect(r.color).toBe(r.danger);
    expect(r.bg).toBe(r.soft);
});

test('TC-DMR-09 md の Outline の下の語数は切れない（「· 」の後ろで折り返す）', async ({ page }) => {
    await bootNotes(page);
    // 語数・文字数・行数が 4〜5 桁になる長さ（11px で 1 行に入らない）
    const md = '# 長い文書\n\n' + Array.from({ length: 1200 }, (_, i) => 'word' + i + ' text ' + (i % 7 === 0 ? '\n\n' : '')).join('');
    await page.evaluate((m) => { (window as any).__testApi.mdDispatcher.loadMarkdown(m, '/x/long.md', ''); }, md);
    await page.waitForSelector('.markdown-container .sidebar-footer .word-count', { state: 'attached' });
    const r = await page.evaluate(() => {
        const sb = document.querySelector('.markdown-container #sidebar') as HTMLElement;
        sb.classList.remove('hidden');   // Outline を開く（既定の幅 234px）
        const wc = document.querySelector('.markdown-container .sidebar-footer .word-count') as HTMLElement;
        const cs = getComputedStyle(wc);
        const lineH = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.4;
        return { text: wc.textContent || '', sw: wc.scrollWidth, cw: wc.clientWidth, h: wc.getBoundingClientRect().height, lineH, ws: cs.whiteSpace, overflow: cs.textOverflow };
    });
    // 数字と単位の間は改行しない空白（U+00A0）— 折り返すのは「· 」の後ろだけ
    expect(r.text).toMatch(/\d+\u00A0\S+ · \d+\u00A0\S+ · \d+\u00A0\S+/);
    expect(r.ws).toBe('normal');
    expect(r.sw, '横にはみ出さない（… で切らない）').toBeLessThanOrEqual(r.cw);
    expect(r.h, 'この長さでは 2 行に折り返す（この test の前提）').toBeGreaterThan(r.lineH * 1.5);
});
