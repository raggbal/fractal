/**
 * Notes mode side panel での cmd+c/v 挙動を実際の Playwright で確認
 * ユーザー報告: ![](rel) → cmd+c/v → ![](abs) になる + ファイル複製されない
 */
import { test, expect } from '@playwright/test';

test.describe('Notes side panel — cmd+c/v debug', () => {
    test.beforeEach(async ({ page }) => {
        await page.goto('/standalone-notes.html');
        await page.waitForFunction(() => (window as any).__testApi?.ready);
    });

    test('side panel に ![](rel) を render し、その img の DOM 状態を観測', async ({ page }) => {
        const result = await page.evaluate(() => {
            // Side panel を開く (mock)
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '![alt-text](files/diagram.drawio.svg)',
                filePath: '/Users/raggbal/Desktop/tasks/mns20pzd8hcj/page1.md',
                fileName: 'page1.md',
                toc: [],
                documentBaseUri: 'http://localhost:3000/note1/'
            });
            // 少し待つ (内部 setTimeout 等)
            return new Promise((resolve) => {
                setTimeout(() => {
                    const sidePanel = document.querySelector('.side-panel');
                    const images = sidePanel ? sidePanel.querySelectorAll('img') : [];
                    const imgs = Array.from(images).map((img: any) => ({
                        src: img.getAttribute('src'),
                        alt: img.getAttribute('alt'),
                        markdownPath: img.dataset.markdownPath,
                        outerHTML: img.outerHTML.slice(0, 300)
                    }));
                    resolve({
                        sidePanelExists: !!sidePanel,
                        imgCount: images.length,
                        imgs
                    });
                }, 500);
            });
        });
        console.log('=== DOM after side panel open ===');
        console.log(JSON.stringify(result, null, 2));
        // assert がなくても観測ログでわかる
    });

    test('cmd+c の copy handler が clipboard に何を書き込むか', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '![alt-text](files/diagram.drawio.svg)\n',
                filePath: '/Users/raggbal/Desktop/tasks/mns20pzd8hcj/page1.md',
                fileName: 'page1.md',
                toc: [],
                documentBaseUri: 'http://localhost:3000/note1/'
            });
        });
        await page.waitForTimeout(500);

        const result = await page.evaluate(() => {
            const sidePanel = document.querySelector('.side-panel');
            const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
            const img = editor?.querySelector('img');
            if (!editor || !img) return { error: 'editor or img not found', editor: !!editor, img: !!img };

            // Selection: 画像を含む段落を全選択
            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);

            // ClipboardEvent を simulate (実 clipboard は使えないが、e.clipboardData だけ DataTransfer で fake)
            const clipboardData = new DataTransfer();
            const copyEvent = new ClipboardEvent('copy', {
                clipboardData: clipboardData,
                bubbles: true,
                cancelable: true,
            });
            // ClipboardEvent.clipboardData は readonly なので明示 set
            Object.defineProperty(copyEvent, 'clipboardData', { value: clipboardData });
            editor.dispatchEvent(copyEvent);

            return {
                imgDataset: img.dataset.markdownPath,
                imgSrc: img.getAttribute('src'),
                clipboardPlain: clipboardData.getData('text/plain'),
                clipboardAnyMd: clipboardData.getData('text/x-any-md'),
                clipboardContext: clipboardData.getData('text/x-any-md-context'),
                clipboardIsCut: clipboardData.getData('text/x-any-md-iscut'),
                clipboardHtml: (clipboardData.getData('text/html') || '').slice(0, 300)
            };
        });
        console.log('=== cmd+c result ===');
        console.log(JSON.stringify(result, null, 2));
        // 重要 assertion:
        expect(result.clipboardAnyMd).toContain('files/diagram.drawio.svg');
        expect(result.clipboardAnyMd).not.toContain('http://');
        expect(result.clipboardAnyMd).not.toContain('/Users/');
    });

    test('もし source MD に絶対パスが入っていたら cmd+c で何が出る?', async ({ page }) => {
        // MD source 自体が絶対 fs path を含むケース (user 報告と同じ形)
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '![files/diagram.drawio.svg](/Users/raggbal/Desktop/tasks/mns20pzd8hcj/files/diagram.drawio.svg)\n',
                filePath: '/Users/raggbal/Desktop/tasks/mns20pzd8hcj/page1.md',
                fileName: 'page1.md',
                toc: [],
                documentBaseUri: 'http://localhost:3000/users-raggbal-desktop-tasks-mns20pzd8hcj/'
            });
        });
        await page.waitForTimeout(500);

        const result = await page.evaluate(() => {
            const sidePanel = document.querySelector('.side-panel');
            const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
            const img = editor?.querySelector('img');
            if (!editor || !img) return { error: 'no img' };

            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);

            const clipboardData = new DataTransfer();
            const copyEvent = new ClipboardEvent('copy', { clipboardData, bubbles: true, cancelable: true });
            Object.defineProperty(copyEvent, 'clipboardData', { value: clipboardData });
            editor.dispatchEvent(copyEvent);

            return {
                imgDatasetMarkdownPath: img.dataset.markdownPath,
                imgSrc: img.getAttribute('src'),
                clipboardAnyMd: clipboardData.getData('text/x-any-md'),
                clipboardPlain: clipboardData.getData('text/plain'),
            };
        });
        console.log('=== abs path source test ===');
        console.log(JSON.stringify(result, null, 2));
    });

    test('user が cmd+c した相対パス MD を、再度 paste すると markdown はどう書かれるか', async ({ page }) => {
        await page.evaluate(() => {
            (window as any).__hostMessageHandler({
                type: 'openSidePanel',
                markdown: '![alt-text](files/diagram.drawio.svg)\n',
                filePath: '/note1/page1.md',
                fileName: 'page1.md',
                toc: [],
                documentBaseUri: 'http://localhost:3000/note1/'
            });
        });
        await page.waitForTimeout(500);

        const result = await page.evaluate(() => {
            const sidePanel = document.querySelector('.side-panel');
            const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
            if (!editor) return { error: 'no editor' };

            const range = document.createRange();
            range.selectNodeContents(editor);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);

            // copy
            const clipData = new DataTransfer();
            const copyEv = new ClipboardEvent('copy', { clipboardData: clipData, bubbles: true, cancelable: true });
            Object.defineProperty(copyEv, 'clipboardData', { value: clipData });
            editor.dispatchEvent(copyEv);

            // 取得した clipboard 内容を log
            const internalMd = clipData.getData('text/x-any-md');
            const ctx = clipData.getData('text/x-any-md-context');

            // cursor を末尾へ
            const lastP = editor.querySelector('p:last-of-type');
            if (lastP) {
                const r2 = document.createRange();
                r2.setStart(lastP, lastP.childNodes.length);
                r2.collapse(true);
                sel.removeAllRanges();
                sel.addRange(r2);
            }

            // paste
            const pasteEv = new ClipboardEvent('paste', { clipboardData: clipData, bubbles: true, cancelable: true });
            Object.defineProperty(pasteEv, 'clipboardData', { value: clipData });
            editor.dispatchEvent(pasteEv);

            // 結果 (DOM)
            return {
                clipInternalMd: internalMd,
                clipContext: ctx,
                editorHTML: editor.innerHTML.slice(0, 800)
            };
        });

        await page.waitForTimeout(500);

        // paste 後の DOM を再確認
        const after = await page.evaluate(() => {
            const sidePanel = document.querySelector('.side-panel');
            const editor: any = sidePanel?.querySelector('.editor[contenteditable]');
            const imgs = editor?.querySelectorAll('img');
            return {
                imgCount: imgs?.length || 0,
                imgs: Array.from(imgs || []).map((img: any) => ({
                    src: img.getAttribute('src'),
                    alt: img.getAttribute('alt'),
                    markdownPath: img.dataset.markdownPath
                })),
                editorHTML: editor?.innerHTML.slice(0, 800)
            };
        });

        console.log('=== copy result ===');
        console.log(JSON.stringify(result, null, 2));
        console.log('=== after paste ===');
        console.log(JSON.stringify(after, null, 2));
    });
});
