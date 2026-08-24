/**
 * viewer-docx-emf.spec.ts — docx の EMF 実描画配線（TC-DXV-15）
 *
 * sprint 20260823-165314-viewer-office-text-image 再オープン④（TASK-28 / ADRL-0097）。
 * renderImage を seam として直接検証（jsdom renderer 単体 — TC-PPV-16/18 と同方式）。
 * 変換可能なベクタ EMF → <img src=svg data URL> / 変換不能 → 従来 dxv-unsupported-img 枠。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

async function loadRender() {
    return import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-docx', 'render.mjs'));
}

// 最小の有効ベクタ EMF（viewer-emf.spec.ts と同レイアウト: 三角形 fill）
function makeEmf(): Uint8Array {
    const rec = (t: number, body: number[]) => {
        const size = 8 + body.length * 4;
        const b = new Uint8Array(size); const dv = new DataView(b.buffer);
        dv.setUint32(0, t, true); dv.setUint32(4, size, true);
        body.forEach((v, i) => dv.setInt32(8 + i * 4, v, true));
        return b;
    };
    const header = new Uint8Array(108);
    {
        const dv = new DataView(header.buffer);
        dv.setUint32(0, 1, true); dv.setUint32(4, 108, true);
        dv.setInt32(16, 99, true); dv.setInt32(20, 99, true);
        dv.setUint32(40, 0x464d4520, true);
    }
    const parts = [header,
        rec(9, [100, 100]), rec(10, [0, 0]),
        rec(39, [1, 0, 0x000000FF, 0]), rec(37, [1]),
        rec(59, []), rec(27, [10, 10]), rec(54, [90, 10]), rec(54, [50, 90]), rec(61, []), rec(60, []), rec(62, [0, 0, 0, 0]),
        rec(14, [0, 0, 5])];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total); let off = 0;
    for (const p of parts) { out.set(p, off); off += p.length; }
    return out;
}

function makeCtx(mediaBytes: Uint8Array | null) {
    return {
        pkg: {
            relTarget: () => 'media/image1.emf',
            media: async () => mediaBytes,
        },
        blobRegistry: { url: () => 'blob:fake' },
        label: (_k: string, fb: string) => fb,
    };
}

test('TC-DXV-15: docx の .emf — 変換可能はエンジン経由の <img> / 変換不能は従来 placeholder', async () => {
    const { renderImage } = await loadRender();
    expect(typeof renderImage, 'renderImage が seam として export されている').toBe('function');
    const dom = new JSDOM('<div id="a"></div><div id="b"></div>', { pretendToBeVisual: true });
    const doc = dom.window.document;
    const run = { relId: 'rId1', cx: 914400, cy: 914400 };

    // (1) 変換可能なベクタ EMF → img（counterfactual: 現行は即 placeholder = RED）
    const hostA = doc.getElementById('a')!;
    renderImage(doc, hostA, run, makeCtx(makeEmf()));
    await new Promise((r) => setTimeout(r, 20));   // 非同期 media 取得の完了待ち
    const img = hostA.querySelector('img') as HTMLImageElement | null;
    expect(img, '変換成功で img が生える').toBeTruthy();
    expect(String(img!.src).startsWith('data:image/svg+xml;base64,')).toBe(true);
    expect(hostA.querySelector('.dxv-unsupported-img')).toBeNull();

    // (2) 変換不能（garbage bytes）→ 従来の縮退枠
    const hostB = doc.getElementById('b')!;
    renderImage(doc, hostB, run, makeCtx(new Uint8Array([1, 2, 3, 4])));
    await new Promise((r) => setTimeout(r, 20));
    expect(hostB.querySelector('img')).toBeNull();
    const ph = hostB.querySelector('.dxv-unsupported-img') as HTMLElement | null;
    expect(ph, '縮退枠').toBeTruthy();
    expect(ph!.textContent).toBe('Image format not supported');
});
