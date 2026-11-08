/** Clip writer — 保存の書き込み（page md・.out・取込 md）。popup の保存と、service worker の quick clip（Alt+Shift+F）と、
 *  test/specs/clipper-compat.spec.ts が同じこの 1 つを使う（以前は popup.js と background.js に同じ手順が 2 つあった）。
 *
 *  使うのは FileSystemDirectoryHandle の getFileHandle / getDirectoryHandle と、file handle の getFile / createWritable だけ
 *  （DOM・chrome.* に依存しない）。保存先の決め方はフラット規約（ADRL-0018・flat-layout-mirror.js）。
 */
(function (global) {
    'use strict';

    const req = typeof require === 'function' ? require : null; // node（spec）だけ。拡張では lib を先に読み込む
    const Core = global.FractalClipperCore || (req && req('./clipper-core.js'));
    const Flat = global.FractalFlatLayout || (req && req('./flat-layout-mirror.js'));
    const Images = global.DataUrlImageExtractor || (req && req('./data-url-image-extractor.js').DataUrlImageExtractor);

    /** folder 内のサブパス（例: "sub/foo.out"）の file handle */
    async function getNestedFileHandle(rootHandle, relPath, opts) {
        const parts = relPath.split('/').filter((p) => p);
        let cur = rootHandle;
        for (let i = 0; i < parts.length - 1; i++) {
            cur = await cur.getDirectoryHandle(parts[i], { create: !!(opts && opts.createDirs) });
        }
        return cur.getFileHandle(parts[parts.length - 1], { create: !!(opts && opts.create) });
    }

    async function getNestedDirHandle(rootHandle, relDir) {
        let cur = rootHandle;
        for (const p of (relDir || '').split('/').filter((x) => x)) {
            cur = await cur.getDirectoryHandle(p, { create: true });
        }
        return cur;
    }

    async function readText(fileHandle) {
        return (await fileHandle.getFile()).text();
    }

    async function writeText(fileHandle, text) {
        const w = await fileHandle.createWritable();
        await w.write(text);
        await w.close();
    }

    /** page md（H1 + 元 URL 等 + 本文）。labels は呼び出し側の言語（core は i18n 非依存） */
    function buildPageMd(extracted, labels) {
        return Core.buildPageMd({
            title: extracted.title || '(untitled)',
            url: extracted.url,
            byline: extracted.byline,
            siteName: extracted.siteName,
            markdown: extracted.markdown,
            labels: labels
        });
    }

    /** md 内の data:image を画像 dir に実体化（失敗したら inline のまま） */
    async function extractImages(md, dirHandle, imagesSubdir, status) {
        try {
            const r = await Images.processDataUrlsInMd(md, dirHandle, imagesSubdir);
            if (r.savedCount > 0) status('popup_saving_images', { count: r.savedCount });
            return r.newMd;
        } catch (e) {
            console.warn('[clipper] data URL extract failed, fallback to inline', e);
            return md;
        }
    }

    /**
     * outliner（.out）への clip: page md を <pageDir>/<pageId>.md に書き、.out の先頭にページの node を足す。
     * opts: { labels, onStatus(key, params) }（onStatus は i18n の key を受ける。無くてよい）
     */
    async function clipToOutliner(folderHandle, outId, extracted, opts) {
        const o = opts || {};
        const status = o.onStatus || function () {};
        const title = extracted.title || '(untitled)';
        const pageMd = buildPageMd(extracted, o.labels);

        status('popup_loading_out');
        const outFileHandle = await getNestedFileHandle(folderHandle, outId + '.out');
        const outData = JSON.parse(await readText(outFileHandle));
        const result = Core.prependClipNode(outData, { title });

        // 保存先: 新フラットレイアウト前提（.out のヒントを尊重・無ければ note 直下）
        const hints = { pageDir: outData.pageDir, imageDir: outData.imageDir, fileDir: outData.fileDir };
        const writeDirRel = Flat.chooseWriteDirRel(hints, outId);
        const pageDirHandle = writeDirRel ? await getNestedDirHandle(folderHandle, writeDirRel) : folderHandle;

        status('popup_saving_page_md');
        const finalMd = await extractImages(pageMd, pageDirHandle, Flat.resolveImagesDirRel(hints), status);
        await writeText(await pageDirHandle.getFileHandle(result.pageId + '.md', { create: true }), finalMd);

        status('popup_writing_out');
        await writeText(outFileHandle, JSON.stringify(result.outData, null, 2));
        return { title: title, dest: outId + '.out', pageId: result.pageId, nodeId: result.nodeId, pageDirRel: writeDirRel };
    }

    /**
     * md への clip（FR-CL-05）: 新規 <uuid>.md を対象 md と同じ dir（フラット: note 直下）に書き、
     * 対象 md の末尾に subpage リンク [[タイトル]](<uuid>.md) を足す。画像は同じ dir の images/。
     */
    async function clipToMd(folderHandle, mdId, extracted, opts) {
        const o = opts || {};
        const status = o.onStatus || function () {};
        const title = extracted.title || '(untitled)';
        const pageMd = buildPageMd(extracted, o.labels);

        status('popup_loading_target_md');
        const targetMdHandle = await folderHandle.getFileHandle(mdId + '.md');
        const clip = Core.buildMdClipResult({ targetMdText: await readText(targetMdHandle), title });

        status('popup_saving_new_md');
        const finalMd = await extractImages(pageMd, folderHandle, undefined, status);
        await writeText(await folderHandle.getFileHandle(clip.newMdName, { create: true }), finalMd);

        status('popup_appending_subpage_link');
        await writeText(targetMdHandle, clip.appendedTargetText);
        return { title: title, dest: mdId + '.md', newMdName: clip.newMdName };
    }

    const api = { clipToOutliner: clipToOutliner, clipToMd: clipToMd, getNestedFileHandle: getNestedFileHandle };

    global.FractalClipWriter = api;
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = api;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
