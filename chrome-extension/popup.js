'use strict';

const setupRequiredEl = document.getElementById('setupRequired');
const pickerEl = document.getElementById('picker');
const folderSelect = document.getElementById('folderSelect');
const outSelect = document.getElementById('outSelect');
const clipBtn = document.getElementById('clipBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');
const optionsLink = document.getElementById('optionsLink');
const statusEl = document.getElementById('status');

openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

let folders = [];      // [{id, name, handle}]
let currentOutliners = []; // [{id, title, depth, folderPath}]

function setStatus(text, kind = 'info') {
    statusEl.style.display = '';
    statusEl.className = 'status ' + kind;
    statusEl.textContent = text;
}

function clearStatus() {
    statusEl.style.display = 'none';
}

/** Folder handle 内のサブパス path (例: "subdir/foo.out") の file handle を取得 */
async function getNestedFileHandle(rootHandle, relPath, opts) {
    const parts = relPath.split('/').filter((p) => p);
    let cur = rootHandle;
    for (let i = 0; i < parts.length - 1; i++) {
        cur = await cur.getDirectoryHandle(parts[i], { create: !!opts?.createDirs });
    }
    const fileName = parts[parts.length - 1];
    return cur.getFileHandle(fileName, { create: !!opts?.create });
}

async function getNestedDirHandle(rootHandle, relDir) {
    const parts = relDir.split('/').filter((p) => p);
    let cur = rootHandle;
    for (const p of parts) {
        cur = await cur.getDirectoryHandle(p, { create: true });
    }
    return cur;
}

async function readJsonFile(fileHandle) {
    const file = await fileHandle.getFile();
    return JSON.parse(await file.text());
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

async function convertActiveTabToMarkdown() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) throw new Error('Active tab not found');
    await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        // v0.207.50: turndown + GFM + Fractal rule は html-md-converter.js に統合済 (1 file)
        files: [
            'lib/Readability.js',
            'lib/html-md-converter.js'
        ]
    });
    const [{ result, error }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
            try {
                const docClone = document.cloneNode(true);
                let extracted;
                try {
                    extracted = HtmlMdConverter.articleToMarkdown(docClone);
                } catch (e) {
                    const md = HtmlMdConverter.htmlToMarkdown(document.body ? document.body.innerHTML : '');
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
    if (error) throw new Error(error.message || String(error));
    if (!result || !result.ok) throw new Error(result?.error || 'Conversion failed');
    return result;
}

function selectedFolder() {
    return folders.find((f) => f.id === folderSelect.value);
}
function selectedOutliner() {
    return currentOutliners.find((o) => o.id === outSelect.value);
}

function updateClipBtn() {
    const ok = !!(selectedFolder() && selectedOutliner());
    clipBtn.disabled = !ok;
}

async function loadOutlinersForCurrentFolder() {
    const f = selectedFolder();
    if (!f) {
        currentOutliners = [];
        outSelect.innerHTML = '<option>(まず folder を選択)</option>';
        outSelect.disabled = true;
        updateClipBtn();
        return;
    }
    // permission
    if (!(await FractalFolders.hasPermission(f.handle))) {
        const ok = await FractalFolders.requestPermission(f.handle);
        if (!ok) {
            outSelect.innerHTML = '<option>(folder 許可が必要)</option>';
            outSelect.disabled = true;
            setStatus('❌ ' + f.name + ' の書き込み許可が得られませんでした', 'err');
            updateClipBtn();
            return;
        }
    }
    try {
        currentOutliners = await FractalFolders.readOutlinersFromOutlineNote(f.handle);
    } catch (e) {
        currentOutliners = [];
        setStatus('❌ outline.note 読み取り失敗: ' + e.message, 'err');
    }
    outSelect.innerHTML = '';
    outSelect.disabled = false;
    if (currentOutliners.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(.out が見つかりません)';
        outSelect.appendChild(opt);
        outSelect.disabled = true;
    } else {
        for (const o of currentOutliners) {
            const opt = document.createElement('option');
            opt.value = o.id;
            const indent = '  '.repeat(o.depth);
            const prefix = o.folderPath ? '[' + o.folderPath + '] ' : '';
            opt.textContent = indent + prefix + o.title;
            outSelect.appendChild(opt);
        }
    }
    // restore last selection if it matches current folder
    const last = await FractalFolders.getLastSelection();
    if (last && last.folderId === f.id && currentOutliners.find((o) => o.id === last.outId)) {
        outSelect.value = last.outId;
    }
    updateClipBtn();
}

folderSelect.addEventListener('change', async () => {
    clearStatus();
    await loadOutlinersForCurrentFolder();
});

outSelect.addEventListener('change', () => {
    updateClipBtn();
});

clipBtn.addEventListener('click', async () => {
    const folder = selectedFolder();
    const outliner = selectedOutliner();
    if (!folder || !outliner) return;
    clipBtn.disabled = true;
    setStatus('処理中…', 'info');
    try {
        // 1. permission 確認
        if (!(await FractalFolders.hasPermission(folder.handle))) {
            const ok = await FractalFolders.requestPermission(folder.handle);
            if (!ok) throw new Error('フォルダ書き込み許可が得られませんでした');
        }

        // 2. tab 側で変換
        setStatus('ページを Markdown に変換中…', 'info');
        const extracted = await convertActiveTabToMarkdown();
        const title = extracted.title || '(untitled)';
        const pageMd = FractalClipperCore.buildPageMd({
            title,
            url: extracted.url,
            byline: extracted.byline,
            siteName: extracted.siteName,
            markdown: extracted.markdown
        });

        // 3. .out path: <folder>/<outId>.out (notes mode の convention は root 直下)
        const outRelPath = outliner.id + '.out';
        setStatus('.out 読み込み中…', 'info');
        const outFileHandle = await getNestedFileHandle(folder.handle, outRelPath);
        const outData = await readJsonFile(outFileHandle);

        // 4. node 追加
        const result = FractalClipperCore.prependClipNode(outData, { title });

        // 5. page MD 保存 — Notes mode convention: <outId>/<pageId>.md
        // (fractal の notes-file-manager.ts: outData.pageDir 未指定時の default は <outId>)
        setStatus('page MD 保存中…', 'info');
        const explicitPageDir = result.outData && typeof result.outData.pageDir === 'string'
            ? result.outData.pageDir.replace(/^\.\//, '').replace(/\/$/, '')
            : '';
        const pageDirRel = explicitPageDir || outliner.id;
        const pageDirHandle = await getNestedDirHandle(folder.handle, pageDirRel);
        // data:image/... を <pageDir>/images/ に実体化し相対 path に書き換え
        let finalMd = pageMd;
        try {
            const { newMd, savedCount } = await DataUrlImageExtractor.processDataUrlsInMd(pageMd, pageDirHandle);
            finalMd = newMd;
            if (savedCount > 0) {
                setStatus(`画像 ${savedCount} 件を保存中…`, 'info');
            }
        } catch (e) {
            console.warn('[clipper] data URL extract failed, fallback to inline', e);
        }
        const pageMdHandle = await pageDirHandle.getFileHandle(result.pageId + '.md', { create: true });
        await writeTextFile(pageMdHandle, finalMd);

        // 6. .out 書き戻し
        setStatus('.out 書き込み中…', 'info');
        await writeJsonFile(outFileHandle, result.outData);

        // 7. last selection 記憶
        await FractalFolders.setLastSelection(folder.id, outliner.id);

        setStatus('✅ Clip 完了: ' + title, 'ok');
    } catch (e) {
        console.error(e);
        setStatus('❌ ' + (e.message || String(e)), 'err');
    } finally {
        clipBtn.disabled = false;
    }
});

(async () => {
    await FractalFolders.migrateLegacyIfNeeded();
    folders = await FractalFolders.listFolders();
    if (folders.length === 0) {
        setupRequiredEl.style.display = '';
        pickerEl.style.display = 'none';
        return;
    }
    setupRequiredEl.style.display = 'none';
    pickerEl.style.display = '';
    folderSelect.innerHTML = '';
    for (const f of folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = f.name;
        folderSelect.appendChild(opt);
    }
    // restore last selection
    const last = await FractalFolders.getLastSelection();
    if (last && folders.find((f) => f.id === last.folderId)) {
        folderSelect.value = last.folderId;
    }
    await loadOutlinersForCurrentFolder();
})();
