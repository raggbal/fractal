/**
 * pinch-zoom — (ctrl||meta)+wheel をカーソル不動点ズーム係数へ変換する共通ゲート
 * （FR-VZP-01 / ADRL-0100・sprint 20260825-224210-viewer-zoom-pan）。
 *
 * トラックパッドのピンチは Chromium で ctrlKey:true の wheel として届く。
 * {passive:false} + preventDefault により viewer 領域上では VS Code(Electron) 全体ズームを
 * 発火させない。係数は mindmap-interactions.js :1668 と同一（exp(-deltaY*0.003)・Kiro 実機
 * チューニング済み）。素の wheel は無視して return（スクロール温存）。
 *
 * 消費側: kind モジュール（pptx/docx/text/xlsx）。pdf（file-viewer.js — 非 ESM）と
 * html（iframe 注入ヘルパ — 文字列）は同係数を直書きで複製する（TASK-01 裁定 (b)。
 * 係数を変えるときは 3 箇所を同時に変えること）。
 */
export function attachPinchZoom(el, onZoom) {
    const handler = (e) => {
        if (!(e.ctrlKey || e.metaKey)) { return; }
        e.preventDefault();
        e.stopPropagation();
        onZoom(Math.exp(-e.deltaY * 0.003), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', handler, { passive: false });
    return () => el.removeEventListener('wheel', handler);
}
