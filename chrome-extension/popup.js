'use strict';

const targetEl = document.getElementById('target');
const clipBtn = document.getElementById('clipBtn');
const statusEl = document.getElementById('status');
const optionsLink = document.getElementById('optionsLink');

function setStatus(text, kind = 'info') {
    statusEl.style.display = '';
    statusEl.className = 'status ' + kind;
    statusEl.textContent = text;
}

optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

async function loadSetup() {
    const folderHandle = await FractalIdb.get('notesFolderHandle');
    const folderName = await FractalIdb.get('notesFolderName');
    const targetOutPath = await FractalIdb.get('targetOutPath');
    return { folderHandle, folderName, targetOutPath };
}

async function ensurePermission(handle) {
    const perm = await handle.queryPermission({ mode: 'readwrite' });
    if (perm === 'granted') return true;
    const req = await handle.requestPermission({ mode: 'readwrite' });
    return req === 'granted';
}

/** Folder handle 内のサブパス path (例: "subdir/foo.out") の file handle を取得 */
async function getNestedFileHandle(rootHandle, relPath, opts) {
    const parts = relPath.split('/').filter(p => p);
    let cur = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = await cur.getDirectoryHandle(parts[i], { create: !!opts?.createDirs });
    }
    const fileName = parts[parts.length - 1];
    return cur.getFileHandle(fileName, { create: !!opts?.create });
}

/** rootHandle 配下に subdir handle を get (作成してでも) */
async function getNestedDirHandle(rootHandle, relDir) {
    const parts = relDir.split('/').filter(p => p);
    let cur = rootHandle;
    for (const p of parts) {
        cur = await cur.getDirectoryHandle(p, { create: true });
    }
    return cur;
}

async function readJsonFile(fileHandle) {
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
}

async function writeJsonFile(fileHandle, obj) {
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(obj, null, 2));
    await writable.close();
}

async function writeTextFile(fileHandle, text) {
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
}

/** active tab から outerHTML + url + title を取得 */
async function fetchActiveTabHtml() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('Active tab not found');
    const [{ result }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
            html: document.documentElement.outerHTML,
            url: location.href,
            title: document.title || ''
        })
    });
    return result;
}

async function refresh() {
    const { folderHandle, folderName, targetOutPath } = await loadSetup();
    if (!folderHandle || !targetOutPath) {
        targetEl.textContent = '⚠️ 未設定 — 設定を開いて Notes フォルダ + .out ファイルを選択してください';
        clipBtn.disabled = true;
        return;
    }
    targetEl.textContent = (folderName || folderHandle.name) + '/' + targetOutPath;
    clipBtn.disabled = false;
}

clipBtn.addEventListener('click', async () => {
    clipBtn.disabled = true;
    setStatus('処理中…', 'info');
    try {
        const { folderHandle, targetOutPath } = await loadSetup();
        if (!folderHandle || !targetOutPath) throw new Error('未設定');

        // 1. 許可確認
        const ok = await ensurePermission(folderHandle);
        if (!ok) throw new Error('フォルダ書き込み許可が得られませんでした');

        // 2. ページ取得
        setStatus('ページ HTML 取得中…', 'info');
        const tabInfo = await fetchActiveTabHtml();

        // 3. Readability + turndown 変換
        setStatus('Markdown 変換中…', 'info');
        const doc = new DOMParser().parseFromString(tabInfo.html, 'text/html');
        let extracted;
        try {
            extracted = FractalMd.articleToMarkdown(doc);
        } catch (e) {
            // Readability 失敗 → body 全体で fallback
            console.warn('Readability failed, falling back to full body', e);
            const md = FractalMd.htmlToMarkdown(doc.body ? doc.body.innerHTML : tabInfo.html);
            extracted = { title: tabInfo.title, markdown: md, byline: '', siteName: '' };
        }
        const title = extracted.title || tabInfo.title || '(untitled)';
        const pageMd = FractalClipperCore.buildPageMd({
            title: title,
            url: tabInfo.url,
            byline: extracted.byline,
            siteName: extracted.siteName,
            markdown: extracted.markdown
        });

        // 4. .out 読み込み
        setStatus('.out 読み込み中…', 'info');
        const outFileHandle = await getNestedFileHandle(folderHandle, targetOutPath);
        const outData = await readJsonFile(outFileHandle);

        // 5. node 追加
        const result = FractalClipperCore.prependClipNode(outData, { title: title });

        // 6. page MD 保存
        setStatus('page MD 保存中…', 'info');
        const pageDirRel = FractalClipperCore.resolvePageDir(result.outData);
        // .out のあるディレクトリの subdir に pageDir があるという想定
        // targetOutPath = "subdir/foo.out" なら .out のあるディレクトリは "subdir"、
        // pageDir は "subdir/<pageDir>"
        const outDirParts = targetOutPath.split('/').slice(0, -1);
        const pageMdDirRel = (outDirParts.length > 0 ? outDirParts.join('/') + '/' : '') + pageDirRel;
        const pageDirHandle = await getNestedDirHandle(folderHandle, pageMdDirRel);
        const pageMdHandle = await pageDirHandle.getFileHandle(result.pageId + '.md', { create: true });
        await writeTextFile(pageMdHandle, pageMd);

        // 7. .out 書き戻し
        setStatus('.out 書き込み中…', 'info');
        await writeJsonFile(outFileHandle, result.outData);

        setStatus('✅ Clip 完了: ' + title, 'ok');
    } catch (e) {
        console.error(e);
        setStatus('❌ ' + (e.message || String(e)), 'err');
    } finally {
        clipBtn.disabled = false;
    }
});

refresh();
