/**
 * viewer-emf.spec.ts — EMF→SVG subset 変換器の unit 番人（TC-EMF-01..04）
 *
 * sprint 20260823-165314-viewer-office-text-image 再オープン④（TASK-26 / ADRL-0097）。
 * 仕様は design/system/viewer-emf.md（レコード表・上限・null 契約）が正。
 * fixture は spec 内で EMF バイト列を合成（MS-EMF レコードレイアウト準拠。実 deck の EMF は commit しない）。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

async function loadEngine() {
    return import(/* webpackIgnore: true */
        path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-common', 'emf.mjs'));
}

// ── EMF レコード合成ヘルパ ──
function rec(iType: number, body: number[]): Uint8Array {
    const size = 8 + body.length * 4;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, iType, true);
    dv.setUint32(4, size, true);
    body.forEach((v, i) => dv.setInt32(8 + i * 4, v, true));
    return buf;
}
function rec16pts(iType: number, pts: Array<[number, number]>): Uint8Array {
    // POLYLINETO16(89)/POLYBEZIERTO16(88)/POLYLINE16(87)等: rclBounds(16) + cPts(4) + POINTS16
    const size = 8 + 16 + 4 + pts.length * 4;
    const buf = new Uint8Array(size);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, iType, true);
    dv.setUint32(4, size, true);
    // rclBounds はゼロで良い（エンジンは winExt を使う）
    dv.setUint32(24, pts.length, true);
    pts.forEach(([x, y], i) => {
        dv.setInt16(28 + i * 4, x, true);
        dv.setInt16(28 + i * 4 + 2, y, true);
    });
    return buf;
}
function header(): Uint8Array {
    const buf = new Uint8Array(108);
    const dv = new DataView(buf.buffer);
    dv.setUint32(0, 1, true);            // EMR_HEADER
    dv.setUint32(4, 108, true);
    // rclBounds: 0,0,99,99（device）
    dv.setInt32(16, 99, true); dv.setInt32(20, 99, true);
    dv.setUint32(40, 0x464d4520, true);  // ' EMF' signature
    return buf;
}
function eof(): Uint8Array { return rec(14, [0, 0, 5]); }
function emf(...records: Uint8Array[]): Uint8Array {
    const all = [header(), ...records, eof()];
    const total = all.reduce((n, r) => n + r.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const r of all) { out.set(r, off); off += r.length; }
    return out;
}
const COMMON = () => [
    rec(9, [400, 300]),                       // SETWINDOWEXTEX
    rec(10, [0, 0]),                          // SETWINDOWORGEX
    rec(11, [100, 75]), rec(12, [0, 0]),      // SETVIEWPORT*
    rec(39, [1, 0 /*BS_SOLID*/, 0x0000A5FF /*COLORREF: R=FF,G=A5,B=00 = orange*/, 0]), // CREATEBRUSHINDIRECT ihBrush=1
    rec(37, [1]),                             // SELECTOBJECT brush 1
];
const TRIANGLE = () => [
    rec(59, []),                              // BEGINPATH
    rec(27, [10, 10]),                        // MOVETOEX
    rec16pts(89, [[390, 10], [200, 290]]),    // POLYLINETO16
    rec16pts(88, [[150, 200], [100, 150], [10, 10]]),  // POLYBEZIERTO16（1 ベジェ = 3 点）
    rec(61, []),                              // CLOSEFIGURE
    rec(60, []),                              // ENDPATH
    rec(62, [0, 0, 0, 0]),                    // FILLPATH（rclBounds）
];
function decodeSvg(dataUrl: string): string {
    expect(dataUrl.startsWith('data:image/svg+xml;base64,')).toBe(true);
    return Buffer.from(dataUrl.slice('data:image/svg+xml;base64,'.length), 'base64').toString('utf8');
}

test('TC-EMF-01: 正常系 — path fill 系レコードのベクタ EMF が SVG data URL に変換される', async () => {
    const { emfToSvgDataUrl } = await loadEngine();
    const out = emfToSvgDataUrl(emf(...COMMON(), ...TRIANGLE()));
    expect(out, '変換成功').toBeTruthy();
    const svg = decodeSvg(out!);
    expect(svg).toContain('<path');
    expect(svg).toContain('#FFA500');                       // COLORREF 0x0000A5FF → RGB(FF,A5,00)
    expect(svg).toContain('viewBox="0 0 400 300"');         // winOrg + winExt
    expect(svg).toContain('C ');                            // ベジェが出力されている
    expect(svg).toContain('Z');                             // CLOSEFIGURE
});

test('TC-EMF-02: 塗り規則 evenodd / BS_NULL は無出力', async () => {
    const { emfToSvgDataUrl } = await loadEngine();
    // ALTERNATE(1) = evenodd
    const out1 = emfToSvgDataUrl(emf(...COMMON(), rec(19, [1]), ...TRIANGLE()));
    expect(decodeSvg(out1!)).toContain('fill-rule="evenodd"');
    // BS_NULL(1) ブラシで FILLPATH → path を出力しない
    const nullBrush = [
        rec(9, [400, 300]), rec(10, [0, 0]),
        rec(39, [1, 1 /*BS_NULL*/, 0, 0]), rec(37, [1]),
    ];
    const out2 = emfToSvgDataUrl(emf(...nullBrush, ...TRIANGLE()));
    expect(out2, 'BS_NULL でも変換自体は成功').toBeTruthy();
    expect(decodeSvg(out2!)).not.toContain('<path');
});

test('TC-EMF-03: 縮退系 — subset 外レコード・不正バイト列は null（throw しない）', async () => {
    const { emfToSvgDataUrl } = await loadEngine();
    // (a) ホワイトリスト外の描画レコード（EXTTEXTOUTW=84）
    expect(emfToSvgDataUrl(emf(...COMMON(), rec(84, [0, 0, 0, 0])))).toBeNull();
    // (b) 不正 size（size<8）レコード
    const bad = emf(...COMMON());
    const dv = new DataView(bad.buffer);
    dv.setUint32(108 + 4, 4, true);   // 先頭レコード（SETWINDOWEXTEX）の size を 4 に破壊
    expect(emfToSvgDataUrl(bad)).toBeNull();
    // (c) 非 EMF バイト列（signature 不一致）
    expect(emfToSvgDataUrl(new Uint8Array(200))).toBeNull();
    expect(emfToSvgDataUrl(new Uint8Array([1, 2, 3]))).toBeNull();
});

test('TC-EMF-04: 上限 4 種 — レコード数 / 入力バイト長 / 1 レコード点数 / 出力 SVG 長の超過は全て null', async () => {
    // reviewer iteration 8 SEC-2/DESN-2: 4 上限全てに counterfactual（DoS ガードの退行番人）
    const { emfToSvgDataUrl } = await loadEngine();
    // (a) MAX_RECORDS: 20,000 超のレコード（MOVETOEX を 21,000 個）
    const many: Uint8Array[] = [];
    for (let i = 0; i < 21000; i++) { many.push(rec(27, [i % 100, i % 100])); }
    expect(emfToSvgDataUrl(emf(...COMMON(), ...many)), 'MAX_RECORDS').toBeNull();
    // (b) MAX_INPUT: 5MB 超の入力（先頭は有効ヘッダ — サイズだけで reject されること）
    const big = new Uint8Array(5 * 1024 * 1024 + 16);
    big.set(emf(...COMMON()));
    expect(emfToSvgDataUrl(big), 'MAX_INPUT').toBeNull();
    // (c) MAX_POINTS: 1 レコード 20,001 点の POLYLINETO16
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < 20001; i++) { pts.push([i % 30000, (i * 7) % 30000]); }
    expect(emfToSvgDataUrl(emf(...COMMON(), rec(59, []), rec(27, [0, 0]), rec16pts(89, pts), rec(62, [0, 0, 0, 0]))), 'MAX_POINTS').toBeNull();
    // (d) MAX_SVG: 出力 SVG が 2MB を超える合成入力（5 桁座標 ×2,000 点の fill path を大量に）
    const bigPts: Array<[number, number]> = [];
    for (let i = 0; i < 2000; i++) { bigPts.push([10000 + (i % 19999), 10000 + ((i * 13) % 19999)]); }
    const groups: Uint8Array[] = [];
    for (let g = 0; g < 110; g++) {
        groups.push(rec(59, []), rec(27, [10000, 10000]), rec16pts(89, bigPts), rec(62, [0, 0, 0, 0]));
    }
    expect(emfToSvgDataUrl(emf(...COMMON(), ...groups)), 'MAX_SVG').toBeNull();
});

test('TC-EMF-05: pen — CREATEPEN/EXTCREATEPEN の stroke 出力と PS_NULL、EXTCREATEPEN の正オフセット', async () => {
    // reviewer iteration 8 QUAL-1: EXTCREATEPEN のフィールドは EMR(8)+ihPen(4)+offBmi(4)+cbBmi(4)+offBits(4)+cbBits(4)
    // の後の EXTLOGPEN{PenStyle@+28, Width@+32, BrushStyle@+36, ColorRef@+40}（4 バイトずれの counterfactual）
    const { emfToSvgDataUrl } = await loadEngine();
    const strokeTri = () => [
        rec(59, []), rec(27, [10, 10]), rec(54, [200, 10]), rec(54, [100, 200]), rec(61, []), rec(60, []), rec(64, [0, 0, 0, 0]), // STROKEPATH
    ];
    // (1) CREATEPEN(38): {ih=2, LOGPEN{style=PS_SOLID(0), width POINTL{3,0}, color=0x00CC8800(R=00,G=88,B=CC)}}
    const out1 = emfToSvgDataUrl(emf(
        rec(9, [400, 300]), rec(10, [0, 0]),
        rec(38, [2, 0, 3, 0, 0x00CC8800]), rec(37, [2]),
        ...strokeTri()));
    const svg1 = decodeSvg(out1!);
    expect(svg1).toContain('stroke="#0088CC"');
    expect(svg1).toContain('stroke-width="3"');
    // (2) EXTCREATEPEN(95): {ih=3, offBmi=0, cbBmi=0, offBits=0, cbBits=0, EXTLOGPEN{PenStyle=PS_SOLID(0), Width=5, BrushStyle=0, Color=0x000000FF(赤), Hatch=0, N=0}}
    const out2 = emfToSvgDataUrl(emf(
        rec(9, [400, 300]), rec(10, [0, 0]),
        rec(95, [3, 0, 0, 0, 0, /*PenStyle*/0, /*Width*/5, /*BrushStyle*/0, /*Color*/0x000000FF, /*Hatch*/0, /*N*/0]), rec(37, [3]),
        ...strokeTri()));
    const svg2 = decodeSvg(out2!);
    expect(svg2, 'EXTCREATEPEN の色（正オフセット @+40）').toContain('stroke="#FF0000"');
    expect(svg2, 'EXTCREATEPEN の幅（正オフセット @+32）').toContain('stroke-width="5"');
    // (3) EXTCREATEPEN PS_NULL(5) → stroke path 無出力
    const out3 = emfToSvgDataUrl(emf(
        rec(9, [400, 300]), rec(10, [0, 0]),
        rec(95, [3, 0, 0, 0, 0, /*PenStyle=PS_NULL*/5, /*Width*/5, /*BrushStyle*/0, /*Color*/0x000000FF, 0, 0]), rec(37, [3]),
        ...strokeTri()));
    expect(decodeSvg(out3!), 'PS_NULL ペンの STROKEPATH は無出力').not.toContain('<path');
});

test('TC-EMF-06: 負の winExt（軸反転）は v1 契約どおり null（bounds フォールバックに落ちない）', async () => {
    // reviewer iteration 8 DESN-1: design/system/viewer-emf.md「負 ext は v1 では null」の counterfactual
    const { emfToSvgDataUrl } = await loadEngine();
    const out = emfToSvgDataUrl(emf(
        rec(9, [400, -300]), rec(10, [0, 0]),
        rec(39, [1, 0, 0x00FFFFFF, 0]), rec(37, [1]),
        ...TRIANGLE()));
    expect(out).toBeNull();
});
