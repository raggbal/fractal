import * as vscode from 'vscode';
import { getWebviewContent, getNonce } from './webviewContent';
import { t, getWebviewMessages, initLocale } from './i18n/messages';
import { OutlinerProvider } from './outlinerProvider';
import { SidePanelManager } from './shared/sidePanelManager';
import {
    extractImageDir,
    extractForceRelativePath,
    extractFileDir,
    extractForceRelativeFilePath,
    removeAllDirectives
} from './shared/markdown-directives';
import { copyMdPasteAssets } from './shared/paste-asset-handler';
import {
    resolveSaveDirFromSidecar,
    readSaveDirConfig,
    sidecarPathForMd,
    isValidSaveDirValue,
    withSaveDir,
    withoutSaveDir,
    isUnderFractalNote,
    detectStandaloneOutlinerPage,
} from './shared/save-dir-directive';
import { runExportBundle } from './shared/export-bundle-host';
import { resolveResourceRoots, findOutOfRangeImages } from './shared/resource-roots';
import { translateText, TRANSLATE_LANGUAGES } from './shared/aws-translate';
import { DrawioWatcherRegistry, extractDrawioReferences, createDrawioFileWatcher } from './shared/drawioWatcher';
import { getCurrentTheme } from './shared/vscode-settings-provider';
import { copyImageToClipboard, openImageInNewTab } from './shared/image-clipboard';
import { buildPlaceholderDrawioSvg, buildUniqueDrawioName } from './shared/drawioTemplate';
import { parseDataUrl, mimeToExt } from './shared/data-url-image-extractor';

// ============================================
// DocumentParser: IMAGE_DIR ディレクティブの解析
// ============================================

// REMOVED: insertOrUpdateImageDir, hasImageDir, insertOrUpdateFileDir
// Per-file directive feature has been removed

// ============================================
// PathResolver: パス解決ロジック
// ============================================

const path = require('path');
const fs = require('fs');

/**
 * 設定パスを絶対パスに解決
 * @param configPath 設定されたパス（絶対または相対）
 * @param documentPath ドキュメントの絶対パス
 * @returns 解決された絶対パス
 */
function resolveToAbsolute(configPath: string, documentPath: string): string {
    if (!configPath || configPath === '') {
        // 空の場合はドキュメントと同じディレクトリ
        return path.dirname(documentPath);
    }
    
    if (path.isAbsolute(configPath)) {
        // 絶対パスはそのまま使用
        return configPath;
    }
    
    // 相対パスはドキュメントの場所を基準に解決
    const docDir = path.dirname(documentPath);
    return path.resolve(docDir, configPath);
}

/**
 * 画像の絶対パスからMarkdown用のパスを生成
 * @param imagePath 画像の絶対パス
 * @param documentPath ドキュメントの絶対パス
 * @param useAbsolute 絶対パスを使用するかどうか
 * @param forceRelative 強制的に相対パスを使用するかどうか
 * @returns Markdown用のパス（絶対または相対）
 */
export function toMarkdownPath(imagePath: string, documentPath: string, useAbsolute: boolean, forceRelative: boolean = false): string {
    // forceRelative が true なら、常に相対パスを使用
    if (forceRelative || !useAbsolute) {
        const docDir = path.dirname(documentPath);
        let relativePath = path.relative(docDir, imagePath);
        // Windowsのバックスラッシュをスラッシュに変換
        relativePath = relativePath.replace(/\\/g, '/');
        return relativePath;
    }
    
    // 絶対パス設定の場合: 絶対パスをそのまま使用
    // Windowsのバックスラッシュをスラッシュに変換
    return imagePath.replace(/\\/g, '/');
}

/**
 * ディレクトリが存在しない場合は作成
 */
export function ensureDirectoryExists(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

/**
 * ユニークなファイル名を生成（タイムスタンプ形式）
 * 同一タイムスタンプのファイルが存在する場合は連番を付与
 * @param dir ディレクトリパス
 * @param extension 拡張子（ドットなし）
 * @returns ユニークなファイル名
 */
export function generateUniqueFileName(dir: string, extension: string): string {
    const timestamp = Date.now();
    const baseName = `${timestamp}.${extension}`;
    const basePath = path.join(dir, baseName);
    
    // ファイルが存在しなければそのまま返す
    if (!fs.existsSync(basePath)) {
        return baseName;
    }
    
    // 同一タイムスタンプのファイルが存在する場合は連番を付与
    let counter = 1;
    while (true) {
        const counterStr = counter.toString().padStart(4, '0');
        const newName = `${timestamp}-${counterStr}.${extension}`;
        const newPath = path.join(dir, newName);
        if (!fs.existsSync(newPath)) {
            return newName;
        }
        counter++;
    }
}

/**
 * Generate unique file name preserving the original name.
 * On collision: report.pdf → report-1.pdf → report-2.pdf
 */
function generateUniqueFileNamePreserving(dir: string, originalName: string): string {
    const destPath = path.join(dir, originalName);
    if (!fs.existsSync(destPath)) {
        return originalName;
    }
    const ext = path.extname(originalName);
    const base = path.basename(originalName, ext);
    let counter = 1;
    while (true) {
        const newName = `${base}-${counter}${ext}`;
        if (!fs.existsSync(path.join(dir, newName))) {
            return newName;
        }
        counter++;
    }
}

/**
 * MD-45 拡張: 多重拡張子（.drawio.svg / .drawio.png）対応の suffix 付与。
 * `foo.drawio.svg` → `foo-1.drawio.svg`（`foo.drawio-1.svg` ではない）。
 * 実体は src/shared/drawioTemplate.ts の buildUniqueDrawioName。
 */
function generateUniqueDrawioFileName(dir: string, originalName: string): string {
    return buildUniqueDrawioName(originalName, (name) => fs.existsSync(path.join(dir, name)));
}

// ============================================
// ImageDirectoryManager: 画像保存ディレクトリの管理
// ============================================

/**
 * パスの末尾スラッシュを正規化（削除）
 */
function normalizeTrailingSlash(p: string): string {
    // ルートパス（/ や C:\）は除外
    if (p === '/' || /^[A-Za-z]:\\?$/.test(p)) {
        return p;
    }
    return p.replace(/[\/\\]+$/, '');
}

export class ImageDirectoryManager {
    // ファイルURIをキーとしたIMAGE_DIRのマップ
    private fileImageDirs: Map<string, string> = new Map();
    // 最後に検出されたIMAGE_DIR（変更検出用）
    private lastDetectedDirs: Map<string, string> = new Map();
    // 設定されたパスが絶対パスかどうかを記録
    private useAbsolutePath: Map<string, boolean> = new Map();
    
    /**
     * 現在有効な画像保存ディレクトリを取得
     * 優先順位: 1. 保存先ディレクティブ (standalone md 限定), 2. ファイル単位のIMAGE_DIR (outliner forced), 3. <mdDir>/images
     */
    getImageDirectory(documentUri: vscode.Uri, documentContent: string): string {
        const documentPath = documentUri.fsPath;
        const uriKey = documentUri.toString();

        // 1. 保存先サイドカー .fractal.json（standalone md 限定・resolver 内ガード。ADRL-0016 / D-1）。
        //    共有シングルトンなので Notes/outliner page md では発火させない（保存先固定の不変条件 NFR-MD-01）。
        if (!isUnderFractalNote(documentPath) && detectStandaloneOutlinerPage(documentPath) === null) {
            const dir = resolveSaveDirFromSidecar(documentPath, 'imageDir');
            if (dir) {
                const normalized = normalizeTrailingSlash(dir);
                this.useAbsolutePath.set(uriKey, path.isAbsolute(normalized));
                return resolveToAbsolute(normalized, documentPath);
            }
        }

        // 2. ファイル単位のIMAGE_DIR (outliner page forced dir)
        const fileImageDir = this.fileImageDirs.get(uriKey);
        if (fileImageDir) {
            const normalized = normalizeTrailingSlash(fileImageDir);
            this.useAbsolutePath.set(uriKey, path.isAbsolute(normalized));
            return resolveToAbsolute(normalized, documentPath);
        }

        // 3. デフォルト: <mdDir>/images（相対パス扱い・固定）
        this.useAbsolutePath.set(uriKey, false);
        return path.join(path.dirname(documentPath), 'images');
    }

    /**
     * 設定されたパスが絶対パスかどうかを取得
     * getImageDirectory() を先に呼び出す必要がある
     */
    shouldUseAbsolutePath(documentUri: vscode.Uri): boolean {
        return this.useAbsolutePath.get(documentUri.toString()) || false;
    }

    /**
     * 相対パスを強制するかどうかを取得（旧設定は廃止 → 常に false）
     */
    shouldForceRelativePath(_documentUri: vscode.Uri, _documentContent: string): boolean {
        return false;
    }
    
    /**
     * ファイル単位のIMAGE_DIRを設定
     */
    setFileImageDir(documentUri: vscode.Uri, dirPath: string): void {
        this.fileImageDirs.set(documentUri.toString(), dirPath);
    }
    
    /**
     * ファイル単位のIMAGE_DIRを取得
     */
    getFileImageDir(uriKey: string): string | undefined {
        const dir = this.fileImageDirs.get(uriKey);
        return dir || undefined;
    }

    /**
     * ファイル単位のIMAGE_DIRをクリア
     */
    clearFileImageDir(documentUri: vscode.Uri): void {
        this.fileImageDirs.delete(documentUri.toString());
    }
}

// グローバルインスタンス
export const imageDirectoryManager = new ImageDirectoryManager();

// ============================================
// FileDirectoryManager: ファイル保存ディレクトリの管理
// ============================================

export class FileDirectoryManager {
    // ファイルURIをキーとしたFILE_DIRのマップ
    private fileFileDirs: Map<string, string> = new Map();
    // 最後に検出されたFILE_DIR（変更検出用）
    private lastDetectedDirs: Map<string, string> = new Map();
    // 設定されたパスが絶対パスかどうかを記録
    private useAbsolutePath: Map<string, boolean> = new Map();

    /**
     * 現在有効なファイル保存ディレクトリを取得
     * 優先順位: 1. 保存先ディレクティブ (standalone md 限定), 2. ファイル単位のFILE_DIR (outliner forced), 3. <mdDir>/files
     */
    getFileDirectory(documentUri: vscode.Uri, documentContent: string): string {
        const documentPath = documentUri.fsPath;
        const uriKey = documentUri.toString();

        // 1. 保存先サイドカー .fractal.json（standalone md 限定・resolver 内ガード。ADRL-0016 / D-1）。
        if (!isUnderFractalNote(documentPath) && detectStandaloneOutlinerPage(documentPath) === null) {
            const dir = resolveSaveDirFromSidecar(documentPath, 'fileDir');
            if (dir) {
                const normalized = normalizeTrailingSlash(dir);
                this.useAbsolutePath.set(uriKey, path.isAbsolute(normalized));
                return resolveToAbsolute(normalized, documentPath);
            }
        }

        // 2. ファイル単位のFILE_DIR (outliner page forced dir)
        const fileFileDir = this.fileFileDirs.get(uriKey);
        if (fileFileDir) {
            const normalized = normalizeTrailingSlash(fileFileDir);
            this.useAbsolutePath.set(uriKey, path.isAbsolute(normalized));
            return resolveToAbsolute(normalized, documentPath);
        }

        // 3. デフォルト: <mdDir>/files（相対パス扱い・固定）
        this.useAbsolutePath.set(uriKey, false);
        return path.join(path.dirname(documentPath), 'files');
    }

    /**
     * 設定されたパスが絶対パスかどうかを取得
     * getFileDirectory() を先に呼び出す必要がある
     */
    shouldUseAbsoluteFilePath(documentUri: vscode.Uri): boolean {
        return this.useAbsolutePath.get(documentUri.toString()) || false;
    }

    /**
     * 相対パスを強制するかどうかを取得（旧設定は廃止 → 常に false）
     */
    shouldForceRelativeFilePath(_documentUri: vscode.Uri, _documentContent: string): boolean {
        return false;
    }

    /**
     * ファイル単位のFILE_DIRを設定
     */
    setFileFileDir(documentUri: vscode.Uri, dirPath: string): void {
        this.fileFileDirs.set(documentUri.toString(), dirPath);
    }

    /**
     * ファイル単位のFILE_DIRを取得
     */
    getFileFileDir(uriKey: string): string | undefined {
        const dir = this.fileFileDirs.get(uriKey);
        return dir || undefined;
    }

    /**
     * ファイル単位のFILE_DIRをクリア
     */
    clearFileFileDir(documentUri: vscode.Uri): void {
        this.fileFileDirs.delete(documentUri.toString());
    }
}

// グローバルインスタンス
export const fileDirectoryManager = new FileDirectoryManager();

// detectStandaloneOutlinerPage は src/shared/save-dir-directive.ts に移動（pure・unit 直接 require 用）。

export class AnyMarkdownEditorProvider implements vscode.CustomTextEditorProvider {
    private static readonly viewType = 'fractal.editor';

    // Track the currently active webview panel for undo/redo command forwarding
    private activeWebviewPanel: vscode.WebviewPanel | undefined;

    constructor(private readonly context: vscode.ExtensionContext) {}

    /**
     * Send undo command to the active webview
     */
    public sendUndo(): boolean {
        if (this.activeWebviewPanel) {
            this.activeWebviewPanel.webview.postMessage({ type: 'performUndo' });
            return true;
        }
        return false;
    }

    /**
     * Send redo command to the active webview
     * @returns true if message was sent, false if no active panel
     */
    public sendRedo(): boolean {
        if (this.activeWebviewPanel) {
            this.activeWebviewPanel.webview.postMessage({ type: 'performRedo' });
            return true;
        }
        return false;
    }

    /**
     * Send toggle source mode command to the active webview
     */
    public sendToggleSourceMode(): void {
        this.activeWebviewPanel?.webview.postMessage({ type: 'toggleSourceMode' });
    }

    public sendTranslate(): void {
        this.activeWebviewPanel?.webview.postMessage({ type: 'triggerTranslate' });
    }

    public sendToggleSidebar(): void {
        this.activeWebviewPanel?.webview.postMessage({ type: 'toggleSidebar' });
    }

    /**
     * Extract h1/h2 headings from markdown for side panel TOC
     */
    /**
     * Build a map of image path -> data URL for side panel iframe.
     * The blob: iframe can't access file:// or vscode-resource URIs,
     * so all images must be provided as data URLs.
     */
    public async resolveCustomTextEditor(
        document: vscode.TextDocument,
        webviewPanel: vscode.WebviewPanel,
        _token: vscode.CancellationToken
    ): Promise<void> {
        // IMPORTANT: Clear any cached webview state immediately to prevent
        // "Assertion Failed: Argument is undefined or null" errors after extension updates.
        // VSCode may try to restore old webview state that's incompatible with new extension code.
        // Setting html to empty string first ensures we start fresh.
        webviewPanel.webview.html = '';
        
        // Get the document directory and workspace folder for local resource access
        const documentDir = vscode.Uri.joinPath(document.uri, '..');
        const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);

        // FR-RR-03: homeDir ハードコードを settings 由来の許可範囲に置換（空なら [homedir]＝後方互換）。
        const cfg = vscode.workspace.getConfiguration('fractal');
        const resourceRoots = resolveResourceRoots(cfg.get<string[]>('resourceRoots', []));

        const localResourceRoots = [
            vscode.Uri.joinPath(this.context.extensionUri, 'media'),
            vscode.Uri.joinPath(this.context.extensionUri, 'node_modules'),
            documentDir,
            // Allow access to configured roots (default = home directory: Downloads, Pictures, etc.)
            ...resourceRoots.map(p => vscode.Uri.file(p))
        ];
        if (workspaceFolder) {
            localResourceRoots.push(workspaceFolder.uri);
        }

        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots
        };

        // Get the base URI for resolving relative paths
        const documentBaseUri = webviewPanel.webview.asWebviewUri(documentDir).toString();
        
        // Convert absolute image paths to webview URIs
        const convertImagePaths = (content: string): string => {
            // Match image markdown: ![alt](path)
            return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, src) => {
                // Skip if already a URL or data URI
                if (src.startsWith('http://') || src.startsWith('https://') || 
                    src.startsWith('data:') || src.startsWith('vscode-webview:') ||
                    src.startsWith('vscode-resource:')) {
                    return match;
                }
                // Convert absolute path to webview URI
                if (src.startsWith('/')) {
                    const fileUri = vscode.Uri.file(src);
                    const webviewUri = webviewPanel.webview.asWebviewUri(fileUri).toString();
                    return `![${alt}](${webviewUri})`;
                }
                // Relative path - will be resolved by webview using documentBaseUri
                return match;
            });
        };
        
        // Remember the original line ending style to preserve on save
        const originalEol = document.eol;

        // nonce を保持（サイドパネル iframe で再利用するため）
        const webviewNonce = { value: getNonce() };

        // outlinerページ判定
        // 1. 明示的登録 (Outliner / Notes provider が page MD を開く時に setFileImageDir 経由で登録)
        // 2. v0.207.44: heuristic 検出 — standalone で直接 .md を開いた場合でも、命名規約に従って
        //    親フォルダ名と同名の .out が grandparent に存在すれば outliner page MD と判定
        let isOutlinerPage = OutlinerProvider.outlinerPagePaths.has(document.uri.fsPath);
        let outlinerPageDir = OutlinerProvider.outlinerPagePaths.get(document.uri.fsPath);
        if (!isOutlinerPage) {
            const detected = detectStandaloneOutlinerPage(document.uri.fsPath);
            if (detected) {
                isOutlinerPage = true;
                outlinerPageDir = detected.pageDir;
            }
        }

        // outlinerページの場合、画像 + ファイルディレクトリを強制設定 (固定で images/ files/)
        // v0.207.45: 相対パスで登録する。絶対パスを渡すと shouldUseAbsolutePath が true になり
        // 画像挿入時に MD パスが絶対化されてしまう (outliner page MD は常に相対パスが望ましい)。
        if (isOutlinerPage && outlinerPageDir) {
            imageDirectoryManager.setFileImageDir(document.uri, 'images');
            fileDirectoryManager.setFileFileDir(document.uri, 'files');
        }

        const sendTranslateLangFromConfig = () => {
            const cfg = vscode.workspace.getConfiguration('fractal');
            webviewPanel.webview.postMessage({
                type: 'translateLangSelected',
                sourceLang: cfg.get<string>('translateSourceLang', 'en'),
                targetLang: cfg.get<string>('translateTargetLang', 'ja'),
            });
        };

        const updateWebview = () => {
            try {
                const config = vscode.workspace.getConfiguration('fractal');
                const content = convertImagePaths(document.getText());
                webviewPanel.webview.html = getWebviewContent(
                    webviewPanel.webview,
                    this.context.extensionUri,
                    content,
                    {
                        theme: getCurrentTheme(this.context),
                        fontSize: config.get<number>('fontSize', 12),
                        toolbarMode: config.get<string>('toolbarMode', 'simple'),
                        documentBaseUri: documentBaseUri,
                        webviewMessages: getWebviewMessages(),
                        enableDebugLogging: config.get<boolean>('enableDebugLogging', false),
                        isOutlinerPage: isOutlinerPage,
                        showTranslateButtons: config.get<boolean>('showTranslateButtons', false),
                        showOpenInTextEditor: config.get<boolean>('showOpenInTextEditor', true),
                        imageMaxWidth: config.get<number>('imageMaxWidth', 400)
                    },
                    webviewNonce
                );
                sendTranslateLangFromConfig();
            } catch (error) {
                console.error('[Any MD] Error updating webview:', error);
                // Show a minimal error page instead of crashing
                webviewPanel.webview.html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>Error</title></head>
<body style="padding: 20px; font-family: sans-serif;">
    <h2>Failed to load editor</h2>
    <p>Please try closing and reopening this file.</p>
    <p>If the problem persists, try reloading VS Code window (Cmd/Ctrl+Shift+P → "Reload Window").</p>
    <details>
        <summary>Error details</summary>
        <pre>${String(error)}</pre>
    </details>
</body>
</html>`;
            }
        };

        // FR-RR-04: この md 内の画像で許可範囲外のものを検知し、フッター案内を webview に送る
        const sendResourceAccessStatus = () => {
            try {
                const body = document.getText();
                const mdDir = path.dirname(document.uri.fsPath);
                const outOfRange = findOutOfRangeImages(body, mdDir, resourceRoots);
                webviewPanel.webview.postMessage({
                    type: 'resourceAccessStatus',
                    outOfRange: outOfRange.length > 0,
                    count: outOfRange.length,
                    samplePath: outOfRange[0]
                });
            } catch { /* 検知は best-effort。失敗しても本体表示を妨げない */ }
        };

        // Send current image directory status to webview
        const sendImageDirStatus = () => {
            const docContent = document.getText();
            const docPath = document.uri.fsPath;
            const uriKey = document.uri.toString();
            const docDir = path.dirname(docPath);

            // Determine source (file = outliner forced, default = <mdDir>/images or directive)
            const fileImageDir = imageDirectoryManager.getFileImageDir(uriKey);
            const source: 'file' | 'default' = fileImageDir ? 'file' : 'default';

            // Compute display path (same logic as toMarkdownPath for directories)
            const absDir = imageDirectoryManager.getImageDirectory(document.uri, docContent);
            const useAbsolute = imageDirectoryManager.shouldUseAbsolutePath(document.uri);
            const forceRelative = imageDirectoryManager.shouldForceRelativePath(document.uri, docContent);

            let displayPath: string;
            if (forceRelative || !useAbsolute) {
                displayPath = path.relative(docDir, absDir) || '.';
                displayPath = displayPath.replace(/\\/g, '/');
            } else {
                displayPath = absDir;
            }
            // v0.207.44: forced dir (outliner page = source 'file') は末尾 / を付けて lock 表示
            const locked = source === 'file';
            if (locked && displayPath !== '.' && !displayPath.endsWith('/')) {
                displayPath += '/';
            }
            // FR-MD-01/02: standalone md（note 配下でない・outliner page でない）だけ保存先変更 UI を出せる
            const editable = !isUnderFractalNote(docPath) && detectStandaloneOutlinerPage(docPath) === null;

            webviewPanel.webview.postMessage({
                type: 'imageDirStatus',
                displayPath,
                source,
                locked,
                editable
            });
        };

        // Send side panel image directory status to webview
        const sendSidePanelImageDirStatus = (spFilePath: string) => {
            const spUri = vscode.Uri.file(spFilePath);
            const spDir = path.dirname(spFilePath);

            // Read content from sidePanel.document or disk
            let spContent = '';
            if (sidePanel.document && !sidePanel.document.isClosed) {
                spContent = sidePanel.document.getText();
            } else {
                try { spContent = fs.readFileSync(spFilePath, 'utf-8'); } catch { /* empty */ }
            }

            // Determine source (file = outliner forced, default = <mdDir>/images or directive)
            const spUriKey = spUri.toString();
            const fileImageDir = imageDirectoryManager.getFileImageDir(spUriKey);
            const source: 'file' | 'default' = fileImageDir ? 'file' : 'default';

            const absDir = imageDirectoryManager.getImageDirectory(spUri, spContent);
            const useAbsolute = imageDirectoryManager.shouldUseAbsolutePath(spUri);
            const forceRelative = imageDirectoryManager.shouldForceRelativePath(spUri, spContent);

            let displayPath: string;
            if (forceRelative || !useAbsolute) {
                displayPath = path.relative(spDir, absDir) || '.';
                displayPath = displayPath.replace(/\\/g, '/');
            } else {
                displayPath = absDir;
            }
            const locked = source === 'file';
            if (locked && displayPath !== '.' && !displayPath.endsWith('/')) {
                displayPath += '/';
            }

            webviewPanel.webview.postMessage({
                type: 'sidePanelImageDirStatus',
                displayPath,
                source,
                locked
            });
        };

        // Send file directory status to webview
        const sendFileDirStatus = () => {
            const docContent = document.getText();
            const docPath = document.uri.fsPath;
            const uriKey = document.uri.toString();
            const docDir = path.dirname(docPath);

            // Determine source (file = outliner forced, default = <mdDir>/files or directive)
            const fileFileDir = fileDirectoryManager.getFileFileDir(uriKey);
            const source: 'file' | 'default' = fileFileDir ? 'file' : 'default';

            // Compute display path (same logic as toMarkdownPath for directories)
            const absDir = fileDirectoryManager.getFileDirectory(document.uri, docContent);
            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(document.uri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(document.uri, docContent);

            let displayPath: string;
            if (forceRelative || !useAbsolute) {
                displayPath = path.relative(docDir, absDir) || '.';
                displayPath = displayPath.replace(/\\/g, '/');
            } else {
                displayPath = absDir;
            }
            const locked = source === 'file';
            if (locked && displayPath !== '.' && !displayPath.endsWith('/')) {
                displayPath += '/';
            }
            const editable = !isUnderFractalNote(docPath) && detectStandaloneOutlinerPage(docPath) === null;

            webviewPanel.webview.postMessage({
                type: 'fileDirStatus',
                displayPath,
                source,
                locked,
                editable
            });
        };

        // Send side panel file directory status to webview
        const sendSidePanelFileDirStatus = (spFilePath: string) => {
            const spUri = vscode.Uri.file(spFilePath);
            const spDir = path.dirname(spFilePath);

            // Read content from sidePanel.document or disk
            let spContent = '';
            if (sidePanel.document && !sidePanel.document.isClosed) {
                spContent = sidePanel.document.getText();
            } else {
                try { spContent = fs.readFileSync(spFilePath, 'utf-8'); } catch { /* empty */ }
            }

            // Determine source (file = outliner forced, default = <mdDir>/files or directive)
            const spUriKey = spUri.toString();
            const fileFileDir = fileDirectoryManager.getFileFileDir(spUriKey);
            const source: 'file' | 'default' = fileFileDir ? 'file' : 'default';

            const absDir = fileDirectoryManager.getFileDirectory(spUri, spContent);
            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(spUri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(spUri, spContent);

            let displayPath: string;
            if (forceRelative || !useAbsolute) {
                displayPath = path.relative(spDir, absDir) || '.';
                displayPath = displayPath.replace(/\\/g, '/');
            } else {
                displayPath = absDir;
            }
            const locked = source === 'file';
            if (locked && displayPath !== '.' && !displayPath.endsWith('/')) {
                displayPath += '/';
            }

            webviewPanel.webview.postMessage({
                type: 'sidePanelFileDirStatus',
                displayPath,
                source,
                locked
            });
        };

        // Initial content
        updateWebview();

        // Send initial image dir status (queued for webview)
        sendImageDirStatus();

        // Send initial file dir status (queued for webview)
        sendFileDirStatus();

        // FR-RR-04: この md の画像に許可範囲外があればフッター案内を送る
        sendResourceAccessStatus();

        // Sync policy: when user is actively editing, external changes are queued in webview.
        // When user is idle (even with focus), external changes are applied with cursor preservation.
        let webviewHasFocus = false;
        let isActivelyEditing = false;
        let isApplyingOwnEdit = false;

        // --- drawio watcher (MD-48): 既存 fileWatcher / fileChangeSubscription とは完全分離 ---
        // NT-14 / OL-22 / MD-24 を破壊しないため、document 経路には触らない。
        // standalone customEditor は workspace folder が無い場合があり、その場合
        // vscode.workspace.createFileSystemWatcher は外部ファイルに対して fire しない。
        // Node の fs.watchFile (1秒 polling) を fallback として併用する。
        const drawioWatcher = new DrawioWatcherRegistry({
            createFileSystemWatcher: (drawioPath: string) =>
                createDrawioFileWatcher(drawioPath, vscode, fs),
            debounceMs: 200,
            onChange: (drawioPath: string, mdPaths: string[]) => {
                if (mdPaths.indexOf(document.uri.fsPath) === -1) return;
                try {
                    const stat = fs.statSync(drawioPath);
                    webviewPanel.webview.postMessage({
                        type: 'drawioFileChanged',
                        path: drawioPath,
                        mtime: stat.mtimeMs
                    });
                } catch {
                    // file removed etc. — ignore
                }
            }
        });

        const updateDrawioRefs = () => {
            try {
                const refs = extractDrawioReferences(
                    document.getText(),
                    path.dirname(document.uri.fsPath)
                );
                drawioWatcher.setReferences(document.uri.fsPath, refs);
            } catch (err) {
                console.warn('[Any MD] updateDrawioRefs error:', err);
            }
        };
        updateDrawioRefs();

        // Listen for document changes
        const changeDocumentSubscription = vscode.workspace.onDidChangeTextDocument(e => {
            if (e.document.uri.toString() !== document.uri.toString()) return;
            if (e.contentChanges.length === 0) return; // Skip metadata-only changes

            // Skip our own edits — they are already reflected in the webview
            if (isApplyingOwnEdit) return;

            // External change detected — send update to webview.
            // The webview will decide whether to apply immediately (idle) or queue (editing).
            const currentContent = document.getText();
            const content = convertImagePaths(currentContent);

            webviewPanel.webview.postMessage({
                type: 'update',
                content: content
            });

            // Update image dir status
            sendImageDirStatus();

            // MD-48: drawio 参照 diff を取り、watcher 追加/削除（既存ロジック無修正）
            updateDrawioRefs();
        });

        // Listen for file system changes (from external editors like Claude)
        // This ONLY syncs the VS Code document; messaging is handled by onDidChangeTextDocument
        const fileWatcher = vscode.workspace.createFileSystemWatcher(
            new vscode.RelativePattern(vscode.Uri.joinPath(document.uri, '..'), path.basename(document.uri.fsPath))
        );

        const fileChangeSubscription = fileWatcher.onDidChange(async (uri) => {
            if (uri.toString() === document.uri.toString()) {
                setTimeout(async () => {
                    try {
                        const fileContent = await vscode.workspace.fs.readFile(uri);
                        const newContent = new TextDecoder().decode(fileContent);
                        const currentContent = document.getText();

                        if (newContent !== currentContent) {
                            // Sync VS Code document with file content (triggers onDidChangeTextDocument)
                            isApplyingOwnEdit = true;
                            const fullRange = new vscode.Range(
                                document.positionAt(0),
                                document.positionAt(currentContent.length)
                            );
                            const edit = new vscode.WorkspaceEdit();
                            edit.replace(document.uri, fullRange, newContent);
                            await vscode.workspace.applyEdit(edit);
                            isApplyingOwnEdit = false;

                            // Save immediately to clear dirty state — file on disk is already up to date
                            await document.save();

                            // Notify webview directly (since isApplyingOwnEdit suppressed onDidChangeTextDocument)
                            const content = convertImagePaths(newContent);
                            webviewPanel.webview.postMessage({
                                type: 'update',
                                content: content
                            });
                        }
                    } catch (error) {
                        isApplyingOwnEdit = false;
                        console.error('[Any MD] Error reading file after external change:', error);
                    }
                }, 100);
            }
        });

        // --- サイドパネル管理 (SidePanelManager で共通化) ---
        const sidePanel = new SidePanelManager(
            {
                postMessage: (msg: any) => webviewPanel.webview.postMessage(msg),
                asWebviewUri: (uri: vscode.Uri) => webviewPanel.webview.asWebviewUri(uri)
            },
            { logPrefix: '[Any MD]' }
        );

        // Listen for configuration changes
        const changeConfigSubscription = vscode.workspace.onDidChangeConfiguration(e => {
            if (e.affectsConfiguration('fractal')) {
                // Re-initialize locale if language setting changed
                if (e.affectsConfiguration('fractal.language')) {
                    const langConfig = vscode.workspace.getConfiguration('fractal');
                    initLocale(langConfig.get<string>('language', 'default'), vscode.env.language);
                }
                updateWebview();
                sendImageDirStatus();
            }
        });

        // Serialized edit queue — debounce + promise chain (no recursive retry, no freeze)
        let pendingContent: string | null = null;
        let editDebounceTimer: NodeJS.Timeout | null = null;
        let applyEditQueue: Promise<void> = Promise.resolve();

        const scheduleEdit = (content: string) => {
            pendingContent = content;
            if (editDebounceTimer) {
                clearTimeout(editDebounceTimer);
            }
            editDebounceTimer = setTimeout(() => {
                editDebounceTimer = null;
                const contentToApply = pendingContent;
                pendingContent = null;
                if (contentToApply === null) return;

                applyEditQueue = applyEditQueue.then(async () => {
                    try {
                        // Skip if content is identical — prevents unnecessary dirty marking
                        const normalize = (s: string) => s.replace(/\r\n/g, '\n');
                        if (normalize(contentToApply) === normalize(document.getText())) return;

                        isApplyingOwnEdit = true;
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(
                            document.uri,
                            new vscode.Range(0, 0, document.lineCount, 0),
                            contentToApply
                        );
                        await vscode.workspace.applyEdit(edit);
                    } catch (e) {
                        console.log('[Any MD] Edit error (ignored):', e);
                    } finally {
                        isApplyingOwnEdit = false;
                    }
                });
            }, 100);
        };

        // Handle messages from the webview
        webviewPanel.webview.onDidReceiveMessage(async message => {
            switch (message.type) {
                case 'edit':
                    // Restore original line endings if document uses CRLF
                    const editContent = originalEol === vscode.EndOfLine.CRLF
                        ? message.content.replace(/\n/g, '\r\n')
                        : message.content;
                    scheduleEdit(editContent);
                    break;

                case 'save':
                    await document.save();
                    break;

                case 'openResourceRootsSettings':
                    await vscode.commands.executeCommand('workbench.action.openSettings', 'fractal.resourceRoots');
                    break;

                // FR-MD-03/04/06: standalone md（note 配下でない）限定 — 画像/添付保存先の変更 UI。
                // sidebar-footer の保存先表示クリック → QuickPick（フォルダを選ぶ / デフォルトに戻す）→
                // md 冒頭の保存先ディレクティブ upsert/remove（ADRL-0015）。
                case 'setSaveDir': {
                    const kind: 'image' | 'file' = message.kind === 'file' ? 'file' : 'image';
                    const docPath = document.uri.fsPath;
                    // 二重ガード: standalone md（note 配下でない・outliner page でない）のみ
                    if (isUnderFractalNote(docPath) || detectStandaloneOutlinerPage(docPath) !== null) break;
                    const dirKey: 'imageDir' | 'fileDir' = kind === 'image' ? 'imageDir' : 'fileDir';
                    const labelKind = kind === 'image'
                        ? (getWebviewMessages().imageDirLabel || 'Image save directory')
                        : (getWebviewMessages().fileDirLabel || 'File save directory');
                    const pickChoose = getWebviewMessages().saveDirChoose || 'Choose folder…';
                    const pickReset = getWebviewMessages().saveDirReset || 'Reset to default (images/ · files/)';
                    const choice = await vscode.window.showQuickPick([pickChoose, pickReset], {
                        placeHolder: labelKind,
                    });
                    if (!choice) break;
                    const mdDir = path.dirname(docPath);
                    if (choice === pickChoose) {
                        const picked = await vscode.window.showOpenDialog({
                            canSelectFolders: true,
                            canSelectFiles: false,
                            canSelectMany: false,
                            defaultUri: vscode.Uri.file(mdDir),
                            openLabel: pickChoose,
                        });
                        if (!picked || picked.length === 0) break;
                        const pickedDir = picked[0].fsPath;
                        // md からの相対。md 外へ出る（.. で始まる）なら絶対パスのまま。
                        let rel = path.relative(mdDir, pickedDir).replace(/\\/g, '/');
                        let value: string;
                        if (rel === '') {
                            value = '.';
                        } else if (rel.startsWith('..')) {
                            value = pickedDir; // md 外 → 絶対パス
                        } else {
                            value = rel;
                        }
                        if (!isValidSaveDirValue(value)) {
                            vscode.window.showWarningMessage('Invalid save directory path.');
                            break;
                        }
                        // .fractal.json（md 同フォルダ）に該当キーを upsert（本文は触らない・他キー保持）
                        const sidecar = sidecarPathForMd(docPath);
                        const nextCfg = withSaveDir(readSaveDirConfig(docPath), dirKey, value);
                        try {
                            fs.writeFileSync(sidecar, JSON.stringify(nextCfg, null, 2) + '\n', 'utf-8');
                        } catch (e) {
                            vscode.window.showWarningMessage(`Failed to write ${sidecar}: ${e}`);
                            break;
                        }
                    } else {
                        // デフォルトに戻す → .fractal.json の該当キーを削除（両キー空なら file 削除）
                        const sidecar = sidecarPathForMd(docPath);
                        const existing = readSaveDirConfig(docPath);
                        if (existing) {
                            const { config: nextCfg, empty } = withoutSaveDir(existing, dirKey);
                            try {
                                if (empty) {
                                    if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
                                } else {
                                    fs.writeFileSync(sidecar, JSON.stringify(nextCfg, null, 2) + '\n', 'utf-8');
                                }
                            } catch (e) {
                                vscode.window.showWarningMessage(`Failed to update ${sidecar}: ${e}`);
                                break;
                            }
                        }
                    }
                    // 表示更新
                    if (kind === 'image') { sendImageDirStatus(); } else { sendFileDirStatus(); }
                    break;
                }

                // FR-EX-01/03: md export bundle。standalone md は document.uri が root
                // （sidepanel から開いた場合は message.sidePanelFilePath 優先）。
                case 'exportBundle': {
                    const rootMd = message.sidePanelFilePath || document.uri.fsPath;
                    if (rootMd && message.options) {
                        await runExportBundle(rootMd, message.options);
                    }
                    break;
                }

                case 'editingStateChanged':
                    isActivelyEditing = message.editing;
                    break;

                case 'webviewFocus':
                    webviewHasFocus = true;
                    break;

                case 'webviewBlur':
                    webviewHasFocus = false;
                    isActivelyEditing = false;
                    break;

                case 'insertImage': {
                    const imgDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const imgDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleImageInsert(imgDocUri, imgDocContent, webviewPanel.webview, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'saveImageAndInsert': {
                    // Save pasted/dropped image to file
                    const saveDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const saveDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    // FR: sidepanel が実際にこの md を開いている（watchedPath 一致）ときだけ sidepanel 宛に載せる
                    const saveImgSp = sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined;
                    await this.handleSaveImage(saveDocUri, saveDocContent, webviewPanel.webview, message.dataUrl, message.fileName, saveImgSp);
                    break;
                }

                case 'readAndInsertImage': {
                    // Read an existing image file and insert it
                    const readDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const readDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleReadAndInsertImage(readDocUri, readDocContent, webviewPanel.webview, message.filePath, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'saveFileAndInsert': {
                    // Save pasted/dropped file
                    const saveDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const saveDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleSaveFile(saveDocUri, saveDocContent, webviewPanel.webview, message.dataUrl, message.fileName, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'readAndInsertFile': {
                    // Read an existing file and insert it
                    const readDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const readDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleReadAndInsertFile(readDocUri, readDocContent, webviewPanel.webview, message.filePath, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'saveDrawioAndInsert': {
                    // MD-45: drawio.svg / drawio.png D&D (Files 経路) — fileDir に dataUrl デコード保存
                    const drawDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const drawDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleSaveDrawio(drawDocUri, drawDocContent, webviewPanel.webview, message.dataUrl, message.fileName, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'readAndInsertDrawio': {
                    // MD-45: drawio.svg / drawio.png D&D (URI 経路) — fileDir にコピー
                    const drawDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const drawDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleReadAndInsertDrawio(drawDocUri, drawDocContent, webviewPanel.webview, message.filePath, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'notifyUnsupportedDrawioXml': {
                    // MD-46: .drawio (XML) D&D 棄却ダイアログ
                    const droppedPath: string = message.droppedPath || '';
                    const fileNameForXml: string = message.fileName || (droppedPath ? path.basename(droppedPath) : '');
                    const noticeMsg = t('unsupportedDrawioXmlNotice');
                    const openBtn = t('openInDrawioDesktopButton');
                    // 第二引数は modal なし、ボタンを並べる
                    const action = await vscode.window.showWarningMessage(noticeMsg, openBtn);
                    if (action === openBtn && droppedPath) {
                        try {
                            await vscode.env.openExternal(vscode.Uri.file(droppedPath));
                        } catch (err) {
                            console.error('[Any MD] Failed to open drawio file externally:', err);
                        }
                    }
                    // ファイルコピー / insertText は一切行わない（仕様）
                    void fileNameForXml; // 未使用警告抑止
                    break;
                }

                case 'requestCreateDrawio': {
                    // MD-47: Cmd+/ → Insert Drawio Diagram → InputBox → fileDir/<name>.drawio.svg 生成 + 挿入
                    const drawDocUri = this.resolveImageDocumentUri(message.sidePanelFilePath, sidePanel.watchedPath, document);
                    const drawDocContent = await this.resolveImageDocumentContent(message.sidePanelFilePath, sidePanel.watchedPath, sidePanel.document, document);
                    await this.handleRequestCreateDrawio(drawDocUri, drawDocContent, webviewPanel.webview, sidePanel.watchedPath === message.sidePanelFilePath ? message.sidePanelFilePath : undefined);
                    break;
                }

                case 'insertLink':
                    const url = await vscode.window.showInputBox({
                        prompt: t('enterUrl'),
                        placeHolder: 'https://example.com'
                    });
                    if (url) {
                        const linkText = message.text || await vscode.window.showInputBox({
                            prompt: t('enterLinkText'),
                            placeHolder: 'Link text',
                            value: 'link'
                        }) || 'link';
                        webviewPanel.webview.postMessage({
                            type: 'insertLinkHtml',
                            url: url,
                            text: linkText
                        });
                    }
                    break;

                case 'openLink':
                case 'openLinkInTab': {
                    const linkHref: string = message.href;
                    // v0.207.23+: openLink / openLinkInTab どちらも tab 固定 (sidePanel 経路撤廃)
                    if (linkHref.startsWith('fractal://')) {
                        vscode.commands.executeCommand('fractal.navigateInAppLink', linkHref);
                    } else if (linkHref.startsWith('http')) {
                        vscode.env.openExternal(vscode.Uri.parse(linkHref));
                    } else if (linkHref.startsWith('#')) {
                        webviewPanel.webview.postMessage({
                            type: 'scrollToAnchor',
                            anchor: linkHref.substring(1)
                        });
                    } else {
                        const resolvedUri = linkHref.startsWith('/')
                            ? vscode.Uri.file(linkHref)
                            : vscode.Uri.joinPath(document.uri, '..', linkHref);
                        const resolvedPath = resolvedUri.fsPath.toLowerCase();
                        if (resolvedPath.endsWith('.md') || resolvedPath.endsWith('.markdown')) {
                            // v0.207.23+: 常に新タブで standalone customEditor として開く (fractal.linkOpenMode 設定撤廃済)。
                            // 旧 sidePanel オプションは sidepanel が peek 用途として頻度低く、混乱の元になるため tab 固定化。
                            vscode.commands.executeCommand('vscode.openWith', resolvedUri, 'fractal.editor');
                        } else {
                            // Non-MD local file - open with OS default application
                            vscode.env.openExternal(resolvedUri);
                        }
                    }
                    break;
                }

                case 'requestOutline':
                    const outline = this.generateOutline(document.getText());
                    webviewPanel.webview.postMessage({
                        type: 'outline',
                        data: outline
                    });
                    break;

                case 'requestWordCount':
                    const stats = this.calculateWordCount(document.getText());
                    webviewPanel.webview.postMessage({
                        type: 'wordCount',
                        data: stats
                    });
                    break;

                case 'error':
                    vscode.window.showErrorMessage(`Fractal: ${message.message}`);
                    break;

                case 'openInTextEditor':
                    // Open the same file in VS Code's default text editor
                    await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default');
                    break;

                case 'copyFilePath':
                    await vscode.env.clipboard.writeText(document.uri.fsPath);
                    break;

                case 'copyImageToClipboard':
                    await copyImageToClipboard(message.absPath);
                    break;

                case 'openImageInNewTab':
                    await openImageInNewTab(message.absPath);
                    break;

                case 'openDrawioExternal': {
                    const { openDrawioExternal } = await import('./shared/drawio-external');
                    await openDrawioExternal(message.absPath);
                    break;
                }

                case 'saveSidePanelFile':
                    await sidePanel.handleSave(message.filePath, message.content);
                    break;

                case 'sidePanelClosed':
                    sidePanel.handleClose();
                    break;

                case 'sidePanelNavigateBack':
                    await sidePanel.navigateBack(message.sidePanelFilePath || '');
                    break;

                case 'sidePanelNavigateForward':
                    await sidePanel.navigateForward(message.sidePanelFilePath || '');
                    break;

                case 'sidePanelOpenLink':
                    await sidePanel.handleOpenLink(message.href, message.sidePanelFilePath);
                    break;

                case 'sidePanelOpenInTextEditor':
                    if (message.sidePanelFilePath) {
                        const spTextUri = vscode.Uri.file(message.sidePanelFilePath);
                        await vscode.commands.executeCommand('vscode.openWith', spTextUri, 'default');
                    }
                    break;

                case 'sendToChat':
                    // Open text editor with selection based on line numbers from webview
                    try {
                        const chatStartLine = message.startLine as number;
                        const chatEndLine = message.endLine as number;
                        if (chatStartLine == null || chatEndLine == null) break;

                        const chatSidePanelFilePath = message.sidePanelFilePath as string | undefined;
                        if (chatSidePanelFilePath) {
                            // サイドパネル → 共通ハンドラ
                            await sidePanel.handleSendToChat(chatSidePanelFilePath, chatStartLine, chatEndLine, message.selectedMarkdown || '');
                        } else {
                            // スタンドアロン → 既存ロジック（document.uri を使用）
                            const textDoc = await vscode.workspace.openTextDocument(document.uri);
                            const textEditor = await vscode.window.showTextDocument(textDoc, { preview: false });

                            const maxLine = textDoc.lineCount - 1;
                            const startLine = Math.max(0, Math.min(chatStartLine, maxLine));
                            const endLine = Math.max(startLine, Math.min(chatEndLine, maxLine));

                            const startPos = new vscode.Position(startLine, 0);
                            const endPos = textDoc.lineAt(endLine).range.end;
                            textEditor.selection = new vscode.Selection(startPos, endPos);
                            textEditor.revealRange(new vscode.Range(startPos, endPos), vscode.TextEditorRevealType.InCenter);

                            const selectedMd = message.selectedMarkdown as string;
                            if (selectedMd) {
                                await vscode.env.clipboard.writeText(selectedMd);
                            }
                        }
                    } catch (err) {
                        console.error('[Any MD] sendToChat error:', err);
                    }
                    break;

                // REMOVED: 'setImageDir' handler (per-file directive feature removed)

                // REMOVED: 'setFileDir' handler (per-file directive feature removed)

                case 'getSidePanelImageDir': {
                    if (message.sidePanelFilePath) {
                        sendSidePanelImageDirStatus(message.sidePanelFilePath);
                        // v9: Send absolute paths for MD paste asset copy
                        const spUri = vscode.Uri.file(message.sidePanelFilePath);
                        let spContent = '';
                        if (sidePanel.document && !sidePanel.document.isClosed) {
                            spContent = sidePanel.document.getText();
                        } else {
                            try { spContent = fs.readFileSync(message.sidePanelFilePath, 'utf-8'); } catch { /* empty */ }
                        }
                        const absImageDir = imageDirectoryManager.getImageDirectory(spUri, spContent);
                        const absFileDir = fileDirectoryManager.getFileDirectory(spUri, spContent);
                        const spDir = path.dirname(message.sidePanelFilePath);
                        webviewPanel.webview.postMessage({
                            type: 'sidePanelAssetContext',
                            imageDir: absImageDir,
                            fileDir: absFileDir,
                            mdDir: spDir
                        });
                    }
                    break;
                }

                // REMOVED: 'getImageDir' handler (per-file directive feature removed)

                case 'pasteWithAssetCopy': {
                    // v9: MD paste with asset copy (cross-file paste)
                    if (message.sidePanelFilePath && message.markdown && message.sourceContext) {
                        const spUri = vscode.Uri.file(message.sidePanelFilePath);
                        let spContent = '';
                        if (sidePanel.document && !sidePanel.document.isClosed) {
                            spContent = sidePanel.document.getText();
                        } else {
                            try { spContent = fs.readFileSync(message.sidePanelFilePath, 'utf-8'); } catch { /* empty */ }
                        }
                        const destImageDir = imageDirectoryManager.getImageDirectory(spUri, spContent);
                        const destFileDir = fileDirectoryManager.getFileDirectory(spUri, spContent);
                        const destMdDir = path.dirname(message.sidePanelFilePath);

                        const result = copyMdPasteAssets({
                            markdown: message.markdown,
                            sourceMdDir: message.sourceContext.mdDir,
                            sourceImageDir: message.sourceContext.imageDir,
                            sourceFileDir: message.sourceContext.fileDir,
                            destImageDir,
                            destFileDir,
                            destMdDir
                        });

                        webviewPanel.webview.postMessage({
                            type: 'pasteWithAssetCopyResult',
                            markdown: result.rewrittenMarkdown
                        });
                    }
                    break;
                }

                case 'extractDataUrlsInPastedMd': {
                    // HTML paste で生まれた data:image/... を <imageDir>/<ts>.<ext> に保存し相対 path 化
                    console.log('[extractDataUrlsInPastedMd] received, sidePanelFilePath=', message.sidePanelFilePath, 'mdLength=', message.markdown?.length);
                    if (!message.markdown) {
                        console.error('[extractDataUrlsInPastedMd] empty markdown, skipping');
                        webviewPanel.webview.postMessage({
                            type: 'extractDataUrlsInPastedMdResult',
                            markdown: '',
                            savedCount: 0,
                            error: 'empty markdown'
                        });
                        break;
                    }
                    try {
                        // eslint-disable-next-line @typescript-eslint/no-var-requires
                        const { processDataUrlsInContent } = require('./shared/data-url-image-extractor');
                        const targetPath = message.sidePanelFilePath || document.uri.fsPath;
                        const targetUri = vscode.Uri.file(targetPath);
                        let targetContent = '';
                        if (message.sidePanelFilePath && sidePanel.document && !sidePanel.document.isClosed) {
                            targetContent = sidePanel.document.getText();
                        } else if (!message.sidePanelFilePath) {
                            targetContent = document.getText();
                        } else {
                            try { targetContent = fs.readFileSync(targetPath, 'utf-8'); } catch { /* empty */ }
                        }
                        const imageDir = imageDirectoryManager.getImageDirectory(targetUri, targetContent);
                        const mdFileDir = path.dirname(targetPath);
                        console.log('[extractDataUrlsInPastedMd] imageDir=', imageDir, 'mdFileDir=', mdFileDir);
                        const { newContent, savedCount } = processDataUrlsInContent(message.markdown, imageDir, mdFileDir);
                        console.log('[extractDataUrlsInPastedMd] saved', savedCount, 'images, returning newMd length=', newContent.length);
                        webviewPanel.webview.postMessage({
                            type: 'extractDataUrlsInPastedMdResult',
                            markdown: newContent,
                            savedCount
                        });
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.stack || err.message : String(err);
                        console.error('[extractDataUrlsInPastedMd] failed:', errMsg);
                        // fallback: 元の MD をそのまま返す (data URL は残るが paste は完了)
                        webviewPanel.webview.postMessage({
                            type: 'extractDataUrlsInPastedMdResult',
                            markdown: message.markdown,
                            savedCount: 0,
                            error: errMsg
                        });
                    }
                    break;
                }

                case 'searchFiles': {
                    const query: string = message.query || '';
                    if (query.length < 1) {
                        webviewPanel.webview.postMessage({
                            type: 'fileSearchResults',
                            results: [],
                            query: query
                        });
                        break;
                    }
                    const docDir = path.dirname(document.uri.fsPath);
                    const wsFolder = vscode.workspace.getWorkspaceFolder(document.uri);
                    const searchBase = wsFolder ? wsFolder.uri : vscode.Uri.file(docDir);
                    try {
                        const files = await vscode.workspace.findFiles(
                            new vscode.RelativePattern(searchBase, '**/*.md'),
                            '**/node_modules/**',
                            50
                        );
                        const relativePaths = files
                            .map(f => path.relative(docDir, f.fsPath))
                            .filter(p => p.toLowerCase().includes(query.toLowerCase()))
                            .sort((a, b) => a.length - b.length)
                            .slice(0, 10);
                        webviewPanel.webview.postMessage({
                            type: 'fileSearchResults',
                            results: relativePaths,
                            query: query
                        });
                    } catch {
                        webviewPanel.webview.postMessage({
                            type: 'fileSearchResults',
                            results: [],
                            query: query
                        });
                    }
                    break;
                }

                case 'createPageAtPath': {
                    const relativePath: string = message.relativePath || '';
                    if (!relativePath) break;
                    const docDir2 = path.dirname(document.uri.fsPath);
                    let targetPath = relativePath;
                    if (!targetPath.endsWith('.md')) {
                        targetPath += '.md';
                    }
                    const absPath = path.resolve(docDir2, targetPath);
                    try {
                        // Create intermediate directories
                        const targetDir = path.dirname(absPath);
                        if (!fs.existsSync(targetDir)) {
                            fs.mkdirSync(targetDir, { recursive: true });
                        }
                        // Only create if not exists
                        if (!fs.existsSync(absPath)) {
                            fs.writeFileSync(absPath, '', 'utf8');
                        }
                        webviewPanel.webview.postMessage({
                            type: 'pageCreatedAtPath',
                            relativePath: path.relative(docDir2, absPath)
                        });
                    } catch (e: any) {
                        vscode.window.showErrorMessage(`Failed to create page: ${e.message}`);
                    }
                    break;
                }

                case 'createPageAuto': {
                    const docDir3 = path.dirname(document.uri.fsPath);
                    // outliner page MD なら outliner の pageDir 直下、それ以外は md と同階層（フラット）。
                    // notes-flat-storage (2026-07-07): standalone md の Add Page も pages/ サブフォルダを作らず
                    // <docDir> 直下に置く（md 本文リンクは ./<file>.md）。
                    const pagesDir = (isOutlinerPage && outlinerPageDir)
                        ? outlinerPageDir
                        : docDir3;
                    if (!fs.existsSync(pagesDir)) {
                        fs.mkdirSync(pagesDir, { recursive: true });
                    }
                    const fileName = generateUniqueFileName(pagesDir, 'md');
                    const absPath2 = path.join(pagesDir, fileName);
                    // 初期 content "# " — render 後 H1 になり即タイトル入力可
                    fs.writeFileSync(absPath2, '# ', 'utf8');
                    const relPath = path.relative(docDir3, absPath2).replace(/\\/g, '/');
                    webviewPanel.webview.postMessage({
                        type: 'pageCreatedAtPath',
                        relativePath: relPath
                    });
                    break;
                }

                case 'createPageAutoForSidePanel': {
                    // v15+: side panel の cmd+/ Add Page (simple flow)
                    // sidePanel が outliner page を開いている場合は outliner の pageDir 直下、
                    // それ以外は side panel file と同階層（フラット、pages/ を作らない）
                    const sidePanelFilePath: string = message.sidePanelFilePath || '';
                    if (!sidePanelFilePath) break;
                    const spDir = path.dirname(sidePanelFilePath);
                    // side panel が outliner page MD かどうか判定
                    const spIsOutlinerPage = OutlinerProvider.outlinerPagePaths.has(sidePanelFilePath);
                    const spOutlinerPageDir = OutlinerProvider.outlinerPagePaths.get(sidePanelFilePath);
                    // notes-flat-storage (2026-07-07): outliner page なら pageDir 直下、
                    // それ以外（standalone md の side panel）は md と同階層（フラット、pages/ を作らない）。
                    const pagesDir = (spIsOutlinerPage && spOutlinerPageDir)
                        ? spOutlinerPageDir
                        : spDir;
                    if (!fs.existsSync(pagesDir)) {
                        fs.mkdirSync(pagesDir, { recursive: true });
                    }
                    const fileName = generateUniqueFileName(pagesDir, 'md');
                    const absPath = path.join(pagesDir, fileName);
                    fs.writeFileSync(absPath, '# ', 'utf8');
                    // side panel から見た相対 path
                    const relPath = path.relative(spDir, absPath).replace(/\\/g, '/');
                    // sidePanelMessage envelope で side panel EditorInstance に届ける
                    webviewPanel.webview.postMessage({
                        type: 'sidePanelMessage',
                        data: { type: 'pageCreatedAtPath', relativePath: relPath }
                    });
                    break;
                }

                case 'updatePageH1': {
                    const h1RelPath: string = message.relativePath || '';
                    const h1Text: string = message.h1Text || '';
                    if (!h1RelPath || !h1Text) break;
                    const docDir4 = path.dirname(document.uri.fsPath);
                    const h1AbsPath = path.resolve(docDir4, h1RelPath);
                    try {
                        if (fs.existsSync(h1AbsPath)) {
                            fs.writeFileSync(h1AbsPath, `# ${h1Text}\n`, 'utf8');
                        }
                    } catch (e: any) {
                        // Silent fail — file may have been deleted
                    }
                    break;
                }

                case 'translateContent': {
                    const config = vscode.workspace.getConfiguration('fractal');
                    const accessKeyId = config.get<string>('transAccessKeyId', '');
                    const secretAccessKey = config.get<string>('transSecretAccessKey', '');
                    const region = config.get<string>('transRegion', 'us-east-1');
                    const terminologyName = (config.get<string>('translateTerminologyName', '') || '').trim();
                    if (!accessKeyId || !secretAccessKey) {
                        webviewPanel.webview.postMessage({
                            type: 'translateError',
                            message: 'AWS credentials not configured. Set fractal.transAccessKeyId and transSecretAccessKey in settings.'
                        });
                        break;
                    }
                    try {
                        const result = await translateText({
                            text: message.markdown,
                            sourceLang: message.sourceLang,
                            targetLang: message.targetLang,
                            accessKeyId,
                            secretAccessKey,
                            region,
                            terminologyName: terminologyName || undefined,
                        });
                        webviewPanel.webview.postMessage({
                            type: 'translateResult',
                            translatedMarkdown: result.translatedText,
                            sourceLang: result.sourceLang,
                            targetLang: result.targetLang
                        });
                    } catch (err: any) {
                        const errMsg = err?.message || String(err);
                        console.error('[Translate] Error:', errMsg, err?.stack || '');
                        vscode.window.showErrorMessage(`Translate failed: ${errMsg}`);
                        webviewPanel.webview.postMessage({
                            type: 'translateError',
                            message: errMsg
                        });
                    }
                    break;
                }

                case 'translateSelectLang': {
                    const sourcePick = await vscode.window.showQuickPick(
                        TRANSLATE_LANGUAGES.map(l => ({ label: l.label, description: l.code })),
                        { placeHolder: 'Source language' }
                    );
                    if (!sourcePick) break;
                    const targetPick = await vscode.window.showQuickPick(
                        TRANSLATE_LANGUAGES.map(l => ({ label: l.label, description: l.code })),
                        { placeHolder: 'Target language' }
                    );
                    if (!targetPick) break;
                    webviewPanel.webview.postMessage({
                        type: 'translateLangSelected',
                        sourceLang: sourcePick.description,
                        targetLang: targetPick.description
                    });
                    break;
                }

                case 'saveTranslateLangs': {
                    // v0.207.24: popup の select で選んだ言語を settings に永続化
                    try {
                        await vscode.workspace.getConfiguration('fractal').update('translateSourceLang', message.sourceLang, vscode.ConfigurationTarget.Global);
                        await vscode.workspace.getConfiguration('fractal').update('translateTargetLang', message.targetLang, vscode.ConfigurationTarget.Global);
                    } catch (err: any) {
                        console.error('[Translate] saveTranslateLangs error:', err);
                    }
                    break;
                }
            }
        });

        // Track active webview panel for undo/redo command forwarding
        if (webviewPanel.active) {
            this.activeWebviewPanel = webviewPanel;
        }
        webviewPanel.onDidChangeViewState(() => {
            if (webviewPanel.active) {
                this.activeWebviewPanel = webviewPanel;
            } else if (this.activeWebviewPanel === webviewPanel) {
                this.activeWebviewPanel = undefined;
            }
        });

        webviewPanel.onDidDispose(() => {
            if (this.activeWebviewPanel === webviewPanel) {
                this.activeWebviewPanel = undefined;
            }
            // outlinerページ追跡をクリーンアップ
            OutlinerProvider.outlinerPagePaths.delete(document.uri.fsPath);
            changeDocumentSubscription.dispose();
            changeConfigSubscription.dispose();
            fileChangeSubscription.dispose();
            fileWatcher.dispose();
            sidePanel.disposeFileWatcher();
            // MD-48: drawio watcher dispose
            drawioWatcher.disposeAll();
        });
    }

    /**
     * Resolve the document URI to use for image operations.
     * If sidePanelFilePath is provided, use it; otherwise use the main document.
     */
    private resolveImageDocumentUri(
        sidePanelFilePath: string | undefined,
        sidePanelWatchedPath: string | undefined,
        document: vscode.TextDocument
    ): vscode.Uri {
        if (sidePanelFilePath && sidePanelWatchedPath === sidePanelFilePath) {
            return vscode.Uri.file(sidePanelFilePath);
        }
        return document.uri;
    }

    /**
     * Resolve the document content to use for image operations (IMAGE_DIR directive lookup).
     * Prefers the in-memory TextDocument buffer if available.
     */
    private async resolveImageDocumentContent(
        sidePanelFilePath: string | undefined,
        sidePanelWatchedPath: string | undefined,
        sidePanelDocument: vscode.TextDocument | undefined,
        document: vscode.TextDocument
    ): Promise<string> {
        if (sidePanelFilePath && sidePanelWatchedPath === sidePanelFilePath) {
            // Prefer sidePanelDocument buffer if available
            if (sidePanelDocument && !sidePanelDocument.isClosed) {
                return sidePanelDocument.getText();
            }
            // Fallback: read from disk
            const fs = require('fs');
            try {
                return fs.readFileSync(sidePanelFilePath, 'utf-8');
            } catch {
                return '';
            }
        }
        return document.getText();
    }

    private async handleImageInsert(documentUri: vscode.Uri, documentContent: string, webview: vscode.Webview, spFilePath?: string) {
        const path = require('path');
        const fs = require('fs');

        const options: vscode.OpenDialogOptions = {
            canSelectMany: false,
            openLabel: t('selectImage'),
            filters: {
                'Images': ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg']
            },
            // Default to current document's directory
            defaultUri: vscode.Uri.file(path.dirname(documentUri.fsPath))
        };

        const fileUri = await vscode.window.showOpenDialog(options);

        if (fileUri && fileUri[0]) {
            const sourcePath = fileUri[0].fsPath;

            // Get the image directory from settings/directive
            const imageDir = imageDirectoryManager.getImageDirectory(documentUri, documentContent);

            try {
            // Ensure the directory exists
            ensureDirectoryExists(imageDir);

            // Always generate unique filename using timestamp format
            const ext = path.extname(sourcePath).slice(1) || 'png'; // Remove leading dot
            const fileName = generateUniqueFileName(imageDir, ext);
            const destPath = path.join(imageDir, fileName);
                // Copy the image with new name
                fs.copyFileSync(sourcePath, destPath);

                // Get webview URI for display
                const webviewUri = webview.asWebviewUri(vscode.Uri.file(destPath)).toString();

                // Generate path for Markdown (absolute if configured with absolute path)
                const useAbsolute = imageDirectoryManager.shouldUseAbsolutePath(documentUri);
                const forceRelative = imageDirectoryManager.shouldForceRelativePath(documentUri, documentContent);
                const markdownPath = toMarkdownPath(destPath, documentUri.fsPath, useAbsolute, forceRelative);

                // Generate data URL for side panel (can't access vscode-resource URIs)
                const imgBuffer = fs.readFileSync(destPath);
                const imgExt = path.extname(destPath).slice(1) || 'png';
                const mimeType = imgExt === 'jpg' ? 'image/jpeg' : `image/${imgExt}`;
                const dataUrl = `data:${mimeType};base64,${imgBuffer.toString('base64')}`;

                webview.postMessage({
                    type: 'insertImageHtml',
                    markdownPath: markdownPath,
                    displayUri: webviewUri,
                    dataUri: dataUrl,
                    sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
                });
            } catch (error) {
                console.error('Failed to copy image:', error);
                vscode.window.showErrorMessage(`${t('failedToCopyImage')}${error}`);
            }
        }
    }

    private async handleSaveImage(documentUri: vscode.Uri, documentContent: string, webview: vscode.Webview, dataUrl: string, fileName?: string, spFilePath?: string) {
        const path = require('path');
        const fs = require('fs');

        // Get the image directory from settings/directive
        const imageDir = imageDirectoryManager.getImageDirectory(documentUri, documentContent);

        try {
        // Ensure the directory exists
        ensureDirectoryExists(imageDir);

        // Always generate unique filename using timestamp format
        // svg+xml / apng / 全 MIME 対応 (parseDataUrl で統一)
        const parsed = parseDataUrl(dataUrl);
        if (!parsed) {
            vscode.window.showErrorMessage(`${t('failedToSaveImage')}invalid data URL format`);
            return;
        }
        const extension = parsed.ext;
        const imageName = generateUniqueFileName(imageDir, extension);
        const imagePath = path.join(imageDir, imageName);
        const imageBuffer = parsed.buffer;
            // Write the file
            fs.writeFileSync(imagePath, imageBuffer);
            console.log('[DEBUG] Image saved to:', imagePath);

            // Get webview URI for display
            const webviewUri = webview.asWebviewUri(vscode.Uri.file(imagePath)).toString();

            // Generate path for Markdown (absolute if configured with absolute path)
            const useAbsolute = imageDirectoryManager.shouldUseAbsolutePath(documentUri);
            const forceRelative = imageDirectoryManager.shouldForceRelativePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(imagePath, documentUri.fsPath, useAbsolute, forceRelative);

            // Send to webview (include dataUri for side panel)
            webview.postMessage({
                type: 'insertImageHtml',
                markdownPath: markdownPath,
                displayUri: webviewUri,
                dataUri: dataUrl,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel（sidepanel が watchedPath 一致のときのみ dispatch が渡す）
            });
        } catch (error) {
            console.error('[DEBUG] Failed to save image:', error);
            vscode.window.showErrorMessage(`${t('failedToSaveImage')}${error}`);
        }
    }

    private getImageExtension(dataUrl: string): string {
        // svg+xml / apng 等の `+` `.` を含む MIME も拾う
        const match = dataUrl.match(/^data:image\/([a-zA-Z0-9+\-.]+)[;,]/);
        return match ? mimeToExt(match[1]) : 'png';
    }

    private async handleReadAndInsertImage(documentUri: vscode.Uri, documentContent: string, webview: vscode.Webview, filePath: string, spFilePath?: string) {
        const path = require('path');
        const fs = require('fs');

        try {
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage(`${t('imageFileNotFound')}${filePath}`);
                return;
            }

            // Get the image directory from settings/directive
            const imageDir = imageDirectoryManager.getImageDirectory(documentUri, documentContent);

            // Ensure the directory exists
            ensureDirectoryExists(imageDir);

            // Always generate unique filename using timestamp format
            const ext = path.extname(filePath).slice(1) || 'png'; // Remove leading dot
            const fileName = generateUniqueFileName(imageDir, ext);
            const destPath = path.join(imageDir, fileName);

            // Copy the file with new name
            fs.copyFileSync(filePath, destPath);

            // Get webview URI for display
            const webviewUri = webview.asWebviewUri(vscode.Uri.file(destPath)).toString();

            // Generate path for Markdown (absolute if configured with absolute path)
            const useAbsolute = imageDirectoryManager.shouldUseAbsolutePath(documentUri);
            const forceRelative = imageDirectoryManager.shouldForceRelativePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(destPath, documentUri.fsPath, useAbsolute, forceRelative);

            // Generate data URL for side panel (can't access vscode-resource URIs)
            const imgBuffer = fs.readFileSync(destPath);
            const imgExt = path.extname(destPath).slice(1) || 'png';
            const mimeType = imgExt === 'jpg' ? 'image/jpeg' : `image/${imgExt}`;
            const dataUrl = `data:${mimeType};base64,${imgBuffer.toString('base64')}`;

            // Send to webview
            webview.postMessage({
                type: 'insertImageHtml',
                markdownPath: markdownPath,
                displayUri: webviewUri,
                dataUri: dataUrl,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
            });
        } catch (error) {
            console.error('Failed to read/copy image:', error);
            vscode.window.showErrorMessage(`${t('failedToProcessImage')}${error}`);
        }
    }

    private async handleSaveFile(documentUri: vscode.Uri, documentContent: string, webview: vscode.Webview, dataUrl: string, fileName?: string, spFilePath?: string) {
        const path = require('path');
        const fs = require('fs');

        // Get the file directory from settings/directive
        const fileDir = fileDirectoryManager.getFileDirectory(documentUri, documentContent);

        try {
            // Ensure the directory exists
            ensureDirectoryExists(fileDir);

            // Generate unique filename preserving original name
            const fileNameToUse = fileName || 'file';
            const uniqueFileName = generateUniqueFileNamePreserving(fileDir, fileNameToUse);
            const filePath = path.join(fileDir, uniqueFileName);

            // Convert data URL to buffer
            const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
            const fileBuffer = Buffer.from(base64Data, 'base64');

            // Write the file
            fs.writeFileSync(filePath, fileBuffer);
            console.log('[DEBUG] File saved to:', filePath);

            // Generate path for Markdown
            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(documentUri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(filePath, documentUri.fsPath, useAbsolute, forceRelative);

            // Send to webview
            webview.postMessage({
                type: 'insertFileLink',
                markdownPath: markdownPath,
                fileName: uniqueFileName,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
            });
        } catch (error) {
            console.error('[DEBUG] Failed to save file:', error);
            vscode.window.showErrorMessage(`${t('failedToSaveFile')}${error}`);
        }
    }

    private async handleReadAndInsertFile(documentUri: vscode.Uri, documentContent: string, webview: vscode.Webview, filePath: string, spFilePath?: string) {
        const path = require('path');
        const fs = require('fs');

        try {
            // Check if file exists
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage(`${t('fileNotFound')}${filePath}`);
                return;
            }

            // Get the file directory from settings/directive
            const fileDir = fileDirectoryManager.getFileDirectory(documentUri, documentContent);

            // Ensure the directory exists
            ensureDirectoryExists(fileDir);

            // Generate unique filename preserving original name
            const originalFileName = path.basename(filePath);
            const uniqueFileName = generateUniqueFileNamePreserving(fileDir, originalFileName);
            const destPath = path.join(fileDir, uniqueFileName);

            // Copy the file with new name
            fs.copyFileSync(filePath, destPath);

            // Generate path for Markdown
            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(documentUri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(destPath, documentUri.fsPath, useAbsolute, forceRelative);

            // Send to webview
            webview.postMessage({
                type: 'insertFileLink',
                markdownPath: markdownPath,
                fileName: uniqueFileName,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
            });
        } catch (error) {
            console.error('Failed to read/copy file:', error);
            vscode.window.showErrorMessage(`${t('failedToProcessFile')}${error}`);
        }
    }

    /**
     * MD-45: drawio.svg / drawio.png をファイル保存先に保存（dataUrl デコード）し、
     * `![<base>](relative)` をエディタに insertText 指示する。
     */
    private async handleSaveDrawio(
        documentUri: vscode.Uri,
        documentContent: string,
        webview: vscode.Webview,
        dataUrl: string,
        fileName: string,
        spFilePath?: string
    ): Promise<void> {
        const path = require('path');
        const fs = require('fs');
        try {
            const fileDir = fileDirectoryManager.getFileDirectory(documentUri, documentContent);
            ensureDirectoryExists(fileDir);

            const safeName = fileName || 'diagram.drawio.svg';
            const uniqueName = generateUniqueDrawioFileName(fileDir, safeName);
            const destPath = path.join(fileDir, uniqueName);

            const base64Data = dataUrl.replace(/^data:[^;]+;base64,/, '');
            const buf = Buffer.from(base64Data, 'base64');
            fs.writeFileSync(destPath, buf);

            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(documentUri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(destPath, documentUri.fsPath, useAbsolute, forceRelative);
            const webviewUri = webview.asWebviewUri(vscode.Uri.file(destPath)).toString();

            // drawio は inline 画像表示のため insertImageHtml を流用（既存 webview 経路で <img> 挿入）
            webview.postMessage({
                type: 'insertImageHtml',
                markdownPath: markdownPath,
                displayUri: webviewUri,
                dataUri: dataUrl,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
            });
        } catch (err) {
            console.error('[Any MD] handleSaveDrawio error:', err);
            vscode.window.showErrorMessage(`${t('failedToSaveFile')}${err}`);
        }
    }

    /**
     * MD-45 (URI 経路): 既存 drawio.svg / drawio.png をファイル保存先にコピーし、
     * `![<base>](relative)` をエディタに insertText 指示する。
     */
    private async handleReadAndInsertDrawio(
        documentUri: vscode.Uri,
        documentContent: string,
        webview: vscode.Webview,
        filePath: string,
        spFilePath?: string
    ): Promise<void> {
        const path = require('path');
        const fs = require('fs');
        try {
            if (!fs.existsSync(filePath)) {
                vscode.window.showErrorMessage(`${t('fileNotFound')}: ${filePath}`);
                return;
            }
            const fileDir = fileDirectoryManager.getFileDirectory(documentUri, documentContent);
            ensureDirectoryExists(fileDir);

            const originalName = path.basename(filePath);
            const uniqueName = generateUniqueDrawioFileName(fileDir, originalName);
            const destPath = path.join(fileDir, uniqueName);
            fs.copyFileSync(filePath, destPath);

            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(documentUri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(destPath, documentUri.fsPath, useAbsolute, forceRelative);
            const webviewUri = webview.asWebviewUri(vscode.Uri.file(destPath)).toString();

            webview.postMessage({
                type: 'insertImageHtml',
                markdownPath: markdownPath,
                displayUri: webviewUri,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
            });
        } catch (err) {
            console.error('[Any MD] handleReadAndInsertDrawio error:', err);
            vscode.window.showErrorMessage(`${t('failedToProcessFile')}${err}`);
        }
    }

    /**
     * MD-47: Cmd+/ → Insert Drawio Diagram。
     * v15+ で InputBox 廃止 → fileDir/diagram.drawio.svg を自動命名で生成 (衝突時 diagram-1, diagram-2 ...) → ![]() を挿入。
     */
    private async handleRequestCreateDrawio(
        documentUri: vscode.Uri,
        documentContent: string,
        webview: vscode.Webview,
        spFilePath?: string
    ): Promise<void> {
        const path = require('path');
        const fs = require('fs');
        try {
            const fileDir = fileDirectoryManager.getFileDirectory(documentUri, documentContent);
            ensureDirectoryExists(fileDir);

            // 自動命名: diagram.drawio.svg が無ければそのまま、あれば diagram-1.drawio.svg ...
            const uniqueName = generateUniqueDrawioFileName(fileDir, 'diagram.drawio.svg');
            const destPath = path.join(fileDir, uniqueName);
            fs.writeFileSync(destPath, buildPlaceholderDrawioSvg(), 'utf8');

            const useAbsolute = fileDirectoryManager.shouldUseAbsoluteFilePath(documentUri);
            const forceRelative = fileDirectoryManager.shouldForceRelativeFilePath(documentUri, documentContent);
            const markdownPath = toMarkdownPath(destPath, documentUri.fsPath, useAbsolute, forceRelative);
            const webviewUri = webview.asWebviewUri(vscode.Uri.file(destPath)).toString();

            webview.postMessage({
                type: 'insertImageHtml',
                markdownPath: markdownPath,
                displayUri: webviewUri,
                sidePanelFilePath: spFilePath // FR: 宛先=sidepanel
            });
        } catch (err) {
            console.error('[Any MD] handleRequestCreateDrawio error:', err);
            vscode.window.showErrorMessage(`${t('failedToSaveFile')}${err}`);
        }
    }

    private generateOutline(content: string): Array<{ level: number; text: string; line: number }> {
        const lines = content.split('\n');
        const outline: Array<{ level: number; text: string; line: number }> = [];

        lines.forEach((line, index) => {
            const match = line.match(/^(#{1,6})\s+(.+)$/);
            if (match) {
                outline.push({
                    level: match[1].length,
                    text: match[2].trim(),
                    line: index
                });
            }
        });

        return outline;
    }

    private calculateWordCount(content: string): { words: number; characters: number; lines: number; readingTime: string } {
        const lines = content.split('\n').length;
        const characters = content.length;
        const words = content.trim().split(/\s+/).filter(word => word.length > 0).length;
        const readingMinutes = Math.ceil(words / 200);
        const readingTime = readingMinutes < 1 ? 'Less than 1 min' : `${readingMinutes} min read`;

        return { words, characters, lines, readingTime };
    }
}
