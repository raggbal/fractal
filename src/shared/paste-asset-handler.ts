/**
 * paste-asset-handler — page/images の copy/move 時のファイル操作を一元化
 *
 * - copyPageAssets: 新 filename で画像を実体コピー + .md 本文の参照を rewrite + .md 本体を保存
 * - movePageAssets: 画像と .md を src → dest に物理移動 (同一 dir なら no-op)
 * - copyImageAssets / moveImageAssets: 非 isPage ノードの images[] 用
 *
 * すべて同期的なファイル操作。失敗時は個別にスキップ (try/catch)。
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMarkdownImagePaths } from './markdown-image-utils';

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
 * 新 filename で画像を実体コピーし、.md 本文の参照も rewrite する。
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

    // rename map (basename → new basename)
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
 * .md と画像を src → dest に物理移動 (filename 不変)。
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

    // .md 移動
    const srcMdPath = path.join(opts.srcPagesDir, `${opts.pageId}.md`);
    const destMdPath = path.join(opts.destPagesDir, `${opts.pageId}.md`);
    if (fs.existsSync(srcMdPath) && srcMdPath !== destMdPath) {
        try {
            fs.copyFileSync(srcMdPath, destMdPath);
            fs.unlinkSync(srcMdPath);
        } catch { /* ignore */ }
    }

    // 移動後の .md を読んで body 画像参照を抽出 (src に既にないので dest から読む)
    let mdContent = '';
    if (fs.existsSync(destMdPath)) {
        try { mdContent = fs.readFileSync(destMdPath, 'utf8'); } catch { /* ignore */ }
    }
    const bodyRefs = extractMarkdownImagePaths(mdContent);
    const allRefs = Array.from(new Set([...(opts.nodeImages || []), ...bodyRefs]));

    // 画像移動 (同 basename)
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
            fs.unlinkSync(srcImg);
        } catch { /* ignore */ }
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
 * 非 isPage ノードの images[] を src → dest に物理移動 (filename 不変)。
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
            fs.unlinkSync(srcImg);
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
