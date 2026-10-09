// frame-doc.mjs — drawio の隔離 iframe に読ませる HTML 文書を組み立てる
//
// sprint 20261009-130815-file-viewer-drawio / ADRL-0135 / design/system/drawio-viewer.md §5。
// - 先頭の meta CSP は、継承した面の CSP に**重ねて**効く（複数ポリシーは全部満たす必要がある = 絞る方向にだけ効く）。
//   notes / outliner 面の img-src https: / font-src https: も iframe 内では無効になる（外部通信 0 = FR-DIO-09）
// - script はすべて nonce 付き inline（S2）。ライブラリ本文は親が fetch したテキストを埋め込む
// - 前置 script は draw.io 本体より前に、外部（viewer.diagrams.net 等）を指す既定 URL を潰す（howto §3 と同一）

const FRAME_CSP = [
    "default-src 'none'",
    "script-src 'nonce-__NONCE__'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    'font-src data:',
    "connect-src 'none'",
    "frame-src 'none'",
    "worker-src 'none'",
    "media-src 'none'",
    "object-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
].join('; ');

// draw.io は `window.X = window.X || "https://viewer.diagrams.net/…"` の形で既定値を置くので、先に入れれば上書きできる
const PRELUDE = [
    'window.urlParams = {};',
    '["PROXY_URL", "STYLE_PATH", "SHAPES_PATH", "DRAW_MATH_URL", "GRAPH_IMAGE_PATH", "mxImageBasePath",',
    ' "mxBasePath", "DRAWIO_BASE_URL", "DRAWIO_LIGHTBOX_URL", "DRAWIO_SERVER_URL"]',
    '  .forEach(function (k) { window[k] = "/drawio/offline"; });',
    // stencils.min.js の辞書キーを切り出すための接頭辞（実在パスでなくてよい — research-external.md）
    'window.STENCIL_PATH = "stencils";',
    'window.mxLoadResources = false;',
    'window.mxLoadStylesheets = false;',
    'window.isLocalStorage = false;',
].join('\n');

/** 埋め込むテキスト中の `</script` で script 要素が途中で閉じないようにする（JS としての意味は変わらない） */
function neutralize(js) {
    return String(js || '').replace(/<\/script/gi, '<\\/script');
}

/**
 * @param {{ nonce: string, viewerStatic: string, stencils: string, boot: string }} p
 * @returns {string} HTML 文書
 */
export function buildFrameDoc({ nonce, viewerStatic, stencils, boot }) {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(String(nonce || ''))) { throw new Error('buildFrameDoc: invalid nonce'); }
    const s = (code) => `<script nonce="${nonce}">${neutralize(code)}</script>`;
    return [
        '<!doctype html><html><head><meta charset="utf-8">',
        `<meta http-equiv="Content-Security-Policy" content="${FRAME_CSP.replace('__NONCE__', nonce)}">`,
        '<meta name="referrer" content="no-referrer">',
        '<style>html,body{margin:0;height:100%;background:#fff}#pane{position:absolute;inset:0;overflow:auto}</style>',
        '</head><body><div id="pane"></div>',
        s(PRELUDE),
        s(viewerStatic),
        s(stencils),
        s(boot),
        '</body></html>',
    ].join('\n');
}
