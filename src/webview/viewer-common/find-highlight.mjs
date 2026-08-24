/**
 * viewer-common/find-highlight.mjs — viewer find bar 用の共通ハイライト（text/docx/pptx が共用）
 *
 * HTML viewer の injectFindHelper と同アルゴリズム（span ラップ・上限 1,000・非描画除外）の
 * 同一 document 直接操作版。クラス名は fv-find-hit / fv-find-current。
 * clearFind は unwrap + normalize で DOM を原状復帰する（serialize 影響ゼロが番人対象 = TC-VEX-19）。
 */

export const FIND_MATCH_LIMIT = 1000;
const HIT_CLASS = 'fv-find-hit';
const CURRENT_CLASS = 'fv-find-current';

function isRendered(el, win) {
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
        const inline = e.style && e.style.display === 'none';
        if (inline) { return false; }
        if (win && typeof win.getComputedStyle === 'function') {
            try {
                if (win.getComputedStyle(e).display === 'none') { return false; }
            } catch { /* detached 等は無視 */ }
        }
    }
    return true;
}

/** rootEl 配下の可視テキストからマッチを span ラップし {count, jumpTo(i)} を返す */
export function execFind(rootEl, query) {
    clearFind(rootEl);
    const doc = rootEl.ownerDocument;
    const win = doc.defaultView;
    if (!query) { return { count: 0, jumpTo: () => { } }; }
    const needle = String(query).toLowerCase();
    // ラップで DOM を書き換えるため、対象テキストノードを先に収集してから処理する
    const walker = doc.createTreeWalker(rootEl, 4 /* NodeFilter.SHOW_TEXT */);
    const textNodes = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.nodeValue || n.nodeValue.toLowerCase().indexOf(needle) === -1) { continue; }
        if (!isRendered(n.parentElement, win)) { continue; }
        textNodes.push(n);
    }
    const hits = [];
    outer: for (const node of textNodes) {
        let rest = node;
        for (; ;) {
            const idx = rest.nodeValue.toLowerCase().indexOf(needle);
            if (idx === -1) { break; }
            const matchNode = rest.splitText(idx);
            const after = matchNode.splitText(needle.length);
            const span = doc.createElement('span');
            span.className = HIT_CLASS;
            matchNode.parentNode.insertBefore(span, matchNode);
            span.appendChild(matchNode);
            hits.push(span);
            if (hits.length >= FIND_MATCH_LIMIT) { break outer; }
            rest = after;
        }
    }
    const jumpTo = (i) => {
        const prev = rootEl.querySelector(`.${CURRENT_CLASS}`);
        if (prev) { prev.classList.remove(CURRENT_CLASS); }
        const span = hits[i];
        if (!span) { return; }
        span.classList.add(CURRENT_CLASS);
        if (typeof span.scrollIntoView === 'function') {
            span.scrollIntoView({ block: 'center' });
        }
    };
    return { count: hits.length, jumpTo };
}

/** span を unwrap して原状復帰（normalize でテキストノードを再結合） */
export function clearFind(rootEl) {
    const spans = rootEl.querySelectorAll(`span.${HIT_CLASS}`);
    for (const span of spans) {
        const parent = span.parentNode;
        while (span.firstChild) { parent.insertBefore(span.firstChild, span); }
        parent.removeChild(span);
    }
    rootEl.normalize();
}
