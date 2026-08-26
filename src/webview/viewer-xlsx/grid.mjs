/**
 * viewer-xlsx/grid.mjs — 行×列 仮想グリッド（DOM-VirtualGrid / MOD-XlsxGrid / FR-XLV-06/07）
 *
 * geometry は dimension（累積 px の Float64Array + 二分探索）・内容は rows Map の疎参照。
 * 描画は「可視域 + バッファ内に**存在するセル**（+ 可視域に交差する結合アンカー）」のみ —
 * 10 万行 × 500 列でも DOM は数百ノード（NFR-VEX-03）。固定ヘッダ 3 レイヤ（corner/列/行）は
 * viewport の scroll に translate で追随する。セル内容・装飾は opts.fillCell に委譲
 * （grid は仮想化と座標だけを持つ — スタイル/リンク/find 強調は index.mjs の責務）。
 */
import { colWidthPx, rowHeightPx } from './styles.mjs';

const HDR_H = 20;   // 列ヘッダ高
const HDR_W = 48;   // 行ヘッダ幅（'100000' が収まる）
const ROW_BUFFER = 5;
const COL_BUFFER = 3;
export const DISPLAY_SCALE = 0.9; // 行高・列幅の表示倍率（実測フィードバック 2026-08-24 — 変わりうる定数）

/** 0-based 列 index → 'A'..'XFD' */
export function colLetter(c0) {
    let n = c0 + 1;
    let s = '';
    while (n > 0) {
        const r = (n - 1) % 26;
        s = String.fromCharCode(65 + r) + s;
        n = Math.floor((n - 1) / 26);
    }
    return s;
}

function ensureStyle(doc) {
    if (doc.getElementById('fv-xlsx-style')) { return; }
    const style = doc.createElement('style');
    style.id = 'fv-xlsx-style';
    style.textContent = [
        '.xlv-root { position: absolute; inset: 0; display: grid;',
        `  grid-template-rows: ${HDR_H}px 1fr auto; grid-template-columns: ${HDR_W}px 1fr;`,
        '  background: #fff; color: #1a1a1a; font: 11px Calibri, "Yu Gothic", sans-serif; }',
        '.xlv-corner { grid-area: 1 / 1; background: #e8e8e8; border-right: 1px solid #bbb; border-bottom: 1px solid #bbb; z-index: 3; }',
        '.xlv-colhdr { grid-area: 1 / 2; overflow: hidden; position: relative; background: #f2f2f2; border-bottom: 1px solid #bbb; z-index: 2; }',
        '.xlv-rowhdr { grid-area: 2 / 1; overflow: hidden; position: relative; background: #f2f2f2; border-right: 1px solid #bbb; z-index: 2; }',
        '.xlv-colhdr-inner, .xlv-rowhdr-inner { position: absolute; top: 0; left: 0; }',
        '.xlv-colhdr-cell, .xlv-rowhdr-cell { position: absolute; box-sizing: border-box; overflow: hidden;',
        '  text-align: center; color: #444; border-right: 1px solid #d4d4d4; border-bottom: 1px solid #d4d4d4; }',
        '.xlv-viewport { grid-area: 2 / 2; overflow: auto; position: relative; }',
        '.xlv-spacer { position: relative; }',
        '.xlv-cell { position: absolute; box-sizing: border-box; overflow: hidden; white-space: pre;',
        '  padding: 0 3px; line-height: 1.6; border-right: 1px solid #e2e2e2; border-bottom: 1px solid #e2e2e2; background: #fff; }',
        '.xlv-tabs { grid-area: 3 / 1 / 3 / 3; display: flex; gap: 2px; padding: 3px 6px; background: #ececec; border-top: 1px solid #bbb; overflow-x: auto; }',
        '.xlv-tab { border: 1px solid #bbb; border-radius: 3px 3px 0 0; background: #f8f8f8; padding: 2px 10px; cursor: pointer; font-size: 12px; }',
        '.xlv-tab-active { background: #fff; font-weight: bold; }',
        '.xlv-tab-hidden { color: #999; background: #e0e0e0; }',
        '.xlv-link { color: #0563C1; text-decoration: underline; cursor: pointer; }',
        '.xlv-comment-marker { position: absolute; top: 0; right: 0; width: 0; height: 0;',
        '  border-top: 6px solid #c00; border-left: 6px solid transparent; }',
        '.xlv-funnel { float: right; font-size: 9px; color: #666; margin-left: 2px; }',
        '.xlv-find-hit { outline: 2px solid rgba(255, 180, 0, 0.9); outline-offset: -2px; }',
        '.xlv-find-current { outline: 2px solid rgba(255, 90, 0, 1); outline-offset: -2px; }',
        '.xlv-loc-hit { outline: 2px solid rgba(30, 130, 255, 1); outline-offset: -2px; }',
    ].join('\n');
    doc.head.appendChild(style);
}

/** prefix（累積 px）で px 位置 → index（最後の prefix[i] <= px）の二分探索 */
function indexAt(prefix, px) {
    let lo = 0, hi = prefix.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (prefix[mid] <= px) { lo = mid; } else { hi = mid - 1; }
    }
    return Math.min(lo, prefix.length - 2);
}

/**
 * createGrid(host, opts) → { root, viewport, tabsHost, scrollToCell, refresh, destroy }
 * opts: { model: SheetModel, mdw, fillCell(el, row0, col0, cell) }
 */
export function createGrid(host, opts) {
    // FR-VZP-01/02 (ADRL-0100): ユーザーズーム倍率（geometry 再構築方式 — DISPLAY_SCALE の一般化）。
    // 行高・列幅・フォントに倍率を織り込んで構築する（CSS zoom / 上位 transform は使わない — 却下理由は ADRL-0100）
    const zoom = (opts && opts.zoom) || 1;
    const doc = host.ownerDocument;
    ensureStyle(doc);
    const model = opts.model;
    const nrows = Math.max(1, model.dimension.rows);
    const ncols = Math.max(1, model.dimension.cols);

    // ── geometry（累積 px） ──
    // DISPLAY_SCALE: 実測フィードバック（2026-08-24）「全体が拡大ぎみ」→ 行高・列幅を一律 0.9 倍で
    // 少し引いた表示にする（ECMA 換算式そのもの = styles.mjs は不変。倍率はここ 1 箇所）
    const defRowPx = Math.round(rowHeightPx(model.defaultRowHeight != null ? model.defaultRowHeight : 15) * DISPLAY_SCALE * zoom);
    const defColPx = Math.round(colWidthPx(model.defaultColWidth != null ? model.defaultColWidth : 8.43, opts.mdw) * DISPLAY_SCALE * zoom);
    const rowPrefix = new Float64Array(nrows + 1);
    for (let r = 0; r < nrows; r++) {
        const row = model.rows.get(r);
        let h = defRowPx;
        if (row) {
            if (row.hidden) { h = 0; }
            else if (row.ht != null) { h = Math.round(rowHeightPx(row.ht) * DISPLAY_SCALE * zoom); }
        }
        rowPrefix[r + 1] = rowPrefix[r] + h;
    }
    const colPrefix = new Float64Array(ncols + 1);
    for (let c = 0; c < ncols; c++) {
        let w = defColPx;
        for (const range of model.cols) {
            if (c + 1 >= range.min && c + 1 <= range.max) {
                w = range.hidden ? 0 : Math.round(colWidthPx(range.width != null ? range.width : (model.defaultColWidth != null ? model.defaultColWidth : 8.43), opts.mdw) * DISPLAY_SCALE * zoom);
                break;
            }
        }
        colPrefix[c + 1] = colPrefix[c] + w;
    }
    const totalH = rowPrefix[nrows];
    const totalW = colPrefix[ncols];

    // ── 結合（被覆セル非描画 + アンカー拡大 — FR-XLV-06） ──
    const covered = new Set();
    const anchors = new Map(); // 'r:c' → merge
    for (const m of model.merges) {
        anchors.set(m.r1 + ':' + m.c1, m);
        for (let r = m.r1; r <= m.r2; r++) {
            for (let c = m.c1; c <= m.c2; c++) {
                if (r !== m.r1 || c !== m.c1) { covered.add(r + ':' + c); }
            }
        }
    }

    // ── DOM 骨格 ──
    const root = doc.createElement('div');
    root.className = 'xlv-root';
    if (zoom !== 1) { root.style.fontSize = (11 * zoom).toFixed(1) + 'px'; }   // 基本フォント 11px × zoom
    const corner = doc.createElement('div');
    corner.className = 'xlv-corner';
    const colHdr = doc.createElement('div');
    colHdr.className = 'xlv-colhdr';
    const colInner = doc.createElement('div');
    colInner.className = 'xlv-colhdr-inner';
    colInner.style.width = totalW + 'px';
    colInner.style.height = HDR_H + 'px';
    colHdr.appendChild(colInner);
    const rowHdr = doc.createElement('div');
    rowHdr.className = 'xlv-rowhdr';
    const rowInner = doc.createElement('div');
    rowInner.className = 'xlv-rowhdr-inner';
    rowInner.style.width = HDR_W + 'px';
    rowInner.style.height = totalH + 'px';
    rowHdr.appendChild(rowInner);
    const viewport = doc.createElement('div');
    viewport.className = 'xlv-viewport';
    const spacer = doc.createElement('div');
    spacer.className = 'xlv-spacer';
    spacer.style.width = totalW + 'px';
    spacer.style.height = totalH + 'px';
    viewport.appendChild(spacer);
    const tabsHost = doc.createElement('div');
    tabsHost.className = 'xlv-tabs';
    root.appendChild(corner);
    root.appendChild(colHdr);
    root.appendChild(rowHdr);
    root.appendChild(viewport);
    root.appendChild(tabsHost);
    host.appendChild(root);

    /**
     * (r,c) 位置に「style を持って描画されるセル」があれば返す（罫線 collapse の隣接照会用）。
     * 被覆セルは所属 merge のアンカー cell を返し、その辺が merge の外周かも添える
     * （merge 内部の辺は描画されない = 隣としてカウントしない）。
     */
    function styleCellAt(r, c) {
        if (r < 0 || c < 0 || r >= nrows || c >= ncols) { return null; }
        if (covered.has(r + ':' + c)) {
            for (const m of model.merges) {
                if (r >= m.r1 && r <= m.r2 && c >= m.c1 && c <= m.c2) {
                    const anchorRow = model.rows.get(m.r1);
                    const anchorCell = anchorRow ? anchorRow.cells.get(m.c1) : null;
                    return anchorCell ? { cell: anchorCell, row0: m.r1, edgeRight: m.c2 === c, edgeBottom: m.r2 === r } : null;
                }
            }
            return null;
        }
        const row = model.rows.get(r);
        const cell = row ? row.cells.get(c) : null;
        return cell ? { cell, row0: r, edgeRight: true, edgeBottom: true } : null;
    }

    function renderCellEl(r, c, m) {
        const cell = (model.rows.get(r) || { cells: new Map() }).cells.get(c);
        const el = doc.createElement('div');
        el.className = 'xlv-cell';
        el.dataset.ref = colLetter(c) + (r + 1);
        el.style.left = colPrefix[c] + 'px';
        el.style.top = rowPrefix[r] + 'px';
        const r2 = m ? m.r2 : r;
        const c2 = m ? m.c2 : c;
        el.style.width = (colPrefix[Math.min(c2 + 1, ncols)] - colPrefix[c]) + 'px';
        el.style.height = (rowPrefix[Math.min(r2 + 1, nrows)] - rowPrefix[r]) + 'px';
        if (m) { el.style.zIndex = '1'; }
        opts.fillCell(el, r, c, cell || null, { styleCellAt });
        spacer.appendChild(el);
    }

    function render() {
        const sT = viewport.scrollTop;
        const sL = viewport.scrollLeft;
        const vh = viewport.clientHeight || 400;
        const vw = viewport.clientWidth || 600;
        const r0 = Math.max(0, indexAt(rowPrefix, sT) - ROW_BUFFER);
        const r1 = Math.min(nrows - 1, indexAt(rowPrefix, sT + vh) + ROW_BUFFER);
        const c0 = Math.max(0, indexAt(colPrefix, sL) - COL_BUFFER);
        const c1 = Math.min(ncols - 1, indexAt(colPrefix, sL + vw) + COL_BUFFER);
        // セル層（全面差し替え — 対象は疎な存在セルのみで軽い）
        spacer.textContent = '';
        for (let r = r0; r <= r1; r++) {
            const row = model.rows.get(r);
            if (!row) { continue; }
            for (const c of row.cells.keys()) {
                if (c < c0 || c > c1) { continue; }
                const key = r + ':' + c;
                if (covered.has(key)) { continue; }
                renderCellEl(r, c, anchors.get(key) || null);
            }
        }
        // 可視域に交差する結合アンカー（アンカー自身が範囲外でも領域が見えるもの）
        for (const m of model.merges) {
            if (m.r2 < r0 || m.r1 > r1 || m.c2 < c0 || m.c1 > c1) { continue; }
            if (m.r1 >= r0 && m.r1 <= r1 && m.c1 >= c0 && m.c1 <= c1) { continue; } // 上で描画済み
            renderCellEl(m.r1, m.c1, m);
        }
        // ヘッダ（可視範囲のみ + translate 同期）
        colInner.textContent = '';
        for (let c = c0; c <= c1; c++) {
            const w = colPrefix[c + 1] - colPrefix[c];
            if (w === 0) { continue; }
            const h = doc.createElement('div');
            h.className = 'xlv-colhdr-cell';
            h.textContent = colLetter(c);
            h.style.left = colPrefix[c] + 'px';
            h.style.width = w + 'px';
            h.style.height = HDR_H + 'px';
            colInner.appendChild(h);
        }
        colInner.style.transform = 'translateX(' + (-sL) + 'px)';
        rowInner.textContent = '';
        for (let r = r0; r <= r1; r++) {
            const hgt = rowPrefix[r + 1] - rowPrefix[r];
            if (hgt === 0) { continue; }
            const h = doc.createElement('div');
            h.className = 'xlv-rowhdr-cell';
            h.textContent = String(r + 1);
            h.style.top = rowPrefix[r] + 'px';
            h.style.width = HDR_W + 'px';
            h.style.height = hgt + 'px';
            rowInner.appendChild(h);
        }
        rowInner.style.transform = 'translateY(' + (-sT) + 'px)';
    }

    const onScroll = () => render();
    viewport.addEventListener('scroll', onScroll);
    render();

    return {
        root,
        viewport,
        tabsHost,
        refresh: render,
        /** 対象セルを viewport 中央付近へ（locHint / find 着地） */
        scrollToCell(r, c) {
            const vh = viewport.clientHeight || 400;
            const vw = viewport.clientWidth || 600;
            viewport.scrollTop = Math.max(0, rowPrefix[Math.min(r, nrows - 1)] - vh / 3);
            viewport.scrollLeft = Math.max(0, colPrefix[Math.min(c, ncols - 1)] - vw / 3);
            render();
        },
        destroy() {
            viewport.removeEventListener('scroll', onScroll);
            if (root.parentNode) { root.parentNode.removeChild(root); }
        },
    };
}
