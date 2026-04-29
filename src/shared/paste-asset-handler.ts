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
import { buildUniqueDrawioName } from './drawioTemplate';
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
            // TC-03: drawio.svg/png は多重拡張子 suffix 対応
            const lowerOrig = originalName.toLowerCase();
            const isMultiExt = lowerOrig.endsWith('.drawio.svg') || lowerOrig.endsWith('.drawio.png');
            let newName: string;
            if (isCut) {
                newName = originalName;
            } else if (isMultiExt) {
                newName = buildUniqueDrawioName(originalName, (n) =>
                    fs.existsSync(path.join(destFilesDir, n))
                );
            } else {
                newName = generateUniqueFileNamePreserving(destFilesDir, originalName);
            }
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

    // mdLinks: [text](*.md) 通常リンクを destPagesDir に複製
    // (page MD の中で別の .md を参照しているケース。`isCut` 時は名前変えずそのまま、copy 時は collision suffix)
    const pageRefs = extractAllAssetRefs(mdContent);
    for (const mdLinkRef of pageRefs.mdLinks) {
        const srcMdLink = resolveSourceImage(mdLinkRef, opts.srcOutDir, opts.srcPagesDir);
        if (!srcMdLink) continue;
        const originalName = path.basename(mdLinkRef);
        const newName = isCut
            ? originalName
            : generateUniqueFileNamePreserving(opts.destPagesDir, originalName);
        const destMdLink = path.join(opts.destPagesDir, newName);
        if (srcMdLink === destMdLink) continue;
        try {
            if (!fs.existsSync(destMdLink)) fs.copyFileSync(srcMdLink, destMdLink);
        } catch { /* ignore */ }
        if (!isCut && newName !== originalName) {
            const oldRelPath = escapeRegExp(mdLinkRef);
            const dirPart = mdLinkRef.substring(0, mdLinkRef.length - originalName.length);
            const newRelPath = dirPart + newName;
            newMdContent = newMdContent.replace(
                new RegExp(oldRelPath, 'g'),
                function() { return newRelPath; }
            );
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
    // TC-03 仕様準拠: 多重拡張子 (.drawio.svg / .drawio.png) は suffix を多重拡張子の前に付ける
    // (foo.drawio.svg → foo-1.drawio.svg、generateUniqueFileNamePreserving だと foo.drawio-1.svg になる)
    const lowerName = originalName.toLowerCase();
    const isMultiExt = lowerName.endsWith('.drawio.svg') || lowerName.endsWith('.drawio.png');
    let uniqueName: string;
    if (!opts.useCollisionSuffix) {
        uniqueName = originalName;
    } else if (isMultiExt) {
        uniqueName = buildUniqueDrawioName(originalName, (n) =>
            fs.existsSync(path.join(opts.destFileDir, n))
        );
    } else {
        uniqueName = generateUniqueFileNamePreserving(opts.destFileDir, originalName);
    }
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

/**
 * webview の resource URL 接頭辞を strip する。
 * cleanImageSrc が完全に剥がせなかったり、Turndown 経由の絶対 URL が
 * markdown に紛れた場合に「フルパス化」を防ぐため、複製前に正規化する。
 */
function stripWebviewUrlPrefixes(md: string): string {
    if (!md) return md;
    md = md.replace(/https:\/\/file\+\.vscode-resource\.vscode-cdn\.net/g, '');
    md = md.replace(/https:\/\/file%2B\.vscode-resource\.vscode-cdn\.net/g, '');
    md = md.replace(/vscode-resource:\/\//g, '');
    md = md.replace(/vscode-webview:\/\//g, '');
    return md;
}

/**
 * markdown から ![alt](url) / [📎...](url) / [text](*.md) を抽出する。
 * extractImagePaths と違い **絶対パス・http(s) URL も結果に含める** (copyMdPasteAssets が後段でコピー判断)。
 * - images: `![](url)`
 * - files:  `[📎 ...](url)` (添付ファイル指定)
 * - mdLinks: `[text](url)` で url が `.md` で終わるもの (📎 でも image でもない通常リンク)
 */
function extractAllAssetRefs(md: string): { images: string[]; files: string[]; mdLinks: string[] } {
    const images = new Set<string>();
    const files = new Set<string>();
    const mdLinks = new Set<string>();
    if (!md) return { images: [], files: [], mdLinks: [] };
    // images: ![alt](url)
    const imgRe = /!\[[^\]]*\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
    let m: RegExpExecArray | null;
    while ((m = imgRe.exec(md)) !== null) {
        const url = (m[1] || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) continue;
        if (/^(data:|https?:|file:)/i.test(url)) continue; // remote / data は除外
        images.add(url);
    }
    // files: [📎 ...](url)
    const fileRe = /\[📎[^\]]*\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
    while ((m = fileRe.exec(md)) !== null) {
        const url = (m[1] || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) continue;
        if (/^(data:|https?:|file:)/i.test(url)) continue;
        files.add(url);
    }
    // mdLinks: [text](url.md) - 画像 (`!` 始まり) と 📎 始まり以外
    // (^|[^!]) で `!` 直前を排除、 \[(?!📎) で 📎 始まりを排除
    const mdLinkRe = /(^|[^!])\[(?!📎)[^\]]+\]\(([^)\s"]+)(?:\s+"[^"]*")?\)/g;
    while ((m = mdLinkRe.exec(md)) !== null) {
        const url = (m[2] || '').trim().replace(/^<|>$/g, '').split(/[?#]/)[0];
        if (!url) continue;
        if (/^(data:|https?:|file:|fractal:)/i.test(url)) continue;
        if (url.startsWith('#')) continue; // anchor link
        if (!url.toLowerCase().endsWith('.md') && !url.toLowerCase().endsWith('.markdown')) continue;
        mdLinks.add(url);
    }
    return { images: Array.from(images), files: Array.from(files), mdLinks: Array.from(mdLinks) };
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
    // Step 1: webview URL 接頭辞を strip して、後段が絶対パスとして扱えるようにする
    let rewrittenMarkdown = stripWebviewUrlPrefixes(opts.markdown);

    // Step 2: ![]() / [📎]() を全件抽出 (絶対パスも含める。extractImagePaths は絶対パスをスキップするので使わない)
    const refs = extractAllAssetRefs(rewrittenMarkdown);

    // MD-41 拡張: drawio.svg / drawio.png は ![]() 構文だが file 系（destFileDir）へ振り分ける
    const isDrawioAsset = (p: string): boolean => {
        const lower = (p || '').toLowerCase();
        return lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png');
    };
    const imagePaths = refs.images.filter((p: string) => !isDrawioAsset(p));
    const drawioImagePaths = refs.images.filter((p: string) => isDrawioAsset(p));

    // Extract file paths from markdown (📎 attached files)
    const filePaths = refs.files;

    // Ensure dest directories exist
    if (imagePaths.length > 0) {
        ensureDir(opts.destImageDir);
    }
    if (filePaths.length > 0 || drawioImagePaths.length > 0) {
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

    // MD-41 拡張: drawio asset を destFileDir にコピー（imageDir には保存しない）
    // TC-03 / TC-15: 衝突 suffix は多重拡張子の前 (foo-1.drawio.svg) — buildUniqueDrawioName を使用
    for (const drawioPath of drawioImagePaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, drawioPath);
        if (!fs.existsSync(srcAbsolute)) continue;
        const originalName = path.basename(drawioPath);
        const uniqueName = buildUniqueDrawioName(originalName, (n) =>
            fs.existsSync(path.join(opts.destFileDir, n))
        );
        const destAbsolute = path.join(opts.destFileDir, uniqueName);
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            continue;
        }
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        imageRenameMap.set(drawioPath, newRelativePath);
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

    // mdLinks: [text](*.md) 通常リンク → dest の destMdDir に複製、相対パス書き換え
    // 「常に複製」要件: cmd+c/v は同 dir でも複製してコピー間で独立性を保つ
    const mdLinkPaths = refs.mdLinks;
    if (mdLinkPaths.length > 0) {
        ensureDir(opts.destMdDir);
    }
    const mdLinkRenameMap = new Map<string, string>();
    for (const mdLinkPath of mdLinkPaths) {
        const srcAbsolute = path.resolve(opts.sourceMdDir, mdLinkPath);
        if (!fs.existsSync(srcAbsolute)) continue;
        const originalName = path.basename(mdLinkPath);
        // 同じ pageDir 配下の page MD (UUID 名) と衝突しないよう、必ず unique suffix を付ける
        const uniqueName = generateUniqueFileNamePreserving(opts.destMdDir, originalName);
        const destAbsolute = path.join(opts.destMdDir, uniqueName);
        try {
            fs.copyFileSync(srcAbsolute, destAbsolute);
        } catch {
            continue;
        }
        const newRelativePath = path.relative(opts.destMdDir, destAbsolute).replace(/\\/g, '/');
        mdLinkRenameMap.set(mdLinkPath, newRelativePath);
    }
    for (const [oldPath, newPath] of mdLinkRenameMap.entries()) {
        const escapedOldPath = escapeRegExp(oldPath);
        rewrittenMarkdown = rewrittenMarkdown.replace(
            new RegExp(escapedOldPath, 'g'),
            function() { return newPath; }
        );
    }

    return { rewrittenMarkdown };
}
