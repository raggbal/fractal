/**
 * outliner のモード二態（node 編集モード / 選択モード）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove
 * FR-OSM-01..07 / FR-OSC-01 rev2 / FR-MSC-02 rev2 / FR-MSEL-06 rev3
 * ADRL-0114（二態 + printable no-op）/ ADRL-0115（黄色 + 色相分離）/ ADRL-0116（Cmd+A 2 段階）/ ADRL-0119（状態は派生）
 *
 * 設計（design/system/mode-state-machine.md）:
 *   - `isSelectMode() ≡ selectedNodeIds.size > 0`（純関数。独立変数を持たない = ADRL-0119）
 *   - 視覚投影は `syncSelectionModeClass()` 単一関数がコンテナ（`.outliner-tree`）に
 *     `is-select-mode` を付け外しする。呼び出し点は 3 種類（既存 4 関数の末尾 / `selectAllNodes()` の末尾 / `renderTree` の末尾）
 *   - caret は `caret-color: transparent` で消す。**focus と collapsed selection は維持する**
 *     （`blur()` / `contenteditable=false` は禁止 — cmd+c/x/v と Cmd+A の受け口が全滅する = HM-1）
 */
import { test, expect, Page } from '@playwright/test';

const MOD = process.platform === 'darwin' ? 'Meta' : 'Control';

function n(id: string, text: string, extra: any = {}) {
    return Object.assign({
        id, parentId: null, children: [], text, collapsed: false, subtext: '',
        images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [],
    }, extra);
}

/** a > a1 / b / c の 3 root（a 展開済み）。可視 = a, a1, b, c の 4 件。 */
const TREE = {
    version: 1,
    rootIds: ['a', 'b', 'c'],
    nodes: {
        a: n('a', 'alpha', { children: ['a1'] }),
        a1: n('a1', 'alpha-1', { parentId: 'a' }),
        b: n('b', 'bravo'),
        c: n('c', 'charlie'),
    },
};

async function setup(page: Page, tree: any = TREE): Promise<void> {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready, undefined, { timeout: 8000 });
    await page.evaluate((t) => { (window as any).__testApi.initOutliner(t); }, tree);
    await page.waitForSelector('.outliner-node', { timeout: 5000 });
    await page.waitForFunction(() => {
        const ae = document.activeElement as HTMLElement | null;
        return !!ae && ae !== document.body;
    }, undefined, { timeout: 5000 }).catch(() => { /* 面によっては自動フォーカスが無い */ });
}

const text = (page: Page, id: string) => page.locator(`.outliner-node[data-id="${id}"] .outliner-text`);
const selectedIds = (page: Page) => page.evaluate(() =>
    Array.from(document.querySelectorAll('.outliner-node.is-selected')).map((el) => (el as HTMLElement).dataset.id || ''));
const isSelectModeClass = (page: Page) => page.evaluate(() => {
    const t = document.querySelector('.outliner-tree');
    return !!t && t.classList.contains('is-select-mode');
});
const caretColor = (page: Page, id: string) => page.evaluate((i) => {
    const el = document.querySelector(`.outliner-node[data-id="${i}"] .outliner-text`) as HTMLElement;
    return getComputedStyle(el).caretColor;
}, id);
const isTransparent = (c: string) => /rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(c);

/**
 * 指定 id を **cmd+click で選択集合に入れる**。
 * 修飾なし click は選択を**クリアする**（出口経路 = `clearSelection('plain-mousedown-on-text')`）ので、
 * 最初の 1 回だけ focus 用に使い、選択に入れたい node はすべて cmd+click する。
 */
async function selectIds(page: Page, ids: string[]) {
    await text(page, ids[0]).click();          // focus のみ（この時点で選択は 0 件）
    for (const id of ids) {
        await text(page, id).click({ modifiers: [MOD as any] });
    }
    expect((await page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node.is-selected')).length)),
        `前提: ${ids.length} 件選択`).toBe(ids.length);
}

// ───────────────────────── A. モードの入口（FR-OSM-02） ─────────────────────────

test.describe('FR-OSM-02 選択モードの入口', () => {
    test('TC-OSM-01 cmd/ctrl+click で選択モードに入る（caret 消去 + 選択クラス）', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();
        expect(await isSelectModeClass(page), '前提: 編集モード（選択 0 件）で is-select-mode が付いていない').toBe(false);

        await text(page, 'c').click({ modifiers: [MOD as any] });
        expect(await isSelectModeClass(page), 'cmd+click で is-select-mode が付かない').toBe(true);
        expect(await selectedIds(page)).toContain('c');
        expect(isTransparent(await caretColor(page, 'c')), 'caret-color が transparent になっていない').toBe(true);
    });

    test('TC-OSM-02 shift+click で選択モードに入る', async ({ page }) => {
        await setup(page);
        await text(page, 'a').click();
        await text(page, 'b').click({ modifiers: ['Shift'] });
        expect(await isSelectModeClass(page), 'shift+click で is-select-mode が付かない').toBe(true);
        expect((await selectedIds(page)).length, '連続範囲が選択されていない').toBeGreaterThanOrEqual(2);
    });

    test('TC-OSM-03 shift+↓ で選択モードに入る', async ({ page }) => {
        await setup(page);
        await text(page, 'a').click();
        // 既存契約（outliner.js の Shift+↑/↓ 分岐）: **1 回目は自行のみ選択 + フォーカス移動なし**、
        // 2 回目から範囲拡張。FR-OSM-02 はキー割り当てを変えないので、この段差もそのまま維持する。
        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(80);
        expect(await isSelectModeClass(page), 'shift+↓ の 1 回目で is-select-mode が付かない').toBe(true);
        expect((await selectedIds(page)).length, '1 回目は自行のみ選択（既存契約）').toBe(1);

        await page.keyboard.press('Shift+ArrowDown');
        await page.waitForTimeout(80);
        expect(await isSelectModeClass(page), '2 回目で is-select-mode が外れた').toBe(true);
        expect((await selectedIds(page)).length, '2 回目で範囲が伸びていない').toBeGreaterThanOrEqual(2);
    });

    test('TC-OSM-04 選択モードに入るとテキスト範囲は捨てるが focus は捨てない（HM-1）', async ({ page }) => {
        await setup(page);
        await text(page, 'b').dblclick();          // 単語範囲選択を作る
        await page.waitForTimeout(50);
        await text(page, 'c').click({ modifiers: [MOD as any] });
        const r = await page.evaluate(() => {
            const s = window.getSelection();
            const ae = document.activeElement as HTMLElement | null;
            return {
                collapsed: !s || s.isCollapsed,
                activeIsText: !!ae && ae.classList.contains('outliner-text'),
                activeTag: ae ? ae.tagName : null,
            };
        });
        expect(r.collapsed, 'テキスト範囲が残っている（clipboard / D&D をブラウザ標準に奪われる）').toBe(true);
        expect(r.activeIsText, `focus が .outliner-text から外れた（blur 実装は禁止 = HM-1）: activeElement=${r.activeTag}`).toBe(true);
    });
});

// ─────────────── A-2. 選択モード中の入力抑止と出口（FR-OSM-03/04 / FR-MSC-02 rev2） ───────────────

test.describe('FR-OSM-04 選択モード中の入力は no-op（INV-2）', () => {
    const texts = (page: Page) => page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node .outliner-text')).map((el) => el.textContent || ''));

    const selectThree = (page: Page) => selectIds(page, ['a', 'b', 'c']);

    test('TC-OSM-05 printable キーは no-op（本文不変 + 選択維持）', async ({ page }) => {
        await setup(page);
        await selectThree(page);
        const before = await texts(page);
        await page.keyboard.press('x');
        await page.waitForTimeout(80);
        expect(await texts(page), 'printable キーで本文が変わった（誤爆で本文が壊れる）').toEqual(before);
        expect((await selectedIds(page)).length, 'printable キーで選択が解除された（FR-OSM-04 = no-op）').toBe(3);
        expect(await isSelectModeClass(page), 'printable キーで選択モードから抜けた').toBe(true);
    });

    test('TC-OSM-06 IME 合成も抑止される（本文不変 + 選択維持）', async ({ page }) => {
        await setup(page);
        await selectThree(page);
        const before = await texts(page);
        // 🔴 合成 `beforeinput` は**実挿入を起こさない**ので「本文が変わらない」だけでは番人にならない。
        //    実装が抑止しているか = `preventDefault()` されているかを直接見る（本文比較は補助）。
        const prevented = await page.evaluate(() => {
            const ae = document.activeElement as HTMLElement;
            ae.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
            const ev = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertCompositionText', data: 'あ' });
            ae.dispatchEvent(ev);
            const p1 = ev.defaultPrevented;
            const ev2 = new InputEvent('beforeinput', { bubbles: true, cancelable: true, inputType: 'insertText', data: 'x' });
            ae.dispatchEvent(ev2);
            ae.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: 'あ' }));
            return { composition: p1, insertText: ev2.defaultPrevented };
        });
        expect(prevented.composition, 'IME 合成（insertCompositionText）が抑止されていない — 実機で日本語が入力できてしまう').toBe(true);
        expect(prevented.insertText, 'insertText が抑止されていない — 実機で文字が入力できてしまう').toBe(true);
        await page.waitForTimeout(80);
        expect(await texts(page), 'IME 合成で本文が変わった').toEqual(before);
        expect((await selectedIds(page)).length, 'IME 合成で選択が解除された').toBe(3);
    });

    test('TC-OSM-07 修飾キー単体 / lock キーでは選択が消えない（裁定 R31 の本体を維持）', async ({ page }) => {
        await setup(page);
        await selectThree(page);
        for (const k of ['Alt', 'CapsLock', 'Shift']) {
            await page.keyboard.press(k as any);
            await page.waitForTimeout(40);
            expect((await selectedIds(page)).length, `${k} で選択が消えた（FR-MSC-02 の既存条項違反）`).toBe(3);
        }
        // metaKey フラグ無しで届いた Meta の keydown でも消えない
        await page.evaluate(() => {
            (document.activeElement as HTMLElement).dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Meta', bubbles: true, cancelable: true, metaKey: false }));
        });
        await page.waitForTimeout(40);
        expect((await selectedIds(page)).length, 'metaKey=false の Meta keydown で選択が消えた').toBe(3);
    });
});

test.describe('FR-OSM-03 選択モードの出口（NFR-OSM-02）', () => {
    /** 入口 5 経路のうちマウス / キーで再現できる 3 経路 */
    const entries: Array<[string, (p: Page) => Promise<void>]> = [
        ['cmd+click', async (p) => { await text(p, 'b').click(); await text(p, 'c').click({ modifiers: [MOD as any] }); }],
        ['shift+click', async (p) => { await text(p, 'a').click(); await text(p, 'b').click({ modifiers: ['Shift'] }); }],
        ['shift+ArrowDown', async (p) => { await text(p, 'a').click(); await p.keyboard.press('Shift+ArrowDown'); }],
    ];

    test('TC-OSM-08 入口 5 経路すべてから Esc で編集モードへ戻る（WCAG 2.1.2）', async ({ page }) => {
        for (const [label, enter] of entries) {
            await setup(page);
            await enter(page);
            await page.waitForTimeout(60);
            expect(await isSelectModeClass(page), `${label}: 選択モードに入っていない`).toBe(true);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(80);
            expect((await selectedIds(page)).length, `${label}: Esc で選択が解除されない（キーボードトラップ）`).toBe(0);
            expect(await isSelectModeClass(page), `${label}: Esc で is-select-mode が外れない`).toBe(false);
        }
    });

    test('TC-OSM-09 Esc は検索クリアと両立する', async ({ page }) => {
        await setup(page);
        // 検索を開いて何か入れる（検索 UI が無ければこの TC はスキップ相当の緩い assert にする）
        const hasSearch = await page.evaluate(() => !!document.querySelector('.outliner-search input, #outlinerSearchInput, .outliner-search-input'));
        await text(page, 'b').click();
        await text(page, 'c').click({ modifiers: [MOD as any] });
        expect(await isSelectModeClass(page)).toBe(true);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, 'Esc で選択が解除されない').toBe(0);
        // 検索 UI がある面では検索もクリアされる（現行の副作用経路と byte 互換）
        if (hasSearch) {
            const q = await page.evaluate(() => {
                const el = document.querySelector('.outliner-search input, #outlinerSearchInput, .outliner-search-input') as HTMLInputElement | null;
                return el ? el.value : '';
            });
            expect(q, 'Esc 後に検索クエリが残っている').toBe('');
        }
    });

    test('TC-OSM-10 修飾なし ↑↓ / click で編集モードへ戻る', async ({ page }) => {
        // ① ArrowDown
        await setup(page);
        await text(page, 'b').click();
        await text(page, 'c').click({ modifiers: [MOD as any] });
        await page.keyboard.press('ArrowDown');
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '修飾なし ↓ で選択が解除されない').toBe(0);
        expect(await isSelectModeClass(page), '修飾なし ↓ で is-select-mode が外れない').toBe(false);

        // ② 修飾なし click
        await setup(page);
        await text(page, 'b').click();
        await text(page, 'c').click({ modifiers: [MOD as any] });
        await text(page, 'a').click();
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '修飾なし click で選択が解除されない').toBe(0);
        expect(await isSelectModeClass(page), '修飾なし click で is-select-mode が外れない').toBe(false);
    });

    test('TC-CBD-61 選択モードで cmd+c / cmd+x / cmd+v が全部動く（HM-1 の番人）', async ({ page }) => {
        // caret を blur で消す実装だと keydown / paste が textEl に届かず**全部無反応**になる
        await setup(page);
        await selectIds(page, ['a', 'b', 'c']);
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(120);
        const copyMsgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerClipboard'));
        expect(copyMsgs.length, '選択モードで cmd+c が届いていない（blur 実装だと無反応になる = HM-1 違反）').toBe(1);
        expect(copyMsgs[0].nodes && copyMsgs[0].nodes.length, 'cmd+c で選択 node が payload に入っていない').toBeGreaterThanOrEqual(3);

        // cmd+x → 選択 node が消える
        await setup(page);
        await selectIds(page, ['b', 'c']);
        const beforeCount = await page.locator('.outliner-node').count();
        await page.keyboard.press(`${MOD}+x`);
        await page.waitForTimeout(150);
        expect(await page.locator('.outliner-node').count(), '選択モードで cmd+x が効いていない').toBeLessThan(beforeCount);
    });
});

// ───────────────── B. モードと選択集合の同期（FR-OSM-07 / NFR-OSM-01 / INV-1） ─────────────────

test.describe('NFR-OSM-01 選択 0 件 ⇔ caret 表示 の等価性（INV-1）', () => {
    test('TC-OSM-11 選択集合を触る全経路で INV-1 が保たれる', async ({ page }) => {
        await setup(page);
        const check = async (label: string) => {
            const ids = await selectedIds(page);
            const cls = await isSelectModeClass(page);
            expect(cls, `${label}: 選択 ${ids.length} 件 なのに is-select-mode=${cls}（INV-1 の乖離）`).toBe(ids.length > 0);
        };

        // ① Delete で選択 node を削除 → 選択 0 件
        await text(page, 'b').click();
        await text(page, 'c').click({ modifiers: [MOD as any] });
        await check('cmd+click 後');
        await page.keyboard.press('Delete');
        await page.waitForTimeout(80);
        await check('Delete 後');

        // ② renderTree の prune（host からの updateData で選択 node が消える）
        await setup(page);
        await text(page, 'b').click();
        await text(page, 'c').click({ modifiers: [MOD as any] });
        await check('再選択後');
        await page.evaluate(() => {
            const w = window as any;
            w.__testApi.initOutliner({ version: 1, rootIds: ['z'], nodes: { z: { id: 'z', parentId: null, children: [], text: 'zulu', collapsed: false, subtext: '', images: [], isPage: false, pageId: null, checked: null, filePath: null, tags: [] } } });
        });
        await page.waitForTimeout(120);
        await check('renderTree prune 後');
    });

    test('TC-OSM-12 再描画をまたいで選択モードが保たれる（裁定 R14 の維持）', async ({ page }) => {
        await setup(page);
        await text(page, 'a').click();
        await text(page, 'b').click({ modifiers: [MOD as any] });
        await text(page, 'c').click({ modifiers: [MOD as any] });
        const before = (await selectedIds(page)).length;
        expect(before, '前提: 2 件以上選択').toBeGreaterThanOrEqual(2);
        await page.evaluate(() => { (window as any).Outliner.renderTree?.(); });
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '再描画で選択が消えた').toBe(before);
        expect(await isSelectModeClass(page), '再描画で is-select-mode が消えた').toBe(true);
    });

    test('TC-OSM-13 選択行の右クリック / D&D 完了は出口ではない', async ({ page }) => {
        await setup(page);
        await selectIds(page, ['b', 'c']);
        const before = (await selectedIds(page)).length;
        await text(page, 'c').click({ button: 'right' });
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '選択行の右クリックで選択が消えた（既存契約違反）').toBe(before);
        expect(await isSelectModeClass(page)).toBe(true);
    });
});

// ───────────────── B-2. Cmd+A の 2 段階 escalation（FR-MSEL-06 rev3 / ADRL-0116） ─────────────────

test.describe('FR-MSEL-06 rev3 Cmd+A の 2 段階 escalation', () => {
    const winSel = (page: Page) => page.evaluate(() => {
        const s = window.getSelection();
        return { text: s ? s.toString() : '', collapsed: !s || s.isCollapsed, ranges: s ? s.rangeCount : 0 };
    });
    const visibleCount = (page: Page) => page.locator('.outliner-node').count();

    test('TC-OSM-20 編集モードの 1 段目 = その node の text 全選択（モード維持）', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();                       // text = 'bravo'
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(80);
        const w = await winSel(page);
        expect(w.text, '1 段目で node の text が全選択されていない').toBe('bravo');
        expect((await selectedIds(page)).length, '1 段目で node 選択に入ってしまった（2 段階になっていない）').toBe(0);
        expect(await isSelectModeClass(page), '1 段目で選択モードに入ってしまった').toBe(false);
        expect(isTransparent(await caretColor(page, 'b')), '1 段目で caret が消えた（編集モード維持のはず）').toBe(false);
    });

    test('TC-OSM-21 編集モードの 2 段目 = 全 node 選択（選択モードへ / removeAllRanges 必須）', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(60);
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '2 段目で全 node 選択になっていない').toBe(await visibleCount(page));
        expect(await isSelectModeClass(page), '2 段目で選択モードに入っていない').toBe(true);
        const w = await winSel(page);
        expect(w.collapsed, 'テキスト範囲が残っている（ADRL-0108 の隠れ必須条項 = clipboard/D&D をブラウザ標準に奪われる）').toBe(true);
    });

    test('TC-OSM-22 3 回目以降は no-op', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();
        await page.keyboard.press(`${MOD}+a`);
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(80);
        const n = (await selectedIds(page)).length;
        await page.keyboard.press(`${MOD}+a`);
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '3 回目以降で選択件数が変わった').toBe(n);
        expect(await isSelectModeClass(page), '3 回目以降で選択モードから抜けた').toBe(true);
    });

    test('TC-OSM-23 選択モードの Cmd+A は常に全 node 選択', async ({ page }) => {
        await setup(page);
        await selectIds(page, ['c']);                        // 1 件だけ選択した選択モード
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '選択モードの Cmd+A で全 node 選択にならない').toBe(await visibleCount(page));
        expect(await isSelectModeClass(page)).toBe(true);
    });

    test('TC-OSM-24 空 node は 1 段目をスキップして即昇格', async ({ page }) => {
        await setup(page, {
            version: 1, rootIds: ['e', 'b'],
            nodes: { e: n('e', ''), b: n('b', 'bravo') },
        });
        await text(page, 'e').click();
        await page.keyboard.press(`${MOD}+a`);               // 1 回だけ
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '空 node で 1 回押しても昇格しない（2 回押しても text が空なので永久に昇格しない）')
            .toBe(await visibleCount(page));
    });

    test('TC-OSM-25 inline 要素を含む node でも全選択済み判定が壊れない', async ({ page }) => {
        await setup(page, {
            version: 1, rootIds: ['m'],
            nodes: { m: n('m', 'A**B**`C`') },              // 太字 + code = inline 要素に分かれる
        });
        await text(page, 'm').click();
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(60);
        const w1 = await winSel(page);
        const full = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node[data-id="m"] .outliner-text') as HTMLElement;
            return el.textContent || '';
        });
        expect(w1.text, '1 段目で node の text 全体が選択されていない（inline 要素で範囲が切れている）').toBe(full);
        await page.keyboard.press(`${MOD}+a`);
        await page.waitForTimeout(80);
        expect((await selectedIds(page)).length, '2 段目に到達できない（Range の offset 比較で誤判定している疑い）')
            .toBe(await visibleCount(page));
    });

    test('TC-OSM-26 全分岐で preventDefault される', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();
        const states: boolean[] = [];
        for (let i = 0; i < 3; i++) {
            states.push(await page.evaluate(() => {
                const el = document.activeElement as HTMLElement;
                const ev = new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', bubbles: true, cancelable: true, metaKey: true });
                el.dispatchEvent(ev);
                return ev.defaultPrevented;
            }));
            await page.waitForTimeout(60);
        }
        expect(states, `preventDefault されない分岐がある（webview のネイティブ全選択が走る = GitHub issue #2 の症状）: ${states.join(',')}`)
            .toEqual([true, true, true]);
    });

    test('TC-OSM-27 mindmap view は 2 段階から免除される（1 回で全 node 選択）', async ({ page }) => {
        await setup(page);
        await page.evaluate(() => { (window as any).Outliner.setViewMode('mindmap'); });
        await page.waitForSelector('.mindmap-node', { timeout: 5000 });
        await page.evaluate(() => {
            const el = (document.querySelector('.mindmap-node') as HTMLElement)
                || (document.querySelector('#outlinerTree, .outliner-tree') as HTMLElement) || document.body;
            el.dispatchEvent(new KeyboardEvent('keydown', {
                key: 'a', code: 'KeyA', bubbles: true, cancelable: true, metaKey: true, ctrlKey: true,
            }));
        });
        await page.waitForTimeout(150);
        const selected = await page.evaluate(() =>
            document.querySelectorAll('.mindmap-node-box.is-selected, .mindmap-node .is-selected, .mindmap-node.is-selected').length);
        expect(selected, 'mindmap で 1 回押しで全 node 選択にならない（VIEW_MODE の免除が無いと 1 段目に落ちる = 既存 TC-168 が壊れる）')
            .toBeGreaterThan(0);
    });

    test('TC-OSM-28 編集モード Cmd+A → Cmd+C は text のみコピー（nodesData なし）', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();
        await page.keyboard.press(`${MOD}+a`);               // 1 段目 = text 全選択
        await page.evaluate(() => { (window as any).__testApi.messages.length = 0; });
        await page.keyboard.press(`${MOD}+c`);
        await page.waitForTimeout(120);
        const msgs = await page.evaluate(() =>
            (window as any).__testApi.messages.filter((m: any) => m.type === 'saveOutlinerClipboard'));
        // text 範囲があるのでブラウザ標準に委譲される（既存 case 'c' の isCollapsed 分岐の帰結）
        expect(msgs.length === 0 || !(msgs[0].nodes && msgs[0].nodes.length > 1),
            `編集モードの text 全選択後の Cmd+C で複数 node の nodesData が送られた（text のみが正）: ${JSON.stringify(msgs)}`).toBe(true);
    });
});

// ───────────────────── C. 選択色と caret CSS（FR-OSC-01 rev2 / NFR-OSM-04） ─────────────────────

function rgb(s: string) {
    const m = s.match(/rgba?\(\s*([0-9.]+)[,\s]+([0-9.]+)[,\s]+([0-9.]+)/);
    return m ? { r: parseFloat(m[1]), g: parseFloat(m[2]), b: parseFloat(m[3]) } : null;
}

test.describe('FR-OSC-01 rev2 選択色は amber・::selection は色相分離', () => {
    const selectTwo = (page: Page) => selectIds(page, ['b', 'c']);

    test('TC-OSM-30 node 選択の塗りが amber 系（R>B かつ G>B）', async ({ page }) => {
        await setup(page);
        await selectTwo(page);
        const bg = await page.evaluate(() => {
            const el = document.querySelector('.outliner-node.is-selected') as HTMLElement | null;
            return el ? getComputedStyle(el).backgroundColor : null;
        });
        expect(bg, '.is-selected が存在しない').not.toBeNull();
        const c = rgb(bg!)!;
        expect(c, `background=${bg}`).not.toBeNull();
        expect(c.r, `amber でない（R>B が成り立たない）: ${bg}`).toBeGreaterThan(c.b);
        expect(c.g, `amber でない（G>B が成り立たない）: ${bg}`).toBeGreaterThan(c.b);
    });

    test('TC-OSM-31 ::selection トークンは青系のまま（node 選択と色相が異なる）', async ({ page }) => {
        await setup(page);
        const t = await page.evaluate(() => {
            const cs = getComputedStyle(document.documentElement);
            return {
                sel: cs.getPropertyValue('--outliner-selection-bg').trim(),
                txt: cs.getPropertyValue('--outliner-selection-text-bg').trim(),
            };
        });
        const cs = rgb(t.sel)!; const ct = rgb(t.txt)!;
        expect(cs, `--outliner-selection-bg=${t.sel}`).not.toBeNull();
        expect(ct, `--outliner-selection-text-bg=${t.txt}`).not.toBeNull();
        expect(cs.r, `node 選択が amber でない: ${t.sel}`).toBeGreaterThan(cs.b);
        expect(ct.b, `::selection が青系でない（色相分離が崩れ Cmd+A の 2 モードが見分けられない）: ${t.txt}`).toBeGreaterThan(ct.r);
    });

    test('TC-OSM-32 focus 行と選択行が別色', async ({ page }) => {
        await setup(page);
        await selectTwo(page);
        const r = await page.evaluate(() => {
            const sel = document.querySelector('.outliner-node.is-selected') as HTMLElement | null;
            const foc = document.querySelector('.outliner-node.is-focused') as HTMLElement | null;
            return {
                sel: sel ? getComputedStyle(sel).backgroundColor : null,
                focToken: getComputedStyle(document.documentElement).getPropertyValue('--fr-color-selection-bg').trim(),
            };
        });
        expect(r.sel).not.toBeNull();
        const cs = rgb(r.sel!)!;
        const cf = rgb(r.focToken) || { r: 0, g: 0, b: 255 };
        expect(cf.b, `focus 行トークン --fr-color-selection-bg が青系でない（黄色にしてはいけない）: ${r.focToken}`).toBeGreaterThan(cf.r);
        expect(cs.r > cs.b, '選択行が amber である').toBe(true);
    });

    test('TC-OSM-36 選択モードで caret CSS が当たり、編集モードでは当たらない', async ({ page }) => {
        await setup(page);
        await text(page, 'b').click();
        expect(isTransparent(await caretColor(page, 'b')), '編集モードで caret が透明になっている').toBe(false);
        await text(page, 'c').click({ modifiers: [MOD as any] });
        expect(isTransparent(await caretColor(page, 'c')), '選択モードで caret が透明になっていない').toBe(true);
    });
});

// ─────────── TC-OSM-37: standalone-notes.html でも同じ CSS が効く（登録点 #8 の番人） ───────────

test('TC-OSM-37 standalone-notes.html の outliner でも選択色と caret CSS が同一', async ({ page }) => {
    await page.goto('/standalone-notes.html');
    await page.waitForFunction(() => !!(window as any).__testApi, undefined, { timeout: 8000 });
    // outliner のランタイムは起こさず、CSS が inline されているかだけを見る
    // （TC-CBD 系は JS のロジックしか見ないので CSS の反映を検出できない = TDD-1 の指摘）
    const r = await page.evaluate(() => {
        const tree = document.createElement('div');
        tree.className = 'outliner-tree is-select-mode';
        const node = document.createElement('div');
        node.className = 'outliner-node is-selected';
        const txt = document.createElement('div');
        txt.className = 'outliner-text';
        txt.contentEditable = 'true';
        txt.textContent = 'probe';
        node.appendChild(txt); tree.appendChild(node); document.body.appendChild(tree);
        const cs = getComputedStyle(document.documentElement);
        return {
            selBg: getComputedStyle(node).backgroundColor,
            caret: getComputedStyle(txt).caretColor,
            selToken: cs.getPropertyValue('--outliner-selection-bg').trim(),
            txtToken: cs.getPropertyValue('--outliner-selection-text-bg').trim(),
        };
    });
    const c = rgb(r.selBg);
    expect(c, `standalone-notes.html で .is-selected の背景が読めない（outliner.css が inline されていない）: ${r.selBg}`).not.toBeNull();
    expect(c!.r, `notes 面の選択色が amber でない（outliner 面だけ黄色く notes 面は別色 = 登録点漏れ）: ${r.selBg}`).toBeGreaterThan(c!.b);
    expect(/rgba\(\s*0,\s*0,\s*0,\s*0\s*\)|transparent/.test(r.caret),
        `notes 面で caret-color: transparent が当たらない（.is-select-mode ルールが inline されていない）: ${r.caret}`).toBe(true);
    const st = rgb(r.selToken);
    expect(st, `notes 面で --outliner-selection-bg が未定義: "${r.selToken}"`).not.toBeNull();
    expect(st!.r, `notes 面のトークンが amber でない: ${r.selToken}`).toBeGreaterThan(st!.b);
});

/**
 * TC-OSM-14（reviewer iteration 1 QUAL-4 / TASK-21 / FR-OSM-03）:
 * Escape の「明示分岐への昇格」が dead code になっていないこと。
 *
 * 汎用ブロック（`selectedNodeIds.size > 0 && !shift && !meta && !ctrl && !isNonTextKeyEvent(e) && …`）は
 * `switch (e.key)` より**前**にあり、`Escape` は `NON_TEXT_KEYS` に含まれないので、iteration 1 では
 * `clearSelection('keydown:Escape')` が先に走って選択が空になり、後続の `case 'Escape'` の
 * `if (isSelectMode()) { clearSelection('Escape'); }` は**本体に到達しなかった**。
 *
 * 最終状態（選択 0 件 / caret 表示）はどちらの経路でも同じなので既存 Escape 系 TC では区別できない。
 * 経路の同一性は **selection trace overlay**（Cmd+Shift+Alt+S → `#fr-sel-trace`）に出る
 * `clear` の reason ラベルで観測する（本番コードに観測用の穴を開けない）。
 *
 * counterfactual（iteration 1 の実装で観測される値）: reason = `(keydown:Escape)`
 */
test('TC-OSM-14 Escape の選択解除は明示分岐が担う（副作用ブロックではない）', async ({ page }) => {
    await setup(page);
    await selectIds(page, ['a', 'b', 'c']);
    // selection trace overlay を ON（Cmd+Shift+Alt+S）。`_selTrace` は overlay OFF でも蓄積しており
    // render が last 14 件を出すので、選択の**後**に開いても直後の Escape は必ず映る
    await page.keyboard.press(`${MOD}+Shift+Alt+s`);
    await expect(page.locator('#fr-sel-trace')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(80);

    expect((await page.evaluate(() =>
        Array.from(document.querySelectorAll('.outliner-node.is-selected')).length)),
        'Escape で選択が解除されていない').toBe(0);

    const trace = (await page.locator('#fr-sel-trace').textContent()) || '';
    expect(trace.includes('(Escape)'),
        `明示分岐 clearSelection('Escape') が実行されていない（trace=${JSON.stringify(trace.slice(-400))}）`)
        .toBe(true);
    expect(trace.includes('(keydown:Escape)'),
        '汎用 side-effect ブロックが Escape を先に処理している（明示分岐が dead code のまま）')
        .toBe(false);
});
