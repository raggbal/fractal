/**
 * drop-import.ts — D&D file import processing
 *
 * Processes dropped files by kind (md/image/file), delegating to
 * importMdFilesCore and importFilesCore for shared logic.
 * Images are processed inline (base64 decode + fs.writeFileSync).
 */

import * as fs from 'fs';
import * as path from 'path';
import { importFilesCore } from './file-import';
import { importMdFilesCore } from './markdown-import';

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
    if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext)) return 'image';
    return 'file';
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
            const dataUrl = imageItem.dataUrl;

            // Validate dataUrl format
            const match = dataUrl.match(/^data:image\/(\w+);base64,(.+)$/);
            if (!match) {
                throw new Error('Invalid dataUrl format');
            }

            const extRaw = match[1];
            const base64Data = match[2];
            const ext = extRaw.replace('jpeg', 'jpg');
            const fileName = `image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;

            // Ensure imageDir exists
            if (!fs.existsSync(ctx.imageDir)) {
                fs.mkdirSync(ctx.imageDir, { recursive: true });
            }

            const destPath = path.join(ctx.imageDir, fileName);
            fs.writeFileSync(destPath, Buffer.from(base64Data, 'base64'));

            const imagePath = path.relative(ctx.outDir, destPath).replace(/\\/g, '/');
            const displayUri = ctx.getDisplayUri ? ctx.getDisplayUri(destPath) : destPath;

            results[g.idx] = {
                kind: 'image',
                ok: true,
                imagePath,
                displayUri
            };
        } catch (err) {
            results[g.idx] = {
                kind: 'image',
                ok: false,
                name: g.item.name,
                error: String(err)
            };
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
