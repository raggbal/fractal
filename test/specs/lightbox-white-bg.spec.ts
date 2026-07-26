/**
 * lightbox（drawio.svg / mermaid / 画像の拡大表示）の図形を白背景 + 余白で表示する CSS の検証。
 *
 * 透明背景の SVG（drawio.svg / mermaid）が暗い overlay（rgba(0,0,0,0.7)）越しに黒く見える問題を、
 * `.outliner-image-large` に background:#fff + padding + box-sizing:border-box を付けて解消する。
 * CSS は styles.css / outliner.css の 2 ファイルに重複定義され、standalone build では
 * outliner.css が styles.css の後にロードされ上書きするため、両方直す必要がある（TC-LB-02 が番人）。
 */
import { test, expect, Page } from '@playwright/test';

// 実 CSS クラスだけを当てた lightbox img を DOM に作り、computed style を読む（inline style を付けない）。
async function makeLightbox(page: Page) {
    await page.evaluate(() => {
        // 既存があれば消す
        document.querySelectorAll('.outliner-image-overlay').forEach((n) => n.remove());
        const overlay = document.createElement('div');
        overlay.className = 'outliner-image-overlay'; // CSS 由来のスタイルのみ（inline なし）
        const img = document.createElement('img');
        img.className = 'outliner-image-large';        // ← 検証対象。inline style を付けない
        // 透明 1px gif（drawio.svg/mermaid の透明背景を模す）
        img.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
        overlay.appendChild(img);
        document.body.appendChild(overlay);
    });
    await page.waitForTimeout(50);
}

async function largeImgStyle(page: Page) {
    return page.evaluate(() => {
        const img = document.querySelector('.outliner-image-overlay .outliner-image-large') as HTMLElement;
        if (!img) return null;
        const cs = getComputedStyle(img);
        return {
            bg: cs.backgroundColor,
            padTop: cs.paddingTop, padRight: cs.paddingRight, padBottom: cs.paddingBottom, padLeft: cs.paddingLeft,
            boxSizing: cs.boxSizing,
        };
    });
}

// standalone-notes（styles.css + outliner.css 両方 inline・outliner.css が後勝ち）で検証。
test.describe('lightbox 図形の白背景+余白 (standalone-notes)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    // TC-LB-01: 白背景 + padding 14px + border-box（load-bearing）
    test('TC-LB-01 .outliner-image-large が白背景・padding 14px・border-box', async ({ page }) => {
        await makeLightbox(page);
        const s = await largeImgStyle(page);
        expect(s, 'lightbox img 存在').not.toBeNull();
        expect(s!.bg, '白背景（透明でない）').toBe('rgb(255, 255, 255)');
        expect(s!.padTop).toBe('14px');
        expect(s!.padRight).toBe('14px');
        expect(s!.padBottom).toBe('14px');
        expect(s!.padLeft).toBe('14px');
        expect(s!.boxSizing, 'padding 込みで 90vw/90vh を超えない').toBe('border-box');
    });

    // TC-LB-02: padding も styles/outliner 両 CSS ロード後に有効（object-fit:contain 併存で潰れない）
    // 注: background は property 単位のカスケードなので styles.css だけでも有効（outliner.css が
    //     background を宣言しなければ上書きされない）。両方に入れているのは見た目の一貫性のため。
    //     この TC は「両 CSS がロードされた最終状態で padding/背景が生きている」ことを確認する。
    test('TC-LB-02 両 CSS ロード後も padding と白背景が有効', async ({ page }) => {
        await makeLightbox(page);
        const s = await largeImgStyle(page);
        expect(s!.bg).toBe('rgb(255, 255, 255)');
        expect(s!.padTop).toBe('14px');
    });
});

// standalone-outliner でも同様に効くこと（3-provider 非対称の確認）
test.describe('lightbox 図形の白背景+余白 (standalone-outliner)', () => {
    test('TC-LB-01b standalone-outliner でも白背景+余白', async ({ page }) => {
        await page.goto('/standalone-outliner.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
        await makeLightbox(page);
        const s = await largeImgStyle(page);
        expect(s!.bg).toBe('rgb(255, 255, 255)');
        expect(s!.padTop).toBe('14px');
        expect(s!.boxSizing).toBe('border-box');
    });
});

// mermaid / math の block-fullscreen（別経路 = .block-fullscreen-*、ADR-006）も白背景 + 余白。
// mermaid は inline SVG で .outliner-image-large を通らず、専用の .block-fullscreen-mermaid-diagram を使う。
test.describe('mermaid / math fullscreen の白背景+余白 (standalone-notes)', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    async function blockFsStyle(page: Page, kind: 'mermaid' | 'math') {
        return page.evaluate((k) => {
            document.querySelectorAll('.block-fullscreen-overlay').forEach((n) => n.remove());
            const overlay = document.createElement('div');
            overlay.className = 'block-fullscreen-overlay block-fullscreen-' + k;
            const stage = document.createElement('div');
            stage.className = 'block-fullscreen-stage';
            const diagram = document.createElement('div');
            diagram.className = k === 'mermaid' ? 'block-fullscreen-mermaid-diagram' : 'block-fullscreen-math-display';
            stage.appendChild(diagram);
            overlay.appendChild(stage);
            document.body.appendChild(overlay);
            const cs = getComputedStyle(diagram);
            return { bg: cs.backgroundColor, padTop: cs.paddingTop, boxSizing: cs.boxSizing };
        }, kind);
    }

    // TC-LB-03: mermaid fullscreen が白背景 + 余白（透明 SVG が暗く見える問題の修正）
    test('TC-LB-03 mermaid fullscreen が白背景・余白あり', async ({ page }) => {
        const s = await blockFsStyle(page, 'mermaid');
        expect(s.bg, 'mermaid 白背景（旧 transparent から修正）').toBe('rgb(255, 255, 255)');
        expect(parseInt(s.padTop, 10), 'mermaid 余白あり（旧 padding:0 から修正）').toBeGreaterThan(0);
        expect(s.boxSizing).toBe('border-box');
    });

    // TC-LB-04: math fullscreen も白背景（旧 var(--bg-color) = dark テーマで暗かった）
    test('TC-LB-04 math fullscreen が白背景', async ({ page }) => {
        const s = await blockFsStyle(page, 'math');
        expect(s.bg, 'math 白背景').toBe('rgb(255, 255, 255)');
        expect(parseInt(s.padTop, 10)).toBeGreaterThan(0);
    });
});
