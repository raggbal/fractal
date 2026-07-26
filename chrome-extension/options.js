'use strict';

const folderListEl = document.getElementById('folderList');
const addFolderBtn = document.getElementById('addFolderBtn');
const addStatus = document.getElementById('addStatus');
// 保存先プリセット UI（FR-CL-04）
const presetFolderSelect = document.getElementById('presetFolderSelect');
const presetTargetSelect = document.getElementById('presetTargetSelect');
const presetNameInput = document.getElementById('presetNameInput');
const addPresetBtn = document.getElementById('addPresetBtn');
const presetStatus = document.getElementById('presetStatus');
const presetListEl = document.getElementById('presetList');

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

async function refreshUI() {
    const folders = await FractalFolders.listFolders();
    folderListEl.innerHTML = '';
    if (folders.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = FractalI18n.t('options_no_notes');
        folderListEl.appendChild(empty);
        return;
    }
    for (const f of folders) {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        // Note タイトル（outline.note の noteTitle）優先・フォルダ名 fallback
        nameEl.textContent = await FractalFolders.getNoteLabel(f.handle, f.name);
        li.appendChild(nameEl);

        // Permission state
        const hasPerm = await FractalFolders.hasPermission(f.handle);
        if (!hasPerm) {
            const warn = document.createElement('span');
            warn.className = 'perm-warn';
            warn.textContent = FractalI18n.t('options_reauth_needed');
            li.appendChild(warn);
            const reauthBtn = document.createElement('button');
            reauthBtn.className = 'small';
            reauthBtn.textContent = FractalI18n.t('options_reauth_button');
            reauthBtn.addEventListener('click', async () => {
                const ok = await FractalFolders.requestPermission(f.handle);
                if (ok) await refreshUI();
                else setStatus(addStatus, FractalI18n.t('options_permission_denied'), 'err');
            });
            li.appendChild(reauthBtn);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger small';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
            if (!confirm(FractalI18n.t('options_confirm_unregister', { name: f.name }))) return;
            await FractalFolders.removeFolder(f.id);
            await refreshUI();
        });
        li.appendChild(removeBtn);
        folderListEl.appendChild(li);
    }
}

addFolderBtn.addEventListener('click', async () => {
    clearStatus(addStatus);
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        const entry = await FractalFolders.addFolder(handle);
        setStatus(addStatus, FractalI18n.t('options_registered', { name: entry.name }), 'ok');
        await refreshUI();
    } catch (e) {
        if (e.name === 'AbortError') return;
        setStatus(addStatus, '❌ ' + e.message, 'err');
    }
});

// ── 保存先プリセット管理（FR-CL-04）──

async function refreshPresetFolderSelect() {
    const folders = await FractalFolders.listFolders();
    presetFolderSelect.innerHTML = '<option value="">(Note…)</option>';
    for (const f of folders) {
        const opt = document.createElement('option');
        opt.value = f.id;
        opt.textContent = await FractalFolders.getNoteLabel(f.handle, f.name);
        presetFolderSelect.appendChild(opt);
    }
}

async function loadPresetTargets() {
    const folders = await FractalFolders.listFolders();
    const f = folders.find((x) => x.id === presetFolderSelect.value);
    presetTargetSelect.innerHTML = '';
    presetTargets = [];
    if (!f) {
        presetTargetSelect.innerHTML = '<option>' + FractalI18n.t('options_select_note') + '</option>';
        return;
    }
    if (!(await FractalFolders.hasPermission(f.handle))) {
        const ok = await FractalFolders.requestPermission(f.handle);
        if (!ok) {
            presetTargetSelect.innerHTML = '<option>' + FractalI18n.t('options_note_permission_needed') + '</option>';
            return;
        }
    }
    try {
        presetTargets = await FractalFolders.readTargetsFromOutlineNote(f.handle);
    } catch (e) {
        presetTargetSelect.innerHTML = '<option>' + FractalI18n.t('options_read_failed') + '</option>';
        return;
    }
    for (const t of presetTargets) {
        const opt = document.createElement('option');
        opt.value = t.id;
        const icon = t.kind === 'md' ? '📝 ' : '📄 ';
        const prefix = t.folderPath ? '[' + t.folderPath + '] ' : '';
        opt.textContent = icon + prefix + t.title;
        presetTargetSelect.appendChild(opt);
    }
}

async function refreshPresetList() {
    const presets = await FractalFolders.listPresets();
    const folders = await FractalFolders.listFolders();
    const def = await FractalFolders.getDefaultPreset();
    presetListEl.innerHTML = '';
    if (presets.length === 0) {
        const empty = document.createElement('li');
        empty.className = 'empty';
        empty.textContent = FractalI18n.t('options_no_presets');
        presetListEl.appendChild(empty);
        return;
    }
    for (const p of presets) {
        const li = document.createElement('li');
        const defRadio = document.createElement('input');
        defRadio.type = 'radio';
        defRadio.name = 'defaultPreset';
        defRadio.checked = !!(def && def.id === p.id);
        defRadio.title = FractalI18n.t('options_default_radio_title');
        defRadio.addEventListener('change', async () => {
            await FractalFolders.setDefaultPreset(p.id);
            await refreshPresetList();
        });
        li.appendChild(defRadio);

        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        const folder = folders.find((f) => f.id === p.folderId);
        const noteLabel = folder ? await FractalFolders.getNoteLabel(folder.handle, folder.name) : '?';
        // 保存先タイトルは毎回最新解決（md=本文 H1 / out=outline.note title。旧プリセットの id 表示も治る）
        const targetTitle = folder
            ? await FractalFolders.getTargetTitle(folder.handle, p.targetId, p.targetKind, p.targetTitle || p.targetId)
            : (p.targetTitle || p.targetId);
        const icon = p.targetKind === 'md' ? '📝' : '📄';
        nameEl.textContent = (def && def.id === p.id ? '★ ' : '') + p.name + '  —  ' + noteLabel + ' / ' + icon + ' ' + targetTitle;
        li.appendChild(nameEl);

        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger small';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
            await FractalFolders.removePreset(p.id);
            await refreshPresetList();
        });
        li.appendChild(removeBtn);
        presetListEl.appendChild(li);
    }
}

presetFolderSelect.addEventListener('change', loadPresetTargets);

addPresetBtn.addEventListener('click', async () => {
    clearStatus(presetStatus);
    const folderId = presetFolderSelect.value;
    const target = presetTargets.find((t) => t.id === presetTargetSelect.value);
    if (!folderId || !target) {
        setStatus(presetStatus, FractalI18n.t('options_select_note_and_dest'), 'err');
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
    setStatus(presetStatus, FractalI18n.t('options_preset_added'), 'ok');
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
            // 動的リスト（登録 Note / プリセット）の文言も新言語で再描画
            await refreshUI();
            await refreshPresetFolderSelect();
            await refreshPresetList();
        });
    }
    await FractalFolders.migrateLegacyIfNeeded();
    await refreshUI();
    await refreshPresetFolderSelect();
    await refreshPresetList();
})();
