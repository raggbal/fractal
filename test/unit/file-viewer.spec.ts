/**
 * file-viewer.spec.ts — viewer webview 本体（file-viewer.js）の実 Chromium 検証
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-02 / testcases.md C 節。
 * ハーネス: standalone-viewer.html（実行前に test:build:all 必須 — stale ビルド事故防止）。
 * 表示系は実レンダ結果を assert（合成イベント禁止 — generator_failures 2026-08-10/12）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const HTML_DIR = path.join(ROOT, 'test', 'html');
const FIXTURE_PDF = path.join(ROOT, 'test', 'fixtures', 'doc-search', 'fixture-ja-en.pdf');

/** fixture html/img をテストサーバー配下に書き出す（相対参照の実測用） */
function writeViewerFixtures(): void {
    const dir = path.join(HTML_DIR, 'viewer-fixtures');
    fs.mkdirSync(dir, { recursive: true });
    // 1x1 PNG
    const png = Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
        'base64');
    fs.writeFileSync(path.join(dir, 'pic.png'), png);
    // script / class / コメント / td 癒着 / entity / 相対 img / リンクを 1 枚に同居
    fs.writeFileSync(path.join(dir, 'sample.html'), [
        '<!DOCTYPE html><html><head>',
        '<style>.meeting-notes { color: red; }</style>',
        '<script>window.parent.postMessage("pwned-from-iframe", "*"); document.title = "pwned";</script>',
        '</head><body>',
        '<!-- コメント内秘匿語 -->',
        '<div class="meeting-notes">議事録本文</div>',
        '<table><tr><td>東京</td><td>大阪</td></tr></table>',
        '<p>A&amp;B&nbsp;C</p>',
        '<img src="pic.png" id="rel-img">',
        '<a href="https://example.com/away" id="nav-link">リンク</a>',
        '</body></html>',
    ].join('\n'));
    // TASK-12: script 実行の可観測プローブ（postMessage は不変条件 7 の capture 遮断で
    // 届かないため観測子に使えない — 実行痕跡は iframe 内 DOM に書かせて Playwright で読む）
    fs.writeFileSync(path.join(dir, 'script-probe.html'), [
        '<!DOCTYPE html><html><head><meta charset="utf-8"><title>probe</title></head><body>',
        '<div class="body-text">本文が見える</div>',
        '<div id="out"></div>',
        '<script>document.getElementById("out").textContent = "RAN";<\/script>',
        '</body></html>',
    ].join('\n'));
    // TASK-12: 選択・コピー用のプレーン html（script なし = copy ヘルパー以外の変数を排除）
    fs.writeFileSync(path.join(dir, 'plain-text.html'), [
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
        '<p id="para">コピー対象テキスト</p>',
        '</body></html>',
    ].join('\n'));
    // TASK-12: 外部送信の試行（オプトイン ON で script が動いても継承 connect-src で落ちる）
    fs.writeFileSync(path.join(dir, 'leak.html'), [
        '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>',
        '<div id="out"></div>',
        '<script>',
        'document.getElementById("out").textContent = "RAN";',
        'fetch("https://example.com/leak")',
        '  .then(function () { document.getElementById("out").textContent = "LEAKED"; })',
        '  .catch(function () { document.getElementById("out").textContent = "BLOCKED"; });',
        '<\/script>',
        '</body></html>',
    ].join('\n'));
    // 壊れた PDF
    fs.writeFileSync(path.join(dir, 'broken.pdf'), Buffer.from('not a pdf at all'));
    // 実 PDF fixture をコピー
    fs.copyFileSync(FIXTURE_PDF, path.join(dir, 'ja-en.pdf'));
}

test.beforeAll(() => { writeViewerFixtures(); });

test.describe('file-viewer: HTML 面（FR-FV-04 / NFR-FV-03）', () => {

    // H-5（TASK-12・許可: test_update）: 旧 TC-FV-01（script 非実行番人）は削除。
    // counterfactual「sandbox に allow-scripts を足すと RED」が ADRL-0067 で不成立になったため
    // （sandbox は既定 allow-scripts になり、防御の実体は blob 継承 CSP の script-src nonce に移った）。
    // 後継 = TC-FV-41（下の「script ゲート」describe。本文表示 + ユーザー script 不実行の番人は維持し、
    // counterfactual を「同一 nonce を与えると実行される」に組替）。

    test('TC-FV-02: 相対参照 img がロードされる（方式 B: blob + base 注入の恒久番人）', async ({ page }) => {
        const imgRequests: string[] = [];
        page.on('request', (req) => { if (req.url().endsWith('pic.png')) { imgRequests.push(req.url()); } });
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/sample.html', document.getElementById('viewer-root'));
        });
        await page.waitForTimeout(1500);
        expect(imgRequests.length, '相対 img のネットワークリクエストが発生する').toBeGreaterThan(0);
    });

    test('TC-FV-03: 外部リンククリックで外部コンテンツがロードされない（親 CSP frame-src の抑止 = 受容事項 2 の pin）', async ({ page }) => {
        // 実測（2026-08-15）: sandbox 属性はリンクによる iframe 内遷移自体を止めない
        // （ADRL-0067 で既定 allow-scripts になった後も同じ — sandbox は遷移の抑止手段ではない）。
        // 抑止の実体は親 CSP frame-src — 外部 URL はブロックされ iframe は chrome-error に落ちる
        // （外部コンテンツは一切ロードされない）。counterfactual: frame-src を外すと example.com へ遷移。
        const externalRequests: string[] = [];
        page.on('request', (r) => { if (r.url().includes('example.com')) { externalRequests.push(r.url()); } });
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/sample.html', document.getElementById('viewer-root'));
        });
        await page.waitForTimeout(1000);
        const frame = page.frames().find((f) => f.url().startsWith('blob:'));
        expect(frame).toBeTruthy();
        await frame!.locator('#nav-link').click();
        await page.waitForTimeout(1200);
        expect(externalRequests, '外部 URL へのリクエストが発生しない（CSP ブロック）').toEqual([]);
        const externalFrame = page.frames().find((f) => f.url().includes('example.com'));
        expect(externalFrame, '外部コンテンツの frame が存在しない').toBeUndefined();
        // 方式 B 補足: blob origin からの外部遷移も frame-src が止める（サンドボックスと CSP の二重防御は不変）
        expect(page.url()).toContain('standalone-viewer');     // 親は遷移しない
    });
});

/** #viewer-root 配下の iframe が指す現在の blob frame を取得（toggle で src が差し替わるため毎回引き直す） */
async function currentBlobFrame(page: import('@playwright/test').Page, timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const src = await page.evaluate(() =>
            (document.querySelector('#viewer-root iframe') as HTMLIFrameElement | null)?.src || '');
        if (src.startsWith('blob:')) {
            const frame = page.frames().find((f) => f.url() === src);
            if (frame) { return frame; }
        }
        await page.waitForTimeout(150);
    }
    throw new Error('blob frame が現れない');
}

/** frame 内 #out の textContent（script 実行痕跡の観測子。不変条件 7 で postMessage は使えない） */
async function probeOut(frame: import('@playwright/test').Frame): Promise<string> {
    return await frame.evaluate(() => document.getElementById('out')?.textContent || '');
}

test.describe('file-viewer: script ゲート（FR-FV-10 / FR-FV-11 / ADRL-0067）', () => {

    test('TC-FV-41: 既定はユーザー script 不実行 + 本文表示（counterfactual: 同一 nonce を与えると実行される）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/script-probe.html', document.getElementById('viewer-root'));
        });
        const frame = await currentBlobFrame(page);
        await page.waitForTimeout(800);

        // 本文は見える（sandbox 既定が allow-scripts になっても表示は不変）
        expect(await frame.locator('.body-text').textContent()).toBe('本文が見える');
        // ユーザー script は実行されない（防御の実体 = blob が継承した CSP script-src 'nonce-...'）
        expect(await probeOut(frame), 'nonce なしのユーザー script が実行された').toBe('');

        // counterfactual 実測: 同一 html の script に注入ヘルパーと同じ nonce を与えると実行される
        // （= 不実行の原因が「script が動かない環境」ではなく nonce ゲートであることの対証明）
        const nonced = await page.evaluate(async () => {
            const nonce = (window as any).__viewerConfig.nonce;
            const html = `<!DOCTYPE html><html><body><div id="out"></div>`
                + `<script nonce="${nonce}">document.getElementById("out").textContent = "RAN";</` + `script></body></html>`;
            const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.src = url;
            document.body.appendChild(iframe);
            await new Promise((r) => setTimeout(r, 800));
            return { url };
        });
        const cfFrame = page.frames().find((f) => f.url() === nonced.url);
        expect(cfFrame, 'counterfactual iframe が現れない').toBeTruthy();
        expect(await probeOut(cfFrame!), 'nonce 付き script が実行されない — CSP 前提が崩れている').toBe('RAN');
    });

    test('TC-FV-42: sandbox は allow-scripts 厳密一致（allow-same-origin 混在は sandbox 脱出 = 不変条件 6）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/sample.html', document.getElementById('viewer-root'));
        });
        await currentBlobFrame(page);
        const sandbox = await page.evaluate(() =>
            (document.querySelector('#viewer-root iframe') as HTMLIFrameElement).getAttribute('sandbox'));
        expect(sandbox, 'sandbox はリテラル allow-scripts 固定').toBe('allow-scripts');
        expect(sandbox || '', 'allow-same-origin が混在（allow-scripts と併記で sandbox 脱出）').not.toContain('allow-same-origin');
        // 実装側も literal 固定であること（変数結合で allow-same-origin が混入する経路を残さない）
        const src = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'file-viewer.js'), 'utf-8');
        expect(src, 'sandbox 値がリテラルで書かれていない').toContain(`setAttribute('sandbox', 'allow-scripts')`);
        // コメント（「allow-same-origin は絶対に併記しない」の警告文）は許容し、
        // コード = 文字列リテラル / setAttribute 実引数に現れることだけを禁じる
        const codeLines = src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l));
        const sameOriginInCode = codeLines.filter((l) => l.includes('allow-same-origin'));
        expect(sameOriginInCode, 'allow-same-origin がコード行に現れる（sandbox 脱出経路）').toEqual([]);
    });

    test('TC-FV-43: cmd+c が既定で効く（注入 copy ヘルパー — VS Code webview の native copy 殺しの回避）', async ({ page, context }) => {
        await context.grantPermissions(['clipboard-read', 'clipboard-write']);
        await page.goto('/standalone-viewer.html');
        // 事前汚染: 「取れた」と「元から入っていた」を区別する sentinel
        await page.evaluate(async () => {
            try { await navigator.clipboard.writeText('__SENTINEL__'); } catch { /* 権限外は無視 */ }
        });
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/plain-text.html', document.getElementById('viewer-root'));
        });
        const frame = await currentBlobFrame(page);
        await page.waitForTimeout(500);

        // 注入ヘルパーより後に発火する window 段 probe（bubble 順: document → window）で
        // 「ヘルパーが preventDefault したか」を観測する。
        // counterfactual: ヘルパー注入を外すと defaultPrevented === false
        // （ハーネス Chromium では native copy が代替してしまい clipboard 内容だけでは判別できない。
        //   本番 VS Code webview は nested iframe の native copy を殺すため実機では空になる — vscode#129178）
        await frame.evaluate(() => {
            (window as any).__copyKeyPrevented = null;
            window.addEventListener('keydown', (e) => {
                if (e.key === 'c' && (e.metaKey || e.ctrlKey)) { (window as any).__copyKeyPrevented = e.defaultPrevented; }
            });
        });
        await frame.locator('#para').click();
        await frame.evaluate(() => {
            const p = document.getElementById('para')!;
            const range = document.createRange();
            range.selectNodeContents(p);
            const sel = window.getSelection()!;
            sel.removeAllRanges();
            sel.addRange(range);
        });
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+c' : 'Control+c');
        await page.waitForTimeout(600);

        const prevented = await frame.evaluate(() => (window as any).__copyKeyPrevented);
        expect(prevented, '注入 copy ヘルパーが cmd+c を処理していない（preventDefault 痕跡なし）').toBe(true);
        const text = await page.evaluate(() => navigator.clipboard.readText());
        expect(text, 'クリップボードに選択テキストが入らない').toContain('コピー対象テキスト');
    });

    test('TC-FV-44: 「スクリプトを許可」ON で再読込 → ユーザー script が実行される（sandbox は不変）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/script-probe.html', document.getElementById('viewer-root'));
        });
        let frame = await currentBlobFrame(page);
        await page.waitForTimeout(600);
        expect(await probeOut(frame), '既定で実行されている（前提崩れ）').toBe('');

        await page.click('.viewer-script-toggle');   // 実クリック
        await page.waitForTimeout(1200);
        frame = await currentBlobFrame(page);
        // counterfactual: nonce rewrite を外すと '' のまま = RED
        expect(await probeOut(frame), 'オプトイン ON でも script が実行されない').toBe('RAN');
        // 本文も維持される（再生成で壊れない）
        expect(await frame.locator('.body-text').textContent()).toBe('本文が見える');
        // sandbox は ON/OFF に関係なく allow-scripts 固定（不変条件 6）
        const sandbox = await page.evaluate(() =>
            (document.querySelector('#viewer-root iframe') as HTMLIFrameElement).getAttribute('sandbox'));
        expect(sandbox).toBe('allow-scripts');
        // toggle は ON 状態を表示する
        expect(await page.getAttribute('.viewer-script-toggle', 'aria-pressed')).toBe('true');
    });

    test('TC-FV-45: OFF 復帰で静的に戻る + 旧 objectURL revoke + 別ファイルは静的から開始', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__revoked = [];
            const orig = URL.revokeObjectURL.bind(URL);
            URL.revokeObjectURL = (u: string) => { (window as any).__revoked.push(u); orig(u); };
            (window as any).__fileViewer.open('html', './viewer-fixtures/script-probe.html', document.getElementById('viewer-root'));
        });
        await currentBlobFrame(page);
        await page.waitForTimeout(600);

        // ON
        await page.click('.viewer-script-toggle');
        await page.waitForTimeout(1200);
        let frame = await currentBlobFrame(page);
        expect(await probeOut(frame)).toBe('RAN');
        const onUrl = await page.evaluate(() =>
            (document.querySelector('#viewer-root iframe') as HTMLIFrameElement).src);

        // OFF 復帰
        await page.click('.viewer-script-toggle');
        await page.waitForTimeout(1200);
        frame = await currentBlobFrame(page);
        expect(await probeOut(frame), 'OFF に戻しても script が実行される').toBe('');
        expect(await page.getAttribute('.viewer-script-toggle', 'aria-pressed')).toBe('false');
        // one-shot リソースの clear 契機: 差し替えた旧 blob URL は revoke される（リーク防止）
        const revoked = await page.evaluate(() => (window as any).__revoked as string[]);
        expect(revoked, '差し替え前の objectURL が revoke されていない').toContain(onUrl);

        // 別ファイルを開いたら state はリセットされ静的から始まる（非永続）
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/leak.html', document.getElementById('viewer-root'));
        });
        await page.waitForTimeout(1200);
        frame = await currentBlobFrame(page);
        expect(await probeOut(frame), '別ファイルでオプトインが引き継がれている').toBe('');
        expect(await page.getAttribute('.viewer-script-toggle', 'aria-pressed')).toBe('false');
    });

    test('TC-FV-46: ON でも外部送信は継承 connect-src でブロックされる（オプトインの被害上限）', async ({ page }) => {
        const externalRequests: string[] = [];
        page.on('request', (r) => { if (r.url().includes('example.com')) { externalRequests.push(r.url()); } });
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('html', './viewer-fixtures/leak.html', document.getElementById('viewer-root'));
        });
        await currentBlobFrame(page);
        await page.waitForTimeout(600);

        await page.click('.viewer-script-toggle');
        await page.waitForTimeout(1500);
        const frame = await currentBlobFrame(page);
        // script は実行されている（= ゲートは開いた。この前提が崩れると以下が vacuous pass になる）
        expect(['BLOCKED', 'LEAKED'], 'ON でも script が動いていない — 検証が空回りする').toContain(await probeOut(frame));
        // 本命: 外部 fetch は継承 CSP connect-src 'self' で落ちる
        expect(await probeOut(frame), '外部送信が成功した（connect-src が効いていない）').toBe('BLOCKED');
        expect(externalRequests, 'example.com へのリクエストが発生した').toEqual([]);
    });
});

test.describe('file-viewer: PDF 面（FR-FV-03）', () => {

    test('TC-FV-04: PDF 実レンダ — canvas 非ゼロ + 非空白 + ズーム再レンダ', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        // pdfjs のレンダ完了を canvas 出現で待つ
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        await page.waitForTimeout(1000);   // 描画完了余裕
        const info = await page.evaluate(() => {
            const canvas = document.querySelector('.pdfViewer canvas') as HTMLCanvasElement;
            if (!canvas) { return null; }
            // 非空白判定: 全ピクセル白でないこと（toDataURL は膨大なので imageData サンプリング）
            const ctx = canvas.getContext('2d')!;
            const d = ctx.getImageData(0, 0, Math.min(canvas.width, 200), Math.min(canvas.height, 200)).data;
            let nonWhite = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] < 250 || d[i + 1] < 250 || d[i + 2] < 250) { nonWhite++; }
            }
            return { w: canvas.width, h: canvas.height, nonWhite };
        });
        expect(info).not.toBeNull();
        expect(info!.w).toBeGreaterThan(0);
        expect(info!.h).toBeGreaterThan(0);
        expect(info!.nonWhite, '描画済み（真っ白でない）').toBeGreaterThan(0);
        // ズーム再レンダ（実クリック）
        const before = info!.w;
        await page.click('.viewer-zoom-in');
        await page.waitForTimeout(1500);
        const afterW = await page.evaluate(() => (document.querySelector('.pdfViewer canvas') as HTMLCanvasElement)?.width || 0);
        expect(afterW, 'ズームで canvas 幅が変わる').not.toBe(before);
    });

    test('TC-FV-05: 壊れた PDF → 読み込み失敗表示 + OS で開くボタンが message を送る', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/broken.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.viewer-error', { timeout: 10000 });
        const errText = await page.locator('.viewer-error').textContent();
        expect(errText).toContain('表示できません');
        // OS で開くボタン（実クリック → postMessage 記録をハーネスの __postedMessages で観測）
        await page.click('.viewer-open-external');
        const posted = await page.evaluate(() => (window as any).__postedMessages);
        expect(posted.some((m: any) => m.type === 'openExternalFallback')).toBe(true);
    });

    test('TC-FV-07: ホスト webview の border-box 下でも textLayer が canvas と一致する（選択テキストのズレ番人）', async ({ page }) => {
        // 実機検収（2026-08-15）: note / sidepanel 面は src/webview/styles.css:17 の
        // `* { box-sizing: border-box }` を読む。pdfjs は .page の width/height を
        // 「内容領域 = scale × ページ寸法」として算出する（pdf.mjs setLayerDimensions）が、
        // .page は 9px の透明 border を持つため border-box では内容領域が縦横 18px 縮み、
        // canvas（width:100%）だけが縮んで textLayer（inset:0）とズレる → 範囲選択した
        // コピー用テキストが実描画から外れる。counterfactual: file-viewer.js の
        // `.page, .page * { box-sizing: content-box }` を外すと canvas だけ 18px 縮んで RED。
        await page.goto('/standalone-viewer.html');
        await page.addStyleTag({ content: '* { margin: 0; padding: 0; box-sizing: border-box; }' });
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 20000 });
        await page.waitForTimeout(1500);   // textLayer の span 生成まで待つ
        const geo = await page.evaluate(() => {
            const pageDiv = document.querySelector('.pdfViewer .page') as HTMLElement;
            const canvas = pageDiv.querySelector('canvas') as HTMLElement;
            const textLayer = pageDiv.querySelector('.textLayer') as HTMLElement;
            const spans = Array.from(textLayer.querySelectorAll('span')) as HTMLElement[];
            // 実文字が乗った span（幅を持つもの）で位置を確認する
            const sized = spans.map((s) => s.getBoundingClientRect()).filter((r) => r.width > 20 && r.height > 5);
            const c = canvas.getBoundingClientRect();
            const t = textLayer.getBoundingClientRect();
            return {
                boxSizing: getComputedStyle(pageDiv).boxSizing,
                canvas: { x: c.left, y: c.top, w: c.width, h: c.height },
                textLayer: { x: t.left, y: t.top, w: t.width, h: t.height },
                spanCount: sized.length,
                outside: sized.filter((r) => r.left < c.left - 2 || r.right > c.right + 2).length,
            };
        });
        expect(geo.boxSizing, 'viewer 配下の .page は content-box に復元される').toBe('content-box');
        expect(geo.spanCount, 'textLayer に実寸の span がある').toBeGreaterThan(0);
        // 核: canvas と textLayer が同一矩形（ズレ 1px 未満）。fix を外すと canvas だけ 18px 小さくなる
        expect(Math.abs(geo.textLayer.w - geo.canvas.w), 'textLayer 幅が canvas 幅と一致').toBeLessThan(1);
        expect(Math.abs(geo.textLayer.h - geo.canvas.h), 'textLayer 高さが canvas 高さと一致').toBeLessThan(1);
        expect(Math.abs(geo.textLayer.x - geo.canvas.x), 'textLayer 左端が canvas と一致').toBeLessThan(1);
        expect(Math.abs(geo.textLayer.y - geo.canvas.y), 'textLayer 上端が canvas と一致').toBeLessThan(1);
        expect(geo.outside, '選択用 span が canvas 描画域の外に出ていない').toBe(0);
    });

    test('TC-FV-06: isEvalSupported:false が getDocument 実引数に渡る', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        const params = await page.evaluate(() => (window as any).__lastGetDocumentParams);
        expect(params).not.toBeNull();
        expect(params.isEvalSupported).toBe(false);
        expect(params.cMapUrl).toBeTruthy();   // 日本語 PDF 用 cmaps 指定
    });
});

test.describe('file-viewer: destroy のリソース解放（reviewer iter1 TASK-10 / TC-FV-40）', () => {

    test('TC-FV-40: destroy(mount) で pdfDocument.destroy が呼ばれる（ARCH-CONS-1 番人）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__lastPdfDocDestroyed = false;
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 30000 });
        await page.evaluate(() => {
            (window as any).__fileViewer.destroy(document.getElementById('viewer-root'));
        });
        const destroyed = await page.evaluate(() => (window as any).__lastPdfDocDestroyed);
        // counterfactual: destroy が cleanupRegistry を呼ばないと false のまま = RED
        // （note 面の hideViewer → destroy(container) 連結は TC-FV-22 が DOM 面で検証済み）
        expect(destroyed, 'pdfDocument.destroy() が呼ばれた').toBe(true);
    });
});

test.describe('file-viewer: ツールバー 4 ボタン（FR-FV-08 / ADRL-0068 / design §10）', () => {

    test('TC-FV-50: 4 ボタンの実クリックで host 向け message が filePath 付きで飛ぶ', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open(
                'html', './viewer-fixtures/plain-text.html',
                document.getElementById('viewer-root'), '/tmp/plain-text.html');
        });
        await page.waitForSelector('.viewer-toolbar', { timeout: 10000 });

        // 実クリック（合成イベント禁止 — generator_failures 2026-08-10/12）→ ハーネスの
        // __postedMessages で観測（TC-FV-05 と同じレコーダー経路）
        await page.click('.viewer-open-in-new-tab');
        await page.click('.viewer-copy-path');
        await page.click('.viewer-copy-inapp-link');
        await page.click('.viewer-export-file');
        const posted: any[] = await page.evaluate(() => (window as any).__postedMessages);

        const byType = (t: string) => posted.filter((m) => m && m.type === t);
        for (const t of ['viewerOpenInNewTab', 'viewerCopyPath', 'viewerCopyInAppLink', 'viewerExportFile']) {
            expect(byType(t).length, `${t} が 1 件飛ぶ`).toBe(1);
            const m = byType(t)[0];
            expect(m.filePath, `${t} は filePath を運ぶ（host 側 case が fs パスを使う）`).toBe('/tmp/plain-text.html');
            expect(m.fileUri, `${t} は fileUri を運ぶ`).toContain('plain-text.html');
        }
        // openInNewTab だけは host が viewType を選ぶために kind を要する（design §10）
        expect(byType('viewerOpenInNewTab')[0].kind, 'viewerOpenInNewTab は kind を運ぶ').toBe('html');
    });

    test('TC-FV-51: standalone 面は Open in new tab 非表示 / filePath 不在の非 standalone は Copy In-App Link 非表示', async ({ page }) => {
        await page.goto('/standalone-viewer.html');

        // (b) 非 standalone（ハーネス = __viewerConfig に kind/fileUri なし）+ filePath 不在
        await page.evaluate(() => {
            (window as any).__fileViewer.open(
                'html', './viewer-fixtures/plain-text.html', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.viewer-toolbar', { timeout: 10000 });
        expect(await page.locator('.viewer-open-in-new-tab').count(),
            '非 standalone では Open in new tab を出す').toBe(1);
        expect(await page.locator('.viewer-copy-inapp-link').count(),
            'filePath が無ければ Copy In-App Link は出さない（逆引き不能）').toBe(0);
        expect(await page.locator('.viewer-copy-path').count(), 'Copy Path は常時').toBe(1);
        expect(await page.locator('.viewer-export-file').count(), 'Export は常時').toBe(1);

        // (a) standalone 面を再現（host の fileViewerContent.ts は config に kind/fileUri を注入する）
        await page.evaluate(() => {
            (window as any).__viewerConfig.kind = 'html';
            (window as any).__viewerConfig.fileUri = './viewer-fixtures/plain-text.html';
            (window as any).__fileViewer.open(
                'html', './viewer-fixtures/plain-text.html', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.viewer-toolbar', { timeout: 10000 });
        expect(await page.locator('.viewer-open-in-new-tab').count(),
            'standalone 面は既にタブなので Open in new tab を出さない').toBe(0);
        expect(await page.locator('.viewer-copy-inapp-link').count(),
            'standalone は filePath 無しでも host が document.uri を持つので出す').toBe(1);
    });
});

// ── 再オープン③（FR-FV-15 / ADRL-0070 — pdfjs viewer バンドル 5.x 化と選択品質） ──────
test.describe('file-viewer: pdf 選択品質 + 版更新（FR-FV-15 / ADRL-0070）', () => {

    test('TC-FV-70: 選択機構 contract — .endOfContent 実在 + mousedown で .selecting 付与 + wasm/icc URL 導出', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        // PR #17923 機構（4.10 から搭載・5.x でも維持）: TextLayerBuilder が textLayer 末尾に endOfContent を置く
        await page.waitForSelector('.textLayer .endOfContent', { state: 'attached', timeout: 15000 });   // 通常時は高さ 0 帯（inset:100% 0 0）= visible でない
        // 実マウス down で .textLayer.selecting が付与される（選択中は endOfContent が全面化して
        // span 間ギャップの選択途切れを受け止める — 滑らか選択の核）
        const box = await page.locator('.textLayer').first().boundingBox();
        expect(box).not.toBeNull();
        await page.mouse.move(box!.x + box!.width / 2, box!.y + Math.min(40, box!.height / 2));
        await page.mouse.down();
        const selecting = await page.evaluate(() => !!document.querySelector('.textLayer.selecting'));
        await page.mouse.up();
        expect(selecting, 'mousedown 中に .textLayer.selecting が付与される').toBe(true);
        // 〔再オープン④で反転 — 許可: test_update〕旧「wasmUrl/iccUrl の導出」assert は撤回。
        // wasm 配線は worker の同期 fetch タイムアウト（≈30 秒白画面）を誘発するため NFR-FV-06 で禁止 —
        // 不在 + useWasm:false の pin は TC-FV-72 が担う（本 TC は選択機構の contract のみ）
    });

    test('TC-FV-70c: 検証 fixture は tagged PDF（Marked:true）+ textLayer に .markedContent 実在（#19785 症状の前提）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        await page.waitForSelector('.textLayer .endOfContent', { state: 'attached', timeout: 15000 });   // 通常時は高さ 0 帯（inset:100% 0 0）= visible でない
        const res = await page.evaluate(async () => {
            // 同一モジュール再 import（workerSrc は open() が設定済みの singleton を共有）
            const cfg = (window as any).__viewerConfig;
            const lib = await import(/* @vite-ignore */ cfg.pdfjsLibUri);
            const resp = await fetch('./viewer-fixtures/ja-en.pdf');
            const data = await resp.arrayBuffer();
            const pdf = await lib.pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
            const mi = await pdf.getMarkInfo();
            await pdf.destroy();
            return {
                marked: !!(mi && mi.Marked),
                markedContentCount: document.querySelectorAll('.textLayer .markedContent').length,
            };
        });
        // スパイク実測（2026-08-16 node 側 getMarkInfo）: fixture-ja-en.pdf は Marked:true —
        // 新規 tagged fixture は不要（design-tdd「tagged PDF fixture の確保」手順 1 の帰結）
        expect(res.marked, 'fixture は tagged PDF').toBe(true);
        expect(res.markedContentCount, '.markedContent ラッパー実在 = #19785 対象構造を実際に踏んでいる').toBeGreaterThan(0);
    });

    test('TC-FV-70b: 版 contract — viewer=alias 5.x（≥5.4.530）/ 検索 vendor=4.10.38 の両 pin', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        // viewer 側: alias devDependency（ADRL-0070。^5.7.284 = 検証済み版を下限に pin — ≥5.4.530 要件充足）
        const alias = pkg.devDependencies && pkg.devDependencies['pdfjs-viewer-dist'];
        expect(alias, 'pdfjs-viewer-dist alias が devDependencies に存在').toBeTruthy();
        // SEC-1（reviewer iteration 4）: **明示 pin（^ なし）** を enforce — ^ 指定は「下限以上の最新」を
        // npm audit 照合なしに受容し、既知 CVE 範囲へ自動追従する（generator_failures 2026-08-16）
        expect(String(alias)).toMatch(/^npm:pdfjs-dist@5\./);
        expect(String(alias).includes('^'), '範囲指定（^）でなく明示 pin であること').toBe(false);
        const installed = JSON.parse(
            fs.readFileSync(path.join(ROOT, 'node_modules', 'pdfjs-viewer-dist', 'package.json'), 'utf8')).version;
        const [maj, min, patch] = installed.split('.').map(Number);
        const atLeast54530 = maj > 5 ? false : (min > 4 || (min === 4 && patch >= 530));
        expect(maj, '5.x 系（6.x は ADRL-0070 で見送り）').toBe(5);
        expect(atLeast54530, `#19785(5.2.133+)/#20492(5.4.530+) を含む版（実測 ${installed}）`).toBe(true);
        // SEC-1/SEC-2（reviewer iteration 4）: 既知 CVE 範囲の**除外**も対で pin — 下限だけの contract は
        // 脆弱版への自動更新を素通しする。GHSA-hq66-cqwq-w95j（悪意 PDF → 任意 JS 実行・high）の
        // 対象範囲 >=5.6.83 <6.2.108 に入らないこと（6.x は上の maj===5 で既に排除）
        const inKnownCveRange = (min >= 7) || (min === 6 && patch >= 83);
        expect(inKnownCveRange,
            `GHSA-hq66-cqwq-w95j 範囲（>=5.6.83）外であること（実測 ${installed} — 採用可能なのは 5.4.530〜5.5.x）`).toBe(false);
        // 検索 vendor 側: 4.10.38 pin 不変（ADRL-0057 非破壊）
        expect(pkg.dependencies['pdfjs-dist'] || pkg.devDependencies['pdfjs-dist']).toBe('4.10.38');
        const vendorSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-pdfjs-vendor.js'), 'utf8');
        expect(vendorSrc.includes('pdfjs-viewer-dist'), '検索 vendor は alias を参照しない').toBe(false);
        // viewer build script は alias を参照する
        const viewerBuildSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'build-pdfjs-viewer.js'), 'utf8');
        expect(viewerBuildSrc.includes("'pdfjs-viewer-dist'")).toBe(true);
        expect(viewerBuildSrc.includes('pdfjs-viewer-dist/build/pdf.mjs')).toBe(true);
    });

    test("TC-FV-71: wasm CSP contract — スパイク実測 = 'wasm-unsafe-eval' 不要（3 面とも不在の対称 pin）", () => {
        // スパイク実測（2026-08-16）: 本番相当 CSP の standalone viewer ハーネスで pdfjs 5.7 の
        // 実レンダ（TC-FV-04/07/70）が CSP 違反なしに green。標準レンダ経路は wasm 非依存で、
        // JPX/JBIG2/ICC は wasm/ に nowasm fallback JS が同梱（4.10 比で機能後退なし）。
        // → 'wasm-unsafe-eval' は追記しない。将来必要になった場合は 3 面**全部**に対で追記する
        //（片肺配線の禁止 — この TC が非対称を RED にする）
        const faces = ['src/fileViewerContent.ts', 'src/notesWebviewContent.ts', 'src/outlinerWebviewContent.ts'];
        const has = faces.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('wasm-unsafe-eval'));
        expect(new Set(has).size, '3 面の wasm-unsafe-eval 有無が非対称').toBe(1);
        expect(has[0], "現裁定 = 不要（全面とも不在）").toBe(false);
    });
});

// ── 再オープン③（FR-FV-12 — ツールバーのアイコン化と md 準拠並び） ──────
test.describe('file-viewer: ツールバーのアイコン化（FR-FV-12）', () => {

    test('TC-FV-61: グリフ正典一致 — md sidepanel / LUCIDE_ICONS からの複製を字面で pin', () => {
        const viewerSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'file-viewer.js'), 'utf8');
        const bodyHtmlSrc = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'editor-body-html.js'), 'utf8');
        const utilsSrc = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'editor-utils.js'), 'utf8');

        /** VIEWER_ICONS の key の SVG 文字列を file-viewer.js ソースから抽出 */
        const viewerIcon = (key: string): string => {
            const m = viewerSrc.match(new RegExp(`${key}:\\s*'(<svg[^']+</svg>)'`));
            expect(m, `file-viewer.js の VIEWER_ICONS に ${key} が無い`).not.toBeNull();
            return m![1];
        };
        /** editor-body-html.js のテンプレから、識別子直後の SVG を抽出 */
        const templateIcon = (marker: string): string => {
            const idx = bodyHtmlSrc.indexOf(marker);
            expect(idx, `editor-body-html.js に ${marker} が無い`).toBeGreaterThan(-1);
            const m = bodyHtmlSrc.slice(idx).match(/<svg[\s\S]*?<\/svg>/);
            expect(m, `${marker} の直後に svg が無い`).not.toBeNull();
            return m![0];
        };
        /** editor-utils.js の LUCIDE_ICONS から抽出 */
        const lucideIcon = (key: string): string => {
            const m = utilsSrc.match(new RegExp(`'${key}':\\s*'(<svg[^']+</svg>)'`));
            expect(m, `editor-utils.js の LUCIDE_ICONS に ${key} が無い`).not.toBeNull();
            return m![1];
        };

        // md sidepanel テンプレ正典（editor-body-html.js）と完全一致（verbatim 複製の pin —
        // counterfactual: グリフを独自形に書き換えると RED = 新規発明の防止・generator_failures 2026-08-14）
        expect(viewerIcon('export')).toBe(templateIcon('data-action="exportBundle"'));
        expect(viewerIcon('copyPath')).toBe(templateIcon('id="sidePanelCopyPath"'));
        expect(viewerIcon('copyInAppLink')).toBe(templateIcon('id="sidePanelCopyInAppLink"'));
        expect(viewerIcon('openInNewTab')).toBe(templateIcon('id="sidePanelOpenTab"'));
        expect(viewerIcon('expand')).toBe(templateIcon('id="sidePanelExpand"'));
        // LUCIDE_ICONS 正典（editor-utils.js）と完全一致
        expect(viewerIcon('openInStandalone')).toBe(lucideIcon('openInTextEditor'));
        expect(viewerIcon('allowScripts')).toBe(lucideIcon('code'));
        // md analog 不在の新規最小は openExternal のみ（存在だけ確認 — 正典比較対象なし）
        expect(viewerIcon('openExternal')).toContain('<svg');
    });

    test('TC-FV-62: アイコン化 + DOM 全順序 contract（OS で開く が左端・Open in new tab が最右端）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        // 非 standalone + タブ strip あり（notes 面相当）を再現: Open in Standalone を可視化する
        // 明示メソッド stub（Proxy 禁止 — generator_failures 2026-08-09）
        await page.evaluate(() => {
            (window as any).__notesTabManager = { openInNewTab: () => { /* recorder 不要 — 表示検証のみ */ } };
            (window as any).__fileViewer.open(
                'html', './viewer-fixtures/plain-text.html',
                document.getElementById('viewer-root'), '/tmp/plain-text.html');
        });
        await page.waitForSelector('.viewer-toolbar', { timeout: 10000 });

        // (c) DOM 全順序（§13 = FR-FV-12 と同一。隣接ペア全部 — 部分順序では逆順実装を素通しする）
        const classesInOrder = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.viewer-toolbar button')).map((b) => b.className));
        const expected = [
            'viewer-script-toggle',        // html 面
            'viewer-open-external',        // OS で開く = アクション群左端
            'viewer-open-in-standalone',
            'viewer-export-file',
            'viewer-copy-path',
            'viewer-copy-inapp-link',
            'viewer-open-in-new-tab',      // 最右端（sidepanel 面では × の直前）
        ];
        expect(classesInOrder, 'DOM 順が §13 の全順序と一致').toEqual(expected);

        // (a)(b) 全ボタンがアイコン（svg 子要素 + 可視テキストなし）+ title/aria-label
        const info = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.viewer-toolbar button')).map((b) => ({
                cls: b.className,
                hasSvg: !!b.querySelector('svg'),
                text: (b.textContent || '').trim(),
                title: b.getAttribute('title') || '',
                aria: b.getAttribute('aria-label') || '',
            })));
        for (const b of info) {
            expect(b.hasSvg, `${b.cls}: svg アイコンを持つ`).toBe(true);
            expect(b.text, `${b.cls}: 可視テキストラベルなし`).toBe('');
            expect(b.title.length, `${b.cls}: title(tooltip) あり`).toBeGreaterThan(0);
            expect(b.aria.length, `${b.cls}: aria-label あり`).toBeGreaterThan(0);
        }

        // pdf 面: zoom −/+ は script 許可スロットの位置（記号ボタン・title/aria は必須）
        await page.evaluate(() => {
            (window as any).__fileViewer.open(
                'pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'), '/tmp/ja-en.pdf');
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        const pdfClasses = await page.evaluate(() =>
            Array.from(document.querySelectorAll('.viewer-toolbar button')).map((b) => b.className));
        expect(pdfClasses).toEqual([
            'viewer-zoom-out', 'viewer-zoom-in',
            'viewer-open-external', 'viewer-open-in-standalone', 'viewer-export-file',
            'viewer-copy-path', 'viewer-copy-inapp-link', 'viewer-open-in-new-tab',
        ]);
        const zoomInfo = await page.evaluate(() => {
            const z = document.querySelector('.viewer-zoom-in')!;
            return { title: z.getAttribute('title') || '', aria: z.getAttribute('aria-label') || '' };
        });
        expect(zoomInfo.title.length).toBeGreaterThan(0);
        expect(zoomInfo.aria.length).toBeGreaterThan(0);
    });
});

// ── 再オープン④（NFR-FV-06 — 表示速度の絶対優先。手動テスト第 7 ラウンド②） ──────
test.describe('file-viewer: 表示速度の絶対ルール（NFR-FV-06）', () => {

    test('TC-FV-72: getDocument params に useWasm:false があり wasmUrl/iccUrl が無い（ブロッキング fetch の芽の不在）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        const params = await page.evaluate(() => (window as any).__lastGetDocumentParams);
        // counterfactual: wasmUrl/iccUrl を配線すると pdfjs 5.x worker が ICC 色空間で
        // fetchSync(qcms_bg.wasm) を同期実行 → vscode-webview では ≈30 秒の白画面（実機第 7 ラウンド②）
        expect(params.useWasm, '速度絶対優先 — wasm 経路を最初から無効化').toBe(false);
        expect(params.wasmUrl, 'wasmUrl を配線しない（worker 同期 fetch の芽）').toBeUndefined();
        expect(params.iccUrl, 'iccUrl を配線しない（同上）').toBeUndefined();
    });
});

// ── 第 8 ラウンド①（cmd+A の viewer 内スコープ） ──────
test.describe('file-viewer: cmd+A は PDF テキストに限定', () => {

    test('TC-FV-75: pdf 表示中の cmd+A が viewer 外へはみ出さない（selectNodeContents スコープ）', async ({ page }) => {
        await page.goto('/standalone-viewer.html');
        await page.evaluate(() => {
            (window as any).__fileViewer.open('pdf', './viewer-fixtures/ja-en.pdf', document.getElementById('viewer-root'));
        });
        await page.waitForSelector('.pdfViewer canvas', { timeout: 15000 });
        await page.waitForSelector('.textLayer .endOfContent', { state: 'attached', timeout: 15000 });
        // viewer 内をクリック → 実キー cmd+A（合成イベント禁止 — generator_failures 2026-08-12）
        const box = (await page.locator('.viewer-pdf-container').boundingBox())!;
        await page.mouse.click(box.x + box.width / 2, box.y + 60);
        await page.keyboard.press(process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        const res = await page.evaluate(() => {
            const sel = window.getSelection()!;
            const container = document.querySelector('.viewer-pdf-container')!;
            const inside = (n: Node | null) => !!n && container.contains(n);
            return {
                ranges: sel.rangeCount,
                anchorInside: inside(sel.anchorNode),
                focusInside: inside(sel.focusNode),
                text: sel.toString().slice(0, 50),
            };
        });
        expect(res.ranges).toBe(1);
        // counterfactual: スコープ handler が無いと select-all は document 全体（anchor = body 側）に及ぶ
        expect(res.anchorInside, '選択の始端が viewer 内').toBe(true);
        expect(res.focusInside, '選択の終端が viewer 内').toBe(true);
        expect(res.text.length, 'PDF テキストが選択されている').toBeGreaterThan(0);
    });
});
