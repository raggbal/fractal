/**
 * cleanup-core.ts
 *
 * Core cleanup logic without VSCode dependencies (for unit testing)
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMarkdownImagePaths } from './markdown-image-utils';
import { safeResolveUnderDir } from './path-safety';

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
): Promise<{ liveMd: Set<string>; liveImages: Set<string> }> {
    const liveMd = new Set<string>();
    const liveImages = new Set<string>();

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

                // node.images[] (resolve relative to pageDir for backward compat, or outDir)
                if (Array.isArray(node.images)) {
                    for (const imgRel of node.images) {
                        // Try pageDirAbs first (most common case for images/*)
                        let safeAbs = safeResolveUnderDir(pageDirAbs, imgRel);
                        if (!safeAbs) {
                            // Fallback: try outDir (for absolute or different base)
                            safeAbs = safeResolveUnderDir(outDir, imgRel);
                        }
                        if (safeAbs) { liveImages.add(safeAbs); }
                    }
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

    return { liveMd, liveImages };
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
