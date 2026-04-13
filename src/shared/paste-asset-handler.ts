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

/**
 * 新 filename で画像・ファイルを実体コピーし、.md 本文の参照も rewrite する。
 * cmd+c 経路。srcPagesDir === destPagesDir でも常に新 filename を発行する。
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
    ensureDir(opts.destPagesDir);
    const srcMdPath = path.join(opts.srcPagesDir, `${opts.sourcePageId}.md`);
    const destMdPath = path.join(opts.destPagesDir, `${opts.newPageId}.md`);

    let mdContent = '';
    if (fs.existsSync(srcMdPath)) {
        try { mdContent = fs.readFileSync(srcMdPath, 'utf8'); } catch { /* ignore */ }
    }

    // 全ての画像参照 basename を収集
    const bodyRefs = extractMarkdownImagePaths(mdContent);
    const allRefs = Array.from(new Set([...(opts.nodeImages || []), ...bodyRefs]));

    // rename map (basename → new basename) — 画像用
    const renameMap = new Map<string, string>();
    const prefix = `copy-${opts.newPageId}-`;
    for (const ref of allRefs) {
        const base = path.basename(ref);
        if (!renameMap.has(base)) renameMap.set(base, prefix + base);
    }

    // 画像ファイルを新 filename で実体コピー (dest/images/<newName> に固定配置)
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    if (allRefs.length > 0) ensureDir(destImagesDir);
    for (const ref of allRefs) {
        const base = path.basename(ref);
        const newBase = renameMap.get(base)!;
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, newBase);
        if (fs.existsSync(destImg)) continue;
        try { fs.copyFileSync(srcImg, destImg); } catch { /* ignore */ }
    }

    // .md 本文の画像参照を新 filename に rewrite
    let newMdContent = mdContent;
    for (const [oldBase, newBase] of renameMap.entries()) {
        newMdContent = newMdContent.replace(new RegExp(escapeRegExp(oldBase), 'g'), newBase);
    }

    // ファイルリンク [📎](files/...) の抽出・コピー・パス書き換え（画像とは別ループで処理）
    const fileRefs: string[] = parser.extractMarkdownFileLinks(mdContent);
    if (fileRefs.length > 0) {
        const destFilesDir = path.join(opts.destPagesDir, 'files');
        ensureDir(destFilesDir);
        for (const fileRef of fileRefs) {
            const srcFile = resolveSourceImage(fileRef, opts.srcOutDir, opts.srcPagesDir);
            if (!srcFile) continue;
            const originalName = path.basename(fileRef);
            // ファイルは元名保持 + collision suffix（画像の rename パターンとは異なる）
            const newName = generateUniqueFileNamePreserving(destFilesDir, originalName);
            const destFile = path.join(destFilesDir, newName);
            try { fs.copyFileSync(srcFile, destFile); } catch { /* ignore */ }
            // 名前が変わった場合のみ .md 内パスを書き換え
            if (newName !== originalName) {
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

    // 新 nodeImages を組み立て (dest out dir 相対 + 新 basename)
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
 * .md と画像・ファイルを src → dest にコピー (filename 不変、元ファイルは削除しない — cleanup が管理)。
 * srcPagesDir === destPagesDir の場合は no-op で元の nodeImages を返す。
 * cmd+x 経路。
 */
export function movePageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    pageId: string;
    nodeImages: string[];
}): PasteAssetResult {
    if (opts.srcPagesDir === opts.destPagesDir) {
        return { newNodeImages: opts.nodeImages || [] };
    }
    ensureDir(opts.destPagesDir);

    // .md コピー (元ファイルは削除しない — cleanup が管理)
    const srcMdPath = path.join(opts.srcPagesDir, `${opts.pageId}.md`);
    const destMdPath = path.join(opts.destPagesDir, `${opts.pageId}.md`);
    if (fs.existsSync(srcMdPath) && srcMdPath !== destMdPath) {
        try {
            fs.copyFileSync(srcMdPath, destMdPath);
        } catch { /* ignore */ }
    }

    // コピー先の .md を読んで body 画像参照を抽出
    let mdContent = '';
    if (fs.existsSync(destMdPath)) {
        try { mdContent = fs.readFileSync(destMdPath, 'utf8'); } catch { /* ignore */ }
    }
    const bodyRefs = extractMarkdownImagePaths(mdContent);
    const allRefs = Array.from(new Set([...(opts.nodeImages || []), ...bodyRefs]));

    // 画像コピー (同 basename、元ファイルは削除しない — cleanup が管理)
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    if (allRefs.length > 0) ensureDir(destImagesDir);
    for (const ref of allRefs) {
        const base = path.basename(ref);
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, base);
        if (srcImg === destImg) continue;
        try {
            if (!fs.existsSync(destImg)) fs.copyFileSync(srcImg, destImg);
        } catch { /* ignore */ }
    }

    // ファイルリンク [📎](files/...) のコピー (同名、パス書き換え不要)
    const fileRefs: string[] = parser.extractMarkdownFileLinks(mdContent);
    if (fileRefs.length > 0) {
        const destFilesDir = path.join(opts.destPagesDir, 'files');
        ensureDir(destFilesDir);
        for (const fileRef of fileRefs) {
            const srcFile = resolveSourceImage(fileRef, opts.srcOutDir, opts.srcPagesDir);
            if (!srcFile) continue;
            const base = path.basename(fileRef);
            const destFile = path.join(destFilesDir, base);
            if (srcFile === destFile) continue;
            try {
                if (!fs.existsSync(destFile)) fs.copyFileSync(srcFile, destFile);
            } catch { /* ignore */ }
        }
    }

    // 新 nodeImages: dest out dir 相対 + 同 basename
    const destImagesRelToOut = path
        .relative(opts.destOutDir, destImagesDir)
        .replace(/\\/g, '/');
    const newNodeImages = (opts.nodeImages || []).map(orig => {
        const base = path.basename(orig);
        return destImagesRelToOut ? `${destImagesRelToOut}/${base}` : base;
    });
    return { newNodeImages };
}

/**
 * 非 isPage ノードの images[] を新 filename で実体コピー。
 * srcPagesDir === destPagesDir でも常に新 filename を発行する。
 */
export function copyImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    newNodeId: string;
    nodeImages: string[];
}): PasteAssetResult {
    const images = opts.nodeImages || [];
    if (images.length === 0) return { newNodeImages: [] };
    ensureDir(opts.destPagesDir);
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    ensureDir(destImagesDir);

    const renameMap = new Map<string, string>();
    const prefix = `copy-${opts.newNodeId}-`;
    for (const ref of images) {
        const base = path.basename(ref);
        if (!renameMap.has(base)) renameMap.set(base, prefix + base);
    }

    for (const ref of images) {
        const base = path.basename(ref);
        const newBase = renameMap.get(base)!;
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, newBase);
        if (fs.existsSync(destImg)) continue;
        try { fs.copyFileSync(srcImg, destImg); } catch { /* ignore */ }
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
 * 非 isPage ノードの images[] を src → dest にコピー (filename 不変、元ファイルは削除しない — cleanup が管理)。
 * srcPagesDir === destPagesDir の場合は no-op。
 */
export function moveImageAssets(opts: {
    srcOutDir: string;
    srcPagesDir: string;
    destOutDir: string;
    destPagesDir: string;
    nodeImages: string[];
}): PasteAssetResult {
    const images = opts.nodeImages || [];
    if (images.length === 0) return { newNodeImages: [] };
    if (opts.srcPagesDir === opts.destPagesDir) {
        return { newNodeImages: images };
    }
    ensureDir(opts.destPagesDir);
    const destImagesDir = path.join(opts.destPagesDir, 'images');
    ensureDir(destImagesDir);

    for (const ref of images) {
        const base = path.basename(ref);
        const srcImg = resolveSourceImage(ref, opts.srcOutDir, opts.srcPagesDir);
        if (!srcImg) continue;
        const destImg = path.join(destImagesDir, base);
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
        return destImagesRelToOut ? `${destImagesRelToOut}/${base}` : base;
    });
    return { newNodeImages };
}

/**
 * filePath 付きノードを copy 時にファイルを新 filename で実体コピー。
 * 元の名前を保ちつつ collision suffix (-1, -2, etc.) を付与する。
 */
export function copyFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string; // relative from srcOutDir
}): { newFilePath: string | null } {
    ensureDir(opts.destFileDir);
    const srcFilePath = path.isAbsolute(opts.filePath)
        ? opts.filePath
        : path.resolve(opts.srcOutDir, opts.filePath);

    if (!fs.existsSync(srcFilePath)) {
        return { newFilePath: null };
    }

    const originalName = path.basename(srcFilePath);
    const uniqueName = generateUniqueFileNamePreserving(opts.destFileDir, originalName);
    const destFilePath = path.join(opts.destFileDir, uniqueName);

    try {
        fs.copyFileSync(srcFilePath, destFilePath);
    } catch {
        return { newFilePath: null };
    }

    const relPath = path.relative(opts.destOutDir, destFilePath).replace(/\\/g, '/');
    return { newFilePath: relPath };
}

/**
 * filePath 付きノードを cut+cross-file 時にファイルを src → dest にコピー (元ファイルは削除しない — cleanup が管理)。
 * 同 dir なら no-op (元の filePath を返す)。
 */
export function moveFileAsset(opts: {
    srcOutDir: string;
    srcFileDir: string;
    destOutDir: string;
    destFileDir: string;
    filePath: string;
}): { newFilePath: string | null } {
    if (opts.srcFileDir === opts.destFileDir) {
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
    const destFilePath = path.join(opts.destFileDir, originalName);

    if (srcFilePath === destFilePath) {
        return { newFilePath: opts.filePath };
    }

    try {
        if (!fs.existsSync(destFilePath)) {
            fs.copyFileSync(srcFilePath, destFilePath);
        }
        // 元ファイルは削除しない — cleanup が管理
    } catch {
        return { newFilePath: null };
    }

    const relPath = path.relative(opts.destOutDir, destFilePath).replace(/\\/g, '/');
    return { newFilePath: relPath };
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
