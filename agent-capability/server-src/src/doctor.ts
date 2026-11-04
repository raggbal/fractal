/**
 * doctor.ts — note フォルダの整合性検査（読むだけ。fractal_doctor の実体）
 *
 * 監査 B-10: 旧 fractal-doctor.mjs は独自の orphan 判定・独自の link regex（空白で切れる）を持っていて、
 * tree の file item / folder link を「.out が無い」と誤検出し、tree 添付や md からリンクされた subpage を
 * 孤児と誤判定していた。ここでは
 *   - 孤児の判定は UI の Cleanup と同じ cleanup-core.scanSingleNoteCore をそのまま使う（判定が必ず一致する）
 *   - md のリンクは正典 markdown-link-parser で読む（空白・括弧入りのパス）
 *   - item の種類（ext: out / md / file / folder）ごとに実体を確かめる
 * に置き換え、足りなかった検査（親子の整合・宙ぶらりんの rootIds・.out をまたぐ pageId の重複・
 * outline.note の rootIds・subpage の再帰）を足した。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { scanSingleNoteCore } from '../../../src/shared/cleanup-core';
import { resolvePagesDir, resolveMdFilePath, resolveMdFilesDir } from '../../../src/shared/flat-layout';
import { safeResolveUnderDir } from '../../../src/shared/path-safety';
import { collectMdLinks } from './md';

export type Level = 'ERROR' | 'WARN' | 'INFO';
export interface Finding { level: Level; check: string; message: string; file?: string }

const FLAT_PAGE_DIR = '.';

function isFile(p: string): boolean { try { return fs.statSync(p).isFile(); } catch { return false; } }
function isDir(p: string): boolean { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

export async function runDoctor(noteDirIn: string): Promise<{ noteDir: string; findings: Finding[]; orphans: { absPath: string; relPath: string; type: string }[] }> {
    const noteDir = path.resolve(noteDirIn);
    const findings: Finding[] = [];
    const add = (level: Level, check: string, message: string, file?: string) => findings.push({ level, check, message, ...(file ? { file } : {}) });
    if (!isDir(noteDir)) {
        add('ERROR', 'structure', `note directory not found: ${noteDir}`);
        return { noteDir, findings, orphans: [] };
    }

    // ── outline.note ──
    const notePath = path.join(noteDir, 'outline.note');
    let structure: any = null;
    if (isFile(notePath)) {
        try { structure = JSON.parse(fs.readFileSync(notePath, 'utf8')); } catch { add('ERROR', 'structure', 'outline.note is not valid JSON', notePath); }
    } else {
        add('WARN', 'structure', 'outline.note not found');
    }
    const items: Record<string, any> = (structure && structure.items) || {};
    const rootIds: string[] = (structure && Array.isArray(structure.rootIds)) ? structure.rootIds : [];
    const liveMd: string[] = []; // 検査対象の md（page md / md item）
    if (structure) {
        const placed = new Map<string, number>();
        const place = (id: string) => placed.set(id, (placed.get(id) || 0) + 1);
        for (const id of rootIds) {
            if (!items[id]) { add('ERROR', 'structure', `outline.note rootIds references missing item: ${id}`); } else { place(id); }
        }
        for (const [id, item] of Object.entries<any>(items)) {
            if (!item) { continue; }
            if (item.id !== undefined && item.id !== id) { add('WARN', 'structure', `item key ${id} and item.id ${item.id} differ`); }
            if (item.type === 'folder') {
                for (const cid of (item.childIds || [])) {
                    if (!items[cid]) { add('ERROR', 'structure', `folder "${item.title}" (${id}) references missing child: ${cid}`); } else { place(cid); }
                }
                continue;
            }
            if (item.type !== 'file') { add('WARN', 'structure', `unknown item type "${item.type}" (${id})`); continue; }
            const ext = item.ext ?? 'out';
            if (ext === 'md') {
                const p = resolveMdFilePath(noteDir, id);
                if (!isFile(p)) { add('ERROR', 'structure', `md item "${item.title}" (${id}) has no ${id}.md on disk`); } else { liveMd.push(p); }
            } else if (ext === 'file') {
                const p = item.filename ? safeResolveUnderDir(resolveMdFilesDir(noteDir), item.filename) : null;
                if (!p || !isFile(p)) { add('ERROR', 'structure', `file item "${item.title}" (${id}) has no files/${item.filename ?? '(filename 無し)'} on disk`); }
            } else if (ext === 'folder') {
                if (!item.folderPath || !isDir(item.folderPath)) { add('WARN', 'structure', `folder link "${item.title}" (${id}) points to a missing folder: ${item.folderPath ?? '(未設定)'}`); }
            } else if (!isFile(path.join(noteDir, `${id}.out`))) {
                add('ERROR', 'structure', `outliner item "${item.title}" (${id}) has no ${id}.out on disk`);
            }
        }
        for (const id of Object.keys(items)) {
            const n = placed.get(id) || 0;
            if (n === 0) { add('WARN', 'structure', `item "${items[id]?.title}" (${id}) is not reachable from rootIds or any folder (ツリーに表示されない)`); }
            if (n > 1) { add('WARN', 'structure', `item "${items[id]?.title}" (${id}) is placed ${n} times in the tree`); }
        }
    }

    // ── .out ごと ──
    let entries: string[] = [];
    try { entries = fs.readdirSync(noteDir); } catch { /* 無し */ }
    const outFiles = entries.filter((f) => f.endsWith('.out') && isFile(path.join(noteDir, f)));
    if (structure) {
        for (const f of outFiles) {
            const id = f.replace(/\.out$/, '');
            if (!items[id]) { add('WARN', 'structure', `${f} exists on disk but is not registered in outline.note`); }
        }
    }
    const pageOwners = new Map<string, string[]>(); // pageId → [out:node]
    const assetOwners = new Map<string, string[]>();
    for (const outFile of outFiles) {
        const outAbs = path.join(noteDir, outFile);
        const stem = outFile.replace(/\.out$/, '');
        let data: any;
        try { data = JSON.parse(fs.readFileSync(outAbs, 'utf8')); } catch { add('ERROR', 'refs', `${outFile} is not valid JSON`, outAbs); continue; }
        const nodes: Record<string, any> = data.nodes || {};
        const roots: string[] = Array.isArray(data.rootIds) ? data.rootIds : [];

        // layout
        if (data.pageDir !== FLAT_PAGE_DIR) {
            const legacyDirs = [stem, 'pages', '_notes_md'].filter((d) => isDir(path.join(noteDir, d)));
            if (legacyDirs.length > 0) {
                add('WARN', 'layout', `${outFile}: no flat pageDir hint ("." expected, got ${JSON.stringify(data.pageDir)}) and legacy dir exists (${legacyDirs.join(', ')}) — 未移行の可能性。本体の移行ゲートで先にフラット化してください`);
            } else if (data.pageDir === undefined) {
                add('INFO', 'layout', `${outFile}: pageDir hint 未設定（フラット規約では "." を推奨）`);
            }
        }
        const pagesDir = resolvePagesDir(outAbs, noteDir, { pageDir: data.pageDir, imageDir: data.imageDir, fileDir: data.fileDir });

        // tree（親子の整合・到達性）
        const reached = new Set<string>();
        const seenRoot = new Set<string>();
        for (const r of roots) {
            if (!nodes[r]) { add('ERROR', 'tree', `${outFile}: rootIds references missing node ${r}`); continue; }
            if (seenRoot.has(r)) { add('ERROR', 'tree', `${outFile}: node ${r} appears twice in rootIds`); }
            seenRoot.add(r);
            if (nodes[r].parentId) { add('ERROR', 'tree', `${outFile}: root node ${r} has parentId ${nodes[r].parentId}`); }
        }
        const stack = roots.filter((r) => nodes[r]).map((r) => r);
        while (stack.length) {
            const id = stack.pop()!;
            if (reached.has(id)) { add('ERROR', 'tree', `${outFile}: node ${id} is reachable twice (cycle or shared child)`); continue; }
            reached.add(id);
            const n = nodes[id];
            // NotesFileManager.createFile の最初のノードは children の代わりに childIds（旧形式）を持つ。
            // OutlinerModel は開くときに children: [] を補う（_ensureChildren）ので、ここでも同じに読む
            const kids: string[] = Array.isArray(n.children) ? n.children : (Array.isArray(n.childIds) ? n.childIds : []);
            for (const c of kids) {
                if (!nodes[c]) { add('ERROR', 'tree', `${outFile}: node ${id} references missing child ${c}`); continue; }
                if ((nodes[c].parentId ?? null) !== id) { add('ERROR', 'tree', `${outFile}: node ${c} is a child of ${id} but its parentId is ${JSON.stringify(nodes[c].parentId)}`); }
                stack.push(c);
            }
        }
        for (const id of Object.keys(nodes)) {
            if (!reached.has(id)) { add('WARN', 'tree', `${outFile}: node ${id} ("${String(nodes[id]?.text || '').slice(0, 40)}") is not reachable from rootIds (画面に出ない)`); }
        }

        // refs / ownership
        for (const [nodeId, n] of Object.entries<any>(nodes)) {
            if (!n) { continue; }
            if (n.isPage && n.filePath) { add('WARN', 'refs', `${outFile} node ${nodeId} is both a page and a file attachment (page と file は排他)`); }
            if (n.isPage && !n.pageId) { add('ERROR', 'refs', `${outFile} node ${nodeId} has isPage but no pageId`); }
            for (const img of (n.images || [])) {
                const abs = path.resolve(noteDir, img);
                if (!isFile(abs)) { add('ERROR', 'refs', `${outFile} node ${nodeId} references missing image: ${img}`); }
                if (!assetOwners.has(abs)) { assetOwners.set(abs, []); }
                assetOwners.get(abs)!.push(`${outFile}:${nodeId}`);
            }
            if (n.filePath) {
                const abs = path.resolve(noteDir, n.filePath);
                if (!isFile(abs)) { add('ERROR', 'refs', `${outFile} node ${nodeId} references missing file: ${n.filePath}`); }
                if (!assetOwners.has(abs)) { assetOwners.set(abs, []); }
                assetOwners.get(abs)!.push(`${outFile}:${nodeId}`);
            }
            if (n.pageId) {
                if (!pageOwners.has(n.pageId)) { pageOwners.set(n.pageId, []); }
                pageOwners.get(n.pageId)!.push(`${outFile}:${nodeId}`);
                const mdAbs = path.join(pagesDir, `${n.pageId}.md`);
                if (!isFile(mdAbs)) { add('ERROR', 'refs', `${outFile} node ${nodeId} references missing page md: ${n.pageId}.md`); } else { liveMd.push(mdAbs); }
            }
        }
    }
    for (const [pageId, owners] of pageOwners) {
        if (owners.length > 1) { add('ERROR', 'ownership', `pageId ${pageId} is used by ${owners.length} nodes (1:1 所有違反): ${owners.join(', ')}`); }
        if (items[pageId] && items[pageId].ext === 'md') { add('ERROR', 'ownership', `${pageId}.md is both a page (${owners.join(', ')}) and an md item in outline.note`); }
    }
    for (const [abs, owners] of assetOwners) {
        if (owners.length > 1) { add('WARN', 'ownership', `asset shared by ${owners.length} nodes (1:1 所有違反): ${path.relative(noteDir, abs)} ← ${owners.join(', ')}`); }
    }

    // ── md の参照（page md / md item から subpage を再帰でたどる） ──
    const visited = new Set<string>();
    const queue = [...new Set(liveMd.map((p) => path.resolve(p)))];
    while (queue.length) {
        const mdAbs = queue.shift()!;
        if (visited.has(mdAbs)) { continue; }
        visited.add(mdAbs);
        let body = '';
        try { body = fs.readFileSync(mdAbs, 'utf8'); } catch { continue; }
        const rel = path.relative(noteDir, mdAbs);
        const links = collectMdLinks(mdAbs, body);
        for (const x of links.images) { if (!x.exists) { add('WARN', 'refs', `${rel} links to missing image: ${x.href}`); } }
        for (const x of links.files) { if (!x.exists) { add('WARN', 'refs', `${rel} links to missing file: ${x.href}`); } }
        for (const x of links.subpages) {
            if (!x.exists) { add('WARN', 'refs', `${rel} links to missing md: ${x.href}`); continue; }
            const inside = !path.relative(noteDir, x.absPath).startsWith('..');
            if (inside && !visited.has(x.absPath)) { queue.push(x.absPath); }
        }
    }

    // ── orphans: UI の Cleanup と同じ判定（cleanup-core） ──
    let orphans: { absPath: string; relPath: string; type: string }[] = [];
    try {
        orphans = (await scanSingleNoteCore(noteDir)).map((c) => ({ absPath: c.absPath, relPath: c.relPath, type: c.type }));
    } catch (e: any) {
        add('WARN', 'orphans', `cleanup-core scan failed: ${e?.message || e}`);
    }
    for (const o of orphans) {
        // md からリンクされているのに Cleanup が孤児と見るもの（cleanup-core の md リンクの regex は空白入りのパスを読めない）は
        // Clean Unused Files で消されてしまうので WARN で知らせる
        if (o.type === 'orphan-md' && visited.has(path.resolve(o.absPath))) {
            add('WARN', 'orphans', `${o.relPath} is linked from a page / md but Fractal's Cleanup treats it as unreferenced (リンクのパスに空白など) — Clean Unused Files would delete it. ファイル名から空白を除いてリンクを直すと安全です`, o.absPath);
            continue;
        }
        add('INFO', 'orphans', `unreferenced (${o.type}): ${o.relPath}`, o.absPath);
    }
    return { noteDir, findings, orphans };
}

export function statusOf(findings: Finding[]): 'errors' | 'warnings' | 'clean' | 'info' {
    if (findings.some((f) => f.level === 'ERROR')) { return 'errors'; }
    if (findings.some((f) => f.level === 'WARN')) { return 'warnings'; }
    if (findings.length) { return 'info'; }
    return 'clean';
}
