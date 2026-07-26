#!/usr/bin/env node
/**
 * fractal-doctor.mjs — Fractal note の整合性チェック（read-only）
 *
 * 検査（FR-DOC-01〜05）:
 *   layout    : .out のフラットヒント（pageDir/imageDir/fileDir）と legacy dir 残骸の検出
 *   refs      : node.images / node.filePath / node.pageId の実体不在（ERROR）+ page md 本文の相対リンク切れ（WARN）
 *   orphans   : どこからも参照されない images/ files/ の実ファイル・note 直下の宙ぶらりん md（INFO）
 *   structure : outline.note items の実体不在（ERROR）/ 未登録 .out（WARN）/ childIds 宙ぶらりん（ERROR）
 *   ownership : 同一 asset を複数 node が参照（1:1 所有違反・WARN）
 *
 * 使い方:
 *   node fractal-doctor.mjs --note-dir /path/to/note
 *   node fractal-doctor.mjs --note-dir /path/to/note --json
 *
 * 保証:
 *   - 完全 read-only（このファイルは fs の書込/削除/mkdir API を一切使わない）
 *   - exit code: 0 = クリーン / 1 = WARN のみ / 2 = ERROR あり（FR-DOC-07）
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

// フラットヒントの正典: src/shared/flat-layout.ts FLAT_OUT_HINTS
const FLAT_HINTS = { pageDir: '.', imageDir: './images', fileDir: './files' };

function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

function listFilesShallow(dir) {
    try { return fs.readdirSync(dir).filter((f) => isFile(path.join(dir, f))); } catch { return []; }
}

/** md 本文からローカル参照（images/files 相対パス）を集める。URL / anchor / 絶対パスは除外 */
export function extractLocalRefs(md) {
    const refs = [];
    const re = /!?\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(String(md || ''))) !== null) {
        let url = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) continue; // http: / mailto: / fractal: 等
        if (url.startsWith('#') || url.startsWith('/')) continue;
        try { url = decodeURIComponent(url); } catch { /* 生のまま */ }
        refs.push(url);
    }
    return refs;
}

/**
 * note フォルダを検査して findings を返す（fs read のみ・unit 対象）。
 * findings: Array<{ level: 'ERROR'|'WARN'|'INFO', check, message, file? }>
 */
export function runDoctor(noteDir) {
    const findings = [];
    const add = (level, check, message, file) => findings.push({ level, check, message, ...(file ? { file } : {}) });

    if (!isDir(noteDir)) {
        add('ERROR', 'structure', `note directory not found: ${noteDir}`);
        return findings;
    }

    const entries = fs.readdirSync(noteDir);
    const outFiles = entries.filter((f) => f.endsWith('.out'));
    const rootMds = entries.filter((f) => f.endsWith('.md'));

    // outline.note
    const notePath = path.join(noteDir, 'outline.note');
    let structure = null;
    if (isFile(notePath)) {
        try { structure = JSON.parse(fs.readFileSync(notePath, 'utf-8')); }
        catch { add('ERROR', 'structure', 'outline.note is not valid JSON', notePath); }
    } else {
        add('WARN', 'structure', 'outline.note not found');
    }

    // ── structure 検査（FR-DOC-04） ──
    const mdItemIds = new Set();
    if (structure && structure.items) {
        for (const [id, item] of Object.entries(structure.items)) {
            if (!item) continue;
            if (item.type === 'folder') {
                for (const cid of (item.childIds || [])) {
                    if (!structure.items[cid]) {
                        add('ERROR', 'structure', `folder "${item.title}" (${id}) references missing child: ${cid}`);
                    }
                }
                continue;
            }
            if (item.type === 'file') {
                if (item.ext === 'md') {
                    mdItemIds.add(id);
                    if (!isFile(path.join(noteDir, `${id}.md`))) {
                        add('ERROR', 'structure', `md item "${item.title}" (${id}) has no ${id}.md on disk`);
                    }
                } else {
                    if (!isFile(path.join(noteDir, `${id}.out`))) {
                        add('ERROR', 'structure', `outliner item "${item.title}" (${id}) has no ${id}.out on disk`);
                    }
                }
            }
        }
        for (const f of outFiles) {
            const id = f.replace(/\.out$/, '');
            if (!structure.items[id]) {
                add('WARN', 'structure', `${f} exists on disk but is not registered in outline.note`);
            }
        }
    }

    // ── .out ごとの検査 ──
    const assetOwners = new Map(); // 正規化 asset 相対パス → [ "out:node" ]
    const referencedAssets = new Set();
    const referencedPageIds = new Set();

    for (const outFile of outFiles) {
        const outAbs = path.join(noteDir, outFile);
        const stem = outFile.replace(/\.out$/, '');
        let data;
        try { data = JSON.parse(fs.readFileSync(outAbs, 'utf-8')); }
        catch { add('ERROR', 'refs', `${outFile} is not valid JSON`, outAbs); continue; }

        // layout（FR-DOC-01）: ヒント有無 + legacy dir 実在
        const hasFlatHints = data.pageDir === FLAT_HINTS.pageDir;
        if (!hasFlatHints) {
            const legacyDirs = [stem, 'pages', '_notes_md'].filter((d) => isDir(path.join(noteDir, d)));
            if (legacyDirs.length > 0) {
                add('WARN', 'layout',
                    `${outFile}: no flat pageDir hint ("." expected, got ${JSON.stringify(data.pageDir)}) and legacy dir exists (${legacyDirs.join(', ')}) — 未移行の可能性。本体の移行ゲートで先にフラット化してください`);
            } else if (data.pageDir === undefined) {
                add('INFO', 'layout', `${outFile}: pageDir hint 未設定（フラット規約では "." を推奨）`);
            }
        }

        // refs（FR-DOC-02）+ ownership（FR-DOC-05）
        for (const [nodeId, n] of Object.entries(data.nodes || {})) {
            if (!n) continue;
            for (const img of (n.images || [])) {
                const abs = path.resolve(noteDir, img);
                referencedAssets.add(path.resolve(abs));
                if (!isFile(abs)) {
                    add('ERROR', 'refs', `${outFile} node ${nodeId} references missing image: ${img}`);
                }
                const key = path.resolve(abs);
                if (!assetOwners.has(key)) assetOwners.set(key, []);
                assetOwners.get(key).push(`${outFile}:${nodeId}`);
            }
            if (n.filePath) {
                const abs = path.resolve(noteDir, n.filePath);
                referencedAssets.add(path.resolve(abs));
                if (!isFile(abs)) {
                    add('ERROR', 'refs', `${outFile} node ${nodeId} references missing file: ${n.filePath}`);
                }
                const key = path.resolve(abs);
                if (!assetOwners.has(key)) assetOwners.set(key, []);
                assetOwners.get(key).push(`${outFile}:${nodeId}`);
            }
            if (n.pageId) {
                referencedPageIds.add(n.pageId);
                const mdAbs = path.join(noteDir, `${n.pageId}.md`);
                if (!isFile(mdAbs)) {
                    add('ERROR', 'refs', `${outFile} node ${nodeId} references missing page md: ${n.pageId}.md`);
                } else {
                    // page md 本文の相対リンク（WARN レベル）
                    const body = fs.readFileSync(mdAbs, 'utf-8');
                    for (const ref of extractLocalRefs(body)) {
                        const refAbs = path.resolve(noteDir, ref);
                        referencedAssets.add(refAbs);
                        if (!isFile(refAbs) && !isDir(refAbs)) {
                            add('WARN', 'refs', `${n.pageId}.md links to missing local path: ${ref}`);
                        }
                    }
                }
            }
        }
    }

    // 独立 md item 本文のローカル参照も orphan 計算に含める
    for (const id of mdItemIds) {
        const mdAbs = path.join(noteDir, `${id}.md`);
        if (!isFile(mdAbs)) continue;
        const body = fs.readFileSync(mdAbs, 'utf-8');
        for (const ref of extractLocalRefs(body)) {
            const refAbs = path.resolve(noteDir, ref);
            referencedAssets.add(refAbs);
            if (!isFile(refAbs) && !isDir(refAbs)) {
                add('WARN', 'refs', `${id}.md links to missing local path: ${ref}`);
            }
        }
    }

    // ── ownership（FR-DOC-05）: 同一 asset の複数参照 ──
    for (const [abs, owners] of assetOwners) {
        if (owners.length > 1) {
            add('WARN', 'ownership',
                `asset shared by ${owners.length} nodes (1:1 所有違反): ${path.relative(noteDir, abs)} ← ${owners.join(', ')}`);
        }
    }

    // ── orphans（FR-DOC-03）──
    for (const sub of ['images', 'files']) {
        const dir = path.join(noteDir, sub);
        for (const f of listFilesShallow(dir)) {
            const abs = path.resolve(dir, f);
            if (!referencedAssets.has(abs)) {
                add('INFO', 'orphans', `unreferenced asset: ${sub}/${f}`);
            }
        }
    }
    for (const md of rootMds) {
        const id = md.replace(/\.md$/, '');
        if (!mdItemIds.has(id) && !referencedPageIds.has(id)) {
            add('INFO', 'orphans', `md not referenced by any node or outline.note item: ${md}`);
        }
    }

    return findings;
}

export function exitCodeFor(findings) {
    if (findings.some((f) => f.level === 'ERROR')) return 2;
    if (findings.some((f) => f.level === 'WARN')) return 1;
    return 0;
}

// --- CLI ---

function main() {
    const argv = process.argv;
    let noteDir = null;
    let json = false;
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--note-dir': noteDir = argv[++i]; break;
            case '--json': json = true; break;
            case '-h': case '--help':
                console.log('Usage: fractal-doctor.mjs --note-dir <path> [--json]');
                console.log('Checks: layout / refs / orphans / structure / ownership (read-only)');
                console.log('Exit: 0=clean 1=warnings 2=errors');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`); process.exit(2);
        }
    }
    if (!noteDir) { console.error('Error: --note-dir is required'); process.exit(2); }

    const findings = runDoctor(path.resolve(noteDir));
    if (json) {
        console.log(JSON.stringify({ noteDir: path.resolve(noteDir), findings }, null, 2));
    } else {
        const counts = { ERROR: 0, WARN: 0, INFO: 0 };
        for (const f of findings) {
            counts[f.level]++;
            const mark = f.level === 'ERROR' ? '✗' : f.level === 'WARN' ? '⚠' : 'ℹ';
            console.log(`${mark} [${f.level}] (${f.check}) ${f.message}`);
        }
        if (findings.length === 0) {
            console.log('✅ クリーン: 問題は見つかりませんでした');
        } else {
            console.log(`\n--- ${counts.ERROR} error(s), ${counts.WARN} warning(s), ${counts.INFO} info ---`);
        }
    }
    process.exit(exitCodeFor(findings));
}

// unit import 時に実行されないよう main guard
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
    main();
}
