/**
 * data-url-image-extractor (browser / Chrome ext 用)
 *
 * MD 内の data:image/... を実体ファイル化し、相対 path に置換する。
 * File System Access API (FileSystemDirectoryHandle) 経由で書き込む。
 *
 * Fractal 本体 (src/shared/data-url-image-extractor.ts) と同じ命名規則:
 *   `<Date.now()>.<ext>`、衝突時 `<ts>-<NNNN>.<ext>`
 *
 * 対応 MIME: png / jpeg / gif / webp / avif / apng / svg+xml
 *   - jpeg → jpg
 *   - svg+xml → svg
 *   - 他は match[1] そのまま
 *
 * Body は MD/HTML delimiter (`)` `"` 空白 `<` `>`) で停止。
 */
(function (global) {
    'use strict';

    function mimeToExt(mimeSubtype) {
        const lower = (mimeSubtype || '').toLowerCase();
        if (lower === 'jpeg') return 'jpg';
        if (lower === 'svg+xml' || lower === 'svg') return 'svg';
        const cleaned = lower.replace(/[^a-z0-9]/g, '');
        return cleaned || 'png';
    }

    // base64 形式: data:image/<mime>(;params)*;base64,<base64-chars>
    const BASE64_RE = /^data:image\/([a-zA-Z0-9+\-.]+)(?:;[^,]*)?;base64,([A-Za-z0-9+/=]+)$/;
    // SVG テキスト形式: data:image/svg+xml(;params)?,<URL-encoded or utf8 body>
    const SVG_TEXT_RE = /^data:image\/svg\+xml(?:;[^,]*)?,(.+)$/;

    // base64 → Uint8Array
    function base64ToBytes(b64) {
        const bin = atob(b64);
        const out = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
    }

    /** data URL → { ext, bytes } | null */
    function parseDataUrl(dataUrl) {
        if (!dataUrl || !dataUrl.startsWith('data:image/')) return null;
        let m = dataUrl.match(BASE64_RE);
        if (m) {
            try {
                return { ext: mimeToExt(m[1]), bytes: base64ToBytes(m[2]) };
            } catch (e) {
                return null;
            }
        }
        m = dataUrl.match(SVG_TEXT_RE);
        if (m) {
            let body = m[1];
            try { body = decodeURIComponent(body); } catch (e) { /* ignore */ }
            return { ext: 'svg', bytes: new TextEncoder().encode(body) };
        }
        return null;
    }

    // 全 scan 用 regex (MD/HTML delimiter で停止)
    const DATA_URL_RE = /(data:image\/[a-zA-Z0-9+\-.]+(?:;[a-zA-Z0-9-]+(?:=[^;,]*)?)*?(?:;base64)?,[^)"\s<>]+)/g;

    /**
     * `<dirHandle>/<fileName>` が存在するか
     */
    async function fileExists(dirHandle, fileName) {
        try {
            await dirHandle.getFileHandle(fileName);
            return true;
        } catch (e) {
            return false;
        }
    }

    /**
     * Fractal の generateUniqueFileName と同じ命名:
     * <ts>.<ext>、衝突時 <ts>-<NNNN>.<ext>
     */
    async function nextUniqueImageName(imagesHandle, ext) {
        const ts = Date.now();
        const base = `${ts}.${ext}`;
        if (!(await fileExists(imagesHandle, base))) return base;
        let counter = 1;
        // 無限ループ防止用
        while (counter < 99999) {
            const name = `${ts}-${String(counter).padStart(4, '0')}.${ext}`;
            if (!(await fileExists(imagesHandle, name))) return name;
            counter++;
        }
        // fallback (極めて稀)
        return `${ts}-${Date.now()}.${ext}`;
    }

    /**
     * MD 内の data:image/... を <pageDir>/images/<ts>.<ext> として保存し、
     * 相対 path (`images/<filename>`) に置換した MD を返す。
     *
     * @param md MD 文字列
     * @param pageDirHandle FileSystemDirectoryHandle (page MD と同階層)
     * @returns { newMd: string, savedCount: number }
     */
    async function processDataUrlsInMd(md, pageDirHandle) {
        if (!md || md.indexOf('data:image/') < 0) {
            return { newMd: md, savedCount: 0 };
        }

        // 全マッチを列挙
        const matches = [...md.matchAll(DATA_URL_RE)];
        if (matches.length === 0) {
            return { newMd: md, savedCount: 0 };
        }

        const imagesHandle = await pageDirHandle.getDirectoryHandle('images', { create: true });

        // 同一 data URL は 1 度だけ書き込み
        const seen = new Map(); // dataUrl → relativePath
        let savedCount = 0;

        for (const m of matches) {
            const dataUrl = m[1];
            if (seen.has(dataUrl)) continue;
            const parsed = parseDataUrl(dataUrl);
            if (!parsed) { seen.set(dataUrl, dataUrl); continue; }
            const fileName = await nextUniqueImageName(imagesHandle, parsed.ext);
            try {
                const fh = await imagesHandle.getFileHandle(fileName, { create: true });
                const writable = await fh.createWritable();
                await writable.write(parsed.bytes);
                await writable.close();
                seen.set(dataUrl, `images/${fileName}`);
                savedCount++;
            } catch (e) {
                console.warn('[data-url-extractor] save failed', fileName, e);
                seen.set(dataUrl, dataUrl);
            }
        }

        const newMd = md.replace(DATA_URL_RE, (m) => seen.get(m) || m);
        return { newMd, savedCount };
    }

    global.DataUrlImageExtractor = {
        mimeToExt,
        parseDataUrl,
        processDataUrlsInMd
    };
})(typeof self !== 'undefined' ? self : this);
