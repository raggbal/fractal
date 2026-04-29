/**
 * cleanup-core.ts
 *
 * Core cleanup logic without VSCode dependencies (for unit testing)
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMarkdownImagePaths } from './markdown-image-utils';
import { safeResolveUnderDir } from './path-safety';
const { extractMarkdownFileLinks } = require('./markdown-link-parser');

export async function listOutFiles(mainFolderPath: string): Promise<string[]> {
    if (!fs.existsSync(mainFolderPath)) { return []; }
    const entries = fs.readdirSync(mainFolderPath, { withFileTypes: true });
    return entries
        .filter(e => e.isFile() && e.name.endsWith('.out'))
        .map(e => path.join(mainFolderPath, e.name));
}

export async function listAllMd(mainFolderPath: string): Promise<string[]> {
    return walkRecursive(mainFolderPath, ['.md']);
}

export async function listAllImages(mainFolderPath: string): Promise<string[]> {
    return walkRecursive(mainFolderPath, ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
}

export async function listAllFiles(mainFolderPath: string): Promise<string[]> {
    // Walk files/ directories and return ALL files (any extension)
    const result: string[] = [];
    if (!fs.existsSync(mainFolderPath)) { return result; }

    // Find all "files" directories recursively
    const filesDir = path.join(mainFolderPath, 'files');
    if (fs.existsSync(filesDir)) {
        walkFilesDir(filesDir, result);
    }

    // Also scan {id}/files/ directories for notes mode
    const entries = fs.readdirSync(mainFolderPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const noteFilesDir = path.join(mainFolderPath, entry.name, 'files');
            if (fs.existsSync(noteFilesDir)) {
                walkFilesDir(noteFilesDir, result);
            }
        }
    }

    return result;
}

function walkFilesDir(dir: string, result: string[]): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFilesDir(fullPath, result);
        } else if (entry.isFile()) {
            result.push(fullPath);
        }
    }
}

export function walkRecursive(dir: string, extensions: string[]): string[] {
    const result: string[] = [];
    if (!fs.existsSync(dir)) { return result; }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...walkRecursive(fullPath, extensions));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (extensions.includes(ext)) {
                result.push(fullPath);
            }
        }
    }
    return result;
}

export async function buildLiveSetPass1(
    outFiles: string[],
    mainFolderPath: string
): Promise<{ liveMd: Set<string>; liveImages: Set<string>; liveFiles: Set<string> }> {
    const liveMd = new Set<string>();
    const liveImages = new Set<string>();
    const liveFiles = new Set<string>();

    for (const outPath of outFiles) {
        try {
            const content = fs.readFileSync(outPath, 'utf8');
            const data = JSON.parse(content);
            const nodes = data.nodes || {};
            const outDir = path.dirname(outPath);

            // pageDir を解決
            let pageDirAbs = outDir;
            if (data.pageDir) {
                pageDirAbs = path.isAbsolute(data.pageDir)
                    ? data.pageDir
                    : path.resolve(outDir, data.pageDir);
            }

            for (const nodeId of Object.keys(nodes)) {
                const node = nodes[nodeId];

                // node.images[] は path.relative(outDir, destPath) で保存されているため outDir 基準で resolve
                // 参考: notesEditorProvider.ts:298, outlinerProvider.ts:516 の saveOutlinerImage ハンドラ
                // 注意: safeResolveUnderDir は存在チェックしないため、必ず outDir 基準のみ使う。
                // pageDir 基準を最初に試すと {id}/images/... を {mainFolderPath}/{id}/{id}/images/... と誤 resolve する
                if (Array.isArray(node.images)) {
                    for (const imgRel of node.images) {
                        const safeAbs = safeResolveUnderDir(outDir, imgRel);
                        if (safeAbs) { liveImages.add(safeAbs); }
                    }
                }

                // node.filePath → file attachment (v8)
                if (node.filePath) {
                    const safeAbs = safeResolveUnderDir(outDir, node.filePath);
                    if (safeAbs) { liveFiles.add(safeAbs); }
                }

                // node.pageId → .md
                if (node.pageId) {
                    const mdPath = path.join(pageDirAbs, `${node.pageId}.md`);
                    liveMd.add(mdPath);
                }
            }
        } catch (e) {
            console.warn('[Fractal] Failed to parse .out for cleanup:', outPath, e);
        }
    }

    return { liveMd, liveImages, liveFiles };
}

export async function buildPass2LiveImages(
    liveMdPass1: Set<string>,
    liveImagesPass1: Set<string>,
    mainFolderPath: string
): Promise<Set<string>> {
    const liveImages = new Set(liveImagesPass1);
    const allMd = await listAllMd(mainFolderPath);
    const aliveMd = allMd.filter(p => liveMdPass1.has(p));

    for (const mdPath of aliveMd) {
        try {
            const content = fs.readFileSync(mdPath, 'utf8');
            const imagePaths = extractMarkdownImagePaths(content);
            const mdDir = path.dirname(mdPath);
            for (const rel of imagePaths) {
                const safeAbs = safeResolveUnderDir(mdDir, rel);
                if (safeAbs) { liveImages.add(safeAbs); }
            }
        } catch (e) {
            console.warn('[Fractal] Failed to read md for cleanup:', mdPath, e);
        }
    }

    return liveImages;
}

export async function buildPass2LiveFiles(
    liveMdPass1: Set<string>,
    liveFilesPass1: Set<string>,
    mainFolderPath: string
): Promise<Set<string>> {
    const liveFiles = new Set(liveFilesPass1);
    const allMd = await listAllMd(mainFolderPath);
    const aliveMd = allMd.filter(p => liveMdPass1.has(p));

    for (const mdPath of aliveMd) {
        try {
            const content = fs.readFileSync(mdPath, 'utf8');
            const filePaths = extractMarkdownFileLinks(content);
            const mdDir = path.dirname(mdPath);
            for (const rel of filePaths) {
                const safeAbs = safeResolveUnderDir(mdDir, rel);
                if (safeAbs) { liveFiles.add(safeAbs); }
            }

            // NT-17 配慮（MD-45 連動）: drawio.svg / drawio.png は ![]() 構文だが
            // fileDir 配下に保存される（OL-19B file 経路）。`extractMarkdownFileLinks`
            // は 📎 alt-text しか拾わないため、ここで ![](*.drawio.svg / *.drawio.png) を
            // 別途追加して orphan-file 誤判定を防ぐ。
            const imagePaths = extractMarkdownImagePaths(content);
            for (const rel of imagePaths) {
                const lower = rel.toLowerCase();
                if (lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png')) {
                    const safeAbs = safeResolveUnderDir(mdDir, rel);
                    if (safeAbs) { liveFiles.add(safeAbs); }
                }
            }
        } catch (e) {
            console.warn('[Fractal] Failed to read md for cleanup:', mdPath, e);
        }
    }

    return liveFiles;
}

/**
 * CleanupCandidate — vscode 依存なしの候補型
 */
export interface CleanupCandidateCore {
    absPath: string;
    relPath: string;
    type: 'orphan-md' | 'orphan-image' | 'orphan-file';
    sizeBytes: number;
}

/**
 * 1 note の orphan 候補を返す (vscode 依存なし、unit テスト対象)
 */
export async function scanSingleNoteCore(mainFolderPath: string): Promise<CleanupCandidateCore[]> {
    const outFiles = await listOutFiles(mainFolderPath);
    const { liveMd, liveImages: initialLiveImages, liveFiles: initialLiveFiles } = await buildLiveSetPass1(outFiles, mainFolderPath);

    const liveImages = await buildPass2LiveImages(liveMd, initialLiveImages, mainFolderPath);
    const liveFiles = await buildPass2LiveFiles(liveMd, initialLiveFiles, mainFolderPath);

    const allMd = await listAllMd(mainFolderPath);
    const orphanMd = allMd.filter(p => !liveMd.has(p));

    const allImages = await listAllImages(mainFolderPath);
    const orphanImages = allImages.filter(p => !liveImages.has(p));

    const allFiles = await listAllFiles(mainFolderPath);
    const orphanFiles = allFiles.filter(p => !liveFiles.has(p));

    const result: CleanupCandidateCore[] = [];
    for (const p of orphanMd) {
        try {
            result.push({
                absPath: p,
                relPath: path.relative(mainFolderPath, p),
                type: 'orphan-md',
                sizeBytes: fs.statSync(p).size
            });
        } catch { /* skip */ }
    }
    for (const p of orphanImages) {
        try {
            result.push({
                absPath: p,
                relPath: path.relative(mainFolderPath, p),
                type: 'orphan-image',
                sizeBytes: fs.statSync(p).size
            });
        } catch { /* skip */ }
    }
    for (const p of orphanFiles) {
        try {
            result.push({
                absPath: p,
                relPath: path.relative(mainFolderPath, p),
                type: 'orphan-file',
                sizeBytes: fs.statSync(p).size
            });
        } catch { /* skip */ }
    }
    return result;
}

/**
 * 複数 note を順にスキャンして、note ごとに grouping した候補 Map を返す。
 * vscode 依存なし、unit テスト対象 (FR-7 全 note モードのコア)
 */
export async function buildAllNotesCleanupGrouped(
    mainFolderPaths: string[]
): Promise<Map<string, CleanupCandidateCore[]>> {
    const result = new Map<string, CleanupCandidateCore[]>();
    for (const mainFolderPath of mainFolderPaths) {
        try {
            const candidates = await scanSingleNoteCore(mainFolderPath);
            if (candidates.length > 0) {
                result.set(mainFolderPath, candidates);
            }
        } catch (e) {
            console.warn(`[Fractal] Failed to scan ${mainFolderPath}:`, e);
        }
    }
    return result;
}
