import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getNonce } from './webviewContent';

interface OutlinerConfig {
    theme: string;
    fontSize: number;
    toolbarMode?: string;
    webviewMessages?: Record<string, string>;
    enableDebugLogging?: boolean;
    documentBaseUri?: string;
    imageMaxWidth?: number;
    showOpenInTextEditor?: boolean;
}

export function getOutlinerWebviewContent(
    webview: vscode.Webview,
    extensionUri: vscode.Uri,
    jsonContent: string,
    config: OutlinerConfig,
    outFileKey?: string
): string {
    const nonce = getNonce();

    // i18n messages
    const msg = config.webviewMessages || {};

    // Load CSS
    // Minimal redesign foundation (sprint 20260509-185557): tokens.css / fr-base.css / fr-components.css
    const tokensCssPath = path.join(__dirname, 'webview', 'tokens.css');
    const tokensCss = fs.existsSync(tokensCssPath) ? fs.readFileSync(tokensCssPath, 'utf8') : '';
    const frBaseCssPath = path.join(__dirname, 'webview', 'fr-base.css');
    const frBaseCss = fs.existsSync(frBaseCssPath) ? fs.readFileSync(frBaseCssPath, 'utf8') : '';
    const frComponentsCssPath = path.join(__dirname, 'webview', 'fr-components.css');
    const frComponentsCss = fs.existsSync(frComponentsCssPath) ? fs.readFileSync(frComponentsCssPath, 'utf8') : '';

    const outlinerCssPath = path.join(__dirname, 'webview', 'outliner.css');
    const outlinerCss = fs.readFileSync(outlinerCssPath, 'utf8')
        .replace('__FONT_SIZE__', String(config.fontSize));

    // Load editor styles (for side panel)
    const stylesPath = path.join(__dirname, 'webview', 'styles.css');
    const editorStyles = fs.readFileSync(stylesPath, 'utf8')
        .replace('__FONT_SIZE__', String(config.fontSize));

    // Load shared markdown link parser (used by both outliner.js and editor.js)
    const linkParserScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'markdown-link-parser.js'), 'utf8');

    // Load clip-source selector (paste 時のクリップボード源判定, outliner.js の前に注入)
    const clipSelectScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-clip-select.js'), 'utf8');

    // Load HostBridge
    const sidePanelBridgeScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'sidepanel-bridge-methods.js'), 'utf8');
    const hostBridgePath = path.join(__dirname, 'shared', 'outliner-host-bridge.js');
    const hostBridgeScript = fs.readFileSync(hostBridgePath, 'utf8');

    // Load outliner scripts
    const outlinerCellScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-cell.js'), 'utf8');
    const outlinerModelScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-model.js'), 'utf8');
    const outlinerSearchScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner-search.js'), 'utf8');
    const outlinerScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'outliner.js'), 'utf8');

    // Load editor scripts (for side panel EditorInstance)
    // FR-FV-05（sprint 20260815-075428）: file viewer（sidepanel 面）— standalone .out の 📎 viewer
    // QUAL-1: PDFViewer のレイアウト CSS（pdf_viewer.css）も対で配線
    const pdfViewerCssPath = path.join(__dirname, '..', 'media', 'pdfjs-viewer', 'pdf_viewer.css');
    const pdfViewerCss = fs.existsSync(pdfViewerCssPath) ? fs.readFileSync(pdfViewerCssPath, 'utf8') : '';
    const fileViewerScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'file-viewer.js'), 'utf8');
    const viewerSidePanelScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'viewer-side-panel.js'), 'utf8');
    const editorUtilsScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'editor-utils.js'), 'utf8');
    // sprint 20260724-160000: インライン文字色 共有 core + パレット + ピッカー（editor.js/outliner.js より前）
    const inlineColorScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'inline-color.js'), 'utf8');
    const colorPaletteScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'notes-color-palette.js'), 'utf8');
    const inlineColorPickerScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'inline-color-picker.js'), 'utf8');
    // FR-B06b: cmd 長押しショートカット HUD（静的リスト + 表示ロジック。editor.js/outliner.js より前）
    const shortcutListScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'shortcut-list.js'), 'utf8');
    const shortcutHudScript = fs.readFileSync(
        path.join(__dirname, 'shared', 'shortcut-hud.js'), 'utf8');
    const pdfExportScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'pdf-export-webview.js'), 'utf8');
    // FR-SPM-01 (sprint 20260808-000219): sidepanel header overflow menu（editor.js/outliner.js より前に window.SidePanelOverflow を用意）
    const sidePanelOverflowScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'sidepanel-overflow.js'), 'utf8');

    const editorScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'editor.js'), 'utf8')
        .replace('__DEBUG_MODE__', String(config.enableDebugLogging ?? false))
        .replace('__I18N__', JSON.stringify(msg))
        .replace('__DOCUMENT_BASE_URI__', '')
        .replace('__IS_OUTLINER_PAGE__', 'true')
        .replace('__CONTENT__', `'(unused)'`);

    // Vendor library URIs
    const vendorDir = path.join(__dirname, '..', 'vendor');
    const vendorUri = (file: string) => webview.asWebviewUri(
        vscode.Uri.file(path.join(vendorDir, file))
    );
    // v0.207.50: html-md-converter bundle で turndown + GFM + Fractal rule を統合
    const htmlMdConverterScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'html-md-converter.js'), 'utf8');
    const mermaidUri = vendorUri('mermaid.min.js');
    const katexJsUri = vendorUri('katex.min.js');
    const katexCssUri = vendorUri('katex.min.css');
    // Mindmap Mode (sprint 20260701-122355): d3 layout engine (UMD, window.d3)
    const d3HierarchyUri = vendorUri('d3-hierarchy.min.js');
    const d3FlextreeUri = vendorUri('d3-flextree.min.js');

    // Mindmap Mode: webview scripts + css (flat under src/webview/)
    const mindmapModelScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-model.js'), 'utf8');
    const mindmapLayoutScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-layout.js'), 'utf8');
    const mindmapRenderScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-render.js'), 'utf8');
    const mindmapExportScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-export.js'), 'utf8');
    const mindmapInteractionsScript = fs.readFileSync(
        path.join(__dirname, 'webview', 'mindmap-interactions.js'), 'utf8');
    const mindmapCssPath = path.join(__dirname, 'webview', 'mindmap.css');
    const mindmapCss = fs.existsSync(mindmapCssPath) ? fs.readFileSync(mindmapCssPath, 'utf8') : '';

    // Base64 encode JSON content to prevent XSS
    const jsonToEncode = jsonContent || '{"version":1,"rootIds":[],"nodes":{}}';
    const base64Content = Buffer.from(jsonToEncode, 'utf8').toString('base64');

    // Side panel HTML (shared with all editors)
    const { generateSidePanelHtml } = require(path.join(__dirname, 'shared', 'editor-body-html.js'));
    const sidePanelHtml = generateSidePanelHtml(msg);

    return `<!DOCTYPE html>
<html lang="en" data-theme="${config.theme}" data-fr-theme="${config.theme}" data-toolbar-mode="${config.toolbarMode || 'full'}" data-show-open-in-text-editor="${String(config.showOpenInTextEditor ?? true)}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline' https://fonts.googleapis.com; script-src 'nonce-${nonce}' ${webview.cspSource}; img-src ${webview.cspSource} https: http: data: file: blob:; font-src ${webview.cspSource} https: https://fonts.gstatic.com data: blob:; frame-src ${webview.cspSource} blob:; worker-src ${webview.cspSource} blob:; connect-src ${webview.cspSource}; form-action 'none';">
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap">
    <title>Fractal Outliner</title>
    <style>${tokensCss}</style>
    <style>${frBaseCss}</style>
    <style>${frComponentsCss}</style>
    <style>
        ${editorStyles}
    </style>
    <style>
        ${outlinerCss}
    </style>
    <style>
        ${mindmapCss}
    </style>
    <link rel="stylesheet" href="${katexCssUri}">
    <style>:root { --image-max-width: ${typeof (config as any).imageMaxWidth === 'number' && (config as any).imageMaxWidth >= 100 ? (config as any).imageMaxWidth : 600}px; }</style>
</head>
<body>
    <div class="outliner-container">
        <div class="outliner-scroll-content">
            <div class="outliner-page-title">
                <input type="text" class="outliner-page-title-input" placeholder="Untitled" />
            </div>
            <div class="outliner-scope-search-indicator" style="display:none"><span class="outliner-scope-search-tag"></span></div>
            <div class="outliner-search-bar">
                <button class="outliner-nav-back-btn" title="Back" disabled><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                <button class="outliner-nav-forward-btn" title="Forward" disabled><svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
                <button class="outliner-search-mode-toggle" title="Toggle search mode: Tree / Focus"></button>
                <div class="outliner-search-input-wrapper"><input type="text" class="outliner-search-input" placeholder="Search... (e.g. #tag, keyword, is:page)" /><button class="outliner-search-clear-btn" style="display:none" title="Clear search"><svg xmlns="http://www.w3.org/2000/svg" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></button><div class="outliner-tag-suggest-bar" style="display:none"></div></div>
                <button class="outliner-undo-btn" title="Undo (Cmd+Z)" disabled></button>
                <button class="outliner-redo-btn" title="Redo (Cmd+Shift+Z)" disabled></button>
                <button class="outliner-view-toggle-btn" title="Switch view (Outline / Table)"></button>
                <button class="outliner-task-mode-toggle-btn" title="Task Mode"></button>
                <button class="outliner-task-filter-toggle-btn" title="Filter: Active / All"></button>
                <button class="outliner-archive-btn" title="Archive completed tasks"></button>
                <button class="outliner-menu-btn" title="Menu"></button>
            </div>
            <div class="outliner-breadcrumb"></div>
            <div class="outliner-tree" role="tree"></div>
        </div>
        <div class="fractal-resource-footer" style="display:none" data-rrf-template="${msg.resourceAccessOutOfRangeCount || '{count} image(s) are outside the allowed folders and cannot be shown (e.g. {sample}).'}">
            <span class="rrf-msg">${msg.resourceAccessOutOfRange || 'Some images are outside the allowed folders and cannot be shown.'}</span>
            <button class="rrf-open-settings" data-action="openResourceRootsSettings">${msg.resourceAccessOpenSettings || 'Change allowed folders'}</button>
        </div>
    </div>

    ${sidePanelHtml}

    <script nonce="${nonce}">
        // sprint 20260815 TASK-13（ADRL-0067 決定4② / 不変条件7）: viewer iframe（sandbox=allow-scripts・
        // opaque origin）発の postMessage 偽装を capture-phase で一括遮断する。bootstrap 最初期
        // （全 message listener 登録より前 — capture リスナーは登録順発火）に 1 本だけ置く。
        // host（extension）発 message の origin は webview 自身の origin なので誤爆しない。
        window.addEventListener('message', function (e) {
            if (e.origin === 'null') { e.stopImmediatePropagation(); }
        }, true);
        window.__webviewNonce = "${nonce}";
    </script>
    <script nonce="${nonce}">${htmlMdConverterScript}</script>
    <script src="${mermaidUri}"></script>
    <script src="${katexJsUri}"></script>
    <script src="${d3HierarchyUri}"></script>
    <script src="${d3FlextreeUri}"></script>

    <script nonce="${nonce}">
        window.__SKIP_EDITOR_AUTO_INIT__ = true;
        window.__outlinerMessages = ${JSON.stringify(config.webviewMessages || {})};
        window.__outlinerImageBaseUri = "${config.documentBaseUri || ''}";
    </script>
    <script nonce="${nonce}">
        ${editorUtilsScript}
    </script>
    <script nonce="${nonce}">
        ${colorPaletteScript}
    </script>
    <script nonce="${nonce}">
        ${inlineColorScript}
    </script>
    <script nonce="${nonce}">
        ${inlineColorPickerScript}
    </script>
    <script nonce="${nonce}">
        ${pdfExportScript}
        ${sidePanelOverflowScript}
    </script>
    <script nonce="${nonce}">
        ${shortcutListScript}
    </script>
    <script nonce="${nonce}">
        ${shortcutHudScript}
    </script>
    <script nonce="${nonce}">
        ${editorScript}
    </script>
    <script nonce="${nonce}">
        ${sidePanelBridgeScript}
    </script>
    <script nonce="${nonce}">
        ${linkParserScript}
    </script>
    <script nonce="${nonce}">
        ${hostBridgeScript}
    </script>
    <script nonce="${nonce}">
        ${outlinerCellScript}
    </script>
    <script nonce="${nonce}">
        ${outlinerModelScript}
    </script>
    <script nonce="${nonce}">
        ${mindmapModelScript}
    </script>
    <script nonce="${nonce}">
        ${mindmapLayoutScript}
    </script>
    <script nonce="${nonce}">
        ${mindmapRenderScript}
    </script>
    <script nonce="${nonce}">
        ${mindmapExportScript}
    </script>
    <script nonce="${nonce}">
        ${mindmapInteractionsScript}
    </script>
    <script nonce="${nonce}">
        ${outlinerSearchScript}
    </script>
    <script nonce="${nonce}">
        ${clipSelectScript}
    </script>
    <script nonce="${nonce}">
        ${outlinerScript}
    </script>
    <style>${pdfViewerCss}</style>
    <script nonce="${nonce}">window.__viewerConfig = {
        pdfjsLibUri: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs-viewer', 'pdfjs-lib.mjs'))}',
        workerUri: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs-viewer', 'pdf.worker.min.mjs'))}',
        cMapUrl: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs-viewer'))}/cmaps/',
        standardFontDataUrl: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'pdfjs-viewer'))}/standard_fonts/',
        // sprint 20260823-165314 / FR-FV-17（ADRL-0092）: kind 別 ESM モジュール（lazy import）
        viewerModuleUris: {
            text: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'viewer-text.mjs'))}',
            image: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'viewer-image.mjs'))}',
            docx: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'viewer-docx.mjs'))}',
            xlsx: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'viewer-xlsx.mjs'))}',
            pptx: '${webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'out', 'webview', 'viewer-pptx.mjs'))}'
        }
    };${fileViewerScript}</script>
    <script nonce="${nonce}">${viewerSidePanelScript}</script>
    <script nonce="${nonce}">
        try {
            var initialData = JSON.parse(decodeURIComponent(escape(atob('${base64Content}'))));
            Outliner.init(initialData, ${JSON.stringify(outFileKey || null)});
        } catch(e) {
            console.error('[Outliner] Failed to initialize:', e);
            Outliner.init({ version: 1, rootIds: [], nodes: {} }, ${JSON.stringify(outFileKey || null)});
        }
    </script>
</body>
</html>`;
}
