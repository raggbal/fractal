/** Folder registry — note の一覧（.fractal）・note を有効にしたフォルダ・outline.note 読み取り・★・前回の保存先。
 *
 *  Storage schema (IDB):
 *    - fractalList: { handle: FileSystemFileHandle, name, notes: string[] }（0.5.0〜。notes は最後に読めた一覧）
 *    - accessRoots: Array<{ path: string, handle: FileSystemDirectoryHandle }>（0.5.0〜。note を有効にするために選んだフォルダ）
 *    - notesFolders: Array<{ id: string, name: string, handle: FileSystemDirectoryHandle }>（〜0.4.x の 1 つずつの登録）
 *    - favoriteNotes: string[]（0.6.0〜。★ の note の id = popup で先に出す）
 *    - lastSelection: { folderId, targetId, targetKind } | undefined（最後に保存した場所 = quick clip の保存先。folderId = note の id）
 *    - lastTargets: { [noteId]: { targetId, targetKind } }（0.6.0〜。note ごとに最後に保存した保存先）
 *    note の id = note のパス（以前の登録は その id）。presets / defaultPresetId（〜0.5.x）は ★ と前回の保存先に移して消す
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

    const req = typeof require === 'function' ? require : null; // node（spec）だけ。拡張では lib を先に読み込む
    const List = global.FractalList || (req && req('./fractal-list.js'));

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

    /**
     * Note の表示名を取得（本体 notesFolderProvider.resolveNoteLabel と同じ規約）:
     * outline.note の noteTitle があればそれ、無ければフォルダ名（handle.name）。
     */
    async function getNoteLabel(folderHandle, fallbackName) {
        try {
            const fh = await folderHandle.getFileHandle('outline.note');
            const s = JSON.parse(await (await fh.getFile()).text());
            if (s && typeof s.noteTitle === 'string' && s.noteTitle.trim()) return s.noteTitle.trim();
        } catch { /* 権限なし・壊れた outline.note はフォルダ名 fallback */ }
        return fallbackName || folderHandle.name;
    }

    /** handle の permission 確認 (granted なら true)。mode は既定 readwrite（.fractal は read） */
    async function hasPermission(handle, mode) {
        try {
            const p = await handle.queryPermission({ mode: mode || 'readwrite' });
            return p === 'granted';
        } catch {
            return false;
        }
    }

    async function requestPermission(handle, mode) {
        try {
            const p = await handle.requestPermission({ mode: mode || 'readwrite' });
            return p === 'granted';
        } catch {
            return false;
        }
    }

    // ── note の一覧（.fractal）と許可したフォルダ（0.5.0〜）──

    /** .fractal を選ぶ: 読めて .fractal の形のときだけ保存する（読めなければ throw・前の設定はそのまま） */
    async function setFractalList(handle) {
        const r = List.parseFractalList(await (await handle.getFile()).text());
        if (!r.ok) throw new Error(r.error);
        await FractalIdb.set('fractalList', { handle: handle, name: handle.name, notes: r.notes });
        return r.notes;
    }

    /**
     * 選んだ .fractal を読み直す（Fractal で足した note もここで入る）。未設定なら null。
     * 返り値 { name, handle, notes, state: 'ok' | 'permission' | 'error', error? }。読めないときの notes は最後に読めた一覧
     * （一覧の写しは、読めたときだけ書き換える）
     */
    async function readFractalList() {
        const saved = await FractalIdb.get('fractalList');
        if (!saved || !saved.handle) return null;
        const last = Array.isArray(saved.notes) ? saved.notes : [];
        const base = { name: saved.name || saved.handle.name, handle: saved.handle, notes: last };
        if (!(await hasPermission(saved.handle, 'read'))) return Object.assign(base, { state: 'permission' });
        let r;
        try {
            r = List.parseFractalList(await (await saved.handle.getFile()).text());
        } catch (e) {
            return Object.assign(base, { state: 'error', error: e.message || String(e) });
        }
        if (!r.ok) return Object.assign(base, { state: 'error', error: r.error });
        if (JSON.stringify(r.notes) !== JSON.stringify(last)) {
            await FractalIdb.set('fractalList', { handle: saved.handle, name: base.name, notes: r.notes });
        }
        return Object.assign(base, { notes: r.notes, state: 'ok' });
    }

    async function listAccessRoots() {
        const arr = await FractalIdb.get('accessRoots');
        return Array.isArray(arr) ? arr : [];
    }

    /**
     * 選んだフォルダを許可したフォルダに足す（.fractal のどのパスかは FractalList.resolvePickedFolder で決める）。
     * 決められなければ Error（.reason = 'none' | 'ambiguous'）を throw。返り値 { path, notes }
     */
    async function addAccessRoot(handle, notePaths) {
        // ほかのマシンの note のパスには当てない（同じ名前のフォルダを取り違えない）
        const os = currentOs();
        const r = await List.resolvePickedFolder(handle, (notePaths || []).filter((p) => !List.isElsewhere(p, os)));
        if (!r.path) {
            const e = new Error(r.reason);
            e.reason = r.reason;
            throw e;
        }
        const roots = (await listAccessRoots()).filter((x) => x.path !== r.path); // 同じパスは新しい handle に置き換える
        roots.push({ path: r.path, handle: handle });
        await FractalIdb.set('accessRoots', roots);
        return r;
    }

    async function removeAccessRoot(rootPath) {
        await FractalIdb.set('accessRoots', (await listAccessRoots()).filter((x) => x.path !== rootPath));
    }

    function currentOs() {
        return List.localOs(global.navigator);
    }

    function listNote(notePath, roots) {
        const root = List.rootFor(roots, notePath);
        return {
            id: notePath,
            name: List.baseName(notePath),
            path: notePath,
            source: 'list',
            elsewhere: List.isElsewhere(notePath, currentOs()), // このコンピューターには無い（保存先にならない）
            root: root,
            rel: root ? List.relUnder(root.path, notePath) : null,
            permHandle: root ? root.handle : null
        };
    }

    function legacyNote(f) {
        return { id: f.id, name: f.name, path: null, source: 'legacy', legacy: f, permHandle: f.handle };
    }

    /**
     * 保存先の note: .fractal の note（list.notes の順）+ まだ残っている旧登録。
     * 返り値 Array<{ id, name, path, source: 'list' | 'legacy', elsewhere, root, rel, legacy, permHandle }>
     * （list の note で root が null = まだ許可したフォルダの下にない。id は note のパス、旧登録は その id）
     */
    async function listNotes(list) {
        const roots = await listAccessRoots();
        const out = (list ? list.notes : []).map((p) => listNote(p, roots));
        for (const f of await listFolders()) out.push(legacyNote(f));
        return out;
    }

    /** id（★・lastSelection の folderId）の note。.fractal の最後に読めた一覧に無いパス・消した旧登録は null */
    async function findNote(id) {
        if (!id) return null;
        const f = (await listFolders()).find((x) => x.id === id);
        if (f) return legacyNote(f);
        const saved = await FractalIdb.get('fractalList');
        if (!saved || !Array.isArray(saved.notes) || !saved.notes.includes(id)) return null;
        return listNote(id, await listAccessRoots());
    }

    /** note のフォルダの handle（許可したフォルダからたどる）。無ければ throw */
    async function noteHandle(note) {
        if (note.source === 'legacy') return note.legacy.handle;
        if (!note.root) throw new Error('No access to ' + note.path);
        return List.dirAt(note.root.handle, note.rel);
    }

    /** pure: ★ と note ごとの前回の保存先の note の id を書き換える（idMap: 旧 id → note のパス） */
    function remapNoteIds(favorites, lastTargets, idMap) {
        const favs = [];
        for (const id of Array.isArray(favorites) ? favorites : []) {
            const to = idMap[id] || id;
            if (!favs.includes(to)) favs.push(to);
        }
        const targets = {};
        for (const [id, t] of Object.entries(lastTargets || {})) {
            const to = idMap[id] || id;
            if (!targets[to] || !idMap[id]) targets[to] = t;
        }
        return { favorites: favs, lastTargets: targets };
    }

    /**
     * 旧版で 1 つずつ登録した note を、.fractal の note として引き継ぐ。決め方は選んだフォルダと同じ
     * （resolvePickedFolder。今 許可があるものだけ見る）。決まったパスが .fractal の note なら、その handle を許可したフォルダに
     * 足し（もっと上のフォルダを許可済みなら足さない）、★・note ごとの前回の保存先・lastSelection の note の id を note のパスに
     * 書き換え、旧登録から外す。書く順は 許可したフォルダ → ★ と前回の保存先 → 旧登録（途中で止まっても保存先を失わない）。
     * 返り値 = 引き継いだ数
     */
    async function adoptLegacyFolders(notePaths) {
        const legacy = await listFolders();
        if (legacy.length === 0 || !notePaths || notePaths.length === 0) return 0;
        const roots = await listAccessRoots();
        const idMap = {};
        for (const f of legacy) {
            if (!(await hasPermission(f.handle))) continue;
            let r;
            try {
                r = await List.resolvePickedFolder(f.handle, notePaths);
            } catch {
                continue;
            }
            if (!r.path || !notePaths.includes(r.path)) continue;
            if (!List.rootFor(roots, r.path)) roots.push({ path: r.path, handle: f.handle });
            idMap[f.id] = r.path;
        }
        const n = Object.keys(idMap).length;
        if (n === 0) return 0;
        await FractalIdb.set('accessRoots', roots);
        const re = remapNoteIds(await listFavorites(), await FractalIdb.get('lastTargets'), idMap);
        await FractalIdb.set('favoriteNotes', re.favorites);
        await FractalIdb.set('lastTargets', re.lastTargets);
        const last = normalizeLastSelection(await FractalIdb.get('lastSelection'));
        if (last && idMap[last.folderId]) {
            await FractalIdb.set('lastSelection', Object.assign({}, last, { folderId: idMap[last.folderId] }));
        }
        await saveFolders(legacy.filter((f) => !idMap[f.id]));
        return n;
    }

    /** outline.note の structure から target 一覧を抽出（pure・unit 対象）。
     *  kind: ext 'md' → 'md'、ext なし / 'out' → 'out'（NoteTreeFile.ext の規約 = notes-file-manager.ts の NoteTreeFile）。
     *  添付（ext 'file'）と folder link（ext 'folder'）は保存先にならないので出さない（以前は 'out' として出て、選ぶと失敗した）。
     *  folder アイテム自身は含めない。 */
    function extractTargets(structure) {
        if (!structure || !structure.items || !Array.isArray(structure.rootIds)) return null;
        const result = [];
        const visit = (id, depth, folderPath) => {
            const item = structure.items[id];
            if (!item) return;
            if (item.type === 'folder') {
                const childPath = folderPath ? folderPath + ' / ' + (item.title || '(folder)') : (item.title || '(folder)');
                const children = item.childIds || [];
                for (const cid of children) visit(cid, depth + 1, childPath);
            } else if (item.type === 'file') {
                const kind = item.ext === 'md' ? 'md' : (!item.ext || item.ext === 'out') ? 'out' : null;
                if (!kind) return;
                result.push({
                    id: item.id,
                    title: item.title || '(untitled)',
                    depth,
                    folderPath: folderPath || '',
                    kind
                });
            }
        };
        for (const rid of structure.rootIds) visit(rid, 0, '');
        return result;
    }

    /** md 本文の先頭 H1 を返す（無ければ null）。
     *  正典 src/shared/md-h1-utils.ts extractFirstH1/parseAtxH1Text の 1:1 ミラー:
     *  - 行頭 0-3 スペース + `# `（`#` 1 個 = H1 のみ）
     *  - 閉じ `#` 列は「空白前置時のみ」剥がす（`# C#` → `C#`、`# Title #` → `Title`）
     *  - ``` フェンス内はスキップ */
    function extractFirstH1FromMd(md) {
        const lines = String(md || '').split('\n');
        let inCode = false;
        for (const rawLine of lines) {
            const line = rawLine.replace(/\r$/, '');
            if (line.startsWith('```')) { inCode = !inCode; continue; }
            if (inCode) continue;
            const m = line.match(/^ {0,3}#[ \t]+(.*)$/);
            if (!m) continue;
            let text = m[1].replace(/[ \t]+$/, '');
            const closing = text.match(/^(.*?)[ \t]+#+$/);
            if (closing) text = closing[1];
            return text.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
        }
        return null;
    }

    /** md target の表示タイトル: 本文 H1 優先、読めなければ fallback */
    async function getMdTargetTitle(folderHandle, mdId, fallback) {
        try {
            const fh = await folderHandle.getFileHandle(mdId + '.md');
            const h1 = extractFirstH1FromMd(await (await fh.getFile()).text());
            if (h1) return h1;
        } catch { /* 権限なし・ファイル欠落は fallback */ }
        return fallback;
    }

    /** outline.note を読んで target 一覧 (outliner .out + md item・folder hierarchy 反映) を返す。
     *  返り値: Array<{ id, title, depth, folderPath, kind: 'out'|'md' }>（FR-CL-03） */
    async function readTargetsFromOutlineNote(folderHandle) {
        let structure;
        try {
            const noteFh = await folderHandle.getFileHandle('outline.note');
            const file = await noteFh.getFile();
            const text = await file.text();
            structure = JSON.parse(text);
        } catch {
            structure = null;
        }
        const extracted = extractTargets(structure);
        if (extracted !== null) {
            // md item は outline.note の title が id のままのことがあるので本文 H1 を表示タイトルに
            for (const t of extracted) {
                if (t.kind !== 'md') continue;
                t.title = await getMdTargetTitle(folderHandle, t.id, t.title);
            }
            return extracted;
        }
        // outline.note が読めない場合は disk 上の *.out を fallback（md は outline.note が正なので列挙しない）
        return await listOutFilesFlat(folderHandle);
    }

    /** 後方互換 alias（旧呼び出し名） */
    async function readOutlinersFromOutlineNote(folderHandle) {
        return readTargetsFromOutlineNote(folderHandle);
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
                    result.push({ id, title, depth: 0, folderPath: '', kind: 'out' });
                }
            }
        } catch { /* ignore */ }
        result.sort((a, b) => a.title.localeCompare(b.title));
        return result;
    }

    // ── lastSelection（新形式 { folderId, targetId, targetKind }・旧 { folderId, outId } を読込時に正規化）──

    /** 旧形式 lastSelection を新形式に正規化（pure・unit 対象・FR-CL-07） */
    function normalizeLastSelection(raw) {
        if (!raw || !raw.folderId) return null;
        if (raw.targetId) {
            return { folderId: raw.folderId, targetId: raw.targetId, targetKind: raw.targetKind === 'md' ? 'md' : 'out' };
        }
        if (raw.outId) {
            return { folderId: raw.folderId, targetId: raw.outId, targetKind: 'out' };
        }
        return null;
    }

    async function getLastSelection() {
        return normalizeLastSelection(await FractalIdb.get('lastSelection'));
    }

    /** 保存した場所を覚える: 最後に保存した場所（quick clip の保存先）と、その note の前回の保存先 */
    async function setLastSelection(folderId, targetId, targetKind) {
        const kind = targetKind === 'md' ? 'md' : 'out';
        await FractalIdb.set('lastSelection', { folderId, targetId, targetKind: kind });
        const targets = Object.assign({}, (await FractalIdb.get('lastTargets')) || {});
        targets[folderId] = { targetId, targetKind: kind };
        await FractalIdb.set('lastTargets', targets);
    }

    /** note の前回の保存先 { targetId, targetKind } | null（無ければ、最後に保存した場所がその note ならそれ） */
    async function getLastTarget(noteId) {
        const targets = (await FractalIdb.get('lastTargets')) || {};
        if (targets[noteId]) return targets[noteId];
        const last = await getLastSelection();
        return last && last.folderId === noteId ? { targetId: last.targetId, targetKind: last.targetKind } : null;
    }

    // ── ★（popup で先に出す note。0.6.0 で保存先プリセットの代わり）──

    async function listFavorites() {
        const arr = await FractalIdb.get('favoriteNotes');
        return Array.isArray(arr) ? arr : [];
    }

    /** pure: ★ を付ける / 外した新しい配列 */
    function withFavorite(favorites, noteId, on) {
        const arr = (Array.isArray(favorites) ? favorites : []).filter((id) => id !== noteId);
        if (on) arr.push(noteId);
        return arr;
    }

    async function setFavorite(noteId, on) {
        await FractalIdb.set('favoriteNotes', withFavorite(await listFavorites(), noteId, on));
    }

    /** pure: ★ の note を先に（それぞれの中は元の順） */
    function sortByFavorite(notes, favorites) {
        const fav = new Set(favorites || []);
        return notes.filter((n) => fav.has(n.id)).concat(notes.filter((n) => !fav.has(n.id)));
    }

    /**
     * 〜0.5.x の保存先プリセットを移す（1 回だけ）: プリセットの note → ★、★default → 最後に保存した場所（まだ無ければ）、
     * 各プリセットの保存先 → その note の前回の保存先（まだ無ければ・★default を優先）。移してから presets / defaultPresetId を消す
     */
    async function migratePresetsIfNeeded() {
        const presets = await FractalIdb.get('presets');
        if (!Array.isArray(presets)) return;
        const defId = await FractalIdb.get('defaultPresetId');
        const ordered = presets.filter((p) => p.id === defId).concat(presets.filter((p) => p.id !== defId));
        let favs = await listFavorites();
        const targets = Object.assign({}, (await FractalIdb.get('lastTargets')) || {});
        for (const p of ordered) {
            if (!p || !p.folderId || !p.targetId) continue;
            if (!favs.includes(p.folderId)) favs = favs.concat([p.folderId]);
            if (!targets[p.folderId]) targets[p.folderId] = { targetId: p.targetId, targetKind: p.targetKind === 'md' ? 'md' : 'out' };
        }
        await FractalIdb.set('favoriteNotes', favs);
        await FractalIdb.set('lastTargets', targets);
        const def = presets.find((p) => p.id === defId);
        if (def && def.folderId && def.targetId && !(await getLastSelection())) {
            await FractalIdb.set('lastSelection', { folderId: def.folderId, targetId: def.targetId, targetKind: def.targetKind === 'md' ? 'md' : 'out' });
        }
        await FractalIdb.delete('presets');
        await FractalIdb.delete('defaultPresetId');
    }

    global.FractalFolders = {
        listFolders,
        addFolder,
        removeFolder,
        hasPermission,
        requestPermission,
        setFractalList,
        readFractalList,
        listAccessRoots,
        addAccessRoot,
        removeAccessRoot,
        listNotes,
        findNote,
        noteHandle,
        adoptLegacyFolders,
        remapNoteIds,
        migrateLegacyIfNeeded,
        getNoteLabel,
        extractFirstH1FromMd,
        getMdTargetTitle,
        extractTargets,
        readTargetsFromOutlineNote,
        readOutlinersFromOutlineNote,
        normalizeLastSelection,
        getLastSelection,
        setLastSelection,
        getLastTarget,
        listFavorites,
        withFavorite,
        setFavorite,
        sortByFavorite,
        migratePresetsIfNeeded
    };
    // node（spec）から require できるように（IDB を使う関数は global.FractalIdb を用意して呼ぶ）
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = global.FractalFolders;
    }
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : globalThis));
