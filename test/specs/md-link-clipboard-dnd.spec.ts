/**
 * md-link-clipboard-dnd.spec.ts — md/file/subpage リンクの clipboard 一体化 + md 内 D&D 移動
 *
 * sprint 20260813-210323 TASK-06（手動テスト再オープン 2026-08-14）:
 *  - リンクテキスト全選択 or 行選択の copy/cut で、リンク（[📎]/[[]]/[]() マーカー + href）が
 *    clipboard md に載り、paste でリンクとして復元される（従来はテキストだけ・cut は殻アイコン残骸）
 *  - 同一 md 内の D&D でリンクを移動できる（従来 self-drop は no-op）
 *
 * TC-LM-01 段落 file リンク全選択 cut → clipboard [📎] + 殻ゼロ + paste 復元
 * TC-LM-02 リスト subpage リンク全選択 copy → paste で [[]] 復元
 * TC-LM-03 md リンク全選択 cut → paste で []( .md) 復元
 * TC-LM-04 md 内 D&D: リスト file リンク → 段落へ移動
 * TC-LM-05 md 内 D&D: 段落 subpage リンク → リスト li へ移動
 * TC-LM-06 段落行選択（端点アンカー外）cut → 残骸ゼロ + paste 復元
 * TC-LM-07 リスト li 行選択 cut → paste 復元
 */
import { test, expect, Page } from '@playwright/test';

async function boot(page: Page, md: string) {
    await page.goto('/standalone-editor.html');
    await page.waitForFunction(() => (window as any).__testApi?.setMarkdown);
    await page.evaluate((m) => { (window as any).__testApi.setMarkdown(m); }, md);
    await page.waitForTimeout(400);
}

// (1) 段落の file リンク全選択 cut → アンカー・アイコンごと消え、md に [📎 ...] が載る
test('TC-LM-01 段落 file リンク全選択 cut → clipboard [📎] + 殻ゼロ + paste 復元', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, 'head\n\n[📎 cdk-outputs.json](files/cdk-outputs.json)\n\ntail\n');
    await page.evaluate(() => {
        const a = document.querySelector('#editor a[data-is-file-attachment="true"]') as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.selectNodeContents(a);   // テキストだけの選択（ユーザーの全選択操作）
        sel.removeAllRanges(); sel.addRange(r);
        (document.getElementById('editor') as HTMLElement).focus();
    });
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log('CLIP:', JSON.stringify(clip));
    expect(clip).toContain('[📎 cdk-outputs.json](files/cdk-outputs.json)');
    const after = await page.evaluate(() => ({
        anchors: document.querySelectorAll('#editor a').length,
        md: (window as any).__testApi.getMarkdown(),
    }));
    expect(after.anchors).toBe(0);
    expect(after.md).not.toContain('cdk-outputs');

    // paste で戻す → リンクとして復元（アイコン付き data 属性込み）
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const p = Array.from(editor.querySelectorAll('p')).find((x) => (x.textContent || '').includes('tail')) as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.setStart(p.firstChild as Node, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(400);
    const pasted = await page.evaluate(() => {
        const a = document.querySelector('#editor a[data-is-file-attachment="true"]');
        return {
            found: !!a,
            text: a ? a.textContent : null,
            md: (window as any).__testApi.getMarkdown(),
        };
    });
    console.log('PASTED:', JSON.stringify(pasted));
    expect(pasted.found).toBe(true);
    expect(pasted.text).toBe('cdk-outputs.json');
    expect(pasted.md).toContain('[📎 cdk-outputs.json](files/cdk-outputs.json)');
});

// (2) copy → paste でもリンク性維持（subpage）
test('TC-LM-02 リスト subpage リンク全選択 copy → paste で [[]] 復元', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, '- [[あだだ]](sub.md)\n- next\n');
    await page.evaluate(() => {
        const a = document.querySelector('#editor a[data-subpage="true"]') as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.selectNodeContents(a);
        sel.removeAllRanges(); sel.addRange(r);
        (document.getElementById('editor') as HTMLElement).focus();
    });
    await page.keyboard.press('Meta+c');
    await page.waitForTimeout(200);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log('CLIP2:', JSON.stringify(clip));
    expect(clip).toContain('[[あだだ]](sub.md)');
    // 元は不変（copy）
    expect(await page.evaluate(() => document.querySelectorAll('#editor a[data-subpage="true"]').length)).toBe(1);

    // next 行に paste → subpage リンクが 2 個に
    await page.evaluate(() => {
        const lis = document.querySelectorAll('#editor li');
        const next = Array.from(lis).find((l) => (l.textContent || '').includes('next')) as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        const tn = next.firstChild as Text;
        r.setStart(tn, tn.length); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        (document.getElementById('editor') as HTMLElement).focus();
    });
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
        subpages: document.querySelectorAll('#editor a[data-subpage="true"]').length,
        md: (window as any).__testApi.getMarkdown(),
    }));
    console.log('STATE2:', JSON.stringify(state));
    expect(state.subpages).toBe(2);
    expect((state.md.match(/\[\[あだだ\]\]\(sub\.md\)/g) || []).length).toBe(2);
});

// (3) md リンク（通常 [text](x.md)）全選択 cut → paste でリンク維持
test('TC-LM-03 md リンク全選択 cut → paste で []( .md) 復元', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, '[msskpm2eyw57.md](msskpm2eyw57.md)\n\ntail\n');
    await page.evaluate(() => {
        const a = document.querySelector('#editor a.link-internal-md') as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.selectNodeContents(a);
        sel.removeAllRanges(); sel.addRange(r);
        (document.getElementById('editor') as HTMLElement).focus();
    });
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log('CLIP3:', JSON.stringify(clip));
    expect(clip).toContain('[msskpm2eyw57.md](msskpm2eyw57.md)');
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(400);
    const state = await page.evaluate(() => ({
        links: document.querySelectorAll('#editor a.link-internal-md').length,
        md: (window as any).__testApi.getMarkdown(),
    }));
    console.log('STATE3:', JSON.stringify(state));
    expect(state.links).toBe(1);
    expect(state.md).toContain('[msskpm2eyw57.md](msskpm2eyw57.md)');
});

// (4) md 内 D&D 移動: リストの file リンク → 段落へ real mouse drag
test('TC-LM-04 md 内 D&D: リスト file リンク → 段落へ移動', async ({ page }) => {
    await boot(page, '- [📎 report.pdf](files/report.pdf)\n- second\n\ntail paragraph\n');
    const a = page.locator('#editor a[data-is-file-attachment="true"]');
    const abox = (await a.boundingBox())!;
    const tail = page.locator('#editor p', { hasText: 'tail paragraph' });
    const tbox = (await tail.boundingBox())!;
    // ::before アイコン起点で drag → tail 段落末尾へ drop
    await page.mouse.move(abox.x + 5, abox.y + abox.height / 2);
    await page.mouse.down();
    await page.mouse.move((abox.x + tbox.x) / 2 + 40, (abox.y + tbox.y) / 2, { steps: 8 });
    await page.mouse.move(tbox.x + tbox.width - 5, tbox.y + tbox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const anchor = editor.querySelector('a[data-is-file-attachment="true"]');
        return {
            anchorCount: editor.querySelectorAll('a[data-is-file-attachment="true"]').length,
            anchorInP: !!(anchor && anchor.closest('p')),
            anchorInLi: !!(anchor && anchor.closest('li')),
            md: (window as any).__testApi.getMarkdown(),
        };
    });
    console.log('DND:', JSON.stringify(state));
    expect(state.anchorCount).toBe(1);          // 複製されない・消えない
    expect(state.anchorInP).toBe(true);         // 段落へ移動
    expect(state.anchorInLi).toBe(false);
    expect(state.md).toContain('[📎 report.pdf](files/report.pdf)');
    expect(state.md).toContain('tail paragraph');
});

// (5) md 内 D&D 移動: 段落の subpage リンク → リスト li へ
test('TC-LM-05 md 内 D&D: 段落 subpage リンク → リスト li へ移動', async ({ page }) => {
    await boot(page, '[[あだだ]](sub.md)\n\n- first\n- second\n');
    const a = page.locator('#editor a[data-subpage="true"]');
    const abox = (await a.boundingBox())!;
    const li = page.locator('#editor li', { hasText: 'second' });
    const lbox = (await li.boundingBox())!;
    await page.mouse.move(abox.x + 5, abox.y + abox.height / 2);
    await page.mouse.down();
    await page.mouse.move((abox.x + lbox.x) / 2 + 40, (abox.y + lbox.y) / 2, { steps: 8 });
    await page.mouse.move(lbox.x + lbox.width - 10, lbox.y + lbox.height / 2, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(500);
    const state = await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const anchor = editor.querySelector('a[data-subpage="true"]');
        return {
            count: editor.querySelectorAll('a[data-subpage="true"]').length,
            inLi: !!(anchor && anchor.closest('li')),
            md: (window as any).__testApi.getMarkdown(),
        };
    });
    console.log('DND2:', JSON.stringify(state));
    expect(state.count).toBe(1);
    expect(state.inLi).toBe(true);
    expect(state.md).toContain('[[あだだ]](sub.md)');
});

// ユーザー報告シナリオ: 段落行全体を選択（端点 = p 要素内・アンカー外）して cmd+x
// → アイコン残骸ゼロ + clipboard に [📎 ...] + cmd+v で復元
test('TC-LM-06 段落行選択（端点アンカー外）cut → 残骸ゼロ + paste 復元', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, 'head\n\n[📎 cdk-outputs.json](files/cdk-outputs.json)\n\ntail\n');
    // 段落全体を選択（p 要素を selectNodeContents = 行選択/トリプルクリック相当）
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const p = Array.from(editor.querySelectorAll('p'))
            .find((x) => x.querySelector('a[data-is-file-attachment="true"]')) as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.selectNodeContents(p);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log('CLIP:', JSON.stringify(clip));
    const after = await page.evaluate(() => ({
        anchors: document.querySelectorAll('#editor a').length,
        md: (window as any).__testApi.getMarkdown(),
    }));
    console.log('AFTER:', JSON.stringify(after));
    expect(clip).toContain('[📎 cdk-outputs.json](files/cdk-outputs.json)');
    expect(after.anchors).toBe(0);   // 殻アンカー（アイコン残骸）ゼロ
    // tail に paste → リンク復元
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const p = Array.from(editor.querySelectorAll('p')).find((x) => (x.textContent || '').includes('tail')) as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.setStart(p.firstChild as Node, 0); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(400);
    const pasted = await page.evaluate(() => ({
        found: document.querySelectorAll('#editor a[data-is-file-attachment="true"]').length,
        md: (window as any).__testApi.getMarkdown(),
    }));
    console.log('PASTED:', JSON.stringify(pasted));
    expect(pasted.found).toBe(1);
    expect(pasted.md).toContain('[📎 cdk-outputs.json](files/cdk-outputs.json)');
});

// リスト li 行選択 cut → paste で file リンク復元（ユーザー報告のリスト変種）
test('TC-LM-07 リスト li 行選択 cut → paste 復元', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await boot(page, '- [📎 report.pdf](files/report.pdf)\n- keep\n');
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const li = editor.querySelector('li') as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        r.selectNodeContents(li);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
    await page.keyboard.press('Meta+x');
    await page.waitForTimeout(300);
    const clip = await page.evaluate(() => navigator.clipboard.readText());
    console.log('CLIP-LI:', JSON.stringify(clip));
    expect(clip).toContain('[📎 report.pdf](files/report.pdf)');
    const after = await page.evaluate(() => ({
        anchors: document.querySelectorAll('#editor a').length,
    }));
    expect(after.anchors).toBe(0);
    // keep 行末に paste
    await page.evaluate(() => {
        const editor = document.getElementById('editor') as HTMLElement;
        const keep = Array.from(editor.querySelectorAll('li')).find((l) => (l.textContent || '').includes('keep')) as HTMLElement;
        const sel = window.getSelection() as Selection;
        const r = document.createRange();
        const tn = keep.firstChild as Text;
        r.setStart(tn, tn.length); r.collapse(true);
        sel.removeAllRanges(); sel.addRange(r);
        editor.focus();
    });
    await page.keyboard.press('Meta+v');
    await page.waitForTimeout(400);
    const pasted = await page.evaluate(() => ({
        found: document.querySelectorAll('#editor a[data-is-file-attachment="true"]').length,
        md: (window as any).__testApi.getMarkdown(),
    }));
    console.log('PASTED-LI:', JSON.stringify(pasted));
    expect(pasted.found).toBe(1);
    expect(pasted.md).toContain('[📎 report.pdf](files/report.pdf)');
});
