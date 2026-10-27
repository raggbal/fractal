/**
 * tools-read.ts — 読むだけの tool（fractal_get / fractal_resolve / fractal_list_notes / fractal_doctor）。
 * どれも書き込まない（outline.note も NotesFileManager を通さず直接読む）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolvePagesDir } from '../../../src/shared/flat-layout';
import { extractFirstH1 } from '../../../src/shared/md-h1-utils';
import { ToolError, findNoteRoot, hashOfFile, requireAbs } from './guard';
import { MatchMode, firstLine, loadOut, nodeCandidate, nodeView, resolveNodeRef, textMatches, truncate } from './outdoc';
import { TreeItem, buildTree, findMdOwner, flattenTree, readStructure } from './notes';
import { collectMdLinks, scanHeadings } from './md';
import { runDoctor, statusOf } from './doctor';

type Json = Record<string, unknown>;

export interface FolderEntry { path: string; sources?: unknown[] }
export type Discover = () => Promise<FolderEntry[]>;

const MAX_BODY = 400_000;

// ═══════════════════════════════════════════════════════════════════════════
// fractal_get
// ═══════════════════════════════════════════════════════════════════════════

export interface GetArgs { path: string; node?: string; match?: MatchMode; depth?: number; maxBodyChars?: number }

export function toolGet(a: GetArgs): Json {
    const abs = requireAbs(a.path, 'path');
    let st: fs.Stats;
    try { st = fs.statSync(abs); } catch { throw new ToolError('NOT_FOUND', `見つかりません: ${abs}`, { absPath: abs }); }

    // ── note フォルダ（または outline.note）→ ツリー ──
    if (st.isDirectory() || path.basename(abs) === 'outline.note') {
        const noteDir = st.isDirectory() ? abs : path.dirname(abs);
        const s = readStructure(noteDir);
        return {
            ok: true, kind: 'note', noteDir, noteTitle: s.noteTitle, absPath: s.outlineNotePath, contentHash: s.contentHash,
            tree: buildTree(s),
            hint: '項目の absPath を fractal_get に渡すと中身を読めます。ツリーを変えるのは fractal_tree（expectedHash に contentHash）。',
        };
    }

    // ── .out → ノード木 ──
    if (abs.endsWith('.out')) {
        const doc = loadOut(abs);
        const maxDepth = typeof a.depth === 'number' && a.depth >= 0 ? a.depth : null;
        const noteDir = findNoteRoot(abs);
        let rootIds = doc.model.rootIds.filter((id) => doc.model.nodes[id]);
        let focus: Json | undefined;
        if (a.node !== undefined) {
            const id = resolveNodeRef(doc.model, a.node, { match: a.match, what: 'node' });
            rootIds = [id];
            focus = nodeCandidate(doc.model, id);
        }
        return {
            ok: true, kind: 'out', absPath: abs, noteDir, contentHash: doc.contentHash,
            title: doc.original.title ?? '', taskMode: !!doc.original.taskMode,
            pagesDir: resolvePagesDir(abs, doc.noteDir, { pageDir: doc.original.pageDir, imageDir: doc.original.imageDir, fileDir: doc.original.fileDir }),
            nodeCount: Object.keys(doc.model.nodes).length,
            ...(focus ? { focus } : {}),
            nodes: rootIds.map((id) => nodeView(doc, id, 0, maxDepth)),
            hint: 'ノードは id で指定すると確実です。書き込み（fractal_modify / fractal_add / fractal_attach）には expectedHash に contentHash を付けてください。',
        };
    }

    // ── md → 本文・H1・見出し・subpage・添付 ──
    if (/\.(md|markdown)$/i.test(abs)) {
        const body = fs.readFileSync(abs, 'utf8');
        const noteDir = findNoteRoot(abs);
        const links = collectMdLinks(abs, body);
        const max = typeof a.maxBodyChars === 'number' && a.maxBodyChars > 0 ? a.maxBodyChars : MAX_BODY;
        return {
            ok: true, kind: 'md', absPath: abs, noteDir, contentHash: hashOfFile(abs),
            h1: extractFirstH1(body),
            owner: noteDir ? findMdOwner(noteDir, abs) : { kind: 'none' },
            headings: scanHeadings(body).map((h) => ({ level: h.level, text: h.text, line: h.line + 1, path: h.path })),
            subpages: links.subpages, images: links.images, files: links.files,
            length: body.length,
            body: body.length > max ? body.slice(0, max) : body,
            ...(body.length > max ? { truncated: true } : {}),
            hint: '本文は直接編集してよい。H1 を変えるときは fractal_tree rename（md item）/ fractal_modify set-text（page）。添付・画像・subpage は fractal_attach / fractal_add（expectedHash に contentHash）。',
        };
    }
    throw new ToolError('INVALID', `fractal_get は Notes フォルダ / outline.note / .out / .md を読みます: ${abs}`);
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_resolve
// ═══════════════════════════════════════════════════════════════════════════

export type ResolveKind = 'any' | 'note' | 'item' | 'node' | 'page' | 'heading';
export interface ResolveArgs { query: string; kind?: ResolveKind; match?: MatchMode; folders?: string[]; within?: string; limit?: number }

interface Cand extends Json { kind: string; title: string }

async function noteDirsOf(a: { folders?: string[] }, discover: Discover): Promise<string[]> {
    if (a.folders?.length) { return a.folders.map((f) => requireAbs(f, 'folders')); }
    return (await discover()).map((e) => e.path);
}

function safeStructure(dir: string) {
    try { return readStructure(dir); } catch { return null; }
}

export async function toolResolve(a: ResolveArgs, discover: Discover): Promise<Json> {
    if (!a.query || !String(a.query).trim()) { throw new ToolError('INVALID', 'query が必要です'); }
    const kind: ResolveKind = a.kind ?? 'any';
    const match: MatchMode = a.match ?? 'exact';
    const q = String(a.query);
    const cands: Cand[] = [];

    // within: .out の中のノード / md の中の見出し
    if (a.within) {
        const w = requireAbs(a.within, 'within');
        if (w.endsWith('.out')) {
            const doc = loadOut(w);
            for (const [id, n] of Object.entries(doc.model.nodes)) {
                if (!textMatches(n.text, q, match) && id !== q) { continue; }
                if (kind !== 'any' && kind !== 'node' && !(kind === 'page' && n.isPage)) { continue; }
                cands.push({ kind: n.isPage ? 'page' : 'node', title: truncate(firstLine(n.text), 80), ...nodeCandidate(doc.model, id), nodeId: id, outPath: w,
                    ...(n.isPage && n.pageId ? { pageMdPath: path.join(resolvePagesDir(w, doc.noteDir, doc.original), `${n.pageId}.md`) } : {}), contentHash: doc.contentHash });
            }
        } else if (/\.(md|markdown)$/i.test(w)) {
            const body = fs.readFileSync(w, 'utf8');
            for (const h of scanHeadings(body)) {
                if (textMatches(h.text, q, match) || (match === 'exact' && h.path === q.trim())) {
                    cands.push({ kind: 'heading', title: h.text, level: h.level, line: h.line + 1, path: h.path, mdPath: w, contentHash: hashOfFile(w) });
                }
            }
        } else {
            throw new ToolError('INVALID', 'within は .out か .md の絶対パスです');
        }
    } else {
        if (kind === 'heading') { throw new ToolError('INVALID', 'kind: "heading" には within（md の絶対パス）が必要です'); }
        const dirs = await noteDirsOf(a, discover);
        for (const dir of dirs) {
            const s = safeStructure(dir);
            if (!s) { continue; }
            if (kind === 'any' || kind === 'note') {
                if (textMatches(s.noteTitle, q, match) || textMatches(path.basename(dir), q, match) || path.resolve(q) === dir) {
                    cands.push({ kind: 'note', title: s.noteTitle, noteDir: dir, dirName: path.basename(dir), absPath: dir, contentHash: s.contentHash });
                }
            }
            if (kind === 'any' || kind === 'item') {
                for (const it of flattenTree(buildTree(s))) {
                    if (textMatches(it.title, q, match) || it.id === q) {
                        cands.push({ kind: 'item', type: it.type, title: it.title, itemId: it.id, noteDir: dir, noteTitle: s.noteTitle,
                            folderPath: it.folderPath.join(' > '), ...(it.absPath ? { absPath: it.absPath, contentHash: hashOfFile(it.absPath) } : {}) });
                    }
                }
            }
            if (kind === 'any' || kind === 'page' || kind === 'node') {
                for (const it of flattenTree(buildTree(s)).filter((x: TreeItem) => x.type === 'out' && x.exists)) {
                    let doc;
                    try { doc = loadOut(it.absPath!); } catch { continue; }
                    for (const [id, n] of Object.entries(doc.model.nodes)) {
                        const isPage = !!(n.isPage && n.pageId);
                        if (kind === 'page' || kind === 'any') { if (!isPage) { continue; } }
                        let hit = textMatches(n.text, q, match);
                        let pageMdPath: string | undefined;
                        if (isPage) {
                            pageMdPath = path.join(resolvePagesDir(it.absPath!, dir, doc.original), `${n.pageId}.md`);
                            if (!hit) { try { const h1 = extractFirstH1(fs.readFileSync(pageMdPath, 'utf8')); hit = !!h1 && textMatches(h1, q, match); } catch { /* 無し */ } }
                        }
                        if (!hit) { continue; }
                        cands.push({ kind: isPage ? 'page' : 'node', title: truncate(firstLine(n.text), 80), nodeId: id, outPath: it.absPath, outTitle: it.title,
                            noteDir: dir, noteTitle: s.noteTitle, breadcrumb: nodeCandidate(doc.model, id).breadcrumb,
                            ...(pageMdPath ? { pageMdPath, contentHash: hashOfFile(pageMdPath) } : { contentHash: doc.contentHash }) });
                    }
                }
            }
        }
    }

    if (cands.length === 1) { return { ok: true, query: q, match, result: cands[0] }; }
    if (cands.length === 0) {
        throw new ToolError('NOT_FOUND', `「${q}」に${match === 'exact' ? '完全一致する' : '一致する'}ものが見つかりません。${match === 'exact' ? 'match: "contains" で探すか、' : ''}kind / folders / within を確かめてください。`, { query: q, match, kind });
    }
    const limit = a.limit && a.limit > 0 ? a.limit : 50;
    throw new ToolError('AMBIGUOUS', `「${q}」に一致するものが ${cands.length} 件あります。candidates から 1 つ選び、その id / absPath で指定してください（または kind / within / folders で絞る）。`,
        { query: q, match, kind, count: cands.length, candidates: cands.slice(0, limit) });
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_list_notes
// ═══════════════════════════════════════════════════════════════════════════

export interface ListNotesArgs { folders?: string[]; noteName?: string[]; includeItems?: boolean }

export async function toolListNotes(a: ListNotesArgs, discover: Discover): Promise<Json> {
    // 監査 B-9: folders を渡したら自動検出しない（旧実装は常に全登録フォルダを返していた）
    const explicit = !!a.folders?.length;
    const entries: FolderEntry[] = explicit ? a.folders!.map((f) => ({ path: requireAbs(f, 'folders') })) : await discover();
    const names = (a.noteName || []).map((n) => String(n).toLowerCase());
    const includeItems = a.includeItems ?? (explicit || names.length > 0);
    const notes: Json[] = [];
    const skipped: Json[] = [];
    for (const e of entries) {
        const s = safeStructure(e.path);
        if (!s) { skipped.push({ path: e.path, reason: fs.existsSync(e.path) ? 'outline.note が無いか壊れています' : 'フォルダがありません' }); continue; }
        if (names.length && !names.some((n) => s.noteTitle.toLowerCase().includes(n) || path.basename(e.path).toLowerCase().includes(n))) { continue; }
        const flat = flattenTree(buildTree(s));
        const counts: Record<string, number> = { out: 0, md: 0, file: 0, folder: 0, folderLink: 0 };
        for (const it of flat) { counts[it.type] = (counts[it.type] || 0) + 1; }
        notes.push({
            noteDir: e.path, noteTitle: s.noteTitle, dirName: path.basename(e.path), outlineNotePath: s.outlineNotePath, contentHash: s.contentHash,
            ...(e.sources ? { sources: e.sources } : {}), counts,
            ...(includeItems ? { items: flat.map((it) => ({ id: it.id, type: it.type, title: it.title, folderPath: it.folderPath.join(' > '), ...(it.absPath ? { absPath: it.absPath, exists: it.exists } : {}) })) } : {}),
        });
    }
    return { ok: true, autoDiscovered: !explicit, count: notes.length, notes, ...(skipped.length ? { skipped } : {}),
        ...(!includeItems ? { hint: 'items（.out / md / 添付 / フォルダ）は folders か noteName で絞るか includeItems: true で出ます' } : {}) };
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_doctor
// ═══════════════════════════════════════════════════════════════════════════

export async function toolDoctor(a: { noteDir: string }): Promise<Json> {
    const noteDir = requireAbs(a.noteDir, 'noteDir');
    const r = await runDoctor(noteDir);
    const counts = { ERROR: 0, WARN: 0, INFO: 0 } as Record<string, number>;
    for (const f of r.findings) { counts[f.level]++; }
    return {
        ok: true, noteDir: r.noteDir, status: statusOf(r.findings), counts, findings: r.findings,
        // 孤児は UI の Cleanup（cleanup-core.scanSingleNoteCore）と同じ判定
        cleanup: { orphanCount: r.orphans.length, orphans: r.orphans },
        hint: 'doctor は読むだけです。修復するかはユーザーと相談してください（孤児は Fractal の Clean Unused Files で消せます）。',
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_summary の node 指定（曖昧なら候補を返してエラー）
// ═══════════════════════════════════════════════════════════════════════════

export function resolveSummaryNode(notePath: string, node: string, match?: MatchMode): string {
    const doc = loadOut(requireAbs(notePath, 'note'));
    return resolveNodeRef(doc.model, node, { match, what: 'node' });
}
