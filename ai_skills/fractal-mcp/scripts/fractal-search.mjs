#!/usr/bin/env node
/**
 * fractal-search.mjs — Fractal の Notes フォルダを横断検索する
 *
 * 対応スコープ: outline(file単位) / node(.out内ノード) / page(<pageId>.md) / md(ルート直下.md)
 * 検索仕様は src/shared/notes-file-manager.ts の searchFilesStreaming() を踏襲。
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { extractDocTextMjs, pushNormalized } from './ooxml-extract.mjs';

// ── フラットレイアウトの pageDir 解決（新フラットレイアウト前提・legacy fallback なし = ユーザー決定 2026-07-26）──
// フラット規約: page md = <folder>/<pageId>.md（直下）。hint（isFlatOut / 相対 / 絶対）尊重・無ければ直下。
export function isFlatOut(pageDir) {
    if (typeof pageDir !== 'string') return false;
    const norm = pageDir.replace(/^\.\//, '').replace(/\/+$/, '');
    return norm === '' || norm === '.';
}
export function resolvePagesDirForSearch(folder, outFile, pageDirHint) {
    void outFile; // 署名互換（旧 <basename>/ default は廃止）
    if (isFlatOut(pageDirHint)) return folder;
    if (pageDirHint) return path.isAbsolute(pageDirHint) ? pageDirHint : path.resolve(folder, pageDirHint);
    return folder; // 新デフォルト = note 直下
}

// bump on schema change to invalidate old caches
// (v5: 添付 lines を {text,loc?} に拡張 — FR-DS-09)
// (v6: 対象外拡張子 skip の廃止 + テキスト sniff 導入 — 旧キャッシュの .txt/.html に
//      旧 skip 種別が truthy 記録済みのため、bump しないと永遠に skip され続ける)
const CACHE_VERSION = 6;

// ─────────────── Tag / checked フィルタ（FR-SRF-01/02） ───────────────

/** タグ抽出（正典: src/webview/outliner-model.js:64 parseTags の 1:1 ミラー） */
export function parseTagsFromText(text) {
    const tags = [];
    let cleaned = String(text || '').replace(/`[^`]*`/g, '');       // inline code 内は除外
    cleaned = cleaned.replace(/https?:\/\/\S+/g, '');               // URL 内 @user 等は除外
    const regex = /(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu;
    let m;
    while ((m = regex.exec(cleaned)) !== null) tags.push(m[1]);
    return tags;
}

/** --tag フィルタ: filterTags（プレフィックス省略可・複数 OR）。filter なしは常に true */
export function matchesTagFilter(nodeTags, filterTags) {
    if (!filterTags || filterTags.length === 0) return true;
    const tags = nodeTags || [];
    return filterTags.some((f) => {
        if (f.startsWith('#') || f.startsWith('@')) return tags.includes(f);
        return tags.includes('#' + f) || tags.includes('@' + f);
    });
}

/** note 表示名（正典: notesFolderProvider.resolveNoteLabel = outline.note の noteTitle → フォルダ名 fallback） */
export function resolveNoteLabelFromDisk(folder) {
    try {
        const s = JSON.parse(fs.readFileSync(path.join(folder, 'outline.note'), 'utf-8'));
        if (s && typeof s.noteTitle === 'string' && s.noteTitle.trim()) return s.noteTitle.trim();
    } catch { /* outline.note 無し/壊れはフォルダ名 */ }
    return path.basename(folder);
}

/** --note-name / --exclude-note の名前一致（noteTitle or フォルダ名・大小無視・部分一致・複数 OR） */
export function matchesNoteName(label, baseName, names) {
    const l = String(label || '').toLowerCase();
    const b = String(baseName || '').toLowerCase();
    return names.some((n) => {
        const t = String(n).toLowerCase();
        return l.includes(t) || b.includes(t);
    });
}

/** folder entries を --note-name（include・空なら全通し）/ --exclude-note で絞る */
export function filterFoldersByNoteName(entries, noteNames, excludeNotes, labelOf = resolveNoteLabelFromDisk) {
    return entries.filter((e) => {
        const label = labelOf(e.path);
        const base = path.basename(e.path);
        if (excludeNotes.length > 0 && matchesNoteName(label, base, excludeNotes)) return false;
        if (noteNames.length > 0 && !matchesNoteName(label, base, noteNames)) return false;
        return true;
    });
}

// ─────────────── md 先頭 H1（FR-SS-03） ───────────────
// 正典: src/shared/md-h1-utils.ts の parseAtxH1Text / extractFirstH1 のミラー（ADRL-0002）。
// CommonMark ATX 準拠: 閉じ `#` 列は「直前に空白がある時だけ」剥がす（`# C#` → `C#`）。
// コードフェンス（```）内の `#` は見出しとみなさない。
// 乖離は test/specs/skills-search-filters.spec.ts の 3 者一致 TC（正典 ts / search mjs / md mjs）が番人。

export function parseAtxH1TextMjs(line) {
    // 末尾 CR を落としてからマッチ（split('\n') 残留 \r 対策）
    const bare = String(line).replace(/\r$/, '');
    // 行頭 0-3 スペース + `#` 1 個 + 空白必須
    const m = bare.match(/^ {0,3}#[ \t]+(.*)$/);
    if (!m) return null;
    let text = m[1].replace(/[ \t]+$/, '');
    // 閉じ `#` 列は「1 個以上の空白の後」のみ剥がす（C#/F# はタイトルの一部）
    const closing = text.match(/^(.*?)[ \t]+#+$/);
    if (closing) text = closing[1];
    return text.replace(/[ \t]+$/, '').replace(/^[ \t]+/, '');
}

export function extractFirstH1Mjs(md) {
    const lines = String(md).split('\n');
    let inCode = false;
    for (const line of lines) {
        if (line.startsWith('```')) { inCode = !inCode; continue; }
        if (inCode) continue;
        const text = parseAtxH1TextMjs(line);
        if (text !== null) return text;
    }
    return null;
}

/** --h1 フィルタ: md 本文の先頭 H1 への大小無視部分一致。h1Filter なしは常に true */
export function matchesH1Filter(mdBody, h1Filter) {
    if (!h1Filter) return true;
    const h1 = extractFirstH1Mjs(mdBody);
    if (h1 == null) return false;
    return h1.toLowerCase().includes(String(h1Filter).toLowerCase());
}

/** --outline-name フィルタ: .out title への大小無視部分一致。filter なしは常に true */
export function matchesOutlineName(title, filter) {
    if (!filter) return true;
    return String(title || '').toLowerCase().includes(String(filter).toLowerCase());
}

/** --checked フィルタ: true|false|none|any。filter なし（null）は常に true */
export function matchesCheckedFilter(checked, mode) {
    if (!mode) return true;
    switch (mode) {
        case 'true': return checked === true;
        case 'false': return checked === false;
        case 'none': return checked !== true && checked !== false; // チェックボックスなし
        case 'any': return checked === true || checked === false;  // タスクノード全部
        default: return true;
    }
}

// ─────────────── Arg parse ───────────────

function parseArgs(argv) {
    const a = {
        query: null,
        folders: [],
        auto: false,
        listFolders: false,
        listNotes: false,
        findOutline: null,
        regex: false,
        caseSensitive: false,
        wholeWord: false,
        maxPerFile: 5,
        maxResults: 100,
        scope: null,         // Set<'outline'|'node'|'page'|'md'|'file'> | null=all（file = 添付中身検索 FR-DS-06）
        tags: [],            // --tag（複数 OR・#/@ プレフィックス省略可）
        checked: null,       // --checked true|false|none|any
        noteNames: [],       // --note-name（noteTitle/フォルダ名の部分一致で対象 note を絞る・複数 OR）
        excludeNotes: [],    // --exclude-note（同上の一致で除外）
        outlineName: null,   // --outline-name（.out title 部分一致の AND プレフィルタ・FR-SS-02）
        h1: null,            // --h1（md 先頭 H1 部分一致の AND プレフィルタ・FR-SS-03）
        json: false,
        summary: false,
        noCache: false,
        clearCache: false,
        cacheDir: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const v = () => argv[++i];
        switch (k) {
            case '--query': a.query = v(); break;
            case '--folder': a.folders.push(v()); break;
            case '--auto': a.auto = true; break;
            case '--list-folders': a.listFolders = true; break;
            case '--list-notes': a.listNotes = true; break;
            case '--find-outline': a.findOutline = v(); break;
            case '--regex': a.regex = true; break;
            case '--case-sensitive': a.caseSensitive = true; break;
            case '--whole-word': a.wholeWord = true; break;
            case '--max-per-file': a.maxPerFile = Number(v()); break;
            case '--max-results': a.maxResults = Number(v()); break;
            case '--scope': a.scope = new Set(v().split(',').map(s => s.trim()).filter(Boolean)); break;
            case '--tag': a.tags.push(v()); break;
            case '--note-name': a.noteNames.push(v()); break;
            case '--exclude-note': a.excludeNotes.push(v()); break;
            case '--outline-name': a.outlineName = v(); break;
            case '--h1': a.h1 = v(); break;
            case '--checked':
                a.checked = v();
                if (!['true', 'false', 'none', 'any'].includes(a.checked)) {
                    console.error(`Error: --checked must be true|false|none|any, got "${a.checked}"`);
                    process.exit(1);
                }
                break;
            case '--json': a.json = true; break;
            case '--summary': a.summary = true; break;
            case '--no-cache': a.noCache = true; break;
            case '--clear-cache': a.clearCache = true; break;
            case '--cache-dir': a.cacheDir = v(); break;
            case '-h': case '--help':
                console.log('Usage: fractal-search.mjs --query <str> (--folder <path>... | --auto) [options]');
                console.log('Modes:   --list-folders | --list-notes | --find-outline <kw> | --clear-cache');
                console.log('Filters: --tag <t>... --checked true|false|none|any --note-name <n>... --exclude-note <n>...');
                console.log('         --outline-name <s> (.out title 部分一致) --h1 <s> (md 先頭 H1 部分一致)');
                console.log('         全フィルタ AND 合成: note → outliner → md(H1) → 行/ノード');
                console.log('         （--tag / --checked / --outline-name / --h1 指定時は --query 省略可）');
                console.log('Options: --regex --case-sensitive --whole-word --scope outline,node,page,md,file');
                console.log('         --max-per-file N --max-results N --json --summary --no-cache --cache-dir <p>');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${k}`);
                process.exit(1);
        }
    }
    // --tag / --checked / --outline-name / --h1 があれば --query 省略可（フィルタのみで列挙）
    const hasFilter = a.tags.length > 0 || a.checked !== null || a.outlineName !== null || a.h1 !== null;
    if (!a.listFolders && !a.listNotes && !a.findOutline && !a.clearCache && !a.query && !hasFilter) {
        console.error('Error: --query is required (or use --tag / --checked / --outline-name / --h1 / --list-folders / --list-notes / --find-outline / --clear-cache)');
        process.exit(1);
    }
    return a;
}

// ─────────────── Folder discovery ───────────────

function electronConfigPath() {
    const plat = os.platform();
    const home = os.homedir();
    if (plat === 'darwin') return path.join(home, 'Library/Application Support/fractal-desktop/config.json');
    if (plat === 'win32') return path.join(process.env.APPDATA || '', 'fractal-desktop/config.json');
    return path.join(home, '.config/fractal-desktop/config.json');
}

function vscodeStatePaths() {
    const home = os.homedir();
    const plat = os.platform();
    const bases = [];
    if (plat === 'darwin') {
        const root = path.join(home, 'Library/Application Support');
        bases.push('Code', 'Code - Insiders', 'Cursor', 'Kiro', 'VSCodium', 'Antigravity');
        return bases.map(b => path.join(root, b, 'User/globalStorage/state.vscdb'));
    }
    if (plat === 'win32') {
        const ad = process.env.APPDATA || '';
        return ['Code', 'Code - Insiders', 'Cursor', 'Kiro', 'VSCodium', 'Antigravity']
            .map(b => path.join(ad, b, 'User/globalStorage/state.vscdb'));
    }
    const cfg = path.join(home, '.config');
    return ['Code', 'Code - Insiders', 'Cursor', 'Kiro', 'VSCodium', 'Antigravity']
        .map(b => path.join(cfg, b, 'User/globalStorage/state.vscdb'));
}

function readVscodeGlobalState(dbPath) {
    if (!fs.existsSync(dbPath)) return null;
    try {
        const out = execFileSync('sqlite3', [dbPath, "SELECT value FROM ItemTable WHERE key='imaken.fractal';"], {
            encoding: 'utf-8',
            timeout: 5000,
        });
        if (!out.trim()) return null;
        return JSON.parse(out.trim());
    } catch {
        return null;
    }
}

function discoverFolders() {
    /**
     * 返り値: [{ path, sources: [{ kind: 'electron'|'vscode', detail: string }] }, ...]
     * sources は同一 path が複数エディタに登録されていれば複数要素になる。
     */
    const byPath = new Map();
    const addAll = (arr, src) => {
        if (!Array.isArray(arr)) return;
        for (const p of arr) {
            if (typeof p !== 'string') continue;
            const norm = path.resolve(p);
            if (!fs.existsSync(norm)) continue;
            if (!byPath.has(norm)) byPath.set(norm, { path: norm, sources: [] });
            byPath.get(norm).sources.push(src);
        }
    };

    // Electron
    const ec = electronConfigPath();
    if (fs.existsSync(ec)) {
        try {
            const cfg = JSON.parse(fs.readFileSync(ec, 'utf-8'));
            addAll(cfg.notesFolders, { kind: 'electron', detail: ec });
        } catch { /* skip */ }
    }
    // VSCode family
    for (const db of vscodeStatePaths()) {
        const st = readVscodeGlobalState(db);
        if (!st) continue;
        // editor 名は db path のフォルダ名から推定
        const editorName = path.basename(path.dirname(path.dirname(path.dirname(db))));
        addAll(st.notesFolders, { kind: 'vscode', editor: editorName, detail: db });
    }
    return [...byPath.values()];
}

// ─────────────── Regex builder ───────────────

// FR-MLG-02 (sprint 20260818-183407): wholeWord の多言語境界 — src/shared/whole-word.js の
// **ミラー**（CLI はゼロ install 配布のため import しない。extension⇄CLI 一致 TC = TC-MLG-04b が番人・
// ADRL-0059 と同型の運用）。規則: CJK 含みクエリは素通し / それ以外 Unicode lookaround（u）/
// u 不正 pattern は従来 \b へ fallback。
export function buildRegex(query, { regex, caseSensitive, wholeWord }) {
    const body = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const flags = caseSensitive ? 'g' : 'gi';
    if (!wholeWord) return new RegExp(body, flags);
    let isCjk = false;
    try {
        isCjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(query || '');
    } catch { /* 判定不能は非 CJK 扱い */ }
    if (isCjk) return new RegExp(body, flags);
    try {
        return new RegExp(`(?<![\\p{L}\\p{N}_])(?:${body})(?![\\p{L}\\p{N}_])`, flags + 'u');
    } catch {
        return new RegExp(`\\b(?:${body})\\b`, flags);
    }
}

// ─────────────── ext: クエリ構文 ───────────────

// FR-SEF-01 (sprint 20260822-203347): ext: クエリ構文の parse — src/shared/search-ext-filter.js の
// **ミラー**（CLI はゼロ install 配布のため import しない。extension⇄CLI 一致 TC = TC-SEF-06 が番人・
// ADRL-0059 と同型の運用）。規則: 先頭トークンのみ / キーワードは大小文字 + 全角を文字クラスで許容 /
// 値のみ NFKC + 小文字 + 先頭ドット strip / 有効値 0 個はリテラル縮退 / body は生のまま。
export function parseExtQuery(raw) {
    const q = String(raw == null ? '' : raw);
    const m = q.match(/^\s*[eｅ][xｘ][tｔ][:：](\S+)(\s+|$)/iu);
    if (!m) return { body: q.trim(), exts: null };
    const exts = m[1].normalize('NFKC').toLowerCase()
        .split(',')
        .map((x) => x.replace(/^\./, '').trim())
        .filter((x) => x.length > 0);
    if (exts.length === 0) return { body: q.trim(), exts: null };
    return { body: q.slice(m[0].length).trim(), exts };
}

/** 拡張子（. なし）が exts にマッチするか。exts == null は常に true（ミラー — 正典と同一規則） */
function matchesExtMjs(ext, exts) {
    if (exts == null) return true;
    const e = String(ext == null ? '' : ext).toLowerCase();
    if (e.length === 0) return false;
    return exts.indexOf(e) !== -1;
}

// ─────────────── Match helpers ───────────────

function findMatches(text, regex) {
    const out = [];
    regex.lastIndex = 0;
    let m;
    while ((m = regex.exec(text)) !== null) {
        out.push({ start: m.index, end: m.index + m[0].length, matched: m[0] });
        if (m.index === regex.lastIndex) regex.lastIndex++;
    }
    return out;
}

function normalizeMdLine(line) {
    return line
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        .substring(0, 200);
}

// ─────────────── outline.note: folder hierarchy ───────────────

/**
 * outline.note を読み、{ structure, mtimeMs, size } を返す。
 * 読めなければ null。
 */
function loadNoteStructure(folder) {
    const p = path.join(folder, 'outline.note');
    if (!fs.existsSync(p)) return null;
    try {
        const st = fs.statSync(p);
        const raw = fs.readFileSync(p, 'utf-8');
        const json = JSON.parse(raw);
        return { structure: json, mtimeMs: st.mtimeMs, size: st.size };
    } catch {
        return null;
    }
}

/**
 * outline.note の構造から、fileId → folderChain (祖先フォルダタイトル配列) のマップを作る。
 * ルート直下のファイルは folderChain = [] になる。
 */
function buildFolderChainMap(structure) {
    const map = new Map();
    if (!structure || !Array.isArray(structure.rootIds) || !structure.items) return map;
    const items = structure.items;

    const visit = (id, chain) => {
        const it = items[id];
        if (!it) return;
        if (it.type === 'file') {
            map.set(id, chain.slice());
            return;
        }
        if (it.type === 'folder' && Array.isArray(it.childIds)) {
            const nextChain = chain.concat(it.title || '');
            for (const cid of it.childIds) visit(cid, nextChain);
        }
    };
    for (const rid of structure.rootIds) visit(rid, []);
    return map;
}

// ─────────────── Cache ───────────────

function defaultCacheDir() {
    if (os.platform() === 'win32') {
        const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        return path.join(base, 'fractal-search', 'cache');
    }
    // XDG_CACHE_HOME preferred, else ~/.cache
    const xdg = process.env.XDG_CACHE_HOME;
    return path.join(xdg || path.join(os.homedir(), '.cache'), 'fractal-search');
}

function cacheFilePath(cacheDir, folder) {
    const abs = path.resolve(folder);
    const hash = crypto.createHash('sha1').update(abs).digest('hex').slice(0, 10);
    const safeBase = path.basename(abs).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
    return path.join(cacheDir, `${safeBase}_${hash}.json`);
}

function loadCache(cacheDir, folder) {
    const p = cacheFilePath(cacheDir, folder);
    if (!fs.existsSync(p)) return emptyCache(folder);
    try {
        const raw = fs.readFileSync(p, 'utf-8');
        const obj = JSON.parse(raw);
        if (obj.version !== CACHE_VERSION) return emptyCache(folder);
        if (obj.folder !== path.resolve(folder)) return emptyCache(folder);
        if (!obj.files || typeof obj.files !== 'object') return emptyCache(folder);
        return obj;
    } catch {
        return emptyCache(folder);
    }
}

function emptyCache(folder) {
    return { version: CACHE_VERSION, folder: path.resolve(folder), files: {} };
}

function saveCache(cacheDir, folder, cache) {
    try {
        fs.mkdirSync(cacheDir, { recursive: true });
        fs.writeFileSync(cacheFilePath(cacheDir, folder), JSON.stringify(cache), 'utf-8');
    } catch { /* silent: cache is best-effort */ }
}

function clearAllCaches(cacheDir) {
    if (!fs.existsSync(cacheDir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(cacheDir)) {
        if (f.endsWith('.json')) {
            try { fs.unlinkSync(path.join(cacheDir, f)); n++; } catch { /* ignore */ }
        }
    }
    return n;
}

/**
 * 相対キー (folder 内相対 path) → 当該ファイル用 cache entry を取得。mtime+size 一致なら hit。
 * parser: (absPath) => object を返す。parse 失敗なら null を返すこと。
 */
function getCachedOrParse(cache, folder, relKey, parser, opts = {}) {
    const abs = path.join(folder, relKey);
    let st;
    try { st = fs.statSync(abs); } catch { return null; }
    const entry = cache.files[relKey];
    if (!opts.noCache && entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size && entry.data) {
        return { data: entry.data, fromCache: true };
    }
    const data = parser(abs);
    if (data === null) return null;
    cache.files[relKey] = { mtimeMs: st.mtimeMs, size: st.size, data };
    return { data, fromCache: false };
}

// ─────────────── Per-folder search ───────────────

/**
 * Parse a .out file for search: only keep what we need.
 * Returns { title, pageDir, nodes: [{id, text, subtext}] } or null on error.
 */
function parseOutForSearch(absPath) {
    try {
        const raw = fs.readFileSync(absPath, 'utf-8');
        const data = JSON.parse(raw);
        const nodes = [];
        for (const [id, n] of Object.entries(data.nodes || {})) {
            if (!n) continue;
            nodes.push({
                id,
                text: n.text || '',
                subtext: n.subtext ? String(n.subtext).substring(0, 500) : '',
                isPage: !!n.isPage,
                pageId: n.pageId || null,
                // v3: --tag / --checked フィルタ用（tags は text から正典ミラーで再計算 = 外部編集にも追従）
                tags: parseTagsFromText(n.text || ''),
                checked: (n.checked === true || n.checked === false) ? n.checked : null,
            });
        }
        return {
            title: data.title || null,
            pageDir: data.pageDir || null,
            nodes,
        };
    } catch {
        return null;
    }
}

/**
 * Parse a .md file for search: just read lines (normalization is cheap per query).
 * Returns { lines: string[] } or null on error.
 */
function parseMdForSearch(absPath) {
    try {
        const raw = fs.readFileSync(absPath, 'utf-8');
        return { lines: raw.split('\n') };
    } catch {
        return null;
    }
}

// ─────────────── 添付中身検索（FR-DS-06: tree file item = ext:'file'） ───────────────

const MAX_ATTACHMENT_SIZE = 50 * 1024 * 1024;  // FR-DS-07(d)・FR-TF-01 precedent

// （rev.2: safeResolveUnderDirMjs は walk 一本化で不要になり削除 — escape 防御は
//   walkContentSearchFilesMjs の symlink 非追従が担う。TC-DS-48(CLI) が番人）

// pdfjs vendor バンドル（esbuild 単一ファイル・repo に commit）の遅延 require。
// 欠損時は null（PDF は pdf_unavailable で skip・OOXML は続行 — FR-DS-06）。
// undefined = 未試行 / null = 不可
let pdfjsVendor;
function loadPdfjsVendor() {
    if (pdfjsVendor !== undefined) return pdfjsVendor;
    // pdf.js は require（module scope）で polyfill 警告を console に吐き、--json の
    // stdout JSON を汚染する → require の間だけ console を黙らせる（stderr 含む全級）
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    try {
        const require2 = createRequire(import.meta.url);
        // vendor/pdfjs-bundle.cjs は module.exports = { getDocument, ... }（scripts/build-pdfjs-vendor.js 生成）
        pdfjsVendor = require2(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'vendor', 'pdfjs-bundle.cjs'));
    } catch {
        pdfjsVendor = null;
    } finally {
        console.log = saved.log; console.warn = saved.warn; console.error = saved.error;
    }
    return pdfjsVendor;
}

async function extractPdfViaVendor(buf) {
    const lib = loadPdfjsVendor();
    if (!lib) return { lines: [], truncated: false, skipReason: 'pdf_unavailable' };
    try {
        // verbosity: 0 = errors のみ（pdfjs の Warning が stdout に出て --json の JSON を汚染するのを防ぐ）
        const doc = await lib.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
        const lines = [];
        const state = { total: 0, truncated: false };
        let rawLen = 0;
        try {
            for (let i = 1; i <= doc.numPages; i++) {
                const page = await doc.getPage(i);
                const content = await page.getTextContent();
                const pageText = content.items.map(it => it.str || '').join('');
                rawLen += pageText.trim().length;
                pushNormalized(lines, state, pageText, `p.${i}`);   // FR-DS-09: loc = ページ番号（正典と同形）
                if (state.truncated) break;
            }
        } finally {
            await doc.destroy().catch(() => {});
        }
        if (rawLen === 0) return { lines: [], truncated: false, skipReason: 'pdf_no_text' };
        return { lines, truncated: state.truncated };
    } catch {
        return { lines: [], truncated: false, skipReason: 'extract_error' };
    }
}

// 添付 1 件の抽出（キャッシュ相乗り用 parser は sync 前提のため、この関数は
// getCachedOrParse を通さず自前で cache.files を読む/書く — mtime+size の判定規則は同一）
async function extractAttachmentCached(cache, folder, relKey, absPath, noCache) {
    let st;
    try { st = fs.statSync(absPath); } catch { return null; }
    const entry = cache.files[relKey];
    // skipReason 込みでも data は truthy オブジェクト（&& entry.data guard で毎回再抽出しない — FR-DS-08）
    if (!noCache && entry && entry.mtimeMs === st.mtimeMs && entry.size === st.size && entry.data) {
        return { data: entry.data, fromCache: true };
    }
    let data;
    if (st.size > MAX_ATTACHMENT_SIZE) {
        data = { lines: [], truncated: false, skipReason: 'too_large' };
    } else {
        const ext = path.extname(absPath).toLowerCase();
        if (ext === '.pdf') {
            data = await extractPdfViaVendor(fs.readFileSync(absPath));
        } else {
            data = await extractDocTextMjs(fs.readFileSync(absPath), ext);
        }
    }
    // FR-DS-04 rev.2 / NFR-DS-08: noCache（テキスト経路の成功結果）はキャッシュに書かない
    // （.env/.pem 等の秘密テキストの平文複製回避）。skip 結果（binary 等）は従来どおり書く
    if (!data.noCache) {
        cache.files[relKey] = { mtimeMs: st.mtimeMs, size: st.size, data };
    }
    return { data, fromCache: false };
}

// files/ 配下の添付中身検索（rev.3: 全ファイル列挙 — 拡張側 walkContentSearchFiles の 1:1 ミラー）。
// 拡張子フィルタは撤廃（sprint 20260815 FR-DS-01 rev.3）— 対象判定は extractDocTextMjs 内側の
// sniff に一元化。files/ は tree file item・node 📎・md 📎 の共有実体置き場なので 1 walk で全種対象。
// symlink は追わない（Dirent の isFile/isDirectory は symlink で false — escape を構造的に防ぐ）。
function walkContentSearchFilesMjs(dir) {
    const result = [];
    const walk = (d) => {
        let entries;
        try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
        entries.sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of entries) {
            const full = path.join(d, entry.name);
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) result.push(full);
        }
    };
    walk(dir);
    return result;
}

async function searchTreeFileAttachments(folder, regex, args, state, cache, notesStructure) {
    if (!regex) return;
    if (args.scope && !args.scope.has('file')) return;
    if (args.h1 || args.outlineName) return;  // md/outliner 向け AND プレフィルタ指定時は対象外
    // TASK-21: 抽出テキストは NFKC 済み — クエリも NFKC で照合（拡張側と同型。既存 scope は生のまま）
    let attachRegex = regex;
    try {
        const nq = String(args.query || '').normalize('NFKC');
        if (nq && nq !== args.query) attachRegex = buildRegex(nq, args);
    } catch { /* 生 regex で続行 */ }
    const filesDir = path.join(folder, 'files');  // flat 前提（共有 files/）
    // 台帳 items は表示 title の逆引きにのみ使用（walk が主・台帳は従 — rev.2）
    const titleByRel = new Map();
    const items = notesStructure?.items || {};
    for (const item of Object.values(items)) {
        if (item && item.type === 'file' && item.ext === 'file' && item.filename && item.title) {
            titleByRel.set(item.filename, item.title);
        }
    }
    for (const abs of walkContentSearchFilesMjs(filesDir)) {
        if (state.results.length >= args.maxResults) return;
        // FR-SEF-03: ext ゲートは抽出の前（extension 第 4 段と同型 — 不要な抽出/キャッシュ生成をしない）
        if (!matchesExtMjs(path.extname(abs).slice(1), args.exts)) continue;
        const rel = path.relative(filesDir, abs);
        const relKey = path.join('files', rel);
        const hit = await extractAttachmentCached(cache, folder, relKey, abs, args.noCache);
        if (!hit) continue;
        if (hit.fromCache) state.stats.fileCacheHit++; else state.stats.fileCacheMiss++;
        if (hit.data.skipReason) continue;   // skip は記録済み・結果には出さない（FR-DS-08）
        // FR-DS-09: lines は {text, loc?} — searchLines は string[] 前提なので text を渡し loc を後付け
        const texts = hit.data.lines.map(l => l.text);
        const m = searchLines(texts, attachRegex, args);
        for (const match of m) {
            const loc = hit.data.lines[match.lineNumber] && hit.data.lines[match.lineNumber].loc;
            if (loc) match.loc = loc;
        }
        if (m.length > 0) {
            state.results.push({
                folder,
                kind: 'file',
                fileId: `files/${rel}`,       // rev.2: 同定は files/ 相対パス（拡張側と同形）
                fileName: rel,
                fileTitle: titleByRel.get(rel) || path.basename(abs),
                filePath: abs,
                folderChain: [],
                matches: m,
            });
        }
    }
}

async function searchFolder(folder, regex, args, state, cache) {
    let outFiles, rootMds;
    try {
        const entries = fs.readdirSync(folder);
        outFiles = entries.filter(f => f.endsWith('.out'));
        rootMds = entries.filter(f => f.endsWith('.md'));
    } catch { outFiles = []; rootMds = []; }

    // per-file summary counts
    const summary = {};

    // outline.note (folder hierarchy + title fallback)
    const noteWrap = loadNoteStructure(folder);
    const notesStructure = noteWrap?.structure || null;
    const folderChainMap = buildFolderChainMap(notesStructure);

    // flat layout では page md が note 直下に居るため、root md 走査との重複を防ぐ台帳
    // （--h1 モードの dedup 用。FR-SS-03。--query の既存挙動は変えない = NFR-SS-01）
    const pageMdNames = new Set();

    for (const outFile of outFiles) {
        if (state.results.length >= args.maxResults) return;
        const filePath = path.join(folder, outFile);
        const outlineId = outFile.replace(/\.out$/, '');

        const hit = getCachedOrParse(cache, folder, outFile, parseOutForSearch, { noCache: args.noCache });
        if (!hit) continue;
        const data = hit.data;
        if (hit.fromCache) state.stats.outCacheHit++;
        else state.stats.outCacheMiss++;

        const title = data.title
            || (notesStructure?.items?.[outlineId]?.title)
            || outlineId;
        // --outline-name: .out title 部分一致の AND プレフィルタ（FR-SS-02。不一致 outliner は丸ごと skip）
        if (!matchesOutlineName(title, args.outlineName)) continue;
        const folderChain = folderChainMap.get(outlineId) || [];
        summary[outlineId] = {
            kind: 'outline', outlineId, outlineTitle: title, outlineFile: filePath,
            folderChain, nodeHits: 0, pageHits: 0,
        };

        // --outline-name 単独（--query/--h1/--tag/--checked なし）: マッチ outliner 自体を結果に積む
        if (args.outlineName && !regex && !args.h1 && args.tags.length === 0 && args.checked === null) {
            state.results.push({
                folder, kind: 'outline', outlineId, outlineTitle: title,
                outlineFile: filePath, folderChain,
            });
            summary[outlineId].nodeHits++;
            if (state.results.length >= args.maxResults) return;
            continue;
        }

        // --- nodes ---
        // --h1 指定時は対象が md（page/root md）なので node 走査は skip（FR-SS-04 の階層）
        if (!args.h1 && (!args.scope || args.scope.has('node') || args.scope.has('outline')) && matchesExtMjs('out', args.exts)) {
            let perFile = 0;
            for (const node of data.nodes) {
                if (perFile >= args.maxPerFile && args.maxPerFile > 0) break;
                // --tag / --checked フィルタ（FR-SRF-01/02。query と AND）
                if (!matchesTagFilter(node.tags, args.tags)) continue;
                if (!matchesCheckedFilter(node.checked, args.checked)) continue;
                const matches = [];
                if (regex) {
                    if (node.text) {
                        for (const m of findMatches(node.text, regex)) {
                            matches.push({ field: 'text', line: node.text, ...m });
                        }
                    }
                    if (node.subtext) {
                        for (const m of findMatches(node.subtext, regex)) {
                            matches.push({ field: 'subtext', line: node.subtext.split('\n')[0], ...m });
                        }
                    }
                } else {
                    // --query 省略（フィルタのみ列挙・FR-SRF-03）: フィルタ通過 = ヒット
                    matches.push({ field: 'text', line: node.text, start: 0, end: 0 });
                }
                if (matches.length > 0) {
                    summary[outlineId].nodeHits++;
                    if (!args.scope || args.scope.has('node')) {
                        state.results.push({
                            folder,
                            kind: 'outline-node',
                            outlineId, outlineTitle: title, outlineFile: filePath, folderChain,
                            nodeId: node.id, nodeText: node.text,
                            isPage: node.isPage, pageId: node.pageId,
                            tags: node.tags, checked: node.checked,
                            matches,
                        });
                        perFile++;
                        if (state.results.length >= args.maxResults) return;
                    }
                }
            }
        }

        // --- pages (only nodes with pageId) ---
        // pageDir 解決: フラット規約（hint 優先 → flat 直下 → legacy <basename>/ → legacy pages/。ADRL-0018 ミラー）
        // 対象: --query あり（本文検索）or --h1 あり（先頭 H1 フィルタ。FR-SS-03/04）
        if ((regex || args.h1) && (!args.scope || args.scope.has('page')) && matchesExtMjs('md', args.exts)) {
            const pageDirAbs = resolvePagesDirForSearch(folder, outFile, data.pageDir);
            if (fs.existsSync(pageDirAbs)) {
                let perFile = 0;
                for (const node of data.nodes) {
                    if (!node.pageId) continue;
                    if (perFile >= args.maxPerFile && args.maxPerFile > 0) break;
                    const mdAbs = path.join(pageDirAbs, `${node.pageId}.md`);
                    pageMdNames.add(path.basename(mdAbs)); // root md 走査との dedup 台帳（--h1 用）
                    const relKey = path.relative(folder, mdAbs).replace(/\\/g, '/');
                    const mdHit = getCachedOrParse(cache, folder, relKey, parseMdForSearch, { noCache: args.noCache });
                    if (!mdHit) continue;
                    if (mdHit.fromCache) state.stats.mdCacheHit++; else state.stats.mdCacheMiss++;
                    // --h1: 先頭 H1 の部分一致で md を絞る（AND プレフィルタ。不一致は skip）
                    const body = mdHit.data.lines.join('\n');
                    if (!matchesH1Filter(body, args.h1)) continue;
                    if (regex) {
                        const pageMatches = searchLines(mdHit.data.lines, regex, args);
                        if (pageMatches.length > 0) {
                            summary[outlineId].pageHits++;
                            state.results.push({
                                folder,
                                kind: 'page',
                                outlineId, outlineTitle: title, outlineFile: filePath, folderChain,
                                pageId: node.pageId,
                                pagePath: mdAbs,
                                parentNodeId: node.id,
                                parentNodeText: node.text,
                                h1: args.h1 ? extractFirstH1Mjs(body) : undefined,
                                matches: pageMatches,
                            });
                            perFile++;
                            if (state.results.length >= args.maxResults) return;
                        }
                    } else {
                        // --h1 のみ（--query なし）: H1 マッチ md 自体を結果に積む
                        summary[outlineId].pageHits++;
                        state.results.push({
                            folder,
                            kind: 'page-h1',
                            outlineId, outlineTitle: title, outlineFile: filePath, folderChain,
                            pageId: node.pageId,
                            pagePath: mdAbs,
                            parentNodeId: node.id,
                            parentNodeText: node.text,
                            h1: extractFirstH1Mjs(body),
                        });
                        perFile++;
                        if (state.results.length >= args.maxResults) return;
                    }
                }
            }
        }
    }

    // --- root-level .md (not tied to any outline) ---
    // 対象: --query あり or --h1 あり（FR-SS-03。--outline-name 指定時は outliner 対象なので skip）
    if ((regex || args.h1) && !args.outlineName && (!args.scope || args.scope.has('md')) && matchesExtMjs('md', args.exts)) {
        for (const md of rootMds) {
            if (state.results.length >= args.maxResults) break;
            // --h1 モードでは page md（flat 直下）を root md として二重ヒットさせない
            if (args.h1 && pageMdNames.has(md)) continue;
            const mdHit = getCachedOrParse(cache, folder, md, parseMdForSearch, { noCache: args.noCache });
            if (!mdHit) continue;
            if (mdHit.fromCache) state.stats.mdCacheHit++; else state.stats.mdCacheMiss++;
            // --h1: 先頭 H1 部分一致で絞る（AND プレフィルタ）
            const body = mdHit.data.lines.join('\n');
            if (!matchesH1Filter(body, args.h1)) continue;
            if (regex) {
                const m = searchLines(mdHit.data.lines, regex, args);
                if (m.length > 0) {
                    state.results.push({
                        folder,
                        kind: 'md',
                        mdPath: path.join(folder, md),
                        mdName: md,
                        folderChain: [],
                        h1: args.h1 ? extractFirstH1Mjs(body) : undefined,
                        matches: m,
                    });
                }
            } else {
                // --h1 のみ: H1 マッチ md 自体を結果に積む
                state.results.push({
                    folder,
                    kind: 'md-h1',
                    mdPath: path.join(folder, md),
                    mdName: md,
                    folderChain: [],
                    h1: extractFirstH1Mjs(body),
                });
            }
        }
    }

    // --- tree file attachments（第 5 段・FR-DS-06。default scope 込み） ---
    await searchTreeFileAttachments(folder, regex, args, state, cache, notesStructure);

    // --- outline summary (file-level) ---
    if (!args.scope || args.scope.has('outline')) {
        for (const s of Object.values(summary)) {
            if (s.nodeHits + s.pageHits > 0) {
                state.outlineSummaries.push(s);
            }
        }
    }

    // --- Prune cache entries for files that no longer exist ---
    if (!args.noCache) {
        const presentKeys = new Set();
        for (const f of outFiles) presentKeys.add(f);
        for (const m of rootMds) presentKeys.add(m);
        // page md entries are keyed by relative path — keep any "*/<uuid>.md" whose referenced .out still exists
        // simpler: keep entries that mention an existing .out via cache; we just drop strictly non-existing paths
        for (const key of Object.keys(cache.files)) {
            const abs = path.join(folder, key);
            if (!fs.existsSync(abs)) {
                delete cache.files[key];
            }
        }
    }
}

/**
 * Run regex across pre-split MD lines with per-file match cap.
 */
function searchLines(lines, regex, args) {
    const out = [];
    for (let i = 0; i < lines.length; i++) {
        if (args.maxPerFile > 0 && out.length >= args.maxPerFile) break;
        const norm = normalizeMdLine(lines[i]);
        for (const m of findMatches(norm, regex)) {
            out.push({ field: 'content', lineNumber: i, line: norm, start: m.start, end: m.end });
            if (args.maxPerFile > 0 && out.length >= args.maxPerFile) break;
        }
    }
    return out;
}

// ─────────────── Output ───────────────

function renderText(results, outlineSummaries, args) {
    const lines = [];
    const byFolder = new Map();
    for (const r of results) {
        const arr = byFolder.get(r.folder) || [];
        arr.push(r);
        byFolder.set(r.folder, arr);
    }
    for (const [folder, arr] of byFolder) {
        lines.push(`📁 ${folder}`);
        const byOutline = new Map();
        const looseMds = [];
        const fileHits = [];
        for (const r of arr) {
            if (r.kind === 'md' || r.kind === 'md-h1') looseMds.push(r);
            else if (r.kind === 'file') fileHits.push(r);
            else {
                const k = r.outlineFile;
                (byOutline.get(k) || byOutline.set(k, []).get(k)).push(r);
            }
        }
        for (const [outlineFile, rs] of byOutline) {
            const first = rs[0];
            const chain = first.folderChain && first.folderChain.length > 0
                ? first.folderChain.join(' > ') + ' > '
                : '';
            lines.push(`  📓 ${chain}${first.outlineTitle}  [${path.basename(outlineFile)}]`);
            for (const r of rs) {
                if (r.kind === 'outline-node') {
                    lines.push(`     • node "${truncate(r.nodeText, 60)}"  (${r.nodeId}${r.isPage ? `, page ${r.pageId?.slice(0, 8)}...` : ''})`);
                    const seen = new Set();
                    for (const m of r.matches) {
                        const k = `${m.field}|${m.line}`;
                        if (seen.has(k)) continue; seen.add(k);
                        lines.push(`       ${m.field}: ${truncate(m.line, 80)}`);
                    }
                } else if (r.kind === 'page') {
                    lines.push(`     📄 page for "${truncate(r.parentNodeText, 50)}"  (pageId: ${r.pageId.slice(0, 8)}... / node: ${r.parentNodeId})`);
                    const seen = new Set();
                    for (const m of r.matches) {
                        if (seen.has(m.lineNumber)) continue; seen.add(m.lineNumber);
                        lines.push(`       L${m.lineNumber + 1}: ${truncate(m.line, 80)}`);
                    }
                } else if (r.kind === 'page-h1') {
                    // --h1 単独モード: H1 マッチ md の一覧（FR-SS-03）
                    lines.push(`     📄 H1 "${truncate(r.h1 || '', 60)}"  (pageId: ${r.pageId.slice(0, 8)}... / node: ${r.parentNodeId})`);
                } else if (r.kind === 'outline') {
                    // --outline-name 単独モード: マッチ outliner の一覧（FR-SS-02）
                    // タイトル行（📓）自体が情報なので追加行は不要
                }
            }
        }
        for (const r of looseMds) {
            if (r.kind === 'md-h1') {
                lines.push(`  📑 ${r.mdName}  — H1 "${truncate(r.h1 || '', 60)}"`);
                continue;
            }
            lines.push(`  📑 ${r.mdName}`);
            const seen = new Set();
            for (const m of r.matches) {
                if (seen.has(m.lineNumber)) continue; seen.add(m.lineNumber);
                lines.push(`     L${m.lineNumber + 1}: ${truncate(m.line, 90)}`);
            }
        }
        for (const r of fileHits) {
            lines.push(`  📎 ${r.fileTitle}  [${r.fileName}]`);
            const seen = new Set();
            for (const m of r.matches) {
                if (seen.has(m.lineNumber)) continue; seen.add(m.lineNumber);
                // FR-DS-09: 位置（p.5 / slide 3 / シート名!B12）があれば L<n> より優先表示
                const pos = m.loc || `L${m.lineNumber + 1}`;
                lines.push(`     ${pos}: ${truncate(m.line, 90)}`);
            }
        }
        lines.push('');
    }
    if (args.scope && args.scope.has('outline') && outlineSummaries.length > 0) {
        lines.push('--- outline summary (node+page hits per outline) ---');
        for (const s of outlineSummaries) {
            lines.push(`  ${s.outlineTitle}  [${path.basename(s.outlineFile)}]  nodes:${s.nodeHits} pages:${s.pageHits}`);
        }
    }
    return lines.join('\n');
}

function renderSummary(results, outlineSummaries) {
    const lines = [];
    const outlineCount = new Map();
    const mdCount = new Map();
    for (const r of results) {
        const folder = r.folder;
        if (r.kind === 'md') {
            const key = `${folder} :: ${r.mdName}`;
            mdCount.set(key, (mdCount.get(key) || 0) + r.matches.length);
        } else {
            const key = `${folder} :: ${r.outlineTitle} [${path.basename(r.outlineFile)}]`;
            const cur = outlineCount.get(key) || { nodes: 0, pages: 0 };
            if (r.kind === 'outline-node') cur.nodes += r.matches.length;
            if (r.kind === 'page') cur.pages += r.matches.length;
            outlineCount.set(key, cur);
        }
    }
    lines.push('outline hits (node + page matches):');
    for (const [k, v] of outlineCount) lines.push(`  ${k}  nodes:${v.nodes}  pages:${v.pages}`);
    if (mdCount.size > 0) {
        lines.push('');
        lines.push('loose md hits:');
        for (const [k, v] of mdCount) lines.push(`  ${k}  lines:${v}`);
    }
    return lines.join('\n');
}

function truncate(s, n) {
    if (!s) return '';
    s = String(s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ─────────────── List notes ───────────────

/**
 * folders: [{path, sources}, ...] or [string, ...] の混在を許容
 * 各フォルダ内の .out を全列挙 → outline.note の folderChain 付与 → dedupe (絶対パス) してフラットリスト化
 */
function listAllNotes(folders, opts = {}) {
    const { cacheDir, noCache } = opts;
    const notes = [];
    const seenOutlines = new Set();
    const stats = { outCacheHit: 0, outCacheMiss: 0 };

    for (const entry of folders) {
        const fAbs = typeof entry === 'string' ? path.resolve(entry) : entry.path;
        const sources = typeof entry === 'string' ? [] : (entry.sources || []);
        if (!fs.existsSync(fAbs)) continue;

        let outFiles = [];
        try {
            outFiles = fs.readdirSync(fAbs).filter(x => x.endsWith('.out'));
        } catch { continue; }

        const noteWrap = loadNoteStructure(fAbs);
        const structure = noteWrap?.structure || null;
        const folderChainMap = buildFolderChainMap(structure);

        // Load cache for this folder (shared with --query search — same entries reused)
        const cache = (cacheDir && !noCache) ? loadCache(cacheDir, fAbs) : emptyCache(fAbs);

        for (const f of outFiles) {
            const abs = path.join(fAbs, f);
            if (seenOutlines.has(abs)) continue;
            seenOutlines.add(abs);

            const outlineId = f.replace(/\.out$/, '');
            let lastModifiedMs = 0;
            try { lastModifiedMs = fs.statSync(abs).mtimeMs; } catch { continue; }

            const hit = getCachedOrParse(cache, fAbs, f, parseOutForSearch, { noCache });
            if (!hit) continue;  // corrupted / unreadable
            if (hit.fromCache) stats.outCacheHit++;
            else stats.outCacheMiss++;

            const data = hit.data;
            const title = data.title
                || structure?.items?.[outlineId]?.title
                || outlineId;
            const nodeCount = data.nodes.length;
            const pageCount = data.nodes.filter(n => n && n.pageId).length;

            notes.push({
                folder: fAbs,
                sources,
                outlineId,
                outlineFile: abs,
                title,
                folderChain: folderChainMap.get(outlineId) || [],
                pageDir: data.pageDir || null,
                nodeCount,
                pageCount,
                lastModifiedMs,
                inOutlineNote: !!structure?.items?.[outlineId],
            });
        }

        // prune stale cache entries (files that no longer exist) and save
        if (cacheDir && !noCache) {
            for (const key of Object.keys(cache.files)) {
                if (!fs.existsSync(path.join(fAbs, key))) delete cache.files[key];
            }
            saveCache(cacheDir, fAbs, cache);
        }
    }
    notes.__stats = stats;
    return notes;
}

function renderFoldersList(folders) {
    const lines = ['Discovered Fractal notes folders:'];
    if (folders.length === 0) {
        lines.push('  (none found — use --folder to specify)');
        return lines.join('\n');
    }
    for (const f of folders) {
        const srcLabels = (f.sources || []).map(s => {
            if (s.kind === 'electron') return 'electron';
            if (s.kind === 'vscode') return `vscode:${s.editor}`;
            return 'unknown';
        });
        const uniq = [...new Set(srcLabels)];
        lines.push(`  ${f.path}`);
        if (uniq.length > 0) lines.push(`     sources: ${uniq.join(', ')}`);
    }
    return lines.join('\n');
}

function renderFoundOutlines(notes, query, totalCount) {
    if (notes.length === 0) {
        return `🔍 find-outline "${query}"\n  (no match in ${totalCount} outlines)`;
    }
    const lines = [`🔍 find-outline "${query}"   matched ${notes.length} of ${totalCount}`];
    const byFolder = new Map();
    for (const n of notes) {
        const arr = byFolder.get(n.folder) || [];
        arr.push(n);
        byFolder.set(n.folder, arr);
    }
    for (const [folder, arr] of byFolder) {
        lines.push(`📁 ${folder}`);
        arr.sort((a, b) => {
            const ka = (a.folderChain || []).join('/') + '/' + (a.title || '');
            const kb = (b.folderChain || []).join('/') + '/' + (b.title || '');
            return ka.localeCompare(kb);
        });
        for (const n of arr) {
            const chain = n.folderChain && n.folderChain.length > 0
                ? n.folderChain.join(' > ') + ' > '
                : '';
            const pageInfo = n.pageCount > 0 ? `, pages:${n.pageCount}` : '';
            lines.push(`  📓 ${chain}${n.title}  [${path.basename(n.outlineFile)}]  nodes:${n.nodeCount}${pageInfo}`);
        }
    }
    return lines.join('\n');
}

function renderNotesList(notes) {
    if (notes.length === 0) return '(no notes found)';
    // group by folder
    const byFolder = new Map();
    for (const n of notes) {
        const arr = byFolder.get(n.folder) || [];
        arr.push(n);
        byFolder.set(n.folder, arr);
    }
    const lines = [];
    for (const [folder, arr] of byFolder) {
        lines.push(`📁 ${folder}  (${arr.length} outlines)`);
        // Sort: by folderChain join, then title
        arr.sort((a, b) => {
            const ka = (a.folderChain || []).join('/') + '/' + (a.title || '');
            const kb = (b.folderChain || []).join('/') + '/' + (b.title || '');
            return ka.localeCompare(kb);
        });
        for (const n of arr) {
            const chain = n.folderChain && n.folderChain.length > 0
                ? n.folderChain.join(' > ') + ' > '
                : '';
            const pageInfo = n.pageCount > 0 ? `, pages:${n.pageCount}` : '';
            const orphan = n.inOutlineNote ? '' : '  (not in outline.note)';
            lines.push(`  📓 ${chain}${n.title}  [${path.basename(n.outlineFile)}]  nodes:${n.nodeCount}${pageInfo}${orphan}`);
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd();
}

// ─────────────── Main ───────────────

async function main() {
    const args = parseArgs(process.argv);
    const cacheDir = args.cacheDir ? path.resolve(args.cacheDir) : defaultCacheDir();

    // --clear-cache: purge and exit
    if (args.clearCache) {
        const n = clearAllCaches(cacheDir);
        if (args.json) {
            console.log(JSON.stringify({ cleared: n, cacheDir }, null, 2));
        } else {
            console.log(`Cleared ${n} cache file(s) from ${cacheDir}`);
        }
        return;
    }

    // folder resolution
    //   explicit --folder entries become {path, sources: []} for consistency
    const explicitEntries = args.folders.map(f => ({ path: path.resolve(f), sources: [] }));

    // auto-discovery triggered by --auto / --list-folders / --list-notes / --find-outline
    // （--note-name / --exclude-note も、--folder 明示が無ければ自動検出を起動）
    let discoveredEntries = [];
    const nameFilterActive = args.noteNames.length > 0 || args.excludeNotes.length > 0;
    if (args.auto || args.listFolders || args.listNotes || args.findOutline
        || (nameFilterActive && explicitEntries.length === 0)) {
        discoveredEntries = discoverFolders();
    }

    // merge explicit + discovered (explicit keeps its empty sources, discovered adds sources)
    const folderMap = new Map();
    for (const e of explicitEntries) folderMap.set(e.path, { ...e });
    for (const e of discoveredEntries) {
        if (folderMap.has(e.path)) {
            // merge sources
            const cur = folderMap.get(e.path);
            cur.sources = [...cur.sources, ...e.sources];
        } else {
            folderMap.set(e.path, { ...e });
        }
    }
    let folderEntries = [...folderMap.values()];
    // --note-name / --exclude-note: noteTitle（outline.note）or フォルダ名で対象 note を絞る
    if (nameFilterActive) {
        const before = folderEntries.length;
        folderEntries = filterFoldersByNoteName(folderEntries, args.noteNames, args.excludeNotes);
        if (folderEntries.length === 0 && before > 0) {
            console.error(`Error: no note matched --note-name/--exclude-note (candidates: ${before})`);
            process.exit(1);
        }
    }
    const folders = folderEntries.map(e => e.path);

    // --list-folders: print discovered folders and exit
    if (args.listFolders) {
        if (args.json) {
            // FR-SS-01: name (noteTitle 優先) と dirName (フォルダ名) を区別して機械可読に
            const enriched = folderEntries.map(e => ({
                ...e,
                name: resolveNoteLabelFromDisk(e.path),
                dirName: path.basename(e.path),
            }));
            console.log(JSON.stringify({ folders: enriched }, null, 2));
        } else {
            console.log(renderFoldersList(folderEntries));
        }
        return;
    }

    // --list-notes: enumerate .out in every folder (cache-backed), dedupe, with folderChain and stats
    if (args.listNotes) {
        const notes = listAllNotes(folderEntries, { cacheDir, noCache: args.noCache });
        const st = notes.__stats || { outCacheHit: 0, outCacheMiss: 0 };
        delete notes.__stats;
        if (args.json) {
            console.log(JSON.stringify({
                folders: folderEntries, notes,
                cache: { dir: cacheDir, enabled: !args.noCache, ...st },
            }, null, 2));
        } else {
            console.log(renderNotesList(notes));
            console.log('');
            console.log(`Total: ${notes.length} outline(s) across ${folderEntries.length} folder(s).`);
            if (!args.noCache) console.log(`Cache: hit ${st.outCacheHit} / miss ${st.outCacheMiss}`);
        }
        return;
    }

    // --find-outline: title + folderChain substring/regex match (reuses list-notes cache)
    if (args.findOutline) {
        const allNotes = listAllNotes(folderEntries, { cacheDir, noCache: args.noCache });
        const st = allNotes.__stats || { outCacheHit: 0, outCacheMiss: 0 };
        delete allNotes.__stats;

        const regex = buildRegex(args.findOutline, args);
        const matched = allNotes.filter(n => {
            if (n.title && regex.test(n.title)) return true;
            if (n.folderChain && n.folderChain.some(f => regex.test(f))) return true;
            return false;
        });

        if (args.json) {
            console.log(JSON.stringify({
                query: args.findOutline,
                folders: folderEntries,
                notes: matched,
                totalOutlines: allNotes.length,
                matchedCount: matched.length,
                cache: { dir: cacheDir, enabled: !args.noCache, ...st },
            }, null, 2));
        } else {
            console.log(renderFoundOutlines(matched, args.findOutline, allNotes.length));
            if (!args.noCache) console.log(`Cache: hit ${st.outCacheHit} / miss ${st.outCacheMiss}`);
        }
        return;
    }

    if (folders.length === 0) {
        console.error('Error: no folders specified (use --folder or --auto)');
        process.exit(1);
    }

    // FR-SEF-03: --query の ext: トークンをミラー parse（--scope とは AND）。body 空 = 検索非実行（既存の空クエリ挙動）
    if (args.query) {
        const pq = parseExtQuery(args.query);
        args.query = pq.body;
        args.exts = pq.exts;
    }
    const regex = args.query ? buildRegex(args.query, args) : null; // null = フィルタのみ列挙（FR-SRF-03）
    const state = {
        results: [],
        outlineSummaries: [],
        stats: { outCacheHit: 0, outCacheMiss: 0, mdCacheHit: 0, mdCacheMiss: 0, fileCacheHit: 0, fileCacheMiss: 0 },
    };
    for (const f of folders) {
        if (!fs.existsSync(f)) {
            console.error(`Warning: folder not found: ${f}`);
            continue;
        }
        const cache = args.noCache ? emptyCache(f) : loadCache(cacheDir, f);
        await searchFolder(f, regex, args, state, cache);
        if (!args.noCache) saveCache(cacheDir, f, cache);
        if (state.results.length >= args.maxResults) break;
    }

    const truncated = state.results.length >= args.maxResults;
    if (args.json) {
        console.log(JSON.stringify({
            query: args.query,
            folders,
            scope: args.scope ? [...args.scope] : ['outline', 'node', 'page', 'md'],
            results: state.results,
            outlineSummaries: state.outlineSummaries,
            cache: { dir: cacheDir, enabled: !args.noCache, ...state.stats },
            truncated,
        }, null, 2));
    } else if (args.summary) {
        console.log(renderSummary(state.results, state.outlineSummaries));
        if (truncated) console.log(`\n(truncated at --max-results ${args.maxResults})`);
    } else {
        const text = renderText(state.results, state.outlineSummaries, args);
        if (text.trim() === '') console.log('(no matches)');
        else console.log(text);
        if (truncated) console.log(`(truncated at --max-results ${args.maxResults})`);
    }
}

// CLI 直接実行時のみ main（unit import 時に暴発しない・design §B5）
// CLI 直接実行判定（TASK-B5 sprint 20260727-065214）: install.sh は claude/cursor/antigravity に
// symlink 配置するが、Node は main entry の import.meta.url を realpath 解決するため、
// argv[1]（symlink パス）との素の比較は不一致 → main() が走らない silent no-op になる。
// argv[1] を realpathSync で解決してから比較する（解決失敗時は素の argv[1] に fallback）。
function __isCliInvocation() {
    if (!process.argv[1]) return false;
    let entry = process.argv[1];
    try { entry = fs.realpathSync(entry); } catch { /* 存在しない等 → 素の argv[1] で比較 */ }
    return import.meta.url === pathToFileURL(entry).href;
}
if (__isCliInvocation()) {
    main().catch((e) => { console.error(e); process.exit(1); });
}
