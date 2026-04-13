/**
 * paste-asset-handler — page/images/files の copy/move 時のファイル操作を一元化
 *
 * - copyPageAssets: 新 filename で画像を実体コピー + .md 本文の参照を rewrite + .md 本体を保存
 * - movePageAssets: 画像と .md を src → dest にコピー (同一 dir なら no-op、元ファイルは削除しない — cleanup が管理)
 * - copyImageAssets / moveImageAssets: 非 isPage ノードの images[] 用 (move も元を削除しない)
 * - copyFileAsset / moveFileAsset: filePath 付きノードのファイル用 (original name 保持、move も元を削除しない)
 *
 * すべて同期的なファイル操作。失敗時は個別にスキップ (try/catch)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMarkdownImagePaths } from './markdown-image-utils';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser = require('./markdown-link-parser');

export interface PasteAssetResult {
    newNodeImages: string[];
}

function ensureDir(dir: string): void {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function resolveSourceImage(ref: string, srcOutDir: string, srcPagesDir: string): string | null {
    const candA = path.isAbsolute(ref) ? ref : path.resolve(srcOutDir, ref);
    if (fs.existsSync(candA)) return candA;
    const candB = path.resolve(srcPagesDir, ref);
    if (fs.existsSync(candB)) return candB;
    return null;
}

function escapeRegExp(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────────────────────────────────────────────────────
// Unified Functions (v9.1)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Unified page asset handler.
 * - newPageId=null: copy without rename (cut behavior)
 * - newPageId set: copy with rename prefix (copy behavior)
 * - sameDirSkip=true + same dir: no-op
 */
export function handlePageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    pageId: string;
    newPageId: string | null;
    nodeImages: string[];
    sameDirSkip?: boolean;
}): PasteAssetResult {
    // Same-dir check (only when sameDirSkip=true)
    if (opts.sameDirSkip && opts.srcPagesDir === opts.destPagesDir) {
        return { newNodeImages: opts.nodeImages || [] };
    }

    ensureDir(opts.destPagesDir);
    const isCut = opts.newPageId === null;
    const sourcePageId = opts.pageId;
    const targetPageId = isCut ? opts.pageId : opts.newPageId;

    const srcMdPath = path.join(opts.srcPagesDir, `${sourcePageId}.md`);
    const destMdPath = path.join(opts.destPagesDir, `${targetPageId}.md`);

    let mdContent = '';
    if (fs.existsSync(srcMdPath)) {
        try { mdContent = fs.readFileSync(srcMdPath, 'utf8'); } catch { /* ignore */ }
    }

    // Extract all image references
    const bodyRefs = extractMarkdownImagePaths(mdContent);
    const allRefs = Array.from(new Set([...(opts.nodeImages || []), ...bodyRefs]));

    // Build rename map (only for copy, not for cut)
    const renameMap = new Map<string, string>();
    if (!isCut) {
        const prefix = `copy-${targetPageId}-`;
        for (const ref of allRefs) {
            const base = path.basename(ref);
            if (!renameMap.has(base)) renameMap.set(base, prefix + base);
        }
    } else {
        for (const ref of allRefs) {
            const base = path.basename(ref);
            if (!renameMap.has(base)) renameMap.set(base, base);
        }
    }

    // Copy images
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    if (allRefs.length > 0) ensureDir(destImagesDir);
    for (const ref of allRefs) {
        const base = path.basename(ref);
        const newBase = renameMap.get(base)!;
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, newBase);
        if (srcImg === destImg) continue;
        try {
            if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
        } catch { /* ignore */ }
    }

    // Rewrite MD content (only for copy, not for cut)
    let newMdContent = mdContent;
    if (!isCut) {
        for (const [oldBase, newBase] of renameMap.entries()) {
            if (oldBase !== newBase) {
                newMdContent = newMdContent.replace(
                    new RegExp(escapeRegExp(oldBase), 'g'),
                    function() { return newBase; }
                );
            }
        }
    }

    // Handle file links
    const fileRefs: string[] = parser.extractMarkdownFileLinks(mdContent);
    if (fileRefs.length > 0) {
        const destFilesDir = path.join(opts.destPagesDir, 'files');
        ensureDir(destFilesDir);
        for (const fileRef of fileRefs) {
            const srcFile = resolveSourceImage(fileRef, opts.srcOutDir, opts.srcPagesDir);
            if (!srcFile) continue;
            const originalName = path.basename(fileRef);
            const newName = isCut ? originalName : generateUniqueFileNamePreserving(destFilesDir, originalName);
            const destFile = path.join(destFilesDir, newName);
            if (srcFile === destFile) continue;
            try {
                if (!fs.existsSync(destFile)) fs.copyFileSync(srcFile, destFile);
            } catch { /* ignore */ }
            // Rewrite MD content if name changed
            if (!isCut && newName !== originalName) {
                const oldRelPath = escapeRegExp(fileRef);
                const dirPart = fileRef.substring(0, fileRef.length - originalName.length);
                const newRelPath = dirPart + newName;
                newMdContent = newMdContent.replace(
                    new RegExp(oldRelPath, 'g'),
                    function() { return newRelPath; }
                );
            }
        }
    }

    try { fs.writeFileSync(destMdPath, newMdContent, 'utf8'); } catch { /* ignore */ }

    // Build newNodeImages
    const destImagesRelToOut = path
        .relative(opts.destOutDir, destImagesDir)
        .replace(/\\/g, '/');
    const newNodeImages = (opts.nodeImages || []).map(orig => {
        const base = path.basename(orig);
        const newBase = renameMap.get(base) || base;
        return destImagesRelToOut ? `${destImagesRelToOut}/${newBase}` : newBase;
    });

    return { newNodeImages };
}

/**
 * Unified image asset handler.
 * - renamePrefix=null: copy without rename (cut behavior)
 * - renamePrefix set: copy with prefix (copy behavior)
 * - sameDirSkip=true + same dir: no-op
 */
export function handleImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    renamePrefix: string | null;
    nodeImages: string[];
    sameDirSkip?: boolean;
}): PasteAssetResult {
    const images = opts.nodeImages || [];
    if (images.length === 0) return { newNodeImages: [] };

    // Same-dir check (only when sameDirSkip=true)
    if (opts.sameDirSkip && opts.srcPagesDir === opts.destPagesDir) {
        return { newNodeImages: images };
    }

    ensureDir(opts.destPagesDir);
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    ensureDir(destImagesDir);

    const isCut = opts.renamePrefix === null;
    const renameMap = new Map<string, string>();

    if (!isCut) {
        for (const ref of images) {
            const base = path.basename(ref);
            if (!renameMap.has(base)) renameMap.set(base, opts.renamePrefix + base);
        }
    } else {
        for (const ref of images) {
            const base = path.basename(ref);
            if (!renameMap.has(base)) renameMap.set(base, base);
        }
    }

    // Copy images
    for (const ref of images) {
        const base = path.basename(ref);
        const newBase = renameMap.get(base)!;
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, newBase);
        if (srcImg === destImg) continue;
        try {
            if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
        } catch { /* ignore */ }
    }

    const destImagesRelToOut = path
        .relative(opts.destOutDir, destImagesDir)
        .replace(/\\/g, '/');
    const newNodeImages = images.map(orig => {
        const base = path.basename(orig);
        const newBase = renameMap.get(base) || base;
        return destImagesRelToOut ? `${destImagesRelToOut}/${newBase}` : newBase;
    });

    return { newNodeImages };
}

/**
 * Unified file asset handler.
 * - useCollisionSuffix=true: add collision suffix (copy behavior)
 * - useCollisionSuffix=false: use original name (cut behavior)
 * - sameDirSkip=true + same dir: no-op
 */
export function handleFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string;
    useCollisionSuffix?: boolean;
    sameDirSkip?: boolean;
}): { newFilePath: string | null } {
    // Same-dir check (only when sameDirSkip=true)
    if (opts.sameDirSkip && opts.srcFileDir === opts.destFileDir) {
        return { newFilePath: opts.filePath };
    }

    ensureDir(opts.destFileDir);

    const srcFilePath = path.isAbsolute(opts.filePath)
        ? opts.filePath
        : path.resolve(opts.srcOutDir, opts.filePath);

    if (!fs.existsSync(srcFilePath)) {
        return { newFilePath: null };
    }

    const originalName = path.basename(srcFilePath);
    const uniqueName = opts.useCollisionSuffix
        ? generateUniqueFileNamePreserving(opts.destFileDir, originalName)
        : originalName;
    const destFilePath = path.join(opts.destFileDir, uniqueName);

    if (srcFilePath === destFilePath) {
        return { newFilePath: opts.filePath };
    }

    try {
        if (!fs.existsSync(destFilePath) || opts.useCollisionSuffix) {
            fs.copyFileSync(srcFilePath, destFilePath);
        }
    } catch {
        return { newFilePath: null };
    }

    const relPath = path.relative(opts.destOutDir, destFilePath).replace(/\\/g, '/');
    return { newFilePath: relPath };
}

// ────────────────────────────────────────────────────────────────────────────
// Legacy Functions (backward compatibility wrappers)
// ────────────────────────────────────────────────────────────────────────────

/**
 * 新 filename で画像・ファイルを実体コピーし、.md 本文の参照も rewrite する。
 * cmd+c 経路。srcPagesDir === destPagesDir でも常に新 filename を発行する。
 * @deprecated Use handlePageAssets with newPageId set
 */
export function copyPageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    sourcePageId: string;
    newPageId: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handlePageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        pageId: opts.sourcePageId,
        newPageId: opts.newPageId,
        nodeImages: opts.nodeImages,
        sameDirSkip: false
    });
}

/**
 * .md と画像・ファイルを src → dest にコピー (filename 不変、元ファイルは削除しない — cleanup が管理)。
 * srcPagesDir === destPagesDir の場合は no-op で元の nodeImages を返す。
 * cmd+x 経路。
 * @deprecated Use handlePageAssets with newPageId=null and sameDirSkip=true
 */
export function movePageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    pageId: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handlePageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        pageId: opts.pageId,
        newPageId: null,
        nodeImages: opts.nodeImages,
        sameDirSkip: true
    });
}

/**
 * 非 isPage ノードの images[] を新 filename で実体コピー。
 * srcPagesDir === destPagesDir でも常に新 filename を発行する。
 * @deprecated Use handleImageAssets with renamePrefix set
 */
export function copyImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    newNodeId: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handleImageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        renamePrefix: `copy-${opts.newNodeId}-`,
        nodeImages: opts.nodeImages,
        sameDirSkip: false
    });
}

/**
 * 非 isPage ノードの images[] を src → dest にコピー (filename 不変、元ファイルは削除しない — cleanup が管理)。
 * srcPagesDir === destPagesDir の場合は no-op。
 * @deprecated Use handleImageAssets with renamePrefix=null and sameDirSkip=true
 */
export function moveImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    nodeImages: string[];
}): PasteAssetResult {
    return handleImageAssets({
        srcOutDir: opts.srcOutDir,
        srcPagesDir: opts.srcPagesDir,
        destOutDir: opts.destOutDir,
        destPagesDir: opts.destPagesDir,
        renamePrefix: null,
        nodeImages: opts.nodeImages,
        sameDirSkip: true
    });
}

/**
 * filePath 付きノードを copy 時にファイルを新 filename で実体コピー。
 * 元の名前を保ちつつ collision suffix (-1, -2, etc.) を付与する。
 * @deprecated Use handleFileAsset with useCollisionSuffix=true
 */
export function copyFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string; // relative from srcOutDir
}): { newFilePath: string | null } {
    return handleFileAsset({
        srcOutDir: opts.srcOutDir,
        srcFileDir: opts.srcFileDir,
        destOutDir: opts.destOutDir,
        destFileDir: opts.destFileDir,
        filePath: opts.filePath,
        useCollisionSuffix: true,
        sameDirSkip: false
    });
}

/**
 * filePath 付きノードを cut+cross-file 時にファイルを src → dest にコピー (元ファイルは削除しない — cleanup が管理)。
 * 同 dir なら no-op (元の filePath を返す)。
 * @deprecated Use handleFileAsset with useCollisionSuffix=false and sameDirSkip=true
 */
export function moveFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string;
}): { newFilePath: string | null } {
    return handleFileAsset({
        srcOutDir: opts.srcOutDir,
        srcFileDir: opts.srcFileDir,
        destOutDir: opts.destOutDir,
        destFileDir: opts.destFileDir,
        filePath: opts.filePath,
        useCollisionSuffix: false,
        sameDirSkip: true
    });
}

/**
 * Generate unique filename preserving original name with collision suffix.
 * Examples: report.pdf, report-1.pdf, report-2.pdf
 */
export function generateUniqueFileNamePreserving(targetDir: string, originalName: string): string {
    const ext = path.extname(originalName);
    const baseName = path.basename(originalName, ext);

    let candidate = originalName;
    let suffix = 0;

    while (fs.existsSync(path.join(targetDir, candidate))) {
        suffix++;
        candidate = `${baseName}-${suffix}${ext}`;
    }

    return candidate;
}

/**
 * MD paste asset copy: extract image/file links from markdown, copy assets to dest, rewrite paths.
 * Used by MD editor copy/paste (side panel cross-outliner paste).
 */
export interface MdPasteAssetResult {
    rewrittenMarkdown: string;
}

export function copyMdPasteAssets(opts: {
    markdown: string;
    sourceMdDir: string;
    sourceImageDir: string;
    sourceFileDir: string;
    destImageDir: string;
    destFileDir: string;
    destMdDir: string;
}): MdPasteAssetResult {
    let rewrittenMarkdown = opts.markdown;

    // Extract image paths from markdown
    const imagePaths = parser.extractImagePaths(opts.markdown);

    // Extract file paths from markdown
    const filePaths = parser.extractMarkdownFileLinks(opts.markdown);

    // Ensure dest directories exist
    if (imagePaths.length > 0) {
        ensureDir(opts.destImageDir);
    }
    if (filePaths.length > 0) {
        ensureDir(opts.destFileDir);
    }

    // Copy images with rename pattern: copy-{timestamp}-{originalName}
    const timestamp = Date.now();
    const imageRenameMap = new Map<string, string>();

    for (const imagePath of imagePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, imagePath);
        if (!fs.existsSync(srcAbsolute)) {
            continue; // Skip missing files
        }

        const originalName = path.basename(imagePath);
        const newName = `copy-${timestamp}-${originalName}`;
        const destAbsolute = path.join(opts.destImageDir, newName);

        // Copy file
        try {
            if (!fs.existsSync(destAbsolute)) {
                fs.copyFileSync(srcAbsolute, destAbsolute);
            }
        } catch {
            continue; // Skip on error
        }

        // Calculate new relative path from destMdDir
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        imageRenameMap.set(imagePath, newRelativePath);
    }

    // Rewrite image paths in markdown
    for (const [oldPath, newPath] of imageRenameMap.entries()) {
        // Use function-based replace to avoid $ injection (patterns/work/string-replace-safety.md)
        const escapedOldPath = escapeRegExp(oldPath);
        rewrittenMarkdown = rewrittenMarkdown.replace(
            new RegExp(escapedOldPath, 'g'),
            function() { return newPath; }
        );
    }

    // Copy files with original name + collision suffix
    const fileRenameMap = new Map<string, string>();

    for (const filePath of filePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, filePath);
        if (!fs.existsSync(srcAbsolute)) {
            continue; // Skip missing files
        }

        const originalName = path.basename(filePath);
        const uniqueName = generateUniqueFileNamePreserving(opts.destFileDir, originalName);
        const destAbsolute = path.join(opts.destFileDir, uniqueName);

        // Copy file
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            continue; // Skip on error
        }

        // Calculate new relative path from destMdDir
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        fileRenameMap.set(filePath, newRelativePath);
    }

    // Rewrite file paths in markdown
    for (const [oldPath, newPath] of fileRenameMap.entries()) {
        const escapedOldPath = escapeRegExp(oldPath);
        rewrittenMarkdown = rewrittenMarkdown.replace(
            new RegExp(escapedOldPath, 'g'),
            function() { return newPath; }
        );
    }

    return { rewrittenMarkdown };
}
