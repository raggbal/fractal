'use strict';

const setupRequiredEl = document.getElementById('setupRequired');
const pickerEl = document.getElementById('picker');
const presetRowEl = document.getElementById('presetRow');
const presetSelect = document.getElementById('presetSelect');
const manualRowsEl = document.getElementById('manualRows');
const folderSelect = document.getElementById('folderSelect');
const outSelect = document.getElementById('outSelect');
const clipBtn = document.getElementById('clipBtn');
const openOptionsBtn = document.getElementById('openOptionsBtn');
const optionsLink = document.getElementById('optionsLink');
const statusEl = document.getElementById('status');

const MANUAL_VALUE = '__manual__';

openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

let folders = [];          // [{id, name, handle}]
let presets = [];          // [{id, name, folderId, targetId, targetKind}]
let currentTargets = [];   // [{id, title, depth, folderPath, kind}]

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
    const parts = (relDir || '').split('/').filter((p) => p);
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

/**
 * outline.note の md item の実ファイル handle を解決（新フラットレイアウト前提: <folder>/<id>.md 固定）。
 * 見つからなければ throw（呼び出し側で表示）。
 */
async function resolveMdTarget(folderHandle, mdId) {
    const fh = await folderHandle.getFileHandle(mdId + '.md');
    return { fileHandle: fh, dirHandle: folderHandle };
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
                // SVG 前処理: inlineSvgComputedStyles + preSerializeSvgsToImages（既存どおり）
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
function selectedTarget() {
    return currentTargets.find((o) => o.id === outSelect.value);
}
function selectedPreset() {
    const v = presetSelect.value;
    if (!v || v === MANUAL_VALUE) return null;
    return presets.find((p) => p.id === v) || null;
}

/** 現在の実効保存先 { folder, targetId, targetKind } | null */
function effectiveSelection() {
    const preset = selectedPreset();
    if (preset) {
        const folder = folders.find((f) => f.id === preset.folderId);
        if (!folder) return null;
        return { folder, targetId: preset.targetId, targetKind: preset.targetKind };
    }
    const folder = selectedFolder();
    const target = selectedTarget();
    if (!folder || !target) return null;
    return { folder, targetId: target.id, targetKind: target.kind || 'out' };
}

function updateClipBtn() {
    clipBtn.disabled = !effectiveSelection();
}

function updateManualVisibility() {
    manualRowsEl.style.display = selectedPreset() ? 'none' : '';
    updateClipBtn();
}

async function loadTargetsForCurrentFolder() {
    const f = selectedFolder();
    if (!f) {
        currentTargets = [];
        outSelect.innerHTML = '<option>(まず Note を選択)</option>';
        outSelect.disabled = true;
        updateClipBtn();
        return;
    }
    if (!(await FractalFolders.hasPermission(f.handle))) {
        const ok = await FractalFolders.requestPermission(f.handle);
        if (!ok) {
            outSelect.innerHTML = '<option>(Note の許可が必要)</option>';
            outSelect.disabled = true;
            setStatus('❌ ' + f.name + ' の書き込み許可が得られませんでした', 'err');
            updateClipBtn();
            return;
        }
    }
    try {
        // FR-CL-03: outliner (.out) と md の両方を種別付きで一覧
        currentTargets = await FractalFolders.readTargetsFromOutlineNote(f.handle);
    } catch (e) {
        currentTargets = [];
        setStatus('❌ outline.note 読み取り失敗: ' + e.message, 'err');
    }
    outSelect.innerHTML = '';
    outSelect.disabled = false;
    if (currentTargets.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = '(.out / .md が見つかりません)';
        outSelect.appendChild(opt);
        outSelect.disabled = true;
    } else {
        for (const o of currentTargets) {
            const opt = document.createElement('option');
            opt.value = o.id;
            const indent = '  '.repeat(o.depth);
            const prefix = o.folderPath ? '[' + o.folderPath + '] ' : '';
            const icon = o.kind === 'md' ? '📝 ' : '📄 ';
            opt.textContent = indent + icon + prefix + o.title;
            outSelect.appendChild(opt);
        }
    }
    // restore last selection if it matches current folder
    const last = await FractalFolders.getLastSelection();
    if (last && last.folderId === f.id && currentTargets.find((o) => o.id === last.targetId)) {
        outSelect.value = last.targetId;
    }
    updateClipBtn();
}

presetSelect.addEventListener('change', () => {
    clearStatus();
    updateManualVisibility();
});

folderSelect.addEventListener('change', async () => {
    clearStatus();
    await loadTargetsForCurrentFolder();
});

outSelect.addEventListener('change', () => {
    updateClipBtn();
});

// ── clip 実行 ──

/** outliner (.out) への clip（フラット規約・ADRL-0018） */
async function clipToOutliner(folder, outId, extracted) {
    const title = extracted.title || '(untitled)';
    const pageMd = FractalClipperCore.buildPageMd({
        title,
        url: extracted.url,
        byline: extracted.byline,
        siteName: extracted.siteName,
        markdown: extracted.markdown
    });

    setStatus('.out 読み込み中…', 'info');
    const outFileHandle = await getNestedFileHandle(folder.handle, outId + '.out');
    const outData = await readJsonFile(outFileHandle);

    const result = FractalClipperCore.prependClipNode(outData, { title });

    // 保存先解決: 新フラットレイアウト前提（hint 尊重・無ければ note 直下）
    const hints = { pageDir: outData.pageDir, imageDir: outData.imageDir, fileDir: outData.fileDir };
    const writeDirRel = FractalFlatLayout.chooseWriteDirRel(hints, outId);
    const pageDirHandle = writeDirRel ? await getNestedDirHandle(folder.handle, writeDirRel) : folder.handle;

    setStatus('page MD 保存中…', 'info');
    // data:image/... を page md 隣の画像 dir に実体化（imageDir ヒント尊重・default 'images' = FR-CL-02）
    const imagesSubdir = FractalFlatLayout.resolveImagesDirRel(hints);
    let finalMd = pageMd;
    try {
        const { newMd, savedCount } = await DataUrlImageExtractor.processDataUrlsInMd(pageMd, pageDirHandle, imagesSubdir);
        finalMd = newMd;
        if (savedCount > 0) setStatus(`画像 ${savedCount} 件を保存中…`, 'info');
    } catch (e) {
        console.warn('[clipper] data URL extract failed, fallback to inline', e);
    }
    const pageMdHandle = await pageDirHandle.getFileHandle(result.pageId + '.md', { create: true });
    await writeTextFile(pageMdHandle, finalMd);

    setStatus('.out 書き込み中…', 'info');
    await writeJsonFile(outFileHandle, result.outData);
    return { title, dest: outId + '.out' };
}

/** md への clip（FR-CL-05: 新規 <uuid>.md を対象 md と同じ dir に + 末尾に subpage リンク追記・ADRL-0018 decision 4） */
async function clipToMd(folder, mdId, extracted) {
    const title = extracted.title || '(untitled)';
    const pageMd = FractalClipperCore.buildPageMd({
        title,
        url: extracted.url,
        byline: extracted.byline,
        siteName: extracted.siteName,
        markdown: extracted.markdown
    });

    setStatus('対象 md 読み込み中…', 'info');
    const { fileHandle: targetMdHandle, dirHandle: targetDirHandle } = await resolveMdTarget(folder.handle, mdId);
    const targetFile = await targetMdHandle.getFile();
    const targetText = await targetFile.text();

    // 新規 md 名 + 対象 md の追記本文（pure）
    const clip = FractalClipperCore.buildMdClipResult({ targetMdText: targetText, title });

    setStatus('新規 md 保存中…', 'info');
    // 画像は新規 md 隣の images/（= 対象 md と同 dir の images/。本体 resolveImagesDirForMd と一致）
    let finalMd = pageMd;
    try {
        const { newMd, savedCount } = await DataUrlImageExtractor.processDataUrlsInMd(pageMd, targetDirHandle);
        finalMd = newMd;
        if (savedCount > 0) setStatus(`画像 ${savedCount} 件を保存中…`, 'info');
    } catch (e) {
        console.warn('[clipper] data URL extract failed, fallback to inline', e);
    }
    const newMdHandle = await targetDirHandle.getFileHandle(clip.newMdName, { create: true });
    await writeTextFile(newMdHandle, finalMd);

    setStatus('subpage リンク追記中…', 'info');
    await writeTextFile(targetMdHandle, clip.appendedTargetText);
    return { title, dest: mdId + '.md' };
}

clipBtn.addEventListener('click', async () => {
    const sel = effectiveSelection();
    if (!sel) return;
    clipBtn.disabled = true;
    setStatus('処理中…', 'info');
    try {
        // 1. permission 確認
        if (!(await FractalFolders.hasPermission(sel.folder.handle))) {
            const ok = await FractalFolders.requestPermission(sel.folder.handle);
            if (!ok) throw new Error('Note への書き込み許可が得られませんでした');
        }

        // 2. tab 側で変換
        setStatus('ページを Markdown に変換中…', 'info');
        const extracted = await convertActiveTabToMarkdown();

        // 3. 保存（out / md 分岐）
        const result = sel.targetKind === 'md'
            ? await clipToMd(sel.folder, sel.targetId, extracted)
            : await clipToOutliner(sel.folder, sel.targetId, extracted);

        // 4. last selection 記憶
        await FractalFolders.setLastSelection(sel.folder.id, sel.targetId, sel.targetKind);

        setStatus('✅ Clip 完了: ' + result.title + ' → ' + result.dest, 'ok');
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

    // Note 表示名（outline.note の noteTitle 優先。フォルダ名 fallback）
    const noteLabels = {};
    for (const f of folders) {
        noteLabels[f.id] = await FractalFolders.getNoteLabel(f.handle, f.name);
    }

    // presets（default 初期選択・FR-CL-04）
    presets = await FractalFolders.listPresets();
    const defaultPreset = await FractalFolders.getDefaultPreset();
    if (presets.length > 0) {
        presetRowEl.style.display = '';
        presetSelect.innerHTML = '';
        for (const p of presets) {
            const opt = document.createElement('option');
            opt.value = p.id;
            const noteLabel = noteLabels[p.folderId] || '?';
            const icon = p.targetKind === 'md' ? '📝' : '📄';
            // 保存先タイトルは毎回最新解決（md=本文 H1 / out=outline.note title）
            const pf = folders.find((f) => f.id === p.folderId);
            const targetTitle = pf
                ? await FractalFolders.getTargetTitle(pf.handle, p.targetId, p.targetKind, p.targetTitle || p.targetId)
                : (p.targetTitle || p.targetId);
            opt.textContent = (defaultPreset && defaultPreset.id === p.id ? '★ ' : '') + p.name + ' (' + noteLabel + ' / ' + icon + ' ' + targetTitle + ')';
            presetSelect.appendChild(opt);
        }
        const manualOpt = document.createElement('option');
        manualOpt.value = MANUAL_VALUE;
        manualOpt.textContent = '(手動選択…)';
        presetSelect.appendChild(manualOpt);
        presetSelect.value = defaultPreset ? defaultPreset.id : MANUAL_VALUE;
    } else {
        presetRowEl.style.display = 'none';
    }

    folderSelect.innerHTML = '';
    for (const f of folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = noteLabels[f.id] || f.name;
        folderSelect.appendChild(opt);
    }
    // restore last selection
    const last = await FractalFolders.getLastSelection();
    if (last && folders.find((f) => f.id === last.folderId)) {
        folderSelect.value = last.folderId;
    }
    await loadTargetsForCurrentFolder();
    updateManualVisibility();
})();
