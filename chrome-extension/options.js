'use strict';

const folderListEl = document.getElementById('folderList');
const addFolderBtn = document.getElementById('addFolderBtn');
const addStatus = document.getElementById('addStatus');

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
        empty.textContent = '(未登録 — 上の「Add Notes Folder」 で追加)';
        folderListEl.appendChild(empty);
        return;
    }
    for (const f of folders) {
        const li = document.createElement('li');
        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = f.name;
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

(async () => {
    await FractalFolders.migrateLegacyIfNeeded();
    await refreshUI();
})();
