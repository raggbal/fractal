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
const listNoticeEl = document.getElementById('listNotice');
const listNoticeText = document.getElementById('listNoticeText');
const listAllowLink = document.getElementById('listAllowLink');

const MANUAL_VALUE = '__manual__';

openOptionsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
optionsLink.addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
});

let list = null;           // FractalFolders.readFractalList()（.fractal 未設定 = null）
let notes = [];            // FractalFolders.listNotes(list): [{id, name, path, source, root, rel, legacy, permHandle}]
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

function selectedNote() {
    return notes.find((n) => n.id === folderSelect.value);
}
function selectedTarget() {
    return currentTargets.find((o) => o.id === outSelect.value);
}
function selectedPreset() {
    const v = presetSelect.value;
    if (!v || v === MANUAL_VALUE) return null;
    return presets.find((p) => p.id === v) || null;
}

/** 現在の実効保存先 { note, targetId, targetKind } | null */
function effectiveSelection() {
    const preset = selectedPreset();
    if (preset) {
        const note = notes.find((n) => n.id === preset.folderId);
        if (!note) return null;
        return { note, targetId: preset.targetId, targetKind: preset.targetKind };
    }
    const note = selectedNote();
    const target = selectedTarget();
    if (!note || !target) return null;
    return { note, targetId: target.id, targetKind: target.kind || 'out' };
}

/** 表示名: 許可があれば outline.note の noteTitle、無ければフォルダ名（ここでは許可を求めない） */
async function noteLabel(note) {
    if (!note.permHandle || !(await FractalFolders.hasPermission(note.permHandle))) return note.name;
    try {
        return await FractalFolders.getNoteLabel(await FractalFolders.noteHandle(note), note.name);
    } catch {
        return note.name;
    }
}

/** preset の保存先タイトル（毎回最新解決: md=本文 H1 / out=outline.note title。開けなければ保存した名前） */
async function presetTargetTitle(note, p) {
    const fallback = p.targetTitle || p.targetId;
    if (!note || !note.permHandle || !(await FractalFolders.hasPermission(note.permHandle))) return fallback;
    try {
        return await FractalFolders.getTargetTitle(await FractalFolders.noteHandle(note), p.targetId, p.targetKind, fallback);
    } catch {
        return fallback;
    }
}

/** .fractal を読めなかったとき（許可切れ・壊れている）の 1 行。note は最後に読めた一覧を使う */
function showListNotice() {
    listNoticeEl.style.display = 'none';
    if (!list || list.state === 'ok') return;
    listNoticeEl.style.display = '';
    const needsPermission = list.state === 'permission';
    listNoticeText.textContent = needsPermission
        ? FractalI18n.t('popup_list_needs_permission', { name: list.name })
        : FractalI18n.t('popup_list_read_failed', { name: list.name, message: list.error });
    listAllowLink.style.display = needsPermission ? '' : 'none';
}

listAllowLink.addEventListener('click', async (e) => {
    e.preventDefault();
    if (list && (await FractalFolders.requestPermission(list.handle, 'read'))) location.reload();
});

function updateClipBtn() {
    clipBtn.disabled = !effectiveSelection();
}

function updateManualVisibility() {
    manualRowsEl.style.display = selectedPreset() ? 'none' : '';
    updateClipBtn();
}

async function loadTargetsForCurrentFolder() {
    const f = selectedNote();
    if (!f) {
        currentTargets = [];
        outSelect.innerHTML = '<option>' + FractalI18n.t('popup_select_note_first') + '</option>';
        outSelect.disabled = true;
        updateClipBtn();
        return;
    }
    if (!f.permHandle) {
        currentTargets = [];
        outSelect.innerHTML = '<option>' + FractalI18n.t('popup_permission_needed') + '</option>';
        outSelect.disabled = true;
        setStatus(FractalI18n.t('popup_no_access', { name: f.name }), 'err');
        updateClipBtn();
        return;
    }
    if (!(await FractalFolders.hasPermission(f.permHandle))) {
        const ok = await FractalFolders.requestPermission(f.permHandle);
        if (!ok) {
            outSelect.innerHTML = '<option>' + FractalI18n.t('popup_permission_needed') + '</option>';
            outSelect.disabled = true;
            setStatus(FractalI18n.t('popup_write_permission_denied', { name: f.name }), 'err');
            updateClipBtn();
            return;
        }
    }
    try {
        // FR-CL-03: outliner (.out) と md の両方を種別付きで一覧
        currentTargets = await FractalFolders.readTargetsFromOutlineNote(await FractalFolders.noteHandle(f));
    } catch (e) {
        currentTargets = [];
        setStatus(FractalI18n.t('popup_outline_read_failed', { message: e.message }), 'err');
    }
    outSelect.innerHTML = '';
    outSelect.disabled = false;
    if (currentTargets.length === 0) {
        const opt = document.createElement('option');
        opt.textContent = FractalI18n.t('popup_no_out_md_found');
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

/** 生成 md のラベル（FR-CI-05: 言語設定に従う。core は labels で受ける = i18n 非依存） */
function clipLabels() {
    return {
        source: FractalI18n.t('core_label_source'),
        author: FractalI18n.t('core_label_author'),
        site: FractalI18n.t('core_label_site')
    };
}

/** 保存（lib/clip-writer.js — quick clip の background.js と同じもの）。途中の経過を status に出す */
async function clipTo(sel, extracted) {
    const opts = { labels: clipLabels(), onStatus: (key, params) => setStatus(FractalI18n.t(key, params), 'info') };
    const handle = await FractalFolders.noteHandle(sel.note);
    return sel.targetKind === 'md'
        ? FractalClipWriter.clipToMd(handle, sel.targetId, extracted, opts)
        : FractalClipWriter.clipToOutliner(handle, sel.targetId, extracted, opts);
}

clipBtn.addEventListener('click', async () => {
    const sel = effectiveSelection();
    if (!sel) return;
    if (!sel.note.permHandle) {
        // .fractal の note で、許可したフォルダの下にない（preset が指している場合）
        setStatus(FractalI18n.t('popup_no_access', { name: sel.note.name }), 'err');
        return;
    }
    clipBtn.disabled = true;
    setStatus(FractalI18n.t('popup_processing'), 'info');
    try {
        // 1. permission 確認（.fractal の note は許可したフォルダの許可）
        if (!(await FractalFolders.hasPermission(sel.note.permHandle))) {
            const ok = await FractalFolders.requestPermission(sel.note.permHandle);
            if (!ok) throw new Error(FractalI18n.t('popup_note_write_permission_denied'));
        }

        // 2. tab 側で変換
        setStatus(FractalI18n.t('popup_converting_markdown'), 'info');
        const extracted = await convertActiveTabToMarkdown();

        // 3. 保存（out / md 分岐）
        const result = await clipTo(sel, extracted);

        // 4. last selection 記憶
        await FractalFolders.setLastSelection(sel.note.id, sel.targetId, sel.targetKind);

        setStatus(FractalI18n.t('popup_clip_done', { title: result.title, dest: result.dest }), 'ok');
    } catch (e) {
        console.error(e);
        setStatus('❌ ' + (e.message || String(e)), 'err');
    } finally {
        clipBtn.disabled = false;
    }
});

(async () => {
    // i18n 初期化（ADRL-0001: chrome.storage.local の 'language'、未設定 = 'en'）
    const langStore = await chrome.storage.local.get('language');
    FractalI18n.init(langStore.language);
    FractalI18n.applyDom(document);
    // 言語切替 UI は options（Settings）のみ（ユーザー決定 2026-07-27: popup には置かない）。
    // popup は storage の 'language' を読んで表示するだけ。
    await FractalFolders.migrateLegacyIfNeeded();
    // note は .fractal から毎回読む（Fractal で足した note もそのまま出る）+ まだ残っている以前の登録
    list = await FractalFolders.readFractalList();
    if (list && list.state === 'ok') await FractalFolders.adoptLegacyFolders(list.notes);
    notes = await FractalFolders.listNotes(list);
    if (notes.length === 0) {
        setupRequiredEl.style.display = '';
        pickerEl.style.display = 'none';
        return;
    }
    setupRequiredEl.style.display = 'none';
    pickerEl.style.display = '';
    showListNotice();

    // Note 表示名（outline.note の noteTitle 優先。フォルダ名 fallback）
    const noteLabels = {};
    for (const n of notes) {
        noteLabels[n.id] = await noteLabel(n);
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
            const pn = notes.find((n) => n.id === p.folderId);
            const icon = p.targetKind === 'md' ? '📝' : '📄';
            const targetTitle = await presetTargetTitle(pn, p);
            opt.textContent = (defaultPreset && defaultPreset.id === p.id ? '★ ' : '') + p.name + ' (' + (pn ? noteLabels[pn.id] : '?') + ' / ' + icon + ' ' + targetTitle + ')';
            presetSelect.appendChild(opt);
        }
        const manualOpt = document.createElement('option');
        manualOpt.value = MANUAL_VALUE;
        manualOpt.textContent = FractalI18n.t('popup_manual_select');
        presetSelect.appendChild(manualOpt);
        presetSelect.value = defaultPreset ? defaultPreset.id : MANUAL_VALUE;
    } else {
        presetRowEl.style.display = 'none';
    }

    // .fractal の note（許可したフォルダの下にないものは選べない）+ 以前の登録
    folderSelect.innerHTML = '';
    for (const n of notes) {
        const opt = document.createElement('option');
        opt.value = n.id;
        const label = noteLabels[n.id] || n.name;
        if (n.source === 'legacy') {
            opt.textContent = FractalI18n.t('popup_note_legacy', { name: label });
        } else if (!n.permHandle) {
            opt.textContent = FractalI18n.t('popup_note_no_access', { name: label });
            opt.disabled = true;
        } else {
            opt.textContent = label;
        }
        folderSelect.appendChild(opt);
    }
    const usable = notes.filter((n) => n.permHandle);
    if (usable.length) folderSelect.value = usable[0].id;
    // restore last selection
    const last = await FractalFolders.getLastSelection();
    if (last && usable.find((n) => n.id === last.folderId)) {
        folderSelect.value = last.folderId;
    }
    await loadTargetsForCurrentFolder();
    updateManualVisibility();
})();
