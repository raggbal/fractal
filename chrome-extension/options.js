'use strict';

const folderStatus = document.getElementById('folderStatus');
const pickFolderBtn = document.getElementById('pickFolderBtn');
const outList = document.getElementById('outList');
const currentTarget = document.getElementById('currentTarget');

function setStatus(el, text, kind) {
    el.textContent = text;
    el.className = 'status' + (kind ? ' ' + kind : '');
}

async function listOutFiles(dirHandle, prefix = '') {
    const results = [];
    for await (const [name, handle] of dirHandle.entries()) {
        const relPath = prefix ? prefix + '/' + name : name;
        if (handle.kind === 'file' && name.endsWith('.out')) {
            results.push({ path: relPath, handle: handle });
        } else if (handle.kind === 'directory' && !name.startsWith('.') && name !== 'pages' && name !== 'images' && name !== 'files' && name !== 'node_modules') {
            const sub = await listOutFiles(handle, relPath);
            for (const s of sub) results.push(s);
        }
    }
    return results;
}

async function refreshUI() {
    const folderHandle = await FractalIdb.get('notesFolderHandle');
    const folderName = await FractalIdb.get('notesFolderName');
    const targetOutPath = await FractalIdb.get('targetOutPath');

    if (!folderHandle) {
        setStatus(folderStatus, '未設定', '');
        outList.innerHTML = '<li style="cursor:default; color:#999">(まず Notes フォルダを設定してください)</li>';
        currentTarget.textContent = '(未設定)';
        return;
    }

    setStatus(folderStatus, '✅ ' + (folderName || folderHandle.name), 'ok');

    // permission 確認 (granted / prompt / denied)
    const perm = await folderHandle.queryPermission({ mode: 'readwrite' });
    if (perm !== 'granted') {
        setStatus(folderStatus, '⚠️ ' + (folderName || folderHandle.name) + ' (要再許可)', 'err');
    }

    try {
        const files = await listOutFiles(folderHandle);
        if (files.length === 0) {
            outList.innerHTML = '<li style="cursor:default; color:#999">(.out ファイルが見つかりません)</li>';
        } else {
            outList.innerHTML = '';
            files.sort((a, b) => a.path.localeCompare(b.path));
            for (const f of files) {
                const li = document.createElement('li');
                li.textContent = f.path;
                if (f.path === targetOutPath) li.classList.add('selected');
                li.addEventListener('click', async () => {
                    await FractalIdb.set('targetOutPath', f.path);
                    await refreshUI();
                });
                outList.appendChild(li);
            }
        }
    } catch (e) {
        outList.innerHTML = '<li style="cursor:default; color:#c33">エラー: ' + e.message + ' (許可を再取得してください)</li>';
    }

    currentTarget.textContent = targetOutPath
        ? (folderName || folderHandle.name) + '/' + targetOutPath
        : '(.out 未選択)';
}

pickFolderBtn.addEventListener('click', async () => {
    try {
        const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
        await FractalIdb.set('notesFolderHandle', handle);
        await FractalIdb.set('notesFolderName', handle.name);
        await FractalIdb.delete('targetOutPath');  // reset target on folder change
        await refreshUI();
    } catch (e) {
        if (e.name !== 'AbortError') {
            setStatus(folderStatus, '❌ ' + e.message, 'err');
        }
    }
});

refreshUI();
