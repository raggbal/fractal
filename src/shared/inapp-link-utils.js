// In-App link (fractal://) の生成・解析の共有純関数（FR-B11 / sprint 20260804-145603）
//
// 文法の単一真実（生成と parse を同一ファイルに置き 2 実装非対称を防ぐ）:
//   page link: fractal://note/{folder}/{outFileId}/page/{pageId}
//   md   link: fractal://note/{folder}/md/{mdFileId}          （FR-B11 追加）
//   node link: fractal://note/{folder}/{outFileId}/{nodeId}
//   out  link: fractal://note/{folder}/{outFileId}            （FR-B11 追加・2 セグメント）
//
// parse は最長一致順 page → md → node → out。md link は node link と同じ 3 セグメント形
// （outFileId 位置がリテラル 'md'）なので、md を node より先に判定する（この順を崩すと
// md link が outFileId='md' の node link に誤解釈される）。outFileId は生成 id なので
// 'md' と衝突する現実的リンクは存在しない（FR-B11 で許容済み）。
//
// encode 規則: セグメントごとの encodeURIComponent（outliner.js:7054/:7427 の既存生成と同一）。

function buildNodeLink(folderName, outFileId, nodeId) {
    return 'fractal://note/' +
        encodeURIComponent(folderName) + '/' +
        encodeURIComponent(outFileId) + '/' +
        encodeURIComponent(nodeId);
}

function buildPageLink(folderName, outFileId, pageId) {
    return 'fractal://note/' +
        encodeURIComponent(folderName) + '/' +
        encodeURIComponent(outFileId) + '/page/' +
        encodeURIComponent(pageId);
}

function buildOutLink(folderName, outFileId) {
    return 'fractal://note/' +
        encodeURIComponent(folderName) + '/' +
        encodeURIComponent(outFileId);
}

function buildMdLink(folderName, mdFileId) {
    return 'fractal://note/' +
        encodeURIComponent(folderName) + '/md/' +
        encodeURIComponent(mdFileId);
}

function parseFractalLink(url) {
    // Page link: fractal://note/{folder}/{outFileId}/page/{pageId}
    var pageMatch = url.match(/^fractal:\/\/note\/([^/]+)\/([^/]+)\/page\/([^/?]+)$/);
    if (pageMatch) {
        return {
            noteFolderName: decodeURIComponent(pageMatch[1]),
            outFileId: decodeURIComponent(pageMatch[2]),
            pageId: decodeURIComponent(pageMatch[3]),
        };
    }
    // Md link: fractal://note/{folder}/md/{mdFileId}（node link より先に判定）
    var mdMatch = url.match(/^fractal:\/\/note\/([^/]+)\/md\/([^/?]+)$/);
    if (mdMatch) {
        return {
            noteFolderName: decodeURIComponent(mdMatch[1]),
            mdFileId: decodeURIComponent(mdMatch[2]),
        };
    }
    // Node link: fractal://note/{folder}/{outFileId}/{nodeId}
    var nodeMatch = url.match(/^fractal:\/\/note\/([^/]+)\/([^/]+)\/([^/?]+)$/);
    if (nodeMatch) {
        return {
            noteFolderName: decodeURIComponent(nodeMatch[1]),
            outFileId: decodeURIComponent(nodeMatch[2]),
            nodeId: decodeURIComponent(nodeMatch[3]),
        };
    }
    // Out link: fractal://note/{folder}/{outFileId}（2 セグメント・jump なし）
    var outMatch = url.match(/^fractal:\/\/note\/([^/]+)\/([^/?]+)$/);
    if (outMatch) {
        return {
            noteFolderName: decodeURIComponent(outMatch[1]),
            outFileId: decodeURIComponent(outMatch[2]),
        };
    }
    return null;
}

var _api = {
    buildNodeLink: buildNodeLink,
    buildPageLink: buildPageLink,
    buildOutLink: buildOutLink,
    buildMdLink: buildMdLink,
    parseFractalLink: parseFractalLink,
};

// CommonJS + global 両対応（webview では window.InAppLinkUtils として使用）
if (typeof module !== 'undefined' && module.exports) {
    module.exports = _api;
}
if (typeof window !== 'undefined') {
    window.InAppLinkUtils = _api;
}
