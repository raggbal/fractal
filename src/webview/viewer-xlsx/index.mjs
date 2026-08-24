/**
 * viewer-xlsx/index.mjs — xlsx viewer の mount(ctx) 契約実装（MOD-XlsxGrid 統合 / FR-XLV-01..09）
 *
 * fetch → zip（三重ガード）→ workbook モデル → シート単位の遅延パース（LRU 3）→ 仮想グリッド。
 * 表示文字列は numfmt.mjs（表示 = find の対象でもある — FR-FV-21 の xlsx 契約は
 * 「numfmt 適用後の表示文字列基準・現シートのみ」）。locHint {sheet, cell} は one-shot。
 * 数式は v キャッシュ表示 + '=f' tooltip（キャッシュ欠落は空欄 — "0" と偽装しない）。
 */
import { openZip } from '../viewer-common/zip.mjs';
import { parseXml, element, elements, attr } from '../viewer-common/xml.mjs';
import { parseWorkbook } from './workbook.mjs';
import { parseSheet, cellRef } from './sheet-parse.mjs';
import { parseStyles, resolveCellStyle, effectiveStyleIdx, measureMdw } from './styles.mjs';
import { formatCell } from './numfmt.mjs';
import { createGrid, colLetter } from './grid.mjs';

const LRU_MAX = 3;

function parseRange(ref) {
    if (!ref) { return null; }
    const [a, b] = String(ref).split(':');
    const p1 = cellRef(a);
    const p2 = b ? cellRef(b) : p1;
    return (p1 && p2) ? { r1: p1.row0, c1: p1.col0, r2: p2.row0, c2: p2.col0 } : null;
}

/** 'worksheets/sheet1.xml' → 'xl/worksheets/_rels/sheet1.xml.rels'（part 相対の rels 規約） */
function relsPathOf(target) {
    const p = target.startsWith('/') ? target.slice(1) : 'xl/' + target;
    const i = p.lastIndexOf('/');
    return p.slice(0, i) + '/_rels/' + p.slice(i + 1) + '.rels';
}

/** rels の相対 Target を part の basedir から解決（'../comments1.xml' → 'xl/comments1.xml'） */
function resolveRel(baseDir, target) {
    if (target.startsWith('/')) { return target.slice(1); }
    const parts = baseDir.split('/');
    for (const seg of target.split('/')) {
        if (seg === '..') { parts.pop(); }
        else if (seg !== '.') { parts.push(seg); }
    }
    return parts.join('/');
}

export default {
    async mount(ctx) {
        const { body, state, label } = ctx;
        const doc = body.ownerDocument;
        const win = doc.defaultView || window;

        const resp = await win.fetch(ctx.fileUri);
        if (!resp.ok) { throw new Error(`fetch failed: ${resp.status}`); }
        const buf = new Uint8Array(await resp.arrayBuffer());
        let zip;
        try {
            zip = await openZip(buf);
        } catch (e) {
            if (e && e.code === 'NOT_ZIP') { throw new Error(label('viewerProtectedFile', 'Password-protected files cannot be displayed')); }
            throw e;
        }
        const dec = new TextDecoder('utf-8');
        const readText = async (name) => {
            if (!zip.entries().has(name)) { return null; }
            try {
                return dec.decode(await zip.readEntry(name));
            } catch (e) {
                if (e && (e.code === 'ENTRY_TOO_LARGE' || e.code === 'ZIP_BUDGET_EXCEEDED')) {
                    throw new Error(label('viewerTooLargeToRender', 'This file is too large to display'));
                }
                throw e;
            }
        };
        const workbookXml = await readText('xl/workbook.xml');
        if (!workbookXml) { throw new Error(label('viewerProtectedFile', 'Password-protected files cannot be displayed')); }
        const model = parseWorkbook({
            workbookXml,
            relsXml: await readText('xl/_rels/workbook.xml.rels'),
            sharedStringsXml: await readText('xl/sharedStrings.xml'),
            themeXml: await readText('xl/theme/theme1.xml'),
            stylesXml: await readText('xl/styles.xml'),
        });
        const styles = model.stylesXml ? parseStyles(model.stylesXml) : null;
        const styleCache = new Map(); // styleIdx → resolveCellStyle 結果
        const styleOf = (idx) => {
            if (idx == null || !styles) { return null; }
            if (!styleCache.has(idx)) { styleCache.set(idx, resolveCellStyle(idx, styles, model.themeColors)); }
            return styleCache.get(idx);
        };
        // MDW 実測（canvas seam — 失敗時 7px fallback は styles.mjs 側）
        const canvas = doc.createElement('canvas');
        const c2d = canvas.getContext ? canvas.getContext('2d') : null;
        if (c2d) { c2d.font = '11pt Calibri'; }
        const mdw = measureMdw((t) => (c2d ? c2d.measureText(t).width : 0));

        const displayable = model.sheets.filter((s) => s.state !== 'veryHidden');
        if (displayable.length === 0) { throw new Error('no visible sheets'); }

        // ── シートキャッシュ（LRU 3 — FR-XLV-02） ──
        const sheetCache = new Map(); // name → { sheet, hyperlinks: Map, comments: Map, autoFilter, disp: Map }
        async function loadSheet(name) {
            if (sheetCache.has(name)) {
                const v = sheetCache.get(name);
                sheetCache.delete(name);
                sheetCache.set(name, v); // touch（LRU 更新）
                return v;
            }
            const meta = model.sheets.find((s) => s.name === name);
            const xml = meta && meta.target ? await readText(meta.target.startsWith('/') ? meta.target.slice(1) : 'xl/' + meta.target) : null;
            if (!xml) { throw new Error(`sheet not found: ${name}`); }
            const sheet = parseSheet(xml);
            // sheet rels（hyperlink 外部 URL・comments part の解決）
            const relsXml = await readText(relsPathOf(meta.target));
            const rels = new Map();
            let commentsPath = null;
            if (relsXml) {
                const rd = parseXml(relsXml);
                for (const rel of elements(rd.documentElement)) {
                    if (rel.localName !== 'Relationship') { continue; }
                    rels.set(attr(rel, 'Id'), attr(rel, 'Target'));
                    if (/\/comments$/.test(attr(rel, 'Type') || '')) { commentsPath = attr(rel, 'Target'); }
                }
            }
            const baseDir = relsPathOf(meta.target).split('/_rels/')[0];
            const hyperlinks = new Map(); // 'r:c' → url
            for (const hl of sheet.hyperlinks) {
                const url = hl.relId ? rels.get(hl.relId) : (hl.location ? '#' + hl.location : null);
                if (url) { hyperlinks.set(hl.row0 + ':' + hl.col0, url); }
            }
            const comments = new Map(); // 'r:c' → text
            if (commentsPath) {
                const cXml = await readText(resolveRel(baseDir, commentsPath));
                if (cXml) {
                    const cd = parseXml(cXml);
                    const list = element(cd.documentElement, 'commentList');
                    for (const cm of (list ? elements(list, 'comment') : [])) {
                        const pos = cellRef(attr(cm, 'ref') || '');
                        const textEl = element(cm, 'text');
                        if (pos && textEl) { comments.set(pos.row0 + ':' + pos.col0, textEl.textContent || ''); }
                    }
                }
            }
            // コメント/リンクが空セル位置に付くケース — 装飾を描くため空セルを実体化する
            for (const key of [...hyperlinks.keys(), ...comments.keys()]) {
                const [r, c] = key.split(':').map(Number);
                let row = sheet.rows.get(r);
                if (!row) { row = { cells: new Map(), ht: null, hidden: false, styleIdx: null }; sheet.rows.set(r, row); }
                if (!row.cells.has(c)) { row.cells.set(c, { v: null, t: 'n', s: null, f: null }); }
            }
            const entry = { sheet, hyperlinks, comments, autoFilter: parseRange(sheet.autoFilterRef), disp: new Map() };
            sheetCache.set(name, entry);
            if (sheetCache.size > LRU_MAX) { sheetCache.delete(sheetCache.keys().next().value); }
            return entry;
        }

        // ── 表示文字列（numfmt — 表示 = find 対象） ──
        function displayText(entry, r, c, cell) {
            const key = r + ':' + c;
            if (entry.disp.has(key)) { return entry.disp.get(key); }
            let out = { text: '', alignHint: 'left', color: null };
            if (cell) {
                const row = entry.sheet.rows.get(r);
                let colStyle = null;
                for (const range of entry.sheet.cols) {
                    if (c + 1 >= range.min && c + 1 <= range.max) { colStyle = range.styleIdx; break; }
                }
                const styleIdx = effectiveStyleIdx(cell.s, row ? row.styleIdx : null, colStyle);
                const st = styleOf(styleIdx);
                const numFmt = st ? st.numFmt : 0;
                const opts = { date1904: model.date1904, locale: 'ja' };
                if (cell.t === 's') {
                    const s = model.sharedStrings[parseInt(cell.v, 10)];
                    out = formatCell(s == null ? '' : s, 'str', numFmt, opts);
                } else if (cell.t === 'inlineStr' || cell.t === 'str' || cell.t === 'd') {
                    out = formatCell(cell.v == null ? '' : cell.v, 'str', numFmt, opts);
                } else if (cell.t === 'b') {
                    out = formatCell(cell.v === '1' || cell.v === 'true', 'b', numFmt, opts);
                } else if (cell.t === 'e') {
                    out = formatCell(cell.v == null ? '' : cell.v, 'e', numFmt, opts);
                } else if (cell.v != null) {
                    out = formatCell(Number(cell.v), 'n', numFmt, opts);
                }
                // 数式でキャッシュ欠落（v なし）→ 空欄のまま（TC-XLV-12 counterfactual: "0" にしない）
                out.styleIdx = styleIdx;
            }
            entry.disp.set(key, out);
            return out;
        }

        // ── grid + タブ ──
        let grid = null;
        let currentEntry = null;
        let currentName = null;
        const findState = { hits: [], current: -1, currentKey: null, set: new Set() };
        let locKey = null;

        /** (r,c) のセルの実効スタイル（罫線 collapse の隣接照会で displayText と共用） */
        function resolvedStyleAt(r, c, cell) {
            if (!cell) { return null; }
            const row = currentEntry.sheet.rows.get(r);
            let colStyle = null;
            for (const range of currentEntry.sheet.cols) {
                if (c + 1 >= range.min && c + 1 <= range.max) { colStyle = range.styleIdx; break; }
            }
            return styleOf(effectiveStyleIdx(cell.s, row ? row.styleIdx : null, colStyle));
        }

        function fillCell(el, r, c, cell, gridInfo) {
            const d = displayText(currentEntry, r, c, cell);
            el.textContent = d.text;
            const st = styleOf(d.styleIdx);
            const explicitAlign = st && st.alignment && st.alignment.horizontal;
            el.style.textAlign = explicitAlign || d.alignHint || 'left';
            if (st) {
                if (st.font.bold) { el.style.fontWeight = 'bold'; }
                if (st.font.italic) { el.style.fontStyle = 'italic'; }
                const deco = [];
                if (st.font.underline) { deco.push('underline'); }
                if (st.font.strike) { deco.push('line-through'); }
                if (deco.length) { el.style.textDecoration = deco.join(' '); }
                // フォントは pt 値を px で描く（= 0.75 倍）— DISPLAY_SCALE の縮小表示と歩調を合わせる
                // （基本フォント 11px = 11pt 相当。実測フィードバック 2026-08-24「フォントも大きく見える」）
                if (st.font.sizePt && st.font.sizePt !== 11) { el.style.fontSize = Math.round(st.font.sizePt) + 'px'; }
                if (st.font.name) { el.style.fontFamily = `"${st.font.name}", Calibri, sans-serif`; }
                if (st.font.color) { el.style.color = st.font.color; }
                if (st.fill) { el.style.backgroundColor = st.fill; }
                // 罫線 collapse（実測フィードバック 2026-08-24「罫線が太い」）: 隣接セルが同じ共有辺に
                // right/bottom を描くなら自分の left/top はスキップ（両者が 1px ずつ描くと 2px に見える —
                // Excel は共有辺 1 本）。隣は grid の styleCellAt（merge 外周判定込み）で照会する
                const nbLeft = gridInfo && gridInfo.styleCellAt ? gridInfo.styleCellAt(r, c - 1) : null;
                const nbTop = gridInfo && gridInfo.styleCellAt ? gridInfo.styleCellAt(r - 1, c) : null;
                const leftDrawnByNb = !!(nbLeft && nbLeft.edgeRight && (() => {
                    const ns = resolvedStyleAt(nbLeft.row0 != null ? nbLeft.row0 : r, c - 1, nbLeft.cell);
                    return ns && ns.border.right;
                })());
                const topDrawnByNb = !!(nbTop && nbTop.edgeBottom && (() => {
                    const ns = resolvedStyleAt(nbTop.row0 != null ? nbTop.row0 : r - 1, c, nbTop.cell);
                    return ns && ns.border.bottom;
                })());
                for (const side of ['left', 'right', 'top', 'bottom']) {
                    const b = st.border[side];
                    if (!b) { continue; }
                    if (side === 'left' && leftDrawnByNb) { continue; }
                    if (side === 'top' && topDrawnByNb) { continue; }
                    const width = b.style === 'thick' ? '3px' : (b.style === 'medium' ? '2px' : '1px');
                    const lineStyle = (b.style === 'dashed' || b.style === 'dotted') ? b.style : 'solid';
                    el.style['border' + side[0].toUpperCase() + side.slice(1)] = `${width} ${lineStyle} ${b.color}`;
                }
                if (st.alignment && st.alignment.wrapText) { el.style.whiteSpace = 'normal'; }
            }
            if (d.color) { el.style.color = d.color; } // numfmt [Red] 等はセル色より優先
            const key = r + ':' + c;
            const titles = [];
            if (cell && cell.f) { titles.push('=' + cell.f); }
            const cm = currentEntry.comments.get(key);
            if (cm) {
                titles.push(cm);
                const marker = doc.createElement('span');
                marker.className = 'xlv-comment-marker';
                el.appendChild(marker);
            }
            if (titles.length) { el.title = titles.join('\n'); }
            const url = currentEntry.hyperlinks.get(key);
            if (url) {
                el.classList.add('xlv-link');
                el.addEventListener('click', () => {
                    if (!url.startsWith('#')) { ctx.postMessage({ type: 'openExternalFallback', fileUri: url, filePath: null }); }
                });
            }
            const af = currentEntry.autoFilter;
            if (af && r === af.r1 && c >= af.c1 && c <= af.c2) {
                const funnel = doc.createElement('span');
                funnel.className = 'xlv-funnel';
                funnel.textContent = '▼';
                el.appendChild(funnel);
            }
            if (findState.set.has(key)) { el.classList.add('xlv-find-hit'); }
            if (key === findState.currentKey) { el.classList.add('xlv-find-current'); }
            if (key === locKey) { el.classList.add('xlv-loc-hit'); }
        }

        function buildTabs() {
            const host = grid.tabsHost;
            host.textContent = '';
            for (const s of displayable) {
                const b = doc.createElement('button');
                b.className = 'xlv-tab' + (s.name === currentName ? ' xlv-tab-active' : '') + (s.state === 'hidden' ? ' xlv-tab-hidden' : '');
                b.textContent = s.name;
                if (s.state === 'hidden') { b.title = label('viewerSheetHidden', 'Hidden sheet (shown on demand)'); }
                b.addEventListener('click', () => { if (s.name !== currentName) { switchSheet(s.name).catch(() => { /* 表示不能シートは無視 */ }); } });
                host.appendChild(b);
            }
        }

        async function switchSheet(name) {
            const entry = await loadSheet(name);
            if (grid) { grid.destroy(); }
            currentEntry = entry;
            currentName = name;
            findState.hits = []; findState.current = -1; findState.currentKey = null; findState.set.clear();
            grid = createGrid(body, { model: entry.sheet, mdw, fillCell });
            buildTabs();
        }

        // ── find（FR-FV-21 xlsx 契約: numfmt 適用後の表示文字列・現シートのみ） ──
        function jumpToHit(n) {
            const h = findState.hits[n];
            if (!h) { return; }
            findState.currentKey = h.r + ':' + h.c;
            grid.scrollToCell(h.r, h.c);
        }
        state.findExec = (q) => {
            findState.hits = []; findState.current = -1; findState.currentKey = null; findState.set.clear();
            const needle = String(q || '').toLowerCase();
            if (needle) {
                const rowIdxs = Array.from(currentEntry.sheet.rows.keys()).sort((a, b) => a - b);
                for (const r of rowIdxs) {
                    const row = currentEntry.sheet.rows.get(r);
                    const colIdxs = Array.from(row.cells.keys()).sort((a, b) => a - b);
                    for (const c of colIdxs) {
                        const d = displayText(currentEntry, r, c, row.cells.get(c));
                        if (d.text && d.text.toLowerCase().indexOf(needle) !== -1) {
                            findState.hits.push({ r, c });
                            findState.set.add(r + ':' + c);
                        }
                    }
                }
            }
            if (findState.hits.length > 0) { findState.current = 0; jumpToHit(0); } else { grid.refresh(); }
            if (state.findUi) { state.findUi.onCount(findState.hits.length ? 1 : 0, findState.hits.length); }
        };
        state.findStep = (dir) => {
            if (!findState.hits.length) { return; }
            findState.current = (findState.current + dir + findState.hits.length) % findState.hits.length;
            jumpToHit(findState.current);
            if (state.findUi) { state.findUi.onCount(findState.current + 1, findState.hits.length); }
        };
        state.findClear = () => {
            findState.hits = []; findState.current = -1; findState.currentKey = null; findState.set.clear();
            if (grid) { grid.refresh(); }
        };

        // ── 初期シート + locHint one-shot（FR-FV-22 / TC-XLV-13） ──
        let initial = displayable[0].name;
        const at = model.sheets[model.activeTab];
        if (at && at.state !== 'veryHidden') { initial = at.name; }
        const loc = ctx.locHint;
        ctx.locHint = null; // one-shot — 消費後の再ジャンプはしない
        if (loc && loc.sheet && model.sheets.some((s) => s.name === loc.sheet && s.state !== 'veryHidden')) {
            initial = loc.sheet;
        }
        await switchSheet(initial);
        if (loc && loc.cell && initial === loc.sheet) {
            const pos = cellRef(loc.cell);
            if (pos) {
                locKey = pos.row0 + ':' + pos.col0;
                grid.scrollToCell(pos.row0, pos.col0);
            }
        }
        if (ctx.findQuery && state.findUi) {
            const fq = ctx.findQuery;
            ctx.findQuery = null; // one-shot
            state.findUi.openWith(fq);
        }

        return {
            destroy() { if (grid) { grid.destroy(); } },
        };
    },
};

export { colLetter };
