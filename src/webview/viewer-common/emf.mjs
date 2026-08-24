/**
 * viewer-common/emf.mjs — 最小 EMF→SVG 変換器（MOD-EmfRenderer / 再オープン④ ADRL-0097）
 *
 * fractal original（sprint 20260823-165314）。仕様は design/system/viewer-emf.md が正。
 * 契約の核: **不確実なら描かない** — 対応レコードのホワイトリスト外・parse 失敗・上限超過は
 * すべて null を返し（throw しない）、呼び出し側の既存 placeholder 縮退に委ねる。
 * 出力 SVG は自前生成の数値 path と #RRGGBB hex のみ（入力由来文字列を埋め込まない = injection 面ゼロ）。
 */

export const MAX_INPUT = 5 * 1024 * 1024;      // 入力 5MB（pptx 配線の atob 前検査も参照 — TASK-31 SEC-1）
const MAX_RECORDS = 20000;              // レコード数
const MAX_POINTS = 20000;               // 1 レコードの点数
const MAX_SVG = 2 * 1024 * 1024;        // 出力 SVG 文字列

// 無視して継続してよい状態レコード（描画結果に影響しない or 明示的に近似を許容 — viewer-emf.md 準拠）
const IGNORABLE = new Set([
    17, // SETMAPMODE
    18, // SETBKMODE
    20, // SETROP2
    21, // SETSTRETCHBLTMODE
    22, // SETTEXTALIGN
    24, // SETTEXTCOLOR
    25, // SETBKCOLOR
    58, // SETMITERLIMIT
    13, // SETBRUSHORGEX
    70, // GDICOMMENT
    98, // SETICMMODE
    67, // SELECTCLIPPATH（クリップ無視 — 既知の近似）
    75, // EXTSELECTCLIPRGN（同上）
    30, // INTERSECTCLIPRECT（同上）
]);

function colorref(v) {
    // COLORREF = 0x00BBGGRR
    const r = v & 0xFF, g = (v >> 8) & 0xFF, b = (v >> 16) & 0xFF;
    const hex = (n) => n.toString(16).toUpperCase().padStart(2, '0');
    return `#${hex(r)}${hex(g)}${hex(b)}`;
}

/**
 * @param {ArrayBuffer|Uint8Array} input EMF バイト列（非信頼入力）
 * @returns {string|null} `data:image/svg+xml;base64,...` / 変換不能なら null
 */
export function emfToSvgDataUrl(input) {
    try {
        const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
        if (bytes.length < 88 || bytes.length > MAX_INPUT) { return null; }
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        if (dv.getUint32(0, true) !== 1) { return null; }                 // EMR_HEADER
        if (dv.getUint32(40, true) !== 0x464d4520) { return null; }       // ' EMF'
        // HEADER bounds（デバイス座標）— winExt 未設定時の viewBox フォールバック
        const bx0 = dv.getInt32(8, true), by0 = dv.getInt32(12, true);
        const bx1 = dv.getInt32(16, true), by1 = dv.getInt32(20, true);

        let winOrg = [0, 0];
        let winExt = null;
        let fillRule = 'nonzero';
        const objects = new Map();         // ih → { fill } | { none: true }
        let brush = { fill: '#000000' };
        let pen = null;                    // { stroke, width } — v1 は PS_SOLID のみ
        let path = null;                   // 構築中の path セグメント配列
        const paths = [];                  // { d, fill, rule, stroke, width }

        let off = dv.getUint32(4, true);   // HEADER の nSize から次レコードへ
        if (off < 88 || off > bytes.length) { return null; }
        let nRec = 0;
        let sawEof = false;

        const pts16 = (base) => {
            // レコード先頭 base から: type(4) size(4) rclBounds(16) cPts(4) points(cPts×4)
            const cnt = dv.getUint32(base + 24, true);
            if (cnt > MAX_POINTS) { throw new Error('MAX_POINTS exceeded'); }
            const out = [];
            for (let i = 0; i < cnt; i++) {
                out.push([dv.getInt16(base + 28 + i * 4, true), dv.getInt16(base + 28 + i * 4 + 2, true)]);
            }
            return out;
        };
        const flush = (mode) => {
            // mode: 'fill' | 'stroke' | 'both'
            if (!path || path.length === 0) { path = null; return; }
            const d = path.join(' ');
            const wantFill = (mode !== 'stroke') && brush && !brush.none;
            const wantStroke = (mode !== 'fill') && pen && !pen.none;
            if (wantFill || wantStroke) {
                paths.push({
                    d,
                    fill: wantFill ? brush.fill : 'none',
                    rule: fillRule,
                    stroke: wantStroke ? pen.stroke : null,
                    width: wantStroke ? pen.width : 0,
                });
            }
            path = null;
        };

        while (off + 8 <= bytes.length) {
            if (++nRec > MAX_RECORDS) { return null; }
            const t = dv.getUint32(off, true);
            const sz = dv.getUint32(off + 4, true);
            if (sz < 8 || sz % 4 !== 0 || off + sz > bytes.length) { return null; }
            switch (t) {
                case 14: sawEof = true; break;                                              // EOF
                case 9: winExt = [dv.getInt32(off + 8, true), dv.getInt32(off + 12, true)]; break;
                case 10: winOrg = [dv.getInt32(off + 8, true), dv.getInt32(off + 12, true)]; break;
                case 11: case 12: break;                                                    // viewport（viewBox は論理座標のため未使用）
                case 19: fillRule = dv.getUint32(off + 8, true) === 1 ? 'evenodd' : 'nonzero'; break;
                case 39: {                                                                  // CREATEBRUSHINDIRECT
                    const ih = dv.getUint32(off + 8, true);
                    const style = dv.getUint32(off + 12, true);
                    if (style === 0) { objects.set(ih, { fill: colorref(dv.getUint32(off + 16, true)) }); }
                    else if (style === 1) { objects.set(ih, { none: true }); }              // BS_NULL
                    else { return null; }                                                   // 他ブラシは subset 外
                    break;
                }
                case 38: {                                                                  // CREATEPEN {ih, LogPen{style, width(POINTL), color}}
                    const ih = dv.getUint32(off + 8, true);
                    const style = dv.getUint32(off + 12, true) & 0xFF;
                    if (style === 5) { objects.set(ih, { pen: true, none: true }); }        // PS_NULL
                    else if (style === 0) {                                                 // PS_SOLID
                        objects.set(ih, { pen: true, stroke: colorref(dv.getUint32(off + 24, true)), width: Math.max(1, dv.getInt32(off + 16, true)) });
                    }
                    else { return null; }
                    break;
                }
                case 95: {                                                                  // EXTCREATEPEN
                    // fractal fix (TASK-31 / reviewer iter8 QUAL-1): レイアウトは EMR(8)+ihPen@8+offBmi@12+cbBmi@16+
                    // offBits@20+cbBits@24 の後に EXTLOGPEN{PenStyle@28, Width@32, BrushStyle@36, ColorRef@40}
                    //（旧実装は 4 バイト手前を読み style/width/color を誤読 — TC-EMF-05 が番人）
                    const ih = dv.getUint32(off + 8, true);
                    const style = dv.getUint32(off + 28, true) & 0xFF;
                    if (style === 5) { objects.set(ih, { pen: true, none: true }); }
                    else if (style === 0) {
                        objects.set(ih, { pen: true, stroke: colorref(dv.getUint32(off + 40, true)), width: Math.max(1, dv.getUint32(off + 32, true)) });
                    }
                    else { return null; }
                    break;
                }
                case 37: {                                                                  // SELECTOBJECT
                    const ih = dv.getUint32(off + 8, true);
                    if (ih & 0x80000000) {                                                  // ストックオブジェクト
                        const stock = ih & 0x7FFFFFFF;
                        if (stock === 5) { brush = { none: true }; }                        // NULL_BRUSH
                        else if (stock === 8) { pen = { none: true }; }                     // NULL_PEN
                        else if (stock <= 7) { brush = { fill: '#000000' }; }               // 他 stock brush は黒近似
                        else { pen = { stroke: '#000000', width: 1 }; }
                        break;
                    }
                    const o = objects.get(ih);
                    if (!o) { break; }                                                      // 未知ハンドル選択は無視（描画時に既値）
                    if (o.pen) { pen = o.none ? { none: true } : { stroke: o.stroke, width: o.width }; }
                    else { brush = o; }
                    break;
                }
                case 40: objects.delete(dv.getUint32(off + 8, true)); break;                // DELETEOBJECT
                case 59: path = []; break;                                                  // BEGINPATH
                case 60: break;                                                             // ENDPATH
                case 61: if (path) { path.push('Z'); } break;                               // CLOSEFIGURE
                case 27: {                                                                  // MOVETOEX
                    if (path) { path.push(`M ${dv.getInt32(off + 8, true)} ${dv.getInt32(off + 12, true)}`); }
                    break;
                }
                case 54: {                                                                  // LINETO
                    if (path) { path.push(`L ${dv.getInt32(off + 8, true)} ${dv.getInt32(off + 12, true)}`); }
                    break;
                }
                case 87: case 89: {                                                         // POLYLINE16 / POLYLINETO16
                    const p = pts16(off);
                    if (path && p.length) {
                        let s = '';
                        if (t === 87) { s = `M ${p[0][0]} ${p[0][1]} ` + p.slice(1).map(([x, y]) => `L ${x} ${y}`).join(' '); }
                        else { s = p.map(([x, y]) => `L ${x} ${y}`).join(' '); }
                        path.push(s);
                    }
                    break;
                }
                case 86: {                                                                  // POLYGON16
                    const p = pts16(off);
                    if (path && p.length) {
                        path.push(`M ${p[0][0]} ${p[0][1]} ` + p.slice(1).map(([x, y]) => `L ${x} ${y}`).join(' ') + ' Z');
                    }
                    break;
                }
                case 85: case 88: {                                                         // POLYBEZIER16 / POLYBEZIERTO16
                    const p = pts16(off);
                    if (path && p.length) {
                        let s = '';
                        let i = 0;
                        if (t === 85) { s = `M ${p[0][0]} ${p[0][1]} `; i = 1; }
                        for (; i + 2 < p.length; i += 3) {
                            s += `C ${p[i][0]} ${p[i][1]} ${p[i + 1][0]} ${p[i + 1][1]} ${p[i + 2][0]} ${p[i + 2][1]} `;
                        }
                        path.push(s.trim());
                    }
                    break;
                }
                case 43: {                                                                  // RECTANGLE {rclBox}
                    const x0 = dv.getInt32(off + 8, true), y0 = dv.getInt32(off + 12, true);
                    const x1 = dv.getInt32(off + 16, true), y1 = dv.getInt32(off + 20, true);
                    paths.push({ d: `M ${x0} ${y0} L ${x1} ${y0} L ${x1} ${y1} L ${x0} ${y1} Z`, fill: brush && !brush.none ? brush.fill : 'none', rule: fillRule, stroke: pen && !pen.none ? pen.stroke : null, width: pen && !pen.none ? pen.width : 0 });
                    break;
                }
                case 42: {                                                                  // ELLIPSE {rclBox}
                    const x0 = dv.getInt32(off + 8, true), y0 = dv.getInt32(off + 12, true);
                    const x1 = dv.getInt32(off + 16, true), y1 = dv.getInt32(off + 20, true);
                    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, rx = Math.abs(x1 - x0) / 2, ry = Math.abs(y1 - y0) / 2;
                    paths.push({ d: `M ${cx - rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx + rx} ${cy} A ${rx} ${ry} 0 1 0 ${cx - rx} ${cy} Z`, fill: brush && !brush.none ? brush.fill : 'none', rule: fillRule, stroke: pen && !pen.none ? pen.stroke : null, width: pen && !pen.none ? pen.width : 0 });
                    break;
                }
                case 62: flush('fill'); break;                                              // FILLPATH
                case 63: flush('both'); break;                                              // STROKEANDFILLPATH
                case 64: flush('stroke'); break;                                            // STROKEPATH
                default:
                    if (!IGNORABLE.has(t)) { return null; }                                 // ホワイトリスト外 = 即 null
            }
            if (t === 14) { break; }
            off += sz;
        }
        if (!sawEof) { return null; }                     // EOF 必須（paths 0 件は透明画像として許容）

        let vb;
        // fractal fix (TASK-31 / reviewer iter8 DESN-1): 負 ext（軸反転）は v1 契約どおり null
        //（bounds フォールバックに落とすと誤った viewBox で描画してしまう — TC-EMF-06 が番人）
        if (winExt && (winExt[0] <= 0 || winExt[1] <= 0)) { return null; }
        if (winExt) { vb = [winOrg[0], winOrg[1], winExt[0], winExt[1]]; }
        else if (bx1 > bx0 && by1 > by0) { vb = [bx0, by0, bx1 - bx0 + 1, by1 - by0 + 1]; }
        else { return null; }

        let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb[0]} ${vb[1]} ${vb[2]} ${vb[3]}">`;
        for (const p of paths) {
            svg += `<path d="${p.d}" fill="${p.fill}" fill-rule="${p.rule}"`;
            if (p.stroke) { svg += ` stroke="${p.stroke}" stroke-width="${p.width}"`; }
            svg += '/>';
            if (svg.length > MAX_SVG) { return null; }
        }
        svg += '</svg>';
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    } catch (e) {
        return null;    // 契約: いかなる失敗も null（throw しない）
    }
}
