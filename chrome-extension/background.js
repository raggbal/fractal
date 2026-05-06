'use strict';

console.log('[Fractal Clipper] SW loaded at', new Date().toISOString());

// IDB helper (popup と独立) — warmup より先に宣言する必要あり (TDZ 回避)
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

// SW 起動中はアイコンを disable + badge `⋯` で「準備中」を視覚化。warmup 後に enable。
let swReady = false;
chrome.action.disable();
chrome.action.setBadgeText({ text: '⋯' });
chrome.action.setBadgeBackgroundColor({ color: '#888' });
chrome.action.setTitle({ title: 'Fractal Clipper (準備中…)' });

(async function warmup() {
    try {
        await idbGet('notesFolderHandle');
    } catch (e) {
        console.warn('[Fractal Clipper] warmup idb failed (non-fatal)', e);
    }
    swReady = true;
    chrome.action.enable();
    chrome.action.setBadgeText({ text: '' });
    chrome.action.setTitle({ title: 'Clip to Fractal Outliner' });
    console.log('[Fractal Clipper] warmup done, action enabled');
})();

// 初回 install 時のみ Options を自動 open
chrome.runtime.onInstalled.addListener((details) => {
    console.log('[Fractal Clipper] onInstalled', details);
    if (details.reason === 'install') {
        chrome.runtime.openOptionsPage();
    }
});

// chrome.notifications フォールバック (macOS 通知許可 OFF 環境では出ないため、
// 必ず active tab に in-page banner を inject する)
function notify(title, message, isError = false) {
    const opts = {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: isError ? '❌ ' + title : title,
        message: message || '',
        priority: isError ? 2 : 0,
        requireInteraction: !!isError
    };
    chrome.notifications.create(opts, (id) => {
        if (chrome.runtime.lastError) {
            console.warn('[Fractal Clipper] notify FAILED:', chrome.runtime.lastError.message, '|', title);
        }
    });
}

// in-page banner (chrome.notifications より確実) — active tab に visible 帯を inject
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

// アイコン上の badge で進捗を視覚化 (通知が出ない環境でも分かるように)
function setBadge(text, color) {
    chrome.action.setBadgeText({ text: text || '' });
    if (color) chrome.action.setBadgeBackgroundColor({ color });
}

async function getNestedFileHandle(rootHandle, relPath, opts) {
    const parts = relPath.split('/').filter(p => p);
    let cur = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = await cur.getDirectoryHandle(parts[i], { create: !!opts?.createDirs });
    }
    return cur.getFileHandle(parts[parts.length - 1], { create: !!opts?.create });
}

async function getNestedDirHandle(rootHandle, relDir) {
    const parts = relDir.split('/').filter(p => p);
    let cur = rootHandle;
    for (const p of parts) cur = await cur.getDirectoryHandle(p, { create: true });
    return cur;
}

async function readJsonFile(handle) {
    const file = await handle.getFile();
    return JSON.parse(await file.text());
}
async function writeJsonFile(handle, obj) {
    const text = JSON.stringify(obj);
    const w = await handle.createWritable();
    await w.write(text);
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
function resolvePageDir(outData) {
    return ((outData && outData.pageDir) || './pages').replace(/^\.\//, '').replace(/\/$/, '');
}

// クリップ queue — 同じ .out への並列書き込み競合 (10-30s に肥大) を防ぐため直列化
// 並列クリックされても順番に処理 (banner で「処理待ち」表示)
const clipQueue = [];
let clipBusy = false;

function enqueueClip(tab) {
    return new Promise((resolve) => {
        clipQueue.push({ tab, resolve });
        const queueIdx = clipQueue.length;
        if (clipBusy && tab && tab.id) {
            showBanner(tab.id, '⏳ Clip 待機中 (' + queueIdx + ' 件目)\n' + (tab.title || ''), 'progress');
        }
        processQueue();
    });
}

async function processQueue() {
    if (clipBusy || clipQueue.length === 0) return;
    clipBusy = true;
    const { tab, resolve } = clipQueue.shift();
    try {
        await doClip(tab);
    } catch (e) {
        console.error('[Fractal Clipper] clip error', e);
    } finally {
        clipBusy = false;
        resolve();
        processQueue();
    }
}

async function doClip(tab) {
    const t0 = performance.now();
    setBadge('…', '#0969da');
    if (tab && tab.id) {
        showBanner(tab.id, '📥 Clip 処理中…\n' + (tab.title || ''), 'progress');
    }

    const folderHandle = await idbGet('notesFolderHandle');
    const folderName = await idbGet('notesFolderName');
    const targetOutPath = await idbGet('targetOutPath');
    console.log('[Fractal Clipper] setup:', !!folderHandle, folderName, targetOutPath);

    if (!folderHandle || !targetOutPath) {
        setBadge('!', '#cc3333');
        notify('未設定', 'Notes フォルダ + .out ファイルを Options で設定してください', true);
        if (tab && tab.id) showBanner(tab.id, '❌ 未設定: Options を開いてください', 'err');
        chrome.runtime.openOptionsPage();
        return;
    }

    notify('📥 Clip 開始', (tab && tab.title || '').slice(0, 80) + ' を処理中…');

    // 許可確認
    const perm = await folderHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
        const req = await folderHandle.requestPermission({ mode: 'readwrite' });
        if (req !== 'granted') {
            setBadge('!', '#cc3333');
            notify('許可が得られませんでした', 'Options を開いてフォルダを再選択してください', true);
            if (tab && tab.id) showBanner(tab.id, '❌ フォルダ許可なし', 'err');
            chrome.runtime.openOptionsPage();
            return;
        }
    }

    // tab に lib inject + 変換
    const tInject = performance.now();
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
            'lib/turndown.js',
            'lib/turndown-plugin-gfm.js',
            'lib/Readability.js',
            'lib/fractal-md.js'
        ]
    });
    console.log('[Fractal Clipper] inject:', ((performance.now() - tInject) / 1000).toFixed(2), 's');

    const tConv = performance.now();
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
                    ok: true,
                    title: extracted.title || document.title || '',
                    url: location.href,
                    markdown: extracted.markdown || '',
                    byline: extracted.byline || '',
                    siteName: extracted.siteName || ''
                };
            } catch (e) {
                return { ok: false, error: e.message || String(e) };
            }
        }
    });
    console.log('[Fractal Clipper] conversion:', ((performance.now() - tConv) / 1000).toFixed(2), 's');
    if (!result || !result.ok) throw new Error(result?.error || 'Conversion failed');

    const title = result.title || '(untitled)';
    const pageMd = buildPageMd({
        title, url: result.url,
        byline: result.byline, siteName: result.siteName,
        markdown: result.markdown
    });

    const tFs = performance.now();
    const outFileHandle = await getNestedFileHandle(folderHandle, targetOutPath);
    const outData = await readJsonFile(outFileHandle);
    const nodeResult = prependClipNode(outData, { title });

    const pageDirRel = resolvePageDir(nodeResult.outData);
    const outDirParts = targetOutPath.split('/').slice(0, -1);
    const pageMdDirRel = (outDirParts.length > 0 ? outDirParts.join('/') + '/' : '') + pageDirRel;
    const pageDirHandle = await getNestedDirHandle(folderHandle, pageMdDirRel);
    const pageMdHandle = await pageDirHandle.getFileHandle(nodeResult.pageId + '.md', { create: true });
    await writeTextFile(pageMdHandle, pageMd);
    await writeJsonFile(outFileHandle, nodeResult.outData);
    console.log('[Fractal Clipper] fs total:', ((performance.now() - tFs) / 1000).toFixed(2), 's, pageMd:', (pageMd.length / 1024).toFixed(1), 'KB, out size:', JSON.stringify(nodeResult.outData).length, 'B');

    const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
    console.log('[Fractal Clipper] DONE in', elapsed, 's');
    setBadge('✓', '#2da44e');
    setTimeout(() => { if (!clipBusy && clipQueue.length === 0) setBadge('', ''); }, 5000);
    notify('✅ Clip 完了 (' + elapsed + 's)', title + '\n→ ' + (folderName || folderHandle.name) + '/' + targetOutPath);
    if (tab && tab.id) {
        showBanner(tab.id, '✅ Clip 完了 (' + elapsed + 's)\n→ ' + (folderName || folderHandle.name) + '/' + targetOutPath + '\n' + title, 'ok');
    }
}

// メイン: icon クリックで起動 (queue に積むだけ)
chrome.action.onClicked.addListener(async (tab) => {
    console.log('[Fractal Clipper] onClicked tab:', tab?.id, tab?.url, '| queue:', clipQueue.length, 'busy:', clipBusy);
    if (!swReady) {
        notify('準備中', 'Service worker 起動中です。数秒後に再度お試しください', true);
        if (tab && tab.id) showBanner(tab.id, '⏳ Service worker 起動中…数秒後に再試行', 'err');
        return;
    }
    try {
        await enqueueClip(tab);
    } catch (e) {
        console.error('[Fractal Clipper] enqueue error', e);
        setBadge('!', '#cc3333');
        notify('Clip 失敗', e.message || String(e), true);
        if (tab && tab.id) showBanner(tab.id, '❌ Clip 失敗\n' + (e.message || String(e)), 'err');
    }
});
