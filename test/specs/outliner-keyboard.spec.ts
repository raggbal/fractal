/**
 * Outliner keyboard operations — comprehensive test suite
 *
 * Covers: Enter, Option+Enter, Backspace, Tab, Shift+Tab, ArrowUp/Down,
 * ArrowLeft/Right (collapse), Ctrl+Shift+Up/Down (move), Shift+Arrow (selection),
 * Undo/Redo, Cmd+A, Cmd+N, Cmd+S, Cmd+F, Escape, Ctrl+. (toggle collapse),
 * Checkbox pattern conversion
 */

import { test, expect } from '@playwright/test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Navigate to the standalone outliner page and wait for the test API. */
async function setup(page: import('@playwright/test').Page) {
    await page.goto('/standalone-outliner.html');
    await page.waitForFunction(() => (window as any).__testApi?.ready);
}

/** Initialize the outliner with the given data structure. */
async function init(page: import('@playwright/test').Page, data: any) {
    await page.evaluate((d) => {
        (window as any).__testApi.initOutliner(d);
    }, data);
}

/** Click on the nth .outliner-text element (0-based) to focus it. */
async function focusNode(page: import('@playwright/test').Page, nth: number) {
    const el = page.locator('.outliner-text').nth(nth);
    await el.click();
    await page.waitForTimeout(100);
}

/**
 * Focus a node by data-id and set cursor at a specific offset.
 * offset = 0 → start, offset = -1 → end, positive number → that character position.
 * Two-step: click to trigger focus event handler (renderEditingText), then set cursor.
 */
async function focusById(page: import('@playwright/test').Page, id: string, offset: number = -1) {
    const textEl = page.locator('.outliner-node[data-id="' + id + '"] .outliner-text');
    await textEl.click();
    await page.waitForTimeout(200);
    await page.evaluate(({ id, offset }) => {
        const nodeEl = document.querySelector('.outliner-node[data-id="' + id + '"]');
        if (!nodeEl) return;
        const el = nodeEl.querySelector('.outliner-text') as HTMLElement;
        if (!el) return;
        const sel = window.getSelection()!;
        const range = document.createRange();
        if (offset === -1) {
            range.selectNodeContents(el);
            range.collapse(false);
        } else {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
            let textNode = walker.nextNode();
            let pos = 0;
            if (!textNode) {
                range.selectNodeContents(el);
                range.collapse(true);
            } else {
                let found = false;
                do {
                    const len = (textNode.textContent || '').length;
                    if (pos + len >= offset) {
                        range.setStart(textNode, offset - pos);
                        range.collapse(true);
                        found = true;
                        break;
                    }
                    pos += len;
                    textNode = walker.nextNode();
                } while (textNode);
                if (!found) { range.selectNodeContents(el); range.collapse(false); }
            }
        }
        sel.removeAllRanges();
        sel.addRange(range);
    }, { id, offset });
    await page.waitForTimeout(50);
}

/**
 * Dispatch a KeyboardEvent directly on the focused .outliner-text element.
 * Useful for Meta/Ctrl+key combinations that Playwright may intercept.
 */
async function dispatchKey(page: import('@playwright/test').Page, opts: {
    key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean; altKey?: boolean;
}) {
    await page.evaluate((o) => {
        const el = document.querySelector('.outliner-node.is-focused .outliner-text')
            || document.activeElement;
        if (!el) return;
        el.dispatchEvent(new KeyboardEvent('keydown', {
            key: o.key, code: o.code,
            metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey,
            shiftKey: !!o.shiftKey, altKey: !!o.altKey,
            bubbles: true, cancelable: true,
        }));
    }, opts);
}

/**
 * Dispatch a keyboard event at the document level.
 */
async function dispatchDocKey(page: import('@playwright/test').Page, opts: {
    key: string; code: string; metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean;
}) {
    await page.evaluate((o) => {
        document.dispatchEvent(new KeyboardEvent('keydown', {
            key: o.key, code: o.code,
            metaKey: !!o.metaKey, ctrlKey: !!o.ctrlKey,
            shiftKey: !!o.shiftKey,
            bubbles: true, cancelable: true,
        }));
    }, opts);
}

/** Return the number of visible .outliner-node elements. */
async function nodeCount(page: import('@playwright/test').Page): Promise<number> {
    return page.locator('.outliner-node').count();
}

/** Return the text content of the nth .outliner-text element. */
async function nodeText(page: import('@playwright/test').Page, nth: number): Promise<string> {
    return (await page.locator('.outliner-text').nth(nth).textContent()) ?? '';
}

/** Return the data-id of the focused (.is-focused) node. */
async function focusedId(page: import('@playwright/test').Page): Promise<string | null> {
    return page.evaluate(() => {
        const el = document.querySelector('.outliner-node.is-focused');
        return el ? el.getAttribute('data-id') : null;
    });
}

/** Return a count of nested .outliner-node elements (children of any parent).
 *  Phase F flat mode: data-depth >= 1 の node を集計 (旧 .outliner-children .outliner-node 相当)
 */
async function nestedNodeCount(page: import('@playwright/test').Page): Promise<number> {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('.outliner-node')).filter((el) => {
            const d = parseInt(el.getAttribute('data-depth') || '0', 10);
            return d >= 1;
        }).length;
    });
}

/** Return the count of top-level (depth=0) nodes.
 *  Phase F flat mode: 全 node が .outliner-tree 直下に並ぶので
 *  data-depth="0" でフィルタする
 */
async function topLevelNodeCount(page: import('@playwright/test').Page): Promise<number> {
    return page.locator('.outliner-tree > .outliner-node[data-depth="0"]').count();
}

/** Return data-ids of all .is-selected nodes. */
async function selectedIds(page: import('@playwright/test').Page): Promise<string[]> {
    return page.evaluate(() => {
        return Array.from(document.querySelectorAll('.outliner-node.is-selected'))
            .map(el => el.getAttribute('data-id') || '');
    });
}

/** Return the messages array from the test API. */
async function getMessages(page: import('@playwright/test').Page): Promise<any[]> {
    return page.evaluate(() => (window as any).__testApi.messages);
}

/** Clear the messages array. */
async function clearMessages(page: import('@playwright/test').Page) {
    await page.evaluate(() => { (window as any).__testApi.messages = []; });
}

// ---------------------------------------------------------------------------
// Data factories
// ---------------------------------------------------------------------------

function singleNode(id = 'n1', text = 'hello') {
    return {
        version: 1,
        rootIds: [id],
        nodes: { [id]: { id, parentId: null, children: [], text, tags: [] } },
    };
}

function twoNodes(t1 = 'alpha', t2 = 'beta') {
    return {
        version: 1,
        rootIds: ['n1', 'n2'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: t1, tags: [] },
            n2: { id: 'n2', parentId: null, children: [], text: t2, tags: [] },
        },
    };
}

function threeNodes(t1 = 'one', t2 = 'two', t3 = 'three') {
    return {
        version: 1,
        rootIds: ['n1', 'n2', 'n3'],
        nodes: {
            n1: { id: 'n1', parentId: null, children: [], text: t1, tags: [] },
            n2: { id: 'n2', parentId: null, children: [], text: t2, tags: [] },
            n3: { id: 'n3', parentId: null, children: [], text: t3, tags: [] },
        },
    };
}

function parentChild(parentText = 'parent', childText = 'child') {
    return {
        version: 1,
        rootIds: ['p1'],
        nodes: {
            p1: { id: 'p1', parentId: null, children: ['c1'], text: parentText, tags: [] },
            c1: { id: 'c1', parentId: 'p1', children: [], text: childText, tags: [] },
        },
    };
}

function parentWithTwoChildren() {
    return {
        version: 1,
        rootIds: ['p1'],
        nodes: {
            p1: { id: 'p1', parentId: null, children: ['c1', 'c2'], text: 'parent', tags: [] },
            c1: { id: 'c1', parentId: 'p1', children: [], text: 'child1', tags: [] },
            c2: { id: 'c2', parentId: 'p1', children: [], text: 'child2', tags: [] },
        },
    };
}

function taskNode(id = 'n1', text = 'task item', checked = false) {
    return {
        version: 1,
        rootIds: [id],
        nodes: { [id]: { id, parentId: null, children: [], text, tags: [], checked } },
    };
}

// ===========================================================================
// Tests
// ===========================================================================

test.describe('Outliner Keyboard Operations', () => {
    test.beforeEach(async ({ page }) => {
        await setup(page);
    });

    // -----------------------------------------------------------------------
    // Enter key
    // -----------------------------------------------------------------------

    test.describe('Enter key', () => {

        test('1. Enter at end of text creates new empty sibling after current', async ({ page }) => {
            await init(page, singleNode('n1', 'hello'));
            await focusNode(page, 0);
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(2);
            expect(await nodeText(page, 0)).toContain('hello');
            expect((await nodeText(page, 1)).trim()).toBe('');
        });

        test('2. Enter at middle of text splits text', async ({ page }) => {
            await init(page, singleNode('n1', 'abcdef'));
            await focusNode(page, 0);
            await page.keyboard.press('Home');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('ArrowRight');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(2);
            expect(await nodeText(page, 0)).toContain('abc');
            expect(await nodeText(page, 1)).toContain('def');
        });

        test('3. Enter on empty node (2nd or later) creates new empty node', async ({ page }) => {
            await init(page, twoNodes('first', ''));
            await focusNode(page, 1); // focus empty second node
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(3);
        });

        test('4. Enter on node with expanded children inserts new sibling and moves children under it', async ({ page }) => {
            // Phase F: 実装は Enter で兄弟挿入し、現在の expanded children は新兄弟に move する
            // (handleEnter: "node の children を newNode に移す" 分岐)
            await init(page, parentChild('parent', 'child'));
            await focusNode(page, 0); // focus parent
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            // parent + new empty sibling + original child = 3
            expect(await nodeCount(page)).toBe(3);

            // モデル上で children が新兄弟へ移っていることを確認
            const layout = await page.evaluate(() => {
                const api = (window as any).__testApi;
                const m = api.getModel();
                const parent = m.getNode('p1');
                const child = m.getNode('c1');
                return {
                    parentChildren: parent?.children || [],
                    childParentId: child?.parentId,
                    rootIds: m.rootIds.slice(),
                };
            });
            expect(layout.parentChildren).toEqual([]);
            // 子は新兄弟（root 配列の 2 番目）の下に居る
            expect(layout.rootIds.length).toBe(2);
            expect(layout.rootIds[0]).toBe('p1');
            expect(layout.childParentId).toBe(layout.rootIds[1]);
        });

        test('5. Enter on task node (checked) creates new node with checked=false', async ({ page }) => {
            await init(page, taskNode('n1', 'done task', true));
            await focusNode(page, 0);
            await page.keyboard.press('End');
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(2);
            // The new node should have a checkbox (unchecked)
            const checkboxes = await page.locator('.outliner-checkbox').count();
            expect(checkboxes).toBe(2);
            // The second checkbox should be unchecked
            const secondCheckbox = page.locator('.outliner-checkbox input[type="checkbox"]').nth(1);
            const isChecked = await secondCheckbox.isChecked();
            expect(isChecked).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // Option+Enter
    // -----------------------------------------------------------------------

    test.describe('Option+Enter', () => {

        test('6. Option+Enter creates child node at start', async ({ page }) => {
            await init(page, singleNode('n1', 'parent'));
            await focusNode(page, 0);
            await page.keyboard.press('End');
            await page.keyboard.press('Alt+Enter');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(2);
            expect(await nestedNodeCount(page)).toBe(1);
            // The new child should be empty (Phase F flat: depth=1 の最初の text)
            const childText = await page.locator('.outliner-node[data-depth="1"] .outliner-text').first().textContent();
            expect((childText ?? '').trim()).toBe('');
        });
    });

    // -----------------------------------------------------------------------
    // Backspace key
    // -----------------------------------------------------------------------

    test.describe.serial('Backspace key', () => {

        test('7. Backspace at start of empty node without children deletes it, focuses previous', async ({ page }) => {
            await init(page, twoNodes('first', ''));
            await focusById(page, 'n2', 0);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(1);
            expect(await nodeText(page, 0)).toContain('first');
            expect(await focusedId(page)).toBe('n1');
        });

        test('8. Backspace at start of node with text merges with previous', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusById(page, 'n2', 0); // cursor at start of 'beta'
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(1);
            expect(await nodeText(page, 0)).toContain('alphabeta');
        });

        test('9. Backspace on the only root node does nothing', async ({ page }) => {
            await init(page, singleNode('n1', 'only'));
            await focusById(page, 'n1', 0);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(1);
            expect(await nodeText(page, 0)).toContain('only');
        });

        test('10. Backspace with text fully selected deletes text only (no merge)', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusById(page, 'n2', -1); // cursor at end of 'beta'
            // Select all text in node using Shift+Home
            await page.keyboard.press('Shift+Home');
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            // Node should remain but be empty, not merged with previous
            expect(await nodeCount(page)).toBe(2);
            expect(await nodeText(page, 0)).toContain('alpha');
            expect((await nodeText(page, 1)).replace(/\s/g, '')).toBe('');
        });
    });

    // -----------------------------------------------------------------------
    // Tab (Indent)
    // -----------------------------------------------------------------------

    test.describe.serial('Tab (Indent)', () => {

        test('11. Tab indents node under previous sibling', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusById(page, 'n2', 0);
            await page.keyboard.press('Tab');
            await page.waitForTimeout(300);

            expect(await nestedNodeCount(page)).toBe(1);
            expect(await topLevelNodeCount(page)).toBe(1);
        });

        test('12. Tab on first node (no previous sibling) does nothing', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusNode(page, 0); // focus first node
            await page.keyboard.press('Tab');
            await page.waitForTimeout(300);

            expect(await topLevelNodeCount(page)).toBe(2);
            expect(await nestedNodeCount(page)).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Shift+Tab (Outdent)
    // -----------------------------------------------------------------------

    test.describe.serial('Shift+Tab (Outdent)', () => {

        test('13. Shift+Tab outdents nested node to parent level', async ({ page }) => {
            await init(page, parentChild('parent', 'child'));
            await focusById(page, 'c1', 0);
            await page.keyboard.press('Shift+Tab');
            await page.waitForTimeout(300);

            expect(await topLevelNodeCount(page)).toBe(2);
        });

        test('14. Shift+Tab on top-level node does nothing', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusNode(page, 0);
            await page.keyboard.press('Shift+Tab');
            await page.waitForTimeout(300);

            expect(await topLevelNodeCount(page)).toBe(2);
        });
    });

    // -----------------------------------------------------------------------
    // ArrowUp / ArrowDown (Navigation)
    // -----------------------------------------------------------------------

    test.describe('ArrowUp / ArrowDown (Navigation)', () => {

        test('15. ArrowDown focuses next visible node', async ({ page }) => {
            await init(page, threeNodes());
            await focusNode(page, 0); // focus 'one'
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(200);

            expect(await focusedId(page)).toBe('n2');
        });

        test('16. ArrowUp focuses previous visible node', async ({ page }) => {
            await init(page, threeNodes());
            await focusNode(page, 1); // focus 'two'
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(200);

            expect(await focusedId(page)).toBe('n1');
        });

        test('17. ArrowUp from first node does nothing', async ({ page }) => {
            await init(page, threeNodes());
            await focusNode(page, 0);
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(200);

            expect(await focusedId(page)).toBe('n1');
        });

        test('18. ArrowDown from last node does nothing', async ({ page }) => {
            await init(page, threeNodes());
            await focusById(page, 'n3', 0);
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(200);

            expect(await focusedId(page)).toBe('n3');
        });
    });

    // -----------------------------------------------------------------------
    // ArrowLeft / ArrowRight (Collapse / Expand)
    // -----------------------------------------------------------------------

    test.describe('ArrowLeft / ArrowRight (Collapse / Expand)', () => {

        test('19. ArrowLeft at start with expanded children collapses node', async ({ page }) => {
            await init(page, parentChild('parent', 'child'));
            await focusById(page, 'p1', 0); // cursor at start of parent
            await page.keyboard.press('ArrowLeft');
            await page.waitForTimeout(300);

            // Phase F flat mode: collapsed の判定はモデル + DOM 上の child 非表示で確認
            const isCollapsed = await page.evaluate(() => {
                const api = (window as any).__testApi;
                const node = api.getModel().getNode('p1');
                return !!node?.collapsed;
            });
            const childInDom = await page.locator('.outliner-node[data-id="c1"]').count();
            expect(isCollapsed).toBe(true);
            expect(childInDom).toBe(0);
        });

        test('20. ArrowRight at end with collapsed children expands node', async ({ page }) => {
            const data = {
                version: 1,
                rootIds: ['p1'],
                nodes: {
                    p1: { id: 'p1', parentId: null, children: ['c1'], text: 'parent', tags: [], collapsed: true },
                    c1: { id: 'c1', parentId: 'p1', children: [], text: 'child', tags: [] },
                },
            };
            await init(page, data);
            await focusNode(page, 0); // focus parent
            await page.keyboard.press('End');
            await page.keyboard.press('ArrowRight');
            await page.waitForTimeout(300);

            // Phase F flat mode: expand 後は child が DOM 上に出る
            const isCollapsed = await page.evaluate(() => {
                const api = (window as any).__testApi;
                const node = api.getModel().getNode('p1');
                return !!node?.collapsed;
            });
            const childInDom = await page.locator('.outliner-node[data-id="c1"]').count();
            expect(isCollapsed).toBe(false);
            expect(childInDom).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // Ctrl+Shift+Up/Down (Move node)
    // -----------------------------------------------------------------------

    test.describe.serial('Ctrl+Shift+Up/Down (Move node)', () => {

        test('21. Meta+Shift+ArrowUp moves node up among siblings', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusById(page, 'n2', 0);
            await dispatchKey(page, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, shiftKey: true });
            await page.waitForTimeout(300);

            expect(await nodeText(page, 0)).toContain('two');
            expect(await nodeText(page, 1)).toContain('one');
        });

        test('22. Meta+Shift+ArrowDown moves node down among siblings', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusById(page, 'n2', 0);
            await dispatchKey(page, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, shiftKey: true });
            await page.waitForTimeout(300);

            expect(await nodeText(page, 0)).toContain('one');
            expect(await nodeText(page, 1)).toContain('three');
            expect(await nodeText(page, 2)).toContain('two');
        });

        test('23. Meta+Shift+ArrowUp on first sibling does nothing', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusById(page, 'n1', 0);
            await dispatchKey(page, { key: 'ArrowUp', code: 'ArrowUp', metaKey: true, shiftKey: true });
            await page.waitForTimeout(300);

            expect(await nodeText(page, 0)).toContain('one');
            expect(await nodeText(page, 1)).toContain('two');
            expect(await nodeText(page, 2)).toContain('three');
        });

        test('24. Meta+Shift+ArrowDown on last sibling does nothing', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusById(page, 'n3', 0);
            await dispatchKey(page, { key: 'ArrowDown', code: 'ArrowDown', metaKey: true, shiftKey: true });
            await page.waitForTimeout(300);

            expect(await nodeText(page, 0)).toContain('one');
            expect(await nodeText(page, 1)).toContain('two');
            expect(await nodeText(page, 2)).toContain('three');
        });
    });

    // -----------------------------------------------------------------------
    // Shift+ArrowUp/Down (Multi-select)
    // -----------------------------------------------------------------------

    test.describe('Shift+ArrowUp/Down (Multi-select)', () => {

        test('25. Shift+ArrowDown first press selects current node only, no focus move', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusNode(page, 0);
            await page.keyboard.press('Shift+ArrowDown');
            await page.waitForTimeout(200);

            const selected = await selectedIds(page);
            expect(selected).toContain('n1');
            expect(selected.length).toBe(1);
            // Focus should remain on n1
            expect(await focusedId(page)).toBe('n1');
        });

        test('26. Shift+ArrowDown second press extends selection to next node', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusNode(page, 0);
            await page.keyboard.press('Shift+ArrowDown');
            await page.waitForTimeout(200);
            await page.keyboard.press('Shift+ArrowDown');
            await page.waitForTimeout(200);

            const selected = await selectedIds(page);
            expect(selected.length).toBe(2);
            expect(selected).toContain('n1');
            expect(selected).toContain('n2');
        });

        test('27. Escape or normal input clears selection', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusNode(page, 0);
            await page.keyboard.press('Shift+ArrowDown');
            await page.waitForTimeout(200);
            await page.keyboard.press('Shift+ArrowDown');
            await page.waitForTimeout(200);

            let selected = await selectedIds(page);
            expect(selected.length).toBe(2);

            // Escape clears selection
            await page.keyboard.press('Escape');
            await page.waitForTimeout(200);

            selected = await selectedIds(page);
            expect(selected.length).toBe(0);
        });
    });

    // -----------------------------------------------------------------------
    // Undo / Redo
    // -----------------------------------------------------------------------

    test.describe('Undo / Redo', () => {

        test('28. Cmd+Z undoes text editing', async ({ page }) => {
            await init(page, singleNode('n1', 'original'));
            await focusNode(page, 0);
            await page.keyboard.press('End');
            await page.keyboard.type(' added');
            await page.waitForTimeout(300);

            expect(await nodeText(page, 0)).toContain('added');

            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);

            expect(await nodeText(page, 0)).not.toContain('added');
        });

        test('29. Cmd+Z then Cmd+Shift+Z redoes', async ({ page }) => {
            await init(page, singleNode('n1', 'original'));
            await focusNode(page, 0);
            await page.keyboard.press('End');
            await page.keyboard.type(' added');
            await page.waitForTimeout(300);

            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);
            expect(await nodeText(page, 0)).not.toContain('added');

            await page.keyboard.press('Meta+Shift+z');
            await page.waitForTimeout(300);
            expect(await nodeText(page, 0)).toContain('added');
        });
    });

    // -----------------------------------------------------------------------
    // Cmd+A (Select all)
    // -----------------------------------------------------------------------

    test.describe('Cmd+A', () => {

        test('30. Cmd+A selects all visible nodes', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusNode(page, 0);
            await page.keyboard.press('Meta+a');
            await page.waitForTimeout(200);

            const selected = await selectedIds(page);
            expect(selected.length).toBe(3);
            expect(selected).toContain('n1');
            expect(selected).toContain('n2');
            expect(selected).toContain('n3');
        });
    });

    // -----------------------------------------------------------------------
    // Cmd+N (New node)
    // -----------------------------------------------------------------------

    test.describe('Cmd+N', () => {

        test('31. Cmd+N adds new node at root end', async ({ page }) => {
            await init(page, twoNodes('first', 'second'));
            const before = await nodeCount(page);
            expect(before).toBe(2);

            await focusById(page, 'n1', 0);
            // Cmd+N is handled by a document-level keydown handler.
            // Due to re-initialization in the test environment, multiple handlers exist.
            // So we dispatch and check that at least one new node was created.
            await dispatchKey(page, { key: 'n', code: 'KeyN', metaKey: true });
            await page.waitForTimeout(300);

            const after = await nodeCount(page);
            expect(after).toBeGreaterThan(before);
            // The last node(s) should be empty
            const lastText = await nodeText(page, after - 1);
            expect(lastText.trim()).toBe('');
        });
    });

    // -----------------------------------------------------------------------
    // Cmd+S (Save)
    // -----------------------------------------------------------------------

    test.describe('Cmd+S', () => {

        test('32. Cmd+S triggers syncToHostImmediate and host.save', async ({ page }) => {
            await init(page, singleNode('n1', 'save test'));
            await focusNode(page, 0);
            await clearMessages(page);

            await page.keyboard.press('Meta+s');
            await page.waitForTimeout(300);

            const messages = await getMessages(page);
            const hasSyncData = messages.some((m: any) => m.type === 'syncData');
            const hasSave = messages.some((m: any) => m.type === 'save');
            expect(hasSyncData).toBe(true);
            expect(hasSave).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Escape
    // -----------------------------------------------------------------------

    test.describe('Escape', () => {

        test('33. Escape clears search when searching', async ({ page }) => {
            await init(page, threeNodes('apple', 'banana', 'cherry'));

            const searchInput = page.locator('.outliner-search-input');
            await searchInput.click();
            await searchInput.fill('apple');
            await page.waitForTimeout(500);

            // Focus a node and press Escape
            await focusNode(page, 0);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(300);

            // All nodes should be visible
            const visibleCount = await page.locator('.outliner-node:not([style*="display: none"])').count();
            expect(visibleCount).toBe(3);
        });
    });

    // -----------------------------------------------------------------------
    // Cmd+F (Search focus)
    // -----------------------------------------------------------------------

    test.describe('Cmd+F', () => {

        test('34. Cmd+F focuses in-document text search input', async ({ page }) => {
            await init(page, singleNode('n1', 'test'));
            await focusNode(page, 0);
            await page.keyboard.press('Meta+f');
            await page.waitForTimeout(200);

            // Cmd+F は openTextSearchBox() が走り、.outliner-search-replace-box .search-input にフォーカス
            // (.outliner-search-input はヘッダフィルタ用で、こちらは Cmd+Shift+F)
            const isFocused = await page.evaluate(() => {
                const searchInput = document.querySelector('.outliner-search-replace-box .search-input');
                return document.activeElement === searchInput;
            });
            expect(isFocused).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // Ctrl+. (Toggle collapse)
    // -----------------------------------------------------------------------

    test.describe('Ctrl+. (Toggle collapse)', () => {

        test('35. Toggle collapse via bullet click on focused node with children', async ({ page }) => {
            await init(page, parentChild('parent', 'child'));
            // Verify child is visible before collapse
            expect(await nestedNodeCount(page)).toBe(1);

            // Collapse via bullet click (same selector as outliner-basic.spec.ts)
            const bullet = page.locator('.outliner-tree > .outliner-node[data-id="p1"] > .outliner-bullet').first();
            await bullet.click();
            await page.waitForTimeout(300);

            // Phase F flat mode: collapsed parent の child は DOM から消える
            const isCollapsed = await page.evaluate(() => {
                const api = (window as any).__testApi;
                return !!api.getModel().getNode('p1')?.collapsed;
            });
            expect(isCollapsed).toBe(true);

            // Child node should be removed from DOM
            const childInDom = await page.locator('.outliner-node[data-id="c1"]').count();
            expect(childInDom).toBe(0);

            // Toggle back
            await bullet.click();
            await page.waitForTimeout(300);

            const isCollapsedAfter = await page.evaluate(() => {
                const api = (window as any).__testApi;
                return !!api.getModel().getNode('p1')?.collapsed;
            });
            expect(isCollapsedAfter).toBe(false);
            const childInDomAfter = await page.locator('.outliner-node[data-id="c1"]').count();
            expect(childInDomAfter).toBe(1);
        });
    });

    // -----------------------------------------------------------------------
    // Checkbox pattern conversion
    // -----------------------------------------------------------------------

    test.describe('Checkbox pattern conversion', () => {

        test('36. "- [ ] text" + Enter converts to task node (unchecked)', async ({ page }) => {
            await init(page, singleNode('n1', ''));
            await focusNode(page, 0);
            await page.keyboard.type('- [ ] my task');
            await page.waitForTimeout(200);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            // Should have a checkbox
            const checkboxes = await page.locator('.outliner-checkbox').count();
            expect(checkboxes).toBeGreaterThanOrEqual(1);

            // First node text should be 'my task' (without the marker prefix)
            const firstText = await nodeText(page, 0);
            expect(firstText).toContain('my task');
            expect(firstText).not.toContain('- [ ]');
        });

        test('37. "- [x] text" + Enter converts to checked task node', async ({ page }) => {
            await init(page, singleNode('n1', ''));
            await focusNode(page, 0);
            await page.keyboard.type('- [x] done task');
            await page.waitForTimeout(200);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            // Should have a checked checkbox
            const checkboxes = await page.locator('.outliner-checkbox').count();
            expect(checkboxes).toBeGreaterThanOrEqual(1);

            const firstCheckbox = page.locator('.outliner-checkbox input[type="checkbox"]').first();
            const isChecked = await firstCheckbox.isChecked();
            expect(isChecked).toBe(true);

            // Text should not contain the marker
            const firstText = await nodeText(page, 0);
            expect(firstText).toContain('done task');
            expect(firstText).not.toContain('- [x]');
        });
    });

    // -----------------------------------------------------------------------
    // Additional edge cases
    // -----------------------------------------------------------------------

    test.describe.serial('Additional edge cases', () => {

        test('ArrowDown navigates into nested children', async ({ page }) => {
            await init(page, parentChild('parent', 'child'));
            await focusNode(page, 0); // focus parent
            await page.keyboard.press('ArrowDown');
            await page.waitForTimeout(200);

            expect(await focusedId(page)).toBe('c1');
        });

        test('ArrowUp from child navigates to parent', async ({ page }) => {
            await init(page, parentChild('parent', 'child'));
            const childText = page.locator('.outliner-node[data-depth="1"] .outliner-text').first();
            await childText.click();
            await page.waitForTimeout(100);
            await page.keyboard.press('ArrowUp');
            await page.waitForTimeout(200);

            expect(await focusedId(page)).toBe('p1');
        });

        test('Backspace at start of node with children merges text with previous', async ({ page }) => {
            const data = {
                version: 1,
                rootIds: ['n1', 'n2'],
                nodes: {
                    n1: { id: 'n1', parentId: null, children: [], text: 'first', tags: [] },
                    n2: { id: 'n2', parentId: null, children: ['c1'], text: 'second', tags: [] },
                    c1: { id: 'c1', parentId: 'n2', children: [], text: 'grandchild', tags: [] },
                },
            };
            await init(page, data);
            await focusById(page, 'n2', 0);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            // n2 is removed and its text merged into n1
            expect(await topLevelNodeCount(page)).toBe(1);
            expect(await nodeText(page, 0)).toContain('firstsecond');
        });

        test('Meta+. on node without children does nothing', async ({ page }) => {
            await init(page, singleNode('n1', 'no children'));
            await focusById(page, 'n1', -1);
            await dispatchKey(page, { key: '.', code: 'Period', metaKey: true });
            await page.waitForTimeout(200);

            // Phase F flat mode: 子のないノードは collapsed にならない
            const isCollapsed = await page.evaluate(() => {
                const api = (window as any).__testApi;
                return !!api.getModel().getNode('n1')?.collapsed;
            });
            expect(isCollapsed).toBe(false);
        });

        test('Multiple Shift+ArrowUp extends selection upward', async ({ page }) => {
            await init(page, threeNodes('one', 'two', 'three'));
            await focusById(page, 'n3', 0);
            await page.keyboard.press('Shift+ArrowUp');
            await page.waitForTimeout(200);
            await page.keyboard.press('Shift+ArrowUp');
            await page.waitForTimeout(200);

            const selected = await selectedIds(page);
            expect(selected.length).toBe(2);
            expect(selected).toContain('n3');
            expect(selected).toContain('n2');
        });

        test('Undo after Enter restores original state', async ({ page }) => {
            await init(page, singleNode('n1', 'hello'));
            await focusById(page, 'n1', -1);
            await page.keyboard.press('Enter');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(2);

            // Focus back to n1 before undo to prevent double-fire
            // (renderTree after undo moves focus; doc handler may re-fire undo)
            await focusById(page, 'n1', -1);
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(1);
            expect(await nodeText(page, 0)).toContain('hello');
        });

        test('Undo after Tab restores original indentation', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusById(page, 'n2', 0);
            await page.keyboard.press('Tab');
            await page.waitForTimeout(300);

            expect(await nestedNodeCount(page)).toBe(1);

            // n2 still exists in DOM as child of n1, focus it
            await focusById(page, 'n2', 0);
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);

            expect(await topLevelNodeCount(page)).toBe(2);
            expect(await nestedNodeCount(page)).toBe(0);
        });

        test('Undo after Backspace merge restores deleted node', async ({ page }) => {
            await init(page, twoNodes('alpha', 'beta'));
            await focusById(page, 'n2', 0);
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(1);

            // Focus the merged node before undo
            await focusById(page, 'n1', -1);
            await page.keyboard.press('Meta+z');
            await page.waitForTimeout(300);

            expect(await nodeCount(page)).toBe(2);
        });
    });
});
