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

const CACHE_VERSION = 2;  // bump on schema change to invalidate old caches

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
        scope: null,         // Set<'outline'|'node'|'page'|'md'> | null=all
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
            case '--json': a.json = true; break;
            case '--summary': a.summary = true; break;
            case '--no-cache': a.noCache = true; break;
            case '--clear-cache': a.clearCache = true; break;
            case '--cache-dir': a.cacheDir = v(); break;
            default:
                console.error(`Unknown option: ${k}`);
                process.exit(1);
        }
    }
    if (!a.listFolders && !a.listNotes && !a.findOutline && !a.clearCache && !a.query) {
        console.error('Error: --query is required (or use --list-folders / --list-notes / --find-outline / --clear-cache)');
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
        bases.push('Code', 'Code - Insiders', 'Cursor', 'Kiro', 'VSCodium');
        return bases.map(b => path.join(root, b, 'User/globalStorage/state.vscdb'));
    }
    if (plat === 'win32') {
        const ad = process.env.APPDATA || '';
        return ['Code', 'Code - Insiders', 'Cursor', 'Kiro', 'VSCodium']
            .map(b => path.join(ad, b, 'User/globalStorage/state.vscdb'));
    }
    const cfg = path.join(home, '.config');
    return ['Code', 'Code - Insiders', 'Cursor', 'Kiro', 'VSCodium']
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

function buildRegex(query, { regex, caseSensitive, wholeWord }) {
    let body = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (wholeWord) body = `\\b(?:${body})\\b`;
    const flags = caseSensitive ? 'g' : 'gi';
    return new RegExp(body, flags);
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

function searchFolder(folder, regex, args, state, cache) {
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
        const folderChain = folderChainMap.get(outlineId) || [];
        summary[outlineId] = {
            kind: 'outline', outlineId, outlineTitle: title, outlineFile: filePath,
            folderChain, nodeHits: 0, pageHits: 0,
        };

        // --- nodes ---
        if (!args.scope || args.scope.has('node') || args.scope.has('outline')) {
            let perFile = 0;
            for (const node of data.nodes) {
                if (perFile >= args.maxPerFile && args.maxPerFile > 0) break;
                const matches = [];
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
                if (matches.length > 0) {
                    summary[outlineId].nodeHits++;
                    if (!args.scope || args.scope.has('node')) {
                        state.results.push({
                            folder,
                            kind: 'outline-node',
                            outlineId, outlineTitle: title, outlineFile: filePath, folderChain,
                            nodeId: node.id, nodeText: node.text,
                            isPage: node.isPage, pageId: node.pageId,
                            matches,
                        });
                        perFile++;
                        if (state.results.length >= args.maxResults) return;
                    }
                }
            }
        }

        // --- pages (only nodes with pageId) ---
        if (!args.scope || args.scope.has('page')) {
            const pageDirAbs = data.pageDir
                ? (path.isAbsolute(data.pageDir) ? data.pageDir : path.resolve(folder, data.pageDir))
                : path.join(folder, 'pages');
            if (fs.existsSync(pageDirAbs)) {
                let perFile = 0;
                for (const node of data.nodes) {
                    if (!node.pageId) continue;
                    if (perFile >= args.maxPerFile && args.maxPerFile > 0) break;
                    const mdAbs = path.join(pageDirAbs, `${node.pageId}.md`);
                    const relKey = path.relative(folder, mdAbs).replace(/\\/g, '/');
                    const mdHit = getCachedOrParse(cache, folder, relKey, parseMdForSearch, { noCache: args.noCache });
                    if (!mdHit) continue;
                    if (mdHit.fromCache) state.stats.mdCacheHit++; else state.stats.mdCacheMiss++;
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
                            matches: pageMatches,
                        });
                        perFile++;
                        if (state.results.length >= args.maxResults) return;
                    }
                }
            }
        }
    }

    // --- root-level .md (not tied to any outline) ---
    if (!args.scope || args.scope.has('md')) {
        for (const md of rootMds) {
            if (state.results.length >= args.maxResults) break;
            const mdHit = getCachedOrParse(cache, folder, md, parseMdForSearch, { noCache: args.noCache });
            if (!mdHit) continue;
            if (mdHit.fromCache) state.stats.mdCacheHit++; else state.stats.mdCacheMiss++;
            const m = searchLines(mdHit.data.lines, regex, args);
            if (m.length > 0) {
                state.results.push({
                    folder,
                    kind: 'md',
                    mdPath: path.join(folder, md),
                    mdName: md,
                    folderChain: [],
                    matches: m,
                });
            }
        }
    }

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
        for (const r of arr) {
            if (r.kind === 'md') looseMds.push(r);
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
                }
            }
        }
        for (const r of looseMds) {
            lines.push(`  📑 ${r.mdName}`);
            const seen = new Set();
            for (const m of r.matches) {
                if (seen.has(m.lineNumber)) continue; seen.add(m.lineNumber);
                lines.push(`     L${m.lineNumber + 1}: ${truncate(m.line, 90)}`);
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

function main() {
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
    let discoveredEntries = [];
    if (args.auto || args.listFolders || args.listNotes || args.findOutline) {
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
    const folderEntries = [...folderMap.values()];
    const folders = folderEntries.map(e => e.path);

    // --list-folders: print discovered folders and exit
    if (args.listFolders) {
        if (args.json) {
            console.log(JSON.stringify({ folders: folderEntries }, null, 2));
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

    const regex = buildRegex(args.query, args);
    const state = {
        results: [],
        outlineSummaries: [],
        stats: { outCacheHit: 0, outCacheMiss: 0, mdCacheHit: 0, mdCacheMiss: 0 },
    };
    for (const f of folders) {
        if (!fs.existsSync(f)) {
            console.error(`Warning: folder not found: ${f}`);
            continue;
        }
        const cache = args.noCache ? emptyCache(f) : loadCache(cacheDir, f);
        searchFolder(f, regex, args, state, cache);
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

main();
