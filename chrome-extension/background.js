'use strict';

/** v0.2.0:
 *  icon click → popup.html (manifest default_popup) で folder + outliner 選択 → Bookmark 実行
 *  keyboard shortcut (Alt+Shift+F) → 直前選択 (lastSelection) で quick clip
 *  service worker (this file) は keyboard shortcut のみ処理。
 */

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

function generateNodeId() {
    return 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}
function generatePageId() {
    return crypto.randomUUID();
}
function parseTags(text) {
    const tags = [];
    const cleaned = (text || '').replace(/`[^`]*`/g, '').replace(/https?:\/\/\S+/g, '');
    const regex = /(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu;
    let m;
    while ((m = regex.exec(cleaned)) !== null) tags.push(m[1]);
    return tags;
}
function prependClipNode(outData, opts) {
    const data = outData || {};
    if (!data.version) data.version = 1;
    if (!data.rootIds) data.rootIds = [];
    if (!data.nodes) data.nodes = {};
    const nodeId = generateNodeId();
    const pageId = generatePageId();
    const text = opts.title || '(untitled)';
    data.nodes[nodeId] = {
        id: nodeId, parentId: null, children: [], text: text, tags: parseTags(text),
        subtext: '', images: [], collapsed: false,
        isPage: true, pageId: pageId, checked: null
    };
    data.rootIds = [nodeId, ...data.rootIds];
    return { outData: data, pageId, nodeId };
}
function buildPageMd(opts) {
    const lines = [];
    if (opts.title) lines.push('# ' + opts.title);
    if (opts.url) lines.push('元ページ: [' + opts.url + '](' + opts.url + ')');
    if (opts.byline) lines.push('著者: ' + opts.byline);
    if (opts.siteName) lines.push('サイト: ' + opts.siteName);
    lines.push('');
    lines.push(opts.markdown || '');
    return lines.join('\n\n');
}

async function quickClip(tab) {
    const t0 = performance.now();
    setBadge('…', '#0969da');
    if (tab && tab.id) showBanner(tab.id, '📥 Clip 処理中…\n' + (tab.title || ''), 'progress');

    // 新 schema: notesFolders[] + lastSelection
    const folders = (await idbGet('notesFolders')) || [];
    const lastSel = await idbGet('lastSelection');
    if (!Array.isArray(folders) || folders.length === 0) {
        setBadge('!', '#cc3333');
        notify('未設定', 'Options で Notes フォルダを登録してください', true);
        if (tab && tab.id) showBanner(tab.id, '❌ Notes フォルダ未登録\nicon click で popup を開いて選択するか、Options で登録', 'err');
        chrome.runtime.openOptionsPage();
        return;
    }
    if (!lastSel || !lastSel.folderId || !lastSel.outId) {
        setBadge('!', '#cc3333');
        notify('未選択', 'icon click で popup を開いて outliner を選んでください (初回のみ)', true);
        if (tab && tab.id) showBanner(tab.id, '❌ 直前選択なし\nicon click で folder + outliner を選択してください', 'err');
        return;
    }
    const folder = folders.find((f) => f.id === lastSel.folderId);
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

    // tab に lib inject + 変換
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['lib/turndown.js', 'lib/turndown-plugin-gfm.js', 'lib/Readability.js', 'lib/fractal-md.js']
    });
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
            try {
                const docClone = document.cloneNode(true);
                let extracted;
                try {
                    extracted = FractalMd.articleToMarkdown(docClone);
                } catch (e) {
                    const md = FractalMd.htmlToMarkdown(document.body ? document.body.innerHTML : '');
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
    const pageMd = buildPageMd({
        title, url: result.url, byline: result.byline, siteName: result.siteName, markdown: result.markdown
    });

    // .out: <folder>/<outId>.out
    const outRelPath = lastSel.outId + '.out';
    const outFileHandle = await getNestedFileHandle(folder.handle, outRelPath);
    const outData = await readJsonFile(outFileHandle);
    const nodeResult = prependClipNode(outData, { title });

    // pageDir: outData.pageDir 明示 or <outId>
    const explicitPageDir = nodeResult.outData && typeof nodeResult.outData.pageDir === 'string'
        ? nodeResult.outData.pageDir.replace(/^\.\//, '').replace(/\/$/, '')
        : '';
    const pageDirRel = explicitPageDir || lastSel.outId;
    const pageDirHandle = await getNestedDirHandle(folder.handle, pageDirRel);
    const pageMdHandle = await pageDirHandle.getFileHandle(nodeResult.pageId + '.md', { create: true });
    await writeTextFile(pageMdHandle, pageMd);
    await writeJsonFile(outFileHandle, nodeResult.outData);

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    setBadge('✓', '#2da44e');
    setTimeout(() => setBadge('', ''), 5000);
    notify('✅ Clip 完了 (' + elapsed + 's)', title + '\n→ ' + folder.name + '/' + lastSel.outId + '.out');
    if (tab && tab.id) {
        showBanner(tab.id, '✅ Clip 完了 (' + elapsed + 's)\n→ ' + folder.name + '/' + lastSel.outId + '\n' + title, 'ok');
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
