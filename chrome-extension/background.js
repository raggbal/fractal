'use strict';

console.log('[Fractal Clipper] SW loaded at', new Date().toISOString());

// SW 起動中はアイコンを disable + badge `⋯` で「準備中」を視覚化。warmup 後に enable。
// (install 直後 / Chrome 起動直後の SW idle 状態でユーザーが押しても無反応にならないように)
let swReady = false;
chrome.action.disable();
chrome.action.setBadgeText({ text: '⋯' });
chrome.action.setBadgeBackgroundColor({ color: '#888' });
chrome.action.setTitle({ title: 'Fractal Clipper (準備中…)' });

(async function warmup() {
    try {
        // IDB を 1 度開いて connection を温めておく (初回 access で遅延しないように)
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

// IDB helper (popup と独立)
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
        } else {
            console.log('[Fractal Clipper] notify ok:', id, '|', title);
        }
    });
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
    // indent なし (大きい .out ではサイズ半減・stringify も速い)。Fractal は parse 時 indent 不要
    const tStr = performance.now();
    const text = JSON.stringify(obj);
    console.log('[Fractal Clipper]   JSON.stringify:', ((performance.now() - tStr) / 1000).toFixed(2), 's,', (text.length / 1024).toFixed(1), 'KB');
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
}
async function writeTextFile(handle, text) {
    const w = await handle.createWritable();
    await w.write(text);
    await w.close();
}

// node 追加 + page MD 組立 (clipper-core.js のロジックを inline)
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
    // deep clone を skip (大きい .out で 10s+ かかるため)。caller は outData を再利用しない
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

// メイン: icon クリックで起動
chrome.action.onClicked.addListener(async (tab) => {
    const t0 = performance.now();
    console.log('[Fractal Clipper] action.onClicked fired, tab:', tab?.id, tab?.url);
    if (!swReady) {
        notify('準備中', 'Service worker 起動中です。数秒後に再度お試しください', true);
        return;
    }
    setBadge('…', '#0969da');
    try {
        const folderHandle = await idbGet('notesFolderHandle');
        const folderName = await idbGet('notesFolderName');
        const targetOutPath = await idbGet('targetOutPath');
        console.log('[Fractal Clipper] setup:', !!folderHandle, folderName, targetOutPath);

        if (!folderHandle || !targetOutPath) {
            setBadge('!', '#cc3333');
            notify('未設定', 'Notes フォルダ + .out ファイルを Options で設定してください', true);
            chrome.runtime.openOptionsPage();
            return;
        }

        // 開始通知 (即時、user に「処理始まった」フィードバック)
        const tabTitle = (tab && tab.title) ? tab.title : (tab && tab.url) ? tab.url : '';
        notify('📥 Clip 開始', tabTitle.slice(0, 80) + ' を処理中…');

        // 許可確認 (queryPermission は user gesture 不要)
        const perm = await folderHandle.queryPermission({ mode: 'readwrite' });
        console.log('[Fractal Clipper] perm:', perm);
        if (perm !== 'granted') {
            // requestPermission は user gesture 必要 → action click 経由なので OK のはず
            const req = await folderHandle.requestPermission({ mode: 'readwrite' });
            console.log('[Fractal Clipper] req perm:', req);
            if (req !== 'granted') {
                notify('許可が得られませんでした', 'Options を開いてフォルダを再選択してください', true);
                chrome.runtime.openOptionsPage();
                return;
            }
        }

        // tab に lib inject + 変換
        const tInject = performance.now();
        console.log('[Fractal Clipper] injecting libs into tab', tab.id);
        try {
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: [
                    'lib/turndown.js',
                    'lib/turndown-plugin-gfm.js',
                    'lib/Readability.js',
                    'lib/fractal-md.js'
                ]
            });
            console.log('[Fractal Clipper] inject took', ((performance.now() - tInject) / 1000).toFixed(2), 's');
        } catch (e) {
            console.error('[Fractal Clipper] inject FAILED', e);
            throw new Error('Script inject failed: ' + (e.message || String(e)));
        }
        const tConv = performance.now();
        console.log('[Fractal Clipper] running conversion in tab');
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
        console.log('[Fractal Clipper] conversion took', ((performance.now() - tConv) / 1000).toFixed(2), 's, ok:', result?.ok);
        if (!result || !result.ok) throw new Error(result?.error || 'Conversion failed');

        const title = result.title || '(untitled)';
        const pageMd = buildPageMd({
            title, url: result.url,
            byline: result.byline, siteName: result.siteName,
            markdown: result.markdown
        });

        // .out file handle 解決
        const tHandle = performance.now();
        const outFileHandle = await getNestedFileHandle(folderHandle, targetOutPath);
        console.log('[Fractal Clipper] resolve .out handle:', ((performance.now() - tHandle) / 1000).toFixed(2), 's');

        // .out 読み込み (JSON parse 含む)
        const tRead = performance.now();
        const outData = await readJsonFile(outFileHandle);
        const outSize = JSON.stringify(outData).length;
        console.log('[Fractal Clipper] read .out:', ((performance.now() - tRead) / 1000).toFixed(2), 's, size:', (outSize / 1024).toFixed(1), 'KB');

        // node 追加 (in-memory)
        const tNode = performance.now();
        const nodeResult = prependClipNode(outData, { title });
        console.log('[Fractal Clipper] node insert:', ((performance.now() - tNode) / 1000).toFixed(3), 's');

        // page MD ディレクトリ解決
        const tDirH = performance.now();
        const pageDirRel = resolvePageDir(nodeResult.outData);
        const outDirParts = targetOutPath.split('/').slice(0, -1);
        const pageMdDirRel = (outDirParts.length > 0 ? outDirParts.join('/') + '/' : '') + pageDirRel;
        const pageDirHandle = await getNestedDirHandle(folderHandle, pageMdDirRel);
        const pageMdHandle = await pageDirHandle.getFileHandle(nodeResult.pageId + '.md', { create: true });
        console.log('[Fractal Clipper] resolve pageDir+handle:', ((performance.now() - tDirH) / 1000).toFixed(2), 's');

        // page MD 書き込み
        const tWriteMd = performance.now();
        await writeTextFile(pageMdHandle, pageMd);
        console.log('[Fractal Clipper] write pageMd:', ((performance.now() - tWriteMd) / 1000).toFixed(2), 's, size:', (pageMd.length / 1024).toFixed(1), 'KB');

        // .out 書き戻し (JSON.stringify 含む)
        const tWriteOut = performance.now();
        await writeJsonFile(outFileHandle, nodeResult.outData);
        console.log('[Fractal Clipper] write .out:', ((performance.now() - tWriteOut) / 1000).toFixed(2), 's');

        const elapsed = ((performance.now() - t0) / 1000).toFixed(1);
        console.log('[Fractal Clipper] DONE in', elapsed, 's');
        setBadge('✓', '#2da44e');
        setTimeout(() => setBadge('', ''), 5000);
        notify('✅ Clip 完了 (' + elapsed + 's)', title + '\n→ ' + (folderName || folderHandle.name) + '/' + targetOutPath);
    } catch (e) {
        console.error('[Fractal Clipper] ERROR', e);
        setBadge('!', '#cc3333');
        notify('Clip 失敗', e.message || String(e), true);
    }
});
