'use strict';

/** v0.3.0:
 *  icon click → popup.html (manifest default_popup) で preset / folder + target 選択 → Bookmark 実行
 *  keyboard shortcut (Alt+Shift+F) → default preset（無ければ lastSelection）で quick clip（out/md 両対応）
 *  service worker (this file) は keyboard shortcut のみ処理。
 *  保存先はフラットレイアウト（ADRL-0018: lib/flat-layout-mirror.js = 本体 flat-layout.ts のミラー）。
 */

// MV3 service worker: 共有 lib を importScripts で読み込む（global = self）
importScripts('lib/flat-layout-mirror.js', 'lib/clipper-core.js', 'lib/data-url-image-extractor.js');

console.log('[Fractal Clipper] SW loaded at', new Date().toISOString());

// ── IDB helper (popup と独立) ──
const DB_NAME = 'fractal-clipper';
const STORE = 'kv';
function openDb() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}
async function idbGet(key) {
    const db = await openDb();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const r = tx.objectStore(STORE).get(key);
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
    });
}

// 初回 install 時のみ Options を自動 open (folder 未登録案内)
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Fractal Clipper] onInstalled', details);
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

function notify(title, message, isError = false) {
    const opts = {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: isError ? '❌ ' + title : title,
        message: message || '',
        priority: isError ? 2 : 0,
        requireInteraction: !!isError
    };
    try {
        chrome.notifications.create(opts, () => {
            if (chrome.runtime.lastError) {
                console.warn('[Fractal Clipper] notify FAILED:', chrome.runtime.lastError.message, '|', title);
            }
        });
    } catch (e) {
        console.warn('[Fractal Clipper] notify exception:', e.message);
    }
}

async function showBanner(tabId, text, kind) {
    if (!tabId) return;
    try {
        await chrome.scripting.executeScript({
            target: { tabId },
            func: (text, kind) => {
                let el = document.getElementById('__fractal_clipper_banner');
                if (!el) {
                    el = document.createElement('div');
                    el.id = '__fractal_clipper_banner';
                    el.style.cssText =
                        'position:fixed;top:16px;right:16px;z-index:2147483647;' +
                        'padding:10px 14px;color:#fff;border-radius:6px;' +
                        'font:600 13px/1.4 -apple-system,BlinkMacSystemFont,sans-serif;' +
                        'box-shadow:0 4px 12px rgba(0,0,0,0.25);max-width:380px;' +
                        'word-wrap:break-word;white-space:pre-wrap;' +
                        'transition:opacity 0.3s;pointer-events:none;';
                    document.body.appendChild(el);
                }
                const colors = { progress: '#0969da', ok: '#2da44e', err: '#cc3333' };
                el.style.background = colors[kind] || colors.progress;
                el.textContent = text;
                el.style.opacity = '1';
                if (el.__hideTimer) clearTimeout(el.__hideTimer);
                if (kind !== 'progress') {
                    el.__hideTimer = setTimeout(() => {
                        el.style.opacity = '0';
                        setTimeout(() => { if (el.parentNode) el.remove(); }, 400);
                    }, kind === 'err' ? 8000 : 4000);
                }
            },
            args: [text, kind || 'progress']
        });
    } catch (e) {
        console.warn('[Fractal Clipper] banner inject failed:', e.message);
    }
}

function setBadge(text, color) {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
}

// ── Quick clip ロジック (keyboard shortcut で lastSelection を使う場合) ──
async function getNestedFileHandle(rootHandle, relPath, opts) {
    const parts = relPath.split('/').filter((p) => p);
    let cur = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = await cur.getDirectoryHandle(parts[i], { create: !!opts?.createDirs });
    }
    return cur.getFileHandle(parts[parts.length - 1], { create: !!opts?.create });
}

async function getNestedDirHandle(rootHandle, relDir) {
    const parts = relDir.split('/').filter((p) => p);
    let cur = rootHandle;
    for (const p of parts) cur = await cur.getDirectoryHandle(p, { create: true });
    return cur;
}

async function readJsonFile(handle) {
    const file = await handle.getFile();
    return JSON.parse(await file.text());
}
async function writeJsonFile(handle, obj) {
    const w = await handle.createWritable();
    await w.write(JSON.stringify(obj, null, 2));
    await w.close();
}
async function writeTextFile(handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
}

// prependClipNode / buildPageMd / buildMdClipResult は importScripts した lib/clipper-core.js
// （self.FractalClipperCore）を使う（popup と同一ロジック・重複実装を廃止）。

// md item の実ファイル handle（新フラットレイアウト前提: <folder>/<id>.md 固定・popup.js と同一）
async function resolveMdTarget(folderHandle, mdId) {
    const fh = await folderHandle.getFileHandle(mdId + '.md');
    return { fileHandle: fh, dirHandle: folderHandle };
}

async function quickClip(tab) {
    const t0 = performance.now();
    setBadge('…', '#0969da');
    if (tab && tab.id) showBanner(tab.id, '📥 Clip 処理中…\n' + (tab.title || ''), 'progress');

    // 保存先: default preset 優先 → lastSelection fallback（FR-CL-06）。旧 lastSelection {outId} も正規化。
    const folders = (await idbGet('notesFolders')) || [];
    if (!Array.isArray(folders) || folders.length === 0) {
        setBadge('!', '#cc3333');
        notify('未設定', 'Options で Notes フォルダを登録してください', true);
        if (tab && tab.id) showBanner(tab.id, '❌ Notes フォルダ未登録\nicon click で popup を開いて選択するか、Options で登録', 'err');
        chrome.runtime.openOptionsPage();
        return;
    }
    let sel = null; // { folderId, targetId, targetKind }
    const defaultPresetId = await idbGet('defaultPresetId');
    if (defaultPresetId) {
        const presets = (await idbGet('presets')) || [];
        const p = presets.find((x) => x.id === defaultPresetId);
        if (p) sel = { folderId: p.folderId, targetId: p.targetId, targetKind: p.targetKind === 'md' ? 'md' : 'out' };
    }
    if (!sel) {
        const lastSel = await idbGet('lastSelection');
        if (lastSel && lastSel.folderId && (lastSel.targetId || lastSel.outId)) {
            sel = {
                folderId: lastSel.folderId,
                targetId: lastSel.targetId || lastSel.outId,
                targetKind: lastSel.targetKind === 'md' ? 'md' : 'out'
            };
        }
    }
    if (!sel) {
        setBadge('!', '#cc3333');
        notify('未選択', 'icon click で popup を開いて保存先を選んでください (初回のみ)', true);
        if (tab && tab.id) showBanner(tab.id, '❌ 保存先なし\nicon click で保存先を選択するか、Options で default preset を設定', 'err');
        return;
    }
    const folder = folders.find((f) => f.id === sel.folderId);
    if (!folder) {
        setBadge('!', '#cc3333');
        notify('Folder not found', 'icon click で再選択してください', true);
        return;
    }

    // 許可確認
    const perm = await folder.handle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
        // SW から requestPermission は user gesture が必要 → popup 経由を促す
        setBadge('!', '#cc3333');
        notify('要再許可', 'icon click で popup を開いて許可してください', true);
        if (tab && tab.id) showBanner(tab.id, '❌ folder 許可が失効\nicon click で popup から再許可してください', 'err');
        return;
    }

    // tab に lib inject + 変換 (v0.207.50: html-md-converter で 1 file)
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['lib/Readability.js', 'lib/html-md-converter.js']
    });
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
            try {
                // SVG 前処理:
                //  1. inlineSvgComputedStyles: live DOM で class→style 解決
                //  2. preSerializeSvgsToImages: Readability が SVG 属性を strip する前に
                //     <svg> を self-contained な <img src="data:image/svg+xml;base64,..."> に置換
                try {
                    if (typeof HtmlMdConverter !== 'undefined') {
                        if (HtmlMdConverter.inlineSvgComputedStyles) {
                            HtmlMdConverter.inlineSvgComputedStyles(document);
                        }
                        if (HtmlMdConverter.unwrapHeadingAnchors) {
                            HtmlMdConverter.unwrapHeadingAnchors(document);
                        }
                    }
                } catch (e) {}
                const docClone = document.cloneNode(true);
                try {
                    if (typeof HtmlMdConverter !== 'undefined' && HtmlMdConverter.preSerializeSvgsToImages) {
                        HtmlMdConverter.preSerializeSvgsToImages(docClone);
                    }
                } catch (e) {}
                let extracted;
                try {
                    extracted = HtmlMdConverter.articleToMarkdown(docClone);
                } catch (e) {
                    const md = HtmlMdConverter.htmlToMarkdown(document.body ? document.body.innerHTML : '');
                    extracted = { title: document.title || '', markdown: md, byline: '', siteName: '' };
                }
                return {
                    ok: true, title: extracted.title || document.title || '',
                    url: location.href, markdown: extracted.markdown || '',
                    byline: extracted.byline || '', siteName: extracted.siteName || ''
                };
            } catch (e) {
                return { ok: false, error: e.message || String(e) };
            }
        }
    });
    if (!result || !result.ok) throw new Error(result?.error || 'Conversion failed');

    const title = result.title || '(untitled)';
    const pageMd = FractalClipperCore.buildPageMd({
        title, url: result.url, byline: result.byline, siteName: result.siteName, markdown: result.markdown
    });

    let destLabel;
    if (sel.targetKind === 'md') {
        // md への clip（FR-CL-05: 新規 <uuid>.md を対象 md と同じ dir に + 末尾に subpage リンク追記）
        const { fileHandle: targetMdHandle, dirHandle: targetDirHandle } = await resolveMdTarget(folder.handle, sel.targetId);
        const targetText = await (await targetMdHandle.getFile()).text();
        const clip = FractalClipperCore.buildMdClipResult({ targetMdText: targetText, title });
        let finalMd = pageMd;
        try {
            const { newMd } = await DataUrlImageExtractor.processDataUrlsInMd(pageMd, targetDirHandle);
            finalMd = newMd;
        } catch (e) { console.warn('[clipper] data URL extract failed', e); }
        const newMdHandle = await targetDirHandle.getFileHandle(clip.newMdName, { create: true });
        await writeTextFile(newMdHandle, finalMd);
        await writeTextFile(targetMdHandle, clip.appendedTargetText);
        destLabel = sel.targetId + '.md';
    } else {
        // outliner への clip（フラット規約: 本体 resolvePagesDir と同一軸・ADRL-0018）
        const outFileHandle = await getNestedFileHandle(folder.handle, sel.targetId + '.out');
        const outData = await readJsonFile(outFileHandle);
        const nodeResult = FractalClipperCore.prependClipNode(outData, { title });

        // 新フラットレイアウト前提（hint 尊重・無ければ note 直下）
        const hints = { pageDir: outData.pageDir, imageDir: outData.imageDir, fileDir: outData.fileDir };
        const writeDirRel = FractalFlatLayout.chooseWriteDirRel(hints, sel.targetId);
        const pageDirHandle = writeDirRel ? await getNestedDirHandle(folder.handle, writeDirRel) : folder.handle;

        const imagesSubdir = FractalFlatLayout.resolveImagesDirRel(hints);
        let finalMd = pageMd;
        try {
            const { newMd } = await DataUrlImageExtractor.processDataUrlsInMd(pageMd, pageDirHandle, imagesSubdir);
            finalMd = newMd;
        } catch (e) { console.warn('[clipper] data URL extract failed', e); }
        const pageMdHandle = await pageDirHandle.getFileHandle(nodeResult.pageId + '.md', { create: true });
        await writeTextFile(pageMdHandle, finalMd);
        await writeJsonFile(outFileHandle, nodeResult.outData);
        destLabel = sel.targetId + '.out';
    }

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    setBadge('✓', '#2da44e');
    setTimeout(() => setBadge('', ''), 5000);
    notify('✅ Clip 完了 (' + elapsed + 's)', title + '\n→ ' + folder.name + '/' + destLabel);
    if (tab && tab.id) {
        showBanner(tab.id, '✅ Clip 完了 (' + elapsed + 's)\n→ ' + folder.name + '/' + destLabel + '\n' + title, 'ok');
    }
}

// keyboard shortcut (Alt+Shift+F) → quick clip with last selection
chrome.commands.onCommand.addListener(async (command) => {
    console.log('[Fractal Clipper] onCommand:', command);
    if (command !== 'clip-to-fractal') return;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab) return;
    try {
        await quickClip(tab);
    } catch (e) {
        console.error('[Fractal Clipper] quickClip error', e);
        setBadge('!', '#cc3333');
        notify('Clip 失敗', e.message || String(e), true);
        if (tab && tab.id) showBanner(tab.id, '❌ Clip 失敗\n' + (e.message || String(e)), 'err');
    }
});

// 注: chrome.action.onClicked は manifest.action.default_popup が宣言されているので fire しない (popup が開く)。
