/**
 * viewer-origin-guard.spec.ts — "null" origin capture 遮断（不変条件 7 / ADRL-0067 決定 4②）
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-13 / testcases.md H-2 節。
 * ハーネス: standalone-notes.html + standalone-viewer.html（実行前 test:build:all 必須）。
 *
 * TC-FV-47: behavioral 番人 — 実 iframe（sandbox="allow-scripts" = opaque origin, event.origin === 'null'）
 *           から parent.postMessage で host message を偽装しても listener に届かない（副作用ゼロ）。
 *           同じ type を同一 origin の window.postMessage で送ると受理される（誤爆なしの対証明）。
 *           counterfactual: capture 遮断（bootstrap 最初期の stopImmediatePropagation）を外すと
 *           偽装 showNoteViewer が viewer-dispatcher.js:98 の listener に届いて RED。
 * TC-FV-48: 配線網羅（source contract 補助）— notes/outliner/viewer の各 bootstrap 生成元に
 *           capture 遮断が 1 本ずつ存在し、かつ「最初の message listener 登録」であること。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

test.describe('"null" origin capture 遮断（NFR-FV-03 不変条件 7）', () => {

    test('TC-FV-47: opaque origin の偽装 message は遮断され、同一 origin は受理される（behavioral 対証明）', async ({ page }) => {
        await page.goto('/standalone-notes.html');

        // viewer-dispatcher が待つ showNoteViewer を sandbox iframe から偽装する。
        // 遮断が効いていれば viewerContainer は生成/表示されない（副作用ゼロ）。
        const spoofed = await page.evaluate(async () => {
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');   // opaque origin → event.origin === 'null'
            iframe.srcdoc = `<script>parent.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: 'https://attacker.example/x.html', fileName: 'x.html', filePath: '/tmp/x.html' }, '*');<\/script>`;
            document.body.appendChild(iframe);
            await new Promise((r) => setTimeout(r, 600));
            const dispatcher = (window as any).__viewerDispatcher;
            return {
                viewerShown: dispatcher ? dispatcher.isViewerShown() : null,
                hasDispatcher: !!dispatcher,
            };
        });
        expect(spoofed.hasDispatcher).toBe(true);      // dispatcher 自体は組込済み（前提の実在確認）
        expect(spoofed.viewerShown).toBe(false);       // 偽装は届かない（capture 遮断を外すと true = RED）

        // 対証明: 同一 origin（host 相当）の window.postMessage は受理される — 誤爆なし
        const legit = await page.evaluate(async () => {
            window.postMessage({ type: 'showNoteViewer', kind: 'html', fileUri: './viewer-fixtures/sample.html', fileName: 'sample.html', filePath: '/tmp/sample.html' }, '*');
            await new Promise((r) => setTimeout(r, 600));
            return (window as any).__viewerDispatcher.isViewerShown();
        });
        expect(legit).toBe(true);
    });

    test('TC-FV-47b: viewer 面（standalone-viewer）でも opaque origin message が遮断される', async ({ page }) => {
        // 注意: srcdoc/blob の spoof iframe は本番相当 CSP（script-src nonce — policy container 継承）で
        // script 自体がブロックされ vacuous pass になる。served fixture（script-src 'self' で実行可）を使い、
        // sandbox 無し（同一 origin）で「偽装機構が実際に発火する」ことを先に実証してから遮断を検証する。
        const dir = path.join(ROOT, 'test', 'html', 'viewer-fixtures');
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, 'spoof.html'),
            `<!DOCTYPE html><html><body><script>parent.postMessage({ type: 'openViewerPanel', spoof: true }, '*');</script></body></html>`);
        await page.goto('/standalone-viewer.html');

        // ① 発火実証（sandbox 無し = 同一 origin）: fixture の script が実行され message が届く
        const liveness = await page.evaluate(async () => {
            const seen: any[] = [];
            window.addEventListener('message', (e) => { seen.push({ origin: e.origin, data: e.data }); });
            const iframe = document.createElement('iframe');
            iframe.src = './viewer-fixtures/spoof.html';
            document.body.appendChild(iframe);
            await new Promise((r) => setTimeout(r, 600));
            iframe.remove();
            return seen;
        });
        expect(liveness.some((m) => m.data && m.data.spoof === true), 'spoof fixture が発火しない — テスト機構が壊れている').toBe(true);

        // ② 遮断検証（sandbox="allow-scripts" = opaque origin, event.origin === 'null'）
        const result = await page.evaluate(async () => {
            const seen: any[] = [];
            window.addEventListener('message', (e) => { seen.push({ origin: e.origin, data: e.data }); });
            const iframe = document.createElement('iframe');
            iframe.setAttribute('sandbox', 'allow-scripts');
            iframe.src = './viewer-fixtures/spoof.html';
            document.body.appendChild(iframe);
            await new Promise((r) => setTimeout(r, 600));
            // 同一 origin は届く（対証明）
            window.postMessage({ type: 'legit' }, '*');
            await new Promise((r) => setTimeout(r, 100));
            return seen;
        });
        expect(result.some((m) => m.origin === 'null')).toBe(false);          // 偽装は遮断（counterfactual: 遮断を外すと届いて RED）
        expect(result.some((m) => m.data && m.data.type === 'legit')).toBe(true);  // 同一 origin は受理
    });

    test('TC-FV-48: 配線網羅 — notes/outliner/viewer の bootstrap に capture 遮断が最初期登録されている', () => {
        const targets = [
            // [生成元, 説明]
            [path.join(ROOT, 'src', 'notesWebviewContent.ts'), 'notes 面'],
            [path.join(ROOT, 'src', 'outlinerWebviewContent.ts'), 'outliner 面'],
            [path.join(ROOT, 'src', 'fileViewerContent.ts'), 'viewer standalone 面'],
        ] as const;
        const GUARD_BODY = "if (e.origin === 'null') { e.stopImmediatePropagation(); }";
        for (const [file, label] of targets) {
            const src = fs.readFileSync(file, 'utf-8');
            // ① 遮断が存在する（字面 pin — 生成 HTML にそのまま埋まる inline script）
            const guardIdx = src.indexOf(GUARD_BODY);
            expect(guardIdx, `${label}（${path.basename(file)}）に capture 遮断が無い`).toBeGreaterThanOrEqual(0);
            // ② capture フラグ付きで登録されている
            expect(src.slice(guardIdx, guardIdx + 200).includes('true'), `${label}: 遮断が capture 登録でない`).toBe(true);
            // ③ 最初期登録である — ファイル内で最初に現れる addEventListener('message' が遮断ブロックの中
            //   （capture リスナーは登録順発火のため、後着だと stopImmediatePropagation が先行リスナーに効かない）
            const firstListener = src.indexOf("addEventListener('message'");
            expect(firstListener, `${label}: message listener が見つからない`).toBeGreaterThanOrEqual(0);
            expect(firstListener < guardIdx, `${label}: 遮断本体より前の位置に addEventListener が無い（構造想定崩れ）`).toBe(true);
            const secondListener = src.indexOf("addEventListener('message'", firstListener + 1);
            expect(
                secondListener === -1 || secondListener > guardIdx,
                `${label}: capture 遮断より前に別の message listener 登録がある（最初期登録の不変条件違反）`
            ).toBe(true);
        }
        // editor.js は SKIP 確定（design §12 — addEventListener('message' grep 0 件・2026-08-15 実測）。
        // 将来 listener が生えたら本 TC の対象に追加すること（ここで 0 件を pin して回帰検知）:
        const editorJs = fs.readFileSync(path.join(ROOT, 'src', 'webview', 'editor.js'), 'utf-8');
        expect(editorJs.includes("addEventListener('message'"), 'editor.js に message listener が生えた — TASK-13 の SKIP 前提が崩れたため capture 遮断の要否を再判定せよ').toBe(false);
    });
});
