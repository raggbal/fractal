/*
 * fractal original（sprint 20260823-165314 / ADR-0010 — 依存置換）。
 * upstream pptxtojson の readXmlFile.js（txml ベース）と**出力互換**の DOMParser 版:
 * タグ名キー（prefix 付き tagName 保持）+ attrs.order 連番 + テキスト value / 単一文字列子は string。
 * simplifyLostLess 本体は upstream の verbatim 移植（入力を txml 木 → DOM 由来の同形木に差し替え）。
 * 注意: DOMParser は実体参照をデコード済みで返す（txml は非デコード）— これが構造化 runs 化
 * （HTML 文字列出力の全廃）とセットで必須の理由（デコード済みテキストを HTML に埋めると XSS）。
 */

let cust_attr_order = 0;

function isWhitespaceTextNode(node) {
    return typeof node === 'string' && node.trim() === '';
}

// upstream readXmlFile.js の simplifyLostLess を verbatim 移植（MIT — vendor/LICENSE-pptxtojson）
export function simplifyLostLess(children, parentAttributes = {}) {
    const out = {};
    if (!children.length) return out;

    if (children.length === 1 && typeof children[0] === 'string') {
        return Object.keys(parentAttributes).length ? {
            attrs: { order: cust_attr_order++, ...parentAttributes },
            value: children[0],
        } : children[0];
    }
    for (const child of children) {
        if (isWhitespaceTextNode(child)) continue;
        if (typeof child !== 'object') return;
        if (child.tagName === '?xml') continue;

        if (!out[child.tagName]) out[child.tagName] = [];

        const kids = simplifyLostLess(child.children || [], child.attributes);

        if (typeof kids === 'object') {
            if (!kids.attrs) kids.attrs = { order: cust_attr_order++ };
            else kids.attrs.order = cust_attr_order++;
        }
        if (Object.keys(child.attributes || {}).length) {
            kids.attrs = { ...kids.attrs, ...child.attributes };
        }
        out[child.tagName].push(kids);
    }
    for (const child in out) {
        if (out[child].length === 1) out[child] = out[child][0];
    }

    return out;
}

/** DOM Element → txml 互換木 {tagName(prefix 付き), attributes, children[]} */
function domToTxml(el) {
    const attributes = {};
    for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        attributes[a.name] = a.value; // prefix 付き属性名（r:id 等）を保持 — upstream と同形
    }
    const children = [];
    for (let n = el.firstChild; n; n = n.nextSibling) {
        if (n.nodeType === 3 || n.nodeType === 4) { children.push(n.nodeValue); }         // text / CDATA
        else if (n.nodeType === 1) { children.push(domToTxml(n)); }                        // element
        // comment / PI はスキップ（txml parse 既定と同等の消費側影響なし）
    }
    return { tagName: el.tagName, attributes, children };
}

/** XML 文字列 → simplified JSON（テスト用の同期入口） */
export function parseXmlString(data) {
    const doc = new DOMParser().parseFromString(data, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) { throw new Error('XML parse error'); }
    return simplifyLostLess([domToTxml(doc.documentElement)]);
}

export async function readXmlFile(zip, filename) {
    try {
        const data = await zip.file(filename).async('string');
        return parseXmlString(data);
    }
    catch {
        return null;
    }
}
