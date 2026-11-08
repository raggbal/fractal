'use strict';

// note の一覧（.fractal）
const chooseListBtn = document.getElementById('chooseListBtn');
const listSummary = document.getElementById('listSummary');
const listReauthBtn = document.getElementById('listReauthBtn');
const listStatus = document.getElementById('listStatus');
const noteListEl = document.getElementById('noteList');
// 許可したフォルダ
const allowFolderBtn = document.getElementById('allowFolderBtn');
const accessSuggest = document.getElementById('accessSuggest');
const accessStatus = document.getElementById('accessStatus');
const rootListEl = document.getElementById('rootList');
// 以前の登録（〜0.4.x の 1 つずつの登録）
const legacySection = document.getElementById('legacySection');
const folderListEl = document.getElementById('folderList');
// 保存先プリセット UI（FR-CL-04）
const presetFolderSelect = document.getElementById('presetFolderSelect');
const presetTargetSelect = document.getElementById('presetTargetSelect');
const presetNameInput = document.getElementById('presetNameInput');
const addPresetBtn = document.getElementById('addPresetBtn');
const presetStatus = document.getElementById('presetStatus');
const presetListEl = document.getElementById('presetList');

const t = (key, params) => FractalI18n.t(key, params);
/** 件数の文（1 件は <key>_one） */
const tn = (key, params) => t(params.count === 1 ? key + '_one' : key, params);

let list = null;        // FractalFolders.readFractalList()（未設定 = null）
let notes = [];         // FractalFolders.listNotes(list)
let presetTargets = []; // [{id, title, depth, folderPath, kind}]

function setStatus(el, text, kind) {
    el.style.display = '';
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
}

function clearStatus(el) {
    el.style.display = 'none';
    el.textContent = '';
    el.className = 'status';
}

function emptyItem(key) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = t(key);
    return li;
}

function smallButton(text, className, onClick) {
    const b = document.createElement('button');
    b.className = className || 'small';
    b.textContent = text;
    b.addEventListener('click', onClick);
    return b;
}

/** note の保存できる状態: 'ok' | 'reauth'（許可が切れた）| 'none'（許可したフォルダの下にない）| 'missing'（フォルダが無い） */
async function noteState(note) {
    if (!note.permHandle) return 'none';
    if (!(await FractalFolders.hasPermission(note.permHandle))) return 'reauth';
    try {
        await FractalFolders.noteHandle(note);
        return 'ok';
    } catch {
        return 'missing';
    }
}

/** 表示名: 開ければ outline.note の noteTitle、無ければフォルダ名 */
async function noteLabel(note) {
    if (!note.permHandle || !(await FractalFolders.hasPermission(note.permHandle))) return note.name;
    try {
        return await FractalFolders.getNoteLabel(await FractalFolders.noteHandle(note), note.name);
    } catch {
        return note.name;
    }
}

async function refresh() {
    list = await FractalFolders.readFractalList();
    if (list && list.state === 'ok') {
        // 以前の登録のうち .fractal にある note は、許可があれば引き継ぐ
        const n = await FractalFolders.adoptLegacyFolders(list.notes);
        if (n > 0) setStatus(accessStatus, tn('options_adopted', { count: n }), 'ok');
    }
    notes = await FractalFolders.listNotes(list);
    renderList();
    await renderNotes();
    await renderRoots();
    await renderLegacy();
    await refreshPresetFolderSelect();
    await refreshPresetList();
}

function renderList() {
    listReauthBtn.style.display = 'none';
    clearStatus(listStatus);
    if (!list) {
        listSummary.textContent = t('options_list_none');
        return;
    }
    listSummary.textContent = tn('options_list_summary', { name: list.name, count: list.notes.length });
    if (list.state === 'permission') {
        setStatus(listStatus, t('options_reauth_needed'), 'err');
        listReauthBtn.style.display = '';
    } else if (list.state === 'error') {
        setStatus(listStatus, t('options_list_read_failed', { name: list.name, message: list.error }), 'err');
    }
}

// 一覧は組み終えてから入れ替える（読み込みの途中を見せない・続けて refresh しても行が重ならない）
async function renderNotes() {
    const items = document.createDocumentFragment();
    const listed = notes.filter((n) => n.source === 'list');
    if (listed.length === 0) {
        items.appendChild(emptyItem(list ? 'options_list_empty' : 'options_no_list_notes'));
    }
    const blocked = [];
    for (const n of listed) {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = await noteLabel(n);
        const pathEl = document.createElement('span');
        pathEl.className = 'path';
        pathEl.textContent = n.path;
        nameEl.appendChild(pathEl);
        li.appendChild(nameEl);

        const state = await noteState(n);
        const st = document.createElement('span');
        st.className = state === 'ok' ? 'ok' : 'perm-warn';
        st.textContent = state === 'ok' ? t('options_note_ok')
            : state === 'reauth' ? t('options_reauth_needed')
                : state === 'missing' ? t('options_read_failed')
                    : t('options_note_no_access');
        li.appendChild(st);
        if (state === 'none') blocked.push(n.path);
        items.appendChild(li);
    }
    noteListEl.replaceChildren(items);
    accessSuggest.textContent = blocked.length
        ? t('options_access_suggest', { paths: FractalList.suggestFolders(blocked).join(', ') })
        : '';
}

async function renderRoots() {
    const roots = await FractalFolders.listAccessRoots();
    const items = document.createDocumentFragment();
    if (roots.length === 0) items.appendChild(emptyItem('options_no_roots'));
    for (const r of roots) {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = r.path;
        li.appendChild(nameEl);
        if (!(await FractalFolders.hasPermission(r.handle))) {
            const warn = document.createElement('span');
            warn.className = 'perm-warn';
            warn.textContent = t('options_reauth_needed');
            li.appendChild(warn);
            li.appendChild(smallButton(t('options_reauth_button'), 'small', async () => {
                if (await FractalFolders.requestPermission(r.handle)) await refresh();
                else setStatus(accessStatus, t('options_permission_denied'), 'err');
            }));
        }
        li.appendChild(smallButton(t('options_remove'), 'danger small', async () => {
            await FractalFolders.removeAccessRoot(r.path);
            await refresh();
        }));
        items.appendChild(li);
    }
    rootListEl.replaceChildren(items);
}

async function renderLegacy() {
    const folders = await FractalFolders.listFolders();
    const items = document.createDocumentFragment();
    for (const f of folders) {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        // Note タイトル（outline.note の noteTitle）優先・フォルダ名 fallback
        nameEl.textContent = await FractalFolders.getNoteLabel(f.handle, f.name);
        li.appendChild(nameEl);
        if (!(await FractalFolders.hasPermission(f.handle))) {
            const warn = document.createElement('span');
            warn.className = 'perm-warn';
            warn.textContent = t('options_reauth_needed');
            li.appendChild(warn);
            li.appendChild(smallButton(t('options_reauth_button'), 'small', async () => {
                if (await FractalFolders.requestPermission(f.handle)) await refresh();
                else setStatus(accessStatus, t('options_permission_denied'), 'err');
            }));
        }
        li.appendChild(smallButton(t('options_remove'), 'danger small', async () => {
            if (!confirm(t('options_confirm_unregister', { name: f.name }))) return;
            await FractalFolders.removeFolder(f.id);
            await refresh();
        }));
        items.appendChild(li);
    }
    folderListEl.replaceChildren(items);
    legacySection.style.display = folders.length ? '' : 'none';
}

chooseListBtn.addEventListener('click', async () => {
    clearStatus(listStatus);
    let handle;
    try {
        [handle] = await window.showOpenFilePicker({
            id: 'fractal-list',
            multiple: false,
            types: [{ description: 'Fractal notes list', accept: { 'application/json': ['.fractal'] } }]
        });
    } catch (e) {
        if (e.name === 'AbortError') return;
        setStatus(listStatus, '❌ ' + e.message, 'err');
        return;
    }
    try {
        await FractalFolders.setFractalList(handle);
    } catch (e) {
        setStatus(listStatus, t('options_list_read_failed', { name: handle.name, message: e.message }), 'err');
        return;
    }
    await refresh();
});

listReauthBtn.addEventListener('click', async () => {
    if (list && (await FractalFolders.requestPermission(list.handle, 'read'))) await refresh();
    else setStatus(listStatus, t('options_permission_denied'), 'err');
});

allowFolderBtn.addEventListener('click', async () => {
    clearStatus(accessStatus);
    if (!list || list.notes.length === 0) {
        setStatus(accessStatus, t('options_access_need_list'), 'err');
        return;
    }
    let handle;
    try {
        handle = await window.showDirectoryPicker({ id: 'fractal-notes', mode: 'readwrite' });
    } catch (e) {
        if (e.name === 'AbortError') return;
        setStatus(accessStatus, '❌ ' + e.message, 'err');
        return;
    }
    let r;
    try {
        r = await FractalFolders.addAccessRoot(handle, list.notes);
    } catch (e) {
        setStatus(accessStatus,
            e.reason === 'ambiguous' ? t('options_access_ambiguous')
                : e.reason === 'none' ? t('options_access_none')
                    : '❌ ' + e.message, 'err');
        return;
    }
    await refresh();
    setStatus(accessStatus, tn('options_access_added', { path: r.path, count: r.notes.length }), 'ok');
});

// ── 保存先プリセット管理（FR-CL-04）──

/** プリセットに選べる note（許可したフォルダの下にある .fractal の note と、以前の登録） */
function presetNotes() {
    return notes.filter((n) => n.permHandle);
}

async function refreshPresetFolderSelect() {
    const current = presetFolderSelect.value;
    presetFolderSelect.innerHTML = '<option value="">(Note…)</option>';
    for (const n of presetNotes()) {
        const opt = document.createElement('option');
        opt.value = n.id;
        opt.textContent = n.source === 'legacy' ? t('popup_note_legacy', { name: await noteLabel(n) }) : await noteLabel(n);
        presetFolderSelect.appendChild(opt);
    }
    if (current && presetNotes().some((n) => n.id === current)) presetFolderSelect.value = current;
    else presetTargetSelect.innerHTML = '<option>' + t('options_select_note') + '</option>';
}

async function loadPresetTargets() {
    const n = presetNotes().find((x) => x.id === presetFolderSelect.value);
    presetTargetSelect.innerHTML = '';
    presetTargets = [];
    if (!n) {
        presetTargetSelect.innerHTML = '<option>' + t('options_select_note') + '</option>';
        return;
    }
    if (!(await FractalFolders.hasPermission(n.permHandle))) {
        const ok = await FractalFolders.requestPermission(n.permHandle);
        if (!ok) {
            presetTargetSelect.innerHTML = '<option>' + t('options_note_permission_needed') + '</option>';
            return;
        }
    }
    try {
        presetTargets = await FractalFolders.readTargetsFromOutlineNote(await FractalFolders.noteHandle(n));
    } catch (e) {
        presetTargetSelect.innerHTML = '<option>' + t('options_read_failed') + '</option>';
        return;
    }
    for (const tg of presetTargets) {
        const opt = document.createElement('option');
        opt.value = tg.id;
        const icon = tg.kind === 'md' ? '📝 ' : '📄 ';
        const prefix = tg.folderPath ? '[' + tg.folderPath + '] ' : '';
        opt.textContent = icon + prefix + tg.title;
        presetTargetSelect.appendChild(opt);
    }
}

async function refreshPresetList() {
    const presets = await FractalFolders.listPresets();
    const def = await FractalFolders.getDefaultPreset();
    const items = document.createDocumentFragment();
    if (presets.length === 0) items.appendChild(emptyItem('options_no_presets'));
    for (const p of presets) {
        const li = document.createElement('li');
        const defRadio = document.createElement('input');
        defRadio.type = 'radio';
        defRadio.name = 'defaultPreset';
        defRadio.checked = !!(def && def.id === p.id);
        defRadio.title = t('options_default_radio_title');
        defRadio.addEventListener('change', async () => {
            await FractalFolders.setDefaultPreset(p.id);
            await refreshPresetList();
        });
        li.appendChild(defRadio);

        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        const note = await FractalFolders.findNote(p.folderId);
        const noteText = note ? await noteLabel(note) : '?';
        // 保存先タイトルは毎回最新解決（md=本文 H1 / out=outline.note title。旧プリセットの id 表示も治る）
        let targetTitle = p.targetTitle || p.targetId;
        if (note && (await noteState(note)) === 'ok') {
            targetTitle = await FractalFolders.getTargetTitle(await FractalFolders.noteHandle(note), p.targetId, p.targetKind, targetTitle);
        }
        const icon = p.targetKind === 'md' ? '📝' : '📄';
        nameEl.textContent = (def && def.id === p.id ? '★ ' : '') + p.name + '  —  ' + noteText + ' / ' + icon + ' ' + targetTitle;
        li.appendChild(nameEl);

        li.appendChild(smallButton(t('options_remove'), 'danger small', async () => {
            await FractalFolders.removePreset(p.id);
            await refreshPresetList();
        }));
        items.appendChild(li);
    }
    presetListEl.replaceChildren(items);
}

presetFolderSelect.addEventListener('change', loadPresetTargets);

addPresetBtn.addEventListener('click', async () => {
    clearStatus(presetStatus);
    const folderId = presetFolderSelect.value;
    const target = presetTargets.find((x) => x.id === presetTargetSelect.value);
    if (!folderId || !target) {
        setStatus(presetStatus, t('options_select_note_and_dest'), 'err');
        return;
    }
    const name = presetNameInput.value.trim() || target.title;
    const added = await FractalFolders.addPreset({ name, folderId, targetId: target.id, targetKind: target.kind, targetTitle: target.title });
    // 最初のプリセットは自動で default に（すぐ使える状態にする）
    const presets = await FractalFolders.listPresets();
    const def = await FractalFolders.getDefaultPreset();
    if (presets.length === 1 || !def) {
        await FractalFolders.setDefaultPreset(added.id);
    }
    presetNameInput.value = '';
    setStatus(presetStatus, t('options_preset_added'), 'ok');
    await refreshPresetList();
});

(async () => {
    // i18n 初期化（ADRL-0001）
    const langStore = await chrome.storage.local.get('language');
    FractalI18n.init(langStore.language);
    FractalI18n.applyDom(document);
    const langSelect = document.getElementById('langSelect');
    if (langSelect) {
        langSelect.value = FractalI18n.getLang();
        langSelect.addEventListener('change', async () => {
            await chrome.storage.local.set({ language: langSelect.value });
            FractalI18n.init(langSelect.value);
            FractalI18n.applyDom(document);
            // 動的リスト（note / 許可したフォルダ / プリセット）の文言も新言語で再描画
            await refresh();
        });
    }
    await FractalFolders.migrateLegacyIfNeeded();
    await refresh();
})();
