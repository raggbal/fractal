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
        empty.textContent = '(未登録 — 上の「Add Note」 で追加)';
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
            warn.textContent = '⚠️ 要再許可';
            li.appendChild(warn);
            const reauthBtn = document.createElement('button');
            reauthBtn.className = 'small';
            reauthBtn.textContent = '再許可';
            reauthBtn.addEventListener('click', async () => {
                const ok = await FractalFolders.requestPermission(f.handle);
                if (ok) await refreshUI();
                else setStatus(addStatus, '❌ 許可されませんでした', 'err');
            });
            li.appendChild(reauthBtn);
        }

        const removeBtn = document.createElement('button');
        removeBtn.className = 'danger small';
        removeBtn.textContent = 'Remove';
        removeBtn.addEventListener('click', async () => {
            if (!confirm(`"${f.name}" を登録解除しますか? (フォルダ自体は削除されません)`)) return;
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
        setStatus(addStatus, '✅ ' + entry.name + ' を登録', 'ok');
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
        presetTargetSelect.innerHTML = '<option>(Note を選択)</option>';
        return;
    }
    if (!(await FractalFolders.hasPermission(f.handle))) {
        const ok = await FractalFolders.requestPermission(f.handle);
        if (!ok) {
            presetTargetSelect.innerHTML = '<option>(Note の許可が必要)</option>';
            return;
        }
    }
    try {
        presetTargets = await FractalFolders.readTargetsFromOutlineNote(f.handle);
    } catch (e) {
        presetTargetSelect.innerHTML = '<option>(読み取り失敗)</option>';
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
        empty.textContent = '(プリセット未登録)';
        presetListEl.appendChild(empty);
        return;
    }
    for (const p of presets) {
        const li = document.createElement('li');
        const defRadio = document.createElement('input');
        defRadio.type = 'radio';
        defRadio.name = 'defaultPreset';
        defRadio.checked = !!(def && def.id === p.id);
        defRadio.title = 'default に設定（popup 初期選択 + quick clip）';
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
        setStatus(presetStatus, '❌ Note と保存先を選択してください', 'err');
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
    setStatus(presetStatus, '✅ 追加しました', 'ok');
    await refreshPresetList();
});

(async () => {
    await FractalFolders.migrateLegacyIfNeeded();
    await refreshUI();
    await refreshPresetFolderSelect();
    await refreshPresetList();
})();
