/** Folder registry — 複数 Notes folder の永続化 + outline.note 読み取り。
 *
 *  Storage schema (IDB):
 *    - notesFolders: Array<{ id: string, name: string, handle: FileSystemDirectoryHandle }>
 *    - lastSelection: { folderId: string, outId: string } | undefined
 *
 *  outline.note format (= NoteStructure from notes-file-manager.ts):
 *    {
 *      version: number,
 *      rootIds: string[],
 *      items: Record<string, NoteTreeFile | NoteTreeFolder>
 *    }
 *    NoteTreeFile = { type: 'file', id, title, color? }
 *    NoteTreeFolder = { type: 'folder', id, title, childIds, collapsed, color? }
 *
 *  v0.2.0: 旧 single-folder schema (notesFolderHandle / notesFolderName / targetOutPath) からの自動 migration。
 */
(function (global) {
    'use strict';

    /** registered folders を取得 (空配列なら未登録) */
    async function listFolders() {
        const arr = await FractalIdb.get('notesFolders');
        return Array.isArray(arr) ? arr : [];
    }

    /** registered folders を保存 */
    async function saveFolders(arr) {
        await FractalIdb.set('notesFolders', arr);
    }

    /** legacy single-folder schema → new array schema migration (1 回限り) */
    async function migrateLegacyIfNeeded() {
        const existing = await FractalIdb.get('notesFolders');
        if (Array.isArray(existing) && existing.length > 0) return;
        const oldHandle = await FractalIdb.get('notesFolderHandle');
        const oldName = await FractalIdb.get('notesFolderName');
        const oldTarget = await FractalIdb.get('targetOutPath');
        if (!oldHandle) return;
        const id = generateFolderId();
        await saveFolders([{ id, name: oldName || oldHandle.name, handle: oldHandle }]);
        // lastSelection (旧 targetOutPath は "subdir/foo.out" 形式、新 outId は file 名から拡張子除いたもの)
        if (oldTarget && typeof oldTarget === 'string') {
            const base = oldTarget.split('/').pop() || '';
            const outId = base.replace(/\.out$/, '');
            if (outId) await FractalIdb.set('lastSelection', { folderId: id, outId });
        }
        // 旧 keys は残してても害はないが migration 済の合図に削除
        await FractalIdb.delete('notesFolderHandle');
        await FractalIdb.delete('notesFolderName');
        await FractalIdb.delete('targetOutPath');
    }

    function generateFolderId() {
        return 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }

    /** folder を 1 つ追加。同じ handle が既にあれば skip して既存 entry を返す */
    async function addFolder(handle) {
        const all = await listFolders();
        // 同じ handle の重複検出 (isSameEntry が確実)
        for (const f of all) {
            try {
                if (await f.handle.isSameEntry(handle)) return f;
            } catch { /* ignore */ }
        }
        const entry = { id: generateFolderId(), name: handle.name, handle: handle };
        all.push(entry);
        await saveFolders(all);
        return entry;
    }

    async function removeFolder(folderId) {
        const all = await listFolders();
        const filtered = all.filter((f) => f.id !== folderId);
        await saveFolders(filtered);
        // lastSelection が消した folder を指していたら clear
        const last = await FractalIdb.get('lastSelection');
        if (last && last.folderId === folderId) {
            await FractalIdb.delete('lastSelection');
        }
    }

    /** folder の readwrite permission 確認 (granted なら true) */
    async function hasPermission(handle) {
        try {
            const p = await handle.queryPermission({ mode: 'readwrite' });
            return p === 'granted';
        } catch {
            return false;
        }
    }

    async function requestPermission(handle) {
        try {
            const p = await handle.requestPermission({ mode: 'readwrite' });
            return p === 'granted';
        } catch {
            return false;
        }
    }

    /** outline.note を読んで file 一覧 (folder hierarchy 反映) を返す。
     *  返り値: Array<{ id: string, title: string, depth: number, folderPath: string }>
     *  folder アイテム自身は含めない (file 一覧として使うため)。 */
    async function readOutlinersFromOutlineNote(folderHandle) {
        let structure;
        try {
            const noteFh = await folderHandle.getFileHandle('outline.note');
            const file = await noteFh.getFile();
            const text = await file.text();
            structure = JSON.parse(text);
        } catch {
            structure = null;
        }
        // outline.note が読めない場合は disk 上の *.out を fallback
        if (!structure || !structure.items || !Array.isArray(structure.rootIds)) {
            return await listOutFilesFlat(folderHandle);
        }

        const result = [];
        const visit = (id, depth, folderPath) => {
            const item = structure.items[id];
            if (!item) return;
            if (item.type === 'folder') {
                const childPath = folderPath ? folderPath + ' / ' + (item.title || '(folder)') : (item.title || '(folder)');
                const children = item.childIds || [];
                for (const cid of children) visit(cid, depth + 1, childPath);
            } else if (item.type === 'file') {
                result.push({
                    id: item.id,
                    title: item.title || '(untitled)',
                    depth,
                    folderPath: folderPath || ''
                });
            }
        };
        for (const rid of structure.rootIds) visit(rid, 0, '');
        return result;
    }

    /** outline.note が無い時の fallback: folder root 直下の *.out を flat に列挙 */
    async function listOutFilesFlat(folderHandle) {
        const result = [];
        try {
            for await (const [name, handle] of folderHandle.entries()) {
                if (handle.kind === 'file' && name.endsWith('.out')) {
                    const id = name.replace(/\.out$/, '');
                    let title = id;
                    try {
                        const f = await handle.getFile();
                        const data = JSON.parse(await f.text());
                        if (data.title) title = data.title;
                    } catch { /* keep id as title */ }
                    result.push({ id, title, depth: 0, folderPath: '' });
                }
            }
        } catch { /* ignore */ }
        result.sort((a, b) => a.title.localeCompare(b.title));
        return result;
    }

    async function getLastSelection() {
        return await FractalIdb.get('lastSelection');
    }

    async function setLastSelection(folderId, outId) {
        await FractalIdb.set('lastSelection', { folderId, outId });
    }

    global.FractalFolders = {
        listFolders,
        addFolder,
        removeFolder,
        hasPermission,
        requestPermission,
        migrateLegacyIfNeeded,
        readOutlinersFromOutlineNote,
        getLastSelection,
        setLastSelection
    };
})(typeof window !== 'undefined' ? window : this);
