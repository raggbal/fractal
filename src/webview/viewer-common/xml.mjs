/**
 * viewer-common/xml.mjs — DOMParser ベースの OOXML 走査ヘルパ（docx/xlsx が消費）
 *
 * 方式: 子要素の直接走査 + localName 比較（getElementsByTagNameNS の深い全探索と live list を避ける）。
 * 属性も localName 比較（prefix 非依存）。OOXML の bool は 1/0/true/false/on/off の全変種を受ける。
 */

export function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('XML parse error');
    }
    return doc;
}

/** 直接の子要素から localName 一致の最初の 1 個 */
export function element(parent, name) {
    if (!parent) { return null; }
    for (let e = parent.firstElementChild; e; e = e.nextElementSibling) {
        if (e.localName === name) { return e; }
    }
    return null;
}

/** 直接の子要素から localName 一致の全部 */
export function elements(parent, name) {
    const out = [];
    if (!parent) { return out; }
    for (let e = parent.firstElementChild; e; e = e.nextElementSibling) {
        if (name === undefined || e.localName === name) { out.push(e); }
    }
    return out;
}

/** 属性を localName で引く（prefix 非依存） */
export function attr(el, name) {
    if (!el || !el.attributes) { return null; }
    for (let i = 0; i < el.attributes.length; i++) {
        const a = el.attributes[i];
        if (a.localName === name) { return a.value; }
    }
    return null;
}

export function intAttr(el, name) {
    const v = attr(el, name);
    if (v === null) { return null; }
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
}

export function boolAttr(el, name, defaultValue = false) {
    const v = attr(el, name);
    if (v === null) { return defaultValue; }
    switch (v) {
        case '1': case 'true': case 'on': return true;
        case '0': case 'false': case 'off': return false;
        default: return defaultValue;
    }
}

/** 数値属性（dxa/EMU 等 — 呼び出し側が単位変換する） */
export function lengthAttr(el, name) {
    return intAttr(el, name);
}
