/**
 * viewer-docx/styles.mjs — スタイル 4 層解決（MOD-DocxStyleEngine / FR-DXV-03）
 *
 * 解決順: docDefaults → 段落スタイル basedOn チェーン（根→葉）→ 文字スタイルチェーン → 直接書式。
 * **toggle property 14 種は XOR**（スタイル階層で true 奇数個 = on・直接書式は絶対値上書き）。
 * pPr>rPr（段落マーク書式）は parse 側で markRPr に隔離済み — ここでは消費しない（ラン非継承）。
 * latentStyles / w:link / tblStylePr は省略（実害小 — 調査 v2 §2）。
 */
import { element, elements, attr } from '../viewer-common/xml.mjs';
import { parseRunProps, parseParaProps } from './parse.mjs';

// XOR 合成対象（実装対象の rPr プロパティに絞った toggle 群 — ECMA-376 §17.7.3）
const TOGGLES = ['b', 'i', 'caps', 'smallCaps', 'strike', 'dstrike', 'vanish'];

export function buildStyleResolver(stylesDoc) {
    const styles = new Map(); // styleId → {type, basedOn, rPr, pPr}
    let docDefaults = { rPr: {}, pPr: {} };
    if (stylesDoc) {
        const root = stylesDoc.documentElement;
        const dd = element(root, 'docDefaults');
        if (dd) {
            const rd = element(dd, 'rPrDefault');
            if (rd) { docDefaults.rPr = parseRunProps(element(rd, 'rPr')); }
            const pd = element(dd, 'pPrDefault');
            if (pd) { docDefaults.pPr = parseParaProps(element(pd, 'pPr')); }
        }
        for (const st of elements(root, 'style')) {
            const basedOnEl = element(st, 'basedOn');
            styles.set(attr(st, 'styleId'), {
                type: attr(st, 'type'),
                basedOn: basedOnEl ? attr(basedOnEl, 'val') : null,
                rPr: parseRunProps(element(st, 'rPr')),
                pPr: parseParaProps(element(st, 'pPr')),
            });
        }
    }

    /** basedOn チェーンを根→葉の順で返す（循環は visited set でガード） */
    function chain(styleId) {
        const out = [];
        const visited = new Set();
        let id = styleId;
        while (id && !visited.has(id)) {
            visited.add(id);
            const st = styles.get(id);
            if (!st) { break; }
            out.unshift(st);
            id = st.basedOn;
        }
        return out;
    }

    /** 非 toggle は後勝ちマージ・toggle は層ごとの XOR カウント */
    function mergeLayers(layers, direct) {
        const eff = {};
        const toggleCount = {};
        for (const layer of layers) {
            if (!layer) { continue; }
            for (const [k, v] of Object.entries(layer)) {
                if (v === undefined) { continue; }
                if (TOGGLES.includes(k)) {
                    if (v === true) { toggleCount[k] = (toggleCount[k] || 0) + 1; }
                    else if (v === false) { toggleCount[k] = 0; } // 明示 off はカウンタをリセット
                    continue;
                }
                if (k === 'fonts') { eff.fonts = { ...(eff.fonts || {}), ...v }; continue; }
                eff[k] = v;
            }
        }
        for (const t of TOGGLES) {
            if (toggleCount[t] !== undefined) { eff[t] = toggleCount[t] % 2 === 1; }
        }
        // 直接書式は絶対値で最終上書き（toggle 含む）
        if (direct) {
            for (const [k, v] of Object.entries(direct)) {
                if (v === undefined) { continue; }
                if (k === 'fonts') { eff.fonts = { ...(eff.fonts || {}), ...v }; continue; }
                eff[k] = v;
            }
        }
        if (!eff.fonts) { eff.fonts = {}; }
        return eff;
    }

    return {
        docDefaults,
        /** 実効 rPr（{paraStyleId, charStyleId, direct}） */
        effectiveRPr({ paraStyleId, charStyleId, direct }) {
            const layers = [docDefaults.rPr];
            for (const st of chain(paraStyleId)) { layers.push(st.rPr); }
            for (const st of chain(charStyleId)) { layers.push(st.rPr); }
            return mergeLayers(layers, direct || {});
        },
        /** 実効 pPr（段落スタイルチェーン + 直接） */
        effectivePPr({ paraStyleId, direct }) {
            const layers = [docDefaults.pPr];
            for (const st of chain(paraStyleId)) { layers.push(st.pPr); }
            const eff = {};
            for (const layer of layers) { Object.assign(eff, layer); }
            Object.assign(eff, direct || {});
            return eff;
        },
        /** スタイル定義の pPr（numbering の pStyle 間接参照用） */
        stylePPr(styleId) {
            const st = styles.get(styleId);
            return st ? st.pPr : null;
        },
    };
}
