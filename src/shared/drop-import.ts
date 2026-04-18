/**
 * drop-import.ts — D&D file import processing
 *
 * Processes dropped files by kind (md/image/file), delegating to
 * importMdFilesCore and importFilesCore for shared logic.
 * Images are processed inline (base64 decode + fs.writeFileSync).
 *
 * v12 拡張: processDropVscodeUrisImport() for VSCode Explorer D&D
 * (application/vnd.code.uri-list type) — uses importFiles/importMdFiles
 * directly with file paths for full relative image resolution support.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { importFiles, importFilesCore } from './file-import';
import { importMdFiles, importMdFilesCore } from './markdown-import';

// ────────────────────────────────────────────
// Types
// ────────────────────────────────────────────

export type DropImportItem =
    | { kind: 'md'; name: string; content: string }
    | { kind: 'image'; name: string; dataUrl: string }
    | { kind: 'file'; name: string; bytes: Uint8Array };

export type DropImportResult =
    | { kind: 'md'; ok: true; title: string; pageId: string }
    | { kind: 'image'; ok: true; imagePath: string; displayUri: string }
    | { kind: 'file'; ok: true; title: string; filePath: string }
    | { kind: 'md' | 'image' | 'file'; ok: false; name: string; error: string };

export interface DropImportContext {
    fileDir: string;    // Target directory for file attachments
    pageDir: string;    // Target directory for page files
    imageDir: string;   // Target directory for images
    outDir: string;     // Base directory for relative paths
    getDisplayUri?: (filePath: string) => string;  // Optional: convert file path to webview URI
}

/** Image file extensions for classification */
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];

// ────────────────────────────────────────────
// Classification
// ────────────────────────────────────────────

/**
 * Classify a dropped file by extension.
 * Returns 'md' for .md files, 'image' for image files, 'file' for everything else.
 */
export function classifyDroppedFile(file: { name: string }): 'md' | 'image' | 'file' {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (ext === 'md') return 'md';
    if (IMAGE_EXTS.includes(ext)) return 'image';
    return 'file';
}

// ────────────────────────────────────────────
// Shared image-save helper (used by both Finder and Explorer paths)
// ────────────────────────────────────────────

/**
 * Save an image buffer to imageDir with a unique filename, returning
 * the relative path (from outDir) and optional display URI.
 */
export function saveImageBuffer(
    buffer: Buffer,
    extHint: string,  // e.g. 'png' (without dot). 'jpeg' is normalized to 'jpg'.
    ctx: { imageDir: string; outDir: string; getDisplayUri?: (p: string) => string }
): { imagePath: string; displayUri: string } {
    const ext = (extHint || 'png').replace('jpeg', 'jpg');
    const fileName = `image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    if (!fs.existsSync(ctx.imageDir)) {
        fs.mkdirSync(ctx.imageDir, { recursive: true });
    }
    const destPath = path.join(ctx.imageDir, fileName);
    fs.writeFileSync(destPath, buffer);
    const imagePath = path.relative(ctx.outDir, destPath).replace(/\\/g, '/');
    const displayUri = ctx.getDisplayUri ? ctx.getDisplayUri(destPath) : destPath;
    return { imagePath, displayUri };
}

/**
 * Parse a data URL (e.g. "data:image/png;base64,...") and save to imageDir.
 * Throws on invalid format.
 */
export function saveImageFromDataUrl(
    dataUrl: string,
    ctx: { imageDir: string; outDir: string; getDisplayUri?: (p: string) => string }
): { imagePath: string; displayUri: string } {
    const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
    if (!match) {
        throw new Error('Invalid dataUrl format');
    }
    const [, extRaw, base64Data] = match;
    return saveImageBuffer(Buffer.from(base64Data, 'base64'), extRaw, ctx);
}

// ────────────────────────────────────────────
// Main processing function
// ────────────────────────────────────────────

/**
 * Process dropped files import.
 * Groups items by kind, processes each group, and returns results in original order.
 *
 * @param items Array of drop import items with kind, name, and content/dataUrl/bytes
 * @param ctx   Context with directories for file placement
 * @returns Array of results maintaining original order
 */
export async function processDropFilesImport(
    items: DropImportItem[],
    ctx: DropImportContext
): Promise<DropImportResult[]> {
    // Group items by kind while preserving original indices
    interface IndexedItem { item: DropImportItem; idx: number }
    const groups: { md: IndexedItem[]; image: IndexedItem[]; file: IndexedItem[] } = {
        md: [],
        image: [],
        file: []
    };

    items.forEach((item, idx) => {
        groups[item.kind].push({ item, idx });
    });

    // Initialize results array
    const results: DropImportResult[] = new Array(items.length);

    // Process md group
    if (groups.md.length > 0) {
        try {
            const mdItems = groups.md.map(g => ({
                name: (g.item as { kind: 'md'; name: string; content: string }).name,
                content: (g.item as { kind: 'md'; name: string; content: string }).content,
                sourceDir: ''  // D&D has no sourceDir, skip relative image resolution
            }));
            const mdResults = importMdFilesCore(mdItems, ctx.pageDir, ctx.imageDir, { skipRelativeImages: true });
            mdResults.forEach((mr, i) => {
                results[groups.md[i].idx] = {
                    kind: 'md',
                    ok: true,
                    title: mr.title,
                    pageId: mr.pageId
                };
            });
        } catch (err) {
            groups.md.forEach(g => {
                results[g.idx] = {
                    kind: 'md',
                    ok: false,
                    name: g.item.name,
                    error: String(err)
                };
            });
        }
    }

    // Process image group (per-item try/catch for partial success)
    for (const g of groups.image) {
        try {
            const imageItem = g.item as { kind: 'image'; name: string; dataUrl: string };
            const { imagePath, displayUri } = saveImageFromDataUrl(imageItem.dataUrl, ctx);
            results[g.idx] = { kind: 'image', ok: true, imagePath, displayUri };
        } catch (err) {
            results[g.idx] = { kind: 'image', ok: false, name: g.item.name, error: String(err) };
        }
    }

    // Process file group
    if (groups.file.length > 0) {
        try {
            const fileItems = groups.file.map(g => {
                const fileItem = g.item as { kind: 'file'; name: string; bytes: Uint8Array };
                return {
                    name: fileItem.name,
                    buffer: Buffer.from(fileItem.bytes)
                };
            });
            const fileResults = importFilesCore(fileItems, ctx.fileDir, ctx.outDir);
            fileResults.forEach((fr, i) => {
                results[groups.file[i].idx] = {
                    kind: 'file',
                    ok: true,
                    title: fr.title,
                    filePath: fr.filePath
                };
            });
        } catch (err) {
            groups.file.forEach(g => {
                results[g.idx] = {
                    kind: 'file',
                    ok: false,
                    name: g.item.name,
                    error: String(err)
                };
            });
        }
    }

    return results;
}

// ────────────────────────────────────────────
// VSCode Explorer D&D (application/vnd.code.uri-list)
// ────────────────────────────────────────────

/**
 * Process dropped VSCode URIs (from VSCode Explorer).
 * Unlike processDropFilesImport, this uses existing importFiles/importMdFiles
 * directly with file paths, enabling full relative image resolution for .md files.
 *
 * Key differences from Finder path:
 * - No 50MB limit (no webview memory involved)
 * - .md files get full relative image resolution (sourceDir from fsPath)
 * - Non-file:// schemes are rejected with error
 *
 * @param uris   Array of file:// URIs from dataTransfer.getData('application/vnd.code.uri-list')
 * @param ctx    Context with directories for file placement
 * @returns Array of results maintaining original order
 */
export async function processDropVscodeUrisImport(
    uris: string[],
    ctx: DropImportContext
): Promise<DropImportResult[]> {
    // Parse URIs and classify by kind, preserving original indices
    interface ParsedUri {
        uri: string;
        fsPath: string;
        kind: 'md' | 'image' | 'file';
        idx: number;
    }

    const parsed: ParsedUri[] = [];
    const results: DropImportResult[] = new Array(uris.length);

    for (let i = 0; i < uris.length; i++) {
        const uri = uris[i];
        try {
            // Parse URI and validate scheme
            const parsedUrl = new URL(uri);

            if (parsedUrl.protocol !== 'file:') {
                // Non-local scheme (e.g., vscode-remote://)
                results[i] = {
                    kind: 'file',
                    ok: false,
                    name: uri,
                    error: `Unsupported URI scheme: ${parsedUrl.protocol} (only file:// is supported)`
                };
                continue;
            }

            // Convert to file system path
            const fsPath = url.fileURLToPath(uri);
            const name = path.basename(fsPath);
            const ext = path.extname(name).toLowerCase().slice(1);

            // Classify by extension
            let kind: 'md' | 'image' | 'file';
            if (ext === 'md') {
                kind = 'md';
            } else if (IMAGE_EXTS.includes(ext)) {
                kind = 'image';
            } else {
                kind = 'file';
            }

            parsed.push({ uri, fsPath, kind, idx: i });
        } catch (err) {
            results[i] = {
                kind: 'file',
                ok: false,
                name: uri,
                error: `Failed to parse URI: ${String(err)}`
            };
        }
    }

    // Group by kind
    const mdPaths: { fsPath: string; idx: number }[] = [];
    const imagePaths: { fsPath: string; name: string; idx: number }[] = [];
    const filePaths: { fsPath: string; idx: number }[] = [];

    for (const p of parsed) {
        if (p.kind === 'md') {
            mdPaths.push({ fsPath: p.fsPath, idx: p.idx });
        } else if (p.kind === 'image') {
            imagePaths.push({ fsPath: p.fsPath, name: path.basename(p.fsPath), idx: p.idx });
        } else {
            filePaths.push({ fsPath: p.fsPath, idx: p.idx });
        }
    }

    // Process .md files using existing importMdFiles (with full relative image resolution)
    if (mdPaths.length > 0) {
        try {
            const paths = mdPaths.map(p => p.fsPath);
            const mdResults = importMdFiles(paths, ctx.pageDir, ctx.imageDir);

            mdResults.forEach((mr, i) => {
                results[mdPaths[i].idx] = {
                    kind: 'md',
                    ok: true,
                    title: mr.title,
                    pageId: mr.pageId
                };
            });
        } catch (err) {
            mdPaths.forEach(p => {
                results[p.idx] = {
                    kind: 'md',
                    ok: false,
                    name: path.basename(p.fsPath),
                    error: String(err)
                };
            });
        }
    }

    // Process image files (read from disk, save to imageDir)
    for (const img of imagePaths) {
        try {
            if (!fs.existsSync(img.fsPath)) {
                throw new Error(`File not found: ${img.fsPath}`);
            }
            const buffer = fs.readFileSync(img.fsPath);
            const extHint = path.extname(img.name).toLowerCase().slice(1);
            const { imagePath, displayUri } = saveImageBuffer(buffer, extHint, ctx);
            results[img.idx] = { kind: 'image', ok: true, imagePath, displayUri };
        } catch (err) {
            results[img.idx] = { kind: 'image', ok: false, name: img.name, error: String(err) };
        }
    }

    // Process other files using existing importFiles
    if (filePaths.length > 0) {
        try {
            const paths = filePaths.map(p => p.fsPath);
            const fileResults = importFiles(paths, ctx.fileDir, ctx.outDir);

            fileResults.forEach((fr, i) => {
                results[filePaths[i].idx] = {
                    kind: 'file',
                    ok: true,
                    title: fr.title,
                    filePath: fr.filePath
                };
            });
        } catch (err) {
            filePaths.forEach(p => {
                results[p.idx] = {
                    kind: 'file',
                    ok: false,
                    name: path.basename(p.fsPath),
                    error: String(err)
                };
            });
        }
    }

    return results;
}

// ────────────────────────────────────────────
// Handler factory (reduces duplication in outlinerProvider / notesEditorProvider)
// ────────────────────────────────────────────

export interface DropImportHandlerDeps {
    resolveDirs: () => Omit<DropImportContext, 'getDisplayUri'>;
    postMessage: (msg: Record<string, unknown>) => void;
    getDisplayUri?: (filePath: string) => string;
    onFailed?: (names: string[]) => void;
}

/**
 * Create a drop-import handler that resolves directories, invokes the processor,
 * reports failures, and posts `dropFilesResult` back to the webview.
 *
 * Removes duplication across outlinerProvider.ts (standalone) and
 * notesEditorProvider.ts (Notes mode), and across Finder vs Explorer paths.
 */
export function createDropImportHandler<P>(
    processor: (payload: P, ctx: DropImportContext) => Promise<DropImportResult[]>,
    deps: DropImportHandlerDeps
): (payload: P, targetNodeId: string | null, position: string) => Promise<void> {
    return async (payload, targetNodeId, position) => {
        const ctx: DropImportContext = {
            ...deps.resolveDirs(),
            getDisplayUri: deps.getDisplayUri
        };
        const results = await processor(payload, ctx);
        const failed = results.filter(r => !r.ok) as Array<Extract<DropImportResult, { ok: false }>>;
        if (failed.length > 0 && deps.onFailed) {
            deps.onFailed(failed.map(f => f.name));
        }
        deps.postMessage({ type: 'dropFilesResult', results, targetNodeId, position });
    };
}
