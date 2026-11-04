/**
 * notes.ts — Notes フォルダ（outline.note）を読むだけの道具（読み取りでは書かない）。
 *
 * NotesFileManager.getStructure() は読み込み時に outline.note を書き戻す（disk 同期）ので、
 * 読むだけの tool（get / resolve / list_notes）はここで outline.note を直接 parse する。
 * 書き込み系は NotesFileManager（正典）を使う。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { safeResolveUnderDir } from '../../../src/shared/path-safety';
import { resolveMdFilesDir, resolveMdFilePath, resolvePagesDir } from '../../../src/shared/flat-layout';
import { ToolError, hashOfFile } from './guard';
import { MatchMode, textMatches, truncate } from './outdoc';

export interface TreeItem {
    id: string;
    type: 'folder' | 'out' | 'md' | 'file' | 'folderLink';
    title: string;
    /** 実体の絶対パス（folder = なし / folderLink = リンク先） */
    absPath?: string;
    /** 上位の仮想フォルダの title の列 */
    folderPath: string[];
    exists?: boolean;
    children?: TreeItem[];
}

export interface NoteStructureView {
    noteDir: string;
    noteTitle: string;
    outlineNotePath: string;
    contentHash: string | null;
    items: Record<string, any>;
    rootIds: string[];
}

export function readStructure(noteDir: string): NoteStructureView {
    const p = path.join(noteDir, 'outline.note');
    let s: any = null;
    try { s = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {
        if (!fs.existsSync(p)) { throw new ToolError('NOT_FOUND', `outline.note がありません: ${noteDir}（Fractal の Notes フォルダではありません）`, { noteDir }); }
        throw new ToolError('INVALID', `outline.note が JSON として読めません: ${p}`, { absPath: p });
    }
    const noteTitle = (s && typeof s.noteTitle === 'string' && s.noteTitle.trim()) ? s.noteTitle.trim() : path.basename(noteDir);
    return {
        noteDir, noteTitle, outlineNotePath: p, contentHash: hashOfFile(p),
        items: (s && s.items) || {}, rootIds: (s && s.rootIds) || [],
    };
}

/** structure item の種類と実体パス */
export function itemKind(noteDir: string, item: any): { type: TreeItem['type']; absPath?: string } {
    if (item.type === 'folder') { return { type: 'folder' }; }
    const ext = item.ext ?? 'out';
    if (ext === 'md') { return { type: 'md', absPath: resolveMdFilePath(noteDir, item.id) }; }
    if (ext === 'file') {
        const abs = item.filename ? safeResolveUnderDir(resolveMdFilesDir(noteDir), item.filename) : null;
        return { type: 'file', absPath: abs ?? undefined };
    }
    if (ext === 'folder') { return { type: 'folderLink', absPath: item.folderPath }; }
    return { type: 'out', absPath: path.join(noteDir, `${item.id}.out`) };
}

/** outline.note をツリーにする（仮想フォルダの入れ子を保つ） */
export function buildTree(st: NoteStructureView): TreeItem[] {
    const seen = new Set<string>();
    const walk = (ids: string[], folderPath: string[]): TreeItem[] => {
        const out: TreeItem[] = [];
        for (const id of ids || []) {
            const it = st.items[id];
            if (!it || seen.has(id)) { continue; }
            seen.add(id);
            const k = itemKind(st.noteDir, it);
            const node: TreeItem = { id, type: k.type, title: String(it.title ?? ''), folderPath };
            if (k.absPath) { node.absPath = k.absPath; node.exists = fs.existsSync(k.absPath); }
            if (it.type === 'folder') { node.children = walk(it.childIds || [], [...folderPath, String(it.title ?? '')]); }
            out.push(node);
        }
        return out;
    };
    return walk(st.rootIds, []);
}

export function flattenTree(items: TreeItem[]): TreeItem[] {
    const out: TreeItem[] = [];
    const rec = (xs: TreeItem[]) => { for (const x of xs) { out.push(x); if (x.children) { rec(x.children); } } };
    rec(items);
    return out;
}

export function itemCandidate(x: TreeItem) {
    return { id: x.id, type: x.type, title: truncate(x.title, 80), folderPath: x.folderPath.join(' > '), ...(x.absPath ? { absPath: x.absPath } : {}) };
}

/**
 * outline.note の item（.out / md / file / folder）を id か title で特定する。
 * title は match（既定 exact）。0 件 = NOT_FOUND（候補付き）、2 件以上 = AMBIGUOUS（候補 = id / title / フォルダのパンくず）。
 */
export function resolveTreeItem(st: NoteStructureView, ref: string, opts: { match?: MatchMode; what: string; types?: TreeItem['type'][] }): TreeItem {
    const all = flattenTree(buildTree(st)).filter((x) => !opts.types || opts.types.includes(x.type));
    const byId = all.find((x) => x.id === ref);
    if (byId) { return byId; }
    // 絶対パスでも指定できる（.out / md / file の実体）
    if (path.isAbsolute(ref)) {
        const byPath = all.find((x) => x.absPath && path.resolve(x.absPath) === path.resolve(ref));
        if (byPath) { return byPath; }
    }
    const match = opts.match ?? 'exact';
    const hits = all.filter((x) => textMatches(x.title, ref, match));
    if (hits.length === 1) { return hits[0]; }
    if (hits.length === 0) {
        const suggestions = all.filter((x) => textMatches(x.title, ref, 'contains')).slice(0, 10).map(itemCandidate);
        throw new ToolError('NOT_FOUND', `${opts.what}「${ref}」が ${st.noteTitle} のツリーにありません。${suggestions.length ? 'suggestions の id で指定してください。' : ''}`, { ref, match, suggestions });
    }
    throw new ToolError('AMBIGUOUS', `${opts.what}「${ref}」に一致する項目が ${hits.length} 件あります。candidates の id で指定してください。`,
        { ref, match, count: hits.length, candidates: hits.slice(0, 30).map(itemCandidate) });
}

/** item の親フォルダ id（ルートなら null） */
export function parentFolderOf(st: NoteStructureView, itemId: string): string | null {
    for (const [id, it] of Object.entries(st.items)) {
        if ((it as any)?.type === 'folder' && ((it as any).childIds || []).includes(itemId)) { return id; }
    }
    return null;
}

// ─── md の持ち主（tree item / page node / subpage） ─────────

export interface MdOwner {
    kind: 'item' | 'page' | 'subpage' | 'none';
    itemId?: string;
    outPath?: string;
    nodeId?: string;
    linkedFrom?: string[];
}

/** note の中で、この md を誰が持っているか（tree の md item / .out の page node / 他の md の subpage） */
export function findMdOwner(noteDir: string, mdAbs: string): MdOwner {
    const abs = path.resolve(mdAbs);
    try {
        const st = readStructure(noteDir);
        for (const it of Object.values(st.items) as any[]) {
            if (it?.type === 'file' && it.ext === 'md' && path.resolve(resolveMdFilePath(noteDir, it.id)) === abs) {
                return { kind: 'item', itemId: it.id };
            }
        }
    } catch { /* outline.note 無し */ }
    const stem = path.basename(abs, '.md');
    let entries: string[] = [];
    try { entries = fs.readdirSync(noteDir); } catch { /* 無し */ }
    for (const f of entries) {
        if (!f.endsWith('.out')) { continue; }
        const outPath = path.join(noteDir, f);
        try {
            const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
            const pagesDir = resolvePagesDir(outPath, noteDir, { pageDir: data.pageDir, imageDir: data.imageDir, fileDir: data.fileDir });
            if (path.resolve(pagesDir) !== path.dirname(abs)) { continue; }
            for (const [nid, n] of Object.entries<any>(data.nodes || {})) {
                if (n && n.isPage && n.pageId === stem) {
                    return { kind: 'page', outPath, nodeId: nid };
                }
            }
        } catch { /* 壊れた .out は飛ばす */ }
    }
    return { kind: 'none' };
}
