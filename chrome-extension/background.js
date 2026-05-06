'use strict';

console.log('[Fractal Clipper] SW loaded at', new Date().toISOString());

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
    chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: isError ? '❌ ' + title : title,
        message: message || '',
        priority: isError ? 2 : 0
    });
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
    const w = await handle.createWritable();
    await w.write(JSON.stringify(obj, null, 2));
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
    const data = JSON.parse(JSON.stringify(outData || {}));
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
    console.log('[Fractal Clipper] action.onClicked fired, tab:', tab?.id, tab?.url);
    try {
        const folderHandle = await idbGet('notesFolderHandle');
        const folderName = await idbGet('notesFolderName');
        const targetOutPath = await idbGet('targetOutPath');
        console.log('[Fractal Clipper] setup:', !!folderHandle, folderName, targetOutPath);

        if (!folderHandle || !targetOutPath) {
            notify('未設定', 'Notes フォルダ + .out ファイルを Options で設定してください', true);
            chrome.runtime.openOptionsPage();
            return;
        }

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
        await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: [
                'lib/turndown.js',
                'lib/turndown-plugin-gfm.js',
                'lib/Readability.js',
                'lib/fractal-md.js'
            ]
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
        if (!result || !result.ok) throw new Error(result?.error || 'Conversion failed');

        const title = result.title || '(untitled)';
        const pageMd = buildPageMd({
            title, url: result.url,
            byline: result.byline, siteName: result.siteName,
            markdown: result.markdown
        });

        // .out 読み + node 追加
        const outFileHandle = await getNestedFileHandle(folderHandle, targetOutPath);
        const outData = await readJsonFile(outFileHandle);
        const nodeResult = prependClipNode(outData, { title });

        // page MD 保存
        const pageDirRel = resolvePageDir(nodeResult.outData);
        const outDirParts = targetOutPath.split('/').slice(0, -1);
        const pageMdDirRel = (outDirParts.length > 0 ? outDirParts.join('/') + '/' : '') + pageDirRel;
        const pageDirHandle = await getNestedDirHandle(folderHandle, pageMdDirRel);
        const pageMdHandle = await pageDirHandle.getFileHandle(nodeResult.pageId + '.md', { create: true });
        await writeTextFile(pageMdHandle, pageMd);

        // .out 書き戻し
        await writeJsonFile(outFileHandle, nodeResult.outData);

        console.log('[Fractal Clipper] DONE');
        notify('✅ Clip 完了', title + '\n→ ' + (folderName || folderHandle.name) + '/' + targetOutPath);
    } catch (e) {
        console.error('[Fractal Clipper] ERROR', e);
        notify('Clip 失敗', e.message || String(e), true);
    }
});
