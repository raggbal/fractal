'use strict';

// note の一覧（.fractal）
const chooseListBtn = document.getElementById('chooseListBtn');
const listSummary = document.getElementById('listSummary');
const listReauthBtn = document.getElementById('listReauthBtn');
const listStatus = document.getElementById('listStatus');
// note（★・有効にする）
const enableBanner = document.getElementById('enableBanner');
const enableBannerText = document.getElementById('enableBannerText');
const enableRows = document.getElementById('enableRows');
const enableHint = document.getElementById('enableHint');
const accessStatus = document.getElementById('accessStatus');
const noteListEl = document.getElementById('noteList');
// 以前の登録（〜0.4.x の 1 つずつの登録）
const legacySection = document.getElementById('legacySection');
const folderListEl = document.getElementById('folderList');

const t = (key, params) => FractalI18n.t(key, params);
/** 件数の文（1 件は <key>_one） */
const tn = (key, params) => t(params.count === 1 ? key + '_one' : key, params);

let list = null;  // FractalFolders.readFractalList()（未設定 = null）
let notes = [];   // FractalFolders.listNotes(list)
let enableFolders = []; // まだ保存できない note をまとめて選べるフォルダ（バナーの行）

const IS_MAC = FractalList.localOs(navigator) === 'mac';

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

/** note の保存できる状態: 'ok' | 'reauth'（許可が切れた）| 'none'（まだ有効にしていない）| 'missing'（フォルダが無い）
 *  | 'elsewhere'（このコンピューターには無い — ほかのマシンのパス） */
async function noteState(note) {
    if (note.elsewhere) return 'elsewhere';
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
    await renderLegacy();
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

// 一覧は組み終えてから入れ替える（読み込みの途中を見せない・続けて描き直しても行が重ならない）
async function renderNotes() {
    const items = document.createDocumentFragment();
    // このコンピューターに無い note は最後に
    const listed = notes.filter((n) => n.source === 'list' && !n.elsewhere).concat(notes.filter((n) => n.source === 'list' && n.elsewhere));
    if (listed.length === 0) {
        items.appendChild(emptyItem(list ? 'options_list_empty' : 'options_no_list_notes'));
    }
    const favorites = await FractalFolders.listFavorites();
    const notEnabled = [];
    for (const n of listed) {
        const li = document.createElement('li');
        const on = favorites.includes(n.id);
        const fav = smallButton(on ? '★' : '☆', 'fav' + (on ? ' on' : ''), async () => {
            await FractalFolders.setFavorite(n.id, !on);
            await renderNotes();
        });
        fav.title = t('options_fav_title');
        fav.setAttribute('aria-pressed', on ? 'true' : 'false');
        if (n.elsewhere) fav.style.visibility = 'hidden'; // このコンピューターに無い note は popup に出ないので ★ も無い
        li.appendChild(fav);

        const nameEl = document.createElement('span');
        nameEl.className = 'name';
        nameEl.textContent = await noteLabel(n);
        const pathEl = document.createElement('span');
        pathEl.className = 'path';
        pathEl.textContent = n.path;
        nameEl.appendChild(pathEl);
        li.appendChild(nameEl);

        const state = await noteState(n);
        if (state === 'ok') {
            const st = document.createElement('span');
            st.className = 'ok';
            st.textContent = t('options_note_ready');
            li.appendChild(st);
        } else if (state === 'reauth') {
            // 有効にしたときに選んだフォルダの許可が切れた（Chrome の再起動など）。同じフォルダの note はまとめて戻る
            li.appendChild(smallButton(t('options_note_allow_again'), 'small', async () => {
                if (await FractalFolders.requestPermission(n.permHandle)) await refresh();
                else setStatus(accessStatus, t('options_permission_denied'), 'err');
            }));
        } else if (state === 'none') {
            notEnabled.push(n.path);
            li.appendChild(smallButton(t('options_note_enable'), 'primary small', () => enableFolder(folderToChoose(n.path))));
        } else {
            const st = document.createElement('span');
            st.className = state === 'elsewhere' ? 'meta' : 'perm-warn';
            st.textContent = t(state === 'elsewhere' ? 'options_note_elsewhere' : 'options_note_missing');
            li.appendChild(st);
        }
        items.appendChild(li);
    }
    noteListEl.replaceChildren(items);

    // まだ保存できない note があれば、選ぶフォルダ（共通の親）ごとに 1 行: パス・note の数・「選ぶ…」
    enableFolders = FractalList.suggestFolders(notEnabled);
    if (notEnabled.length) {
        enableBannerText.textContent = tn('options_enable_banner', { count: notEnabled.length });
        const rows = document.createDocumentFragment();
        for (const path of enableFolders) {
            const row = document.createElement('div');
            row.className = 'suggest';
            const code = document.createElement('code');
            code.textContent = path;
            row.appendChild(code);
            const count = document.createElement('span');
            count.className = 'meta';
            count.textContent = tn('options_enable_count', { count: notEnabled.filter((p) => FractalList.relUnder(path, p) !== null).length });
            row.appendChild(count);
            row.appendChild(smallButton(t('options_enable_choose'), 'primary small', () => enableFolder(path)));
            rows.appendChild(row);
        }
        enableRows.replaceChildren(rows);
        enableHint.textContent = t(IS_MAC ? 'options_enable_dialog_hint' : 'options_enable_dialog_hint_other');
        enableBanner.style.display = '';
    } else {
        enableBanner.style.display = 'none';
    }
}

/** note を有効にするために選ぶフォルダ（バナーの行のうち、その note を含むもの。無ければ note のフォルダ） */
function folderToChoose(notePath) {
    return enableFolders.find((f) => FractalList.relUnder(f, notePath) !== null) || notePath;
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

/** note を有効にする: note が入っているフォルダ（path）を選んでもらう（Chrome は選ばれたフォルダにしか書かせない）。
 *  選ぶ画面は前に開いた場所で開き、拡張からは場所を指定できないので、パスをコピーしておく（画面で貼り付けて移る）。
 *  選んだフォルダの中の .fractal の note すべてが保存できるようになる */
async function enableFolder(path) {
    clearStatus(accessStatus);
    if (!list || list.notes.length === 0) {
        setStatus(accessStatus, t('options_access_need_list'), 'err');
        return;
    }
    if (path) {
        try {
            await navigator.clipboard.writeText(path);
            setStatus(accessStatus, t('options_enable_copied', { path }), 'info');
        } catch { /* コピーできなくても選ぶ画面は開く */ }
    }
    let handle;
    try {
        handle = await window.showDirectoryPicker({ id: 'fractal-notes', mode: 'readwrite' });
    } catch (e) {
        if (e.name === 'AbortError') {
            clearStatus(accessStatus);
            return;
        }
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
            // 動的リスト（.fractal・note・以前の登録）の文言も新言語で再描画
            await refresh();
        });
    }
    await FractalFolders.migrateLegacyIfNeeded();
    await FractalFolders.migratePresetsIfNeeded();
    await refresh();
})();
