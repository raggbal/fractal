/**
 * outdoc.ts — .out（Outliner）を正典 OutlinerModel（src/webview/outliner-model.js）で読み書きする。
 *
 * 画面（outliner.js）と同じモデルを通すので、ノードの初期値・tags（parseTags）・taskMode の checkbox・
 * 追加 / 移動の位置の意味が UI と一致する（監査 B-3 / B-4 / B-5 の原因だった mjs の書き直しを廃止）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
// @ts-ignore — CJS の素の JS（webview と共用。module.exports = Model）
import OutlinerModelCjs from '../../src/webview/outliner-model.js';
import { resolvePagesDir, resolveImagesDir, resolveFilesDir } from '../../src/shared/flat-layout';
import { ToolError, atomicWriteFile, hashOfFile } from './guard';

export interface OutNode {
    id: string;
    parentId: string | null;
    children: string[];
    text: string;
    tags: string[];
    isPage: boolean;
    pageId: string | null;
    collapsed: boolean;
    checked: boolean | null;
    subtext: string;
    images: string[];
    filePath: string | null;
    [k: string]: unknown;
}

export interface OutlinerModel {
    title: string;
    rootIds: string[];
    nodes: Record<string, OutNode>;
    taskMode: boolean;
    taskScope: 'top' | 'all';
    getNode(id: string): OutNode | null;
    addNode(parentId: string | null, afterId: string | null, text: string): OutNode;
    addNodeAtStart(parentId: string | null, text: string): OutNode;
    addNodeBefore(parentId: string | null, beforeId: string | null, text: string): OutNode;
    removeNode(id: string): void;
    updateText(id: string, text: string): unknown;
    addImage(id: string, rel: string): void;
    moveNode(id: string, newParentId: string | null, afterId: string | null): boolean;
    isDescendant(nodeId: string, potentialAncestorId: string): boolean;
    makePage(id: string): string | null;
    removePage(id: string): string | null;
    getDescendantIds(id: string): string[];
    serialize(): Record<string, unknown>;
}

interface ModelCtor {
    new (data: unknown): OutlinerModel;
    parseTags(text: string): string[];
    generatePageId(): string;
    generateNodeId(): string;
}
export const Model = OutlinerModelCjs as unknown as ModelCtor;

export interface LoadedOut {
    absPath: string;
    noteDir: string;
    original: Record<string, any>;
    model: OutlinerModel;
    contentHash: string | null;
}

export function loadOut(absPath: string): LoadedOut {
    let raw: string;
    try { raw = fs.readFileSync(absPath, 'utf8'); } catch { throw new ToolError('NOT_FOUND', `.out が見つかりません: ${absPath}`, { absPath }); }
    let original: Record<string, any>;
    try { original = JSON.parse(raw); } catch (e: any) {
        throw new ToolError('INVALID', `.out が JSON として読めません（${e?.message}）。手で直すか Fractal で開き直してください: ${absPath}`, { absPath });
    }
    if (!original || typeof original !== 'object') { throw new ToolError('INVALID', `.out の中身が不正です: ${absPath}`); }
    original.nodes = original.nodes || {};
    original.rootIds = original.rootIds || [];
    // Model は渡した data を共有するので、元を残すため複製してから渡す
    const model = new Model(JSON.parse(JSON.stringify(original)));
    return { absPath, noteDir: path.dirname(absPath), original, model, contentHash: hashOfFile(absPath) };
}

/** OutlinerModel.serialize が持たない top-level のキー（pageDir 等）を UI の serializeForSave と同じ順で引き継ぐ */
const MODEL_OWNED = new Set(['version', 'rootIds', 'nodes', 'title', 'columns', 'taskMode', 'taskScope', 'taskFilter', 'viewMode', 'mindmap']);
const UI_ORDER = ['searchFocusMode', 'pageDir', 'imageDir', 'fileDir', 'sidePanelWidth', 'sidePanelOutlineWidth', 'pinnedTags'];

export function serializeOut(model: OutlinerModel, original: Record<string, any>): string {
    const data: Record<string, unknown> = model.serialize();
    for (const k of UI_ORDER) {
        if (k in original && !(k in data)) { data[k] = original[k]; }
    }
    for (const k of Object.keys(original)) {
        if (!MODEL_OWNED.has(k) && !(k in data)) { data[k] = original[k]; }
    }
    return JSON.stringify(data, null, 2);
}

export function saveOut(doc: LoadedOut): void {
    atomicWriteFile(doc.absPath, serializeOut(doc.model, doc.original));
}

// ─── dir 解決（正典 flat-layout） ──────────────────────

export function hintsOf(original: Record<string, any>) {
    return { pageDir: original.pageDir, imageDir: original.imageDir, fileDir: original.fileDir };
}
export function pagesDirOf(doc: LoadedOut): string { return resolvePagesDir(doc.absPath, doc.noteDir, hintsOf(doc.original)); }
export function imagesDirOf(doc: LoadedOut): string { return resolveImagesDir(doc.absPath, doc.noteDir, hintsOf(doc.original)); }
export function filesDirOf(doc: LoadedOut): string { return resolveFilesDir(doc.absPath, doc.noteDir, hintsOf(doc.original)); }
export function pagePathOf(doc: LoadedOut, pageId: string): string { return path.join(pagesDirOf(doc), `${pageId}.md`); }

// ─── ノードの特定（D4: 既定 exact・曖昧なら候補を返してエラー） ─────

export type MatchMode = 'exact' | 'prefix' | 'contains';

export function firstLine(text: string): string {
    return String(text || '').split('\n')[0];
}

export function breadcrumbOf(model: OutlinerModel, id: string): string {
    const parts: string[] = [];
    let cur = model.nodes[id];
    let guard = 0;
    while (cur && cur.parentId && guard++ < 200) {
        const p = model.nodes[cur.parentId];
        if (!p) { break; }
        parts.unshift(truncate(firstLine(p.text) || '(空)', 40));
        cur = p;
    }
    return parts.join(' > ');
}

export function truncate(s: string, n: number): string {
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function nodeCandidate(model: OutlinerModel, id: string) {
    const n = model.nodes[id];
    return {
        id,
        text: truncate(firstLine(n?.text || ''), 80),
        breadcrumb: breadcrumbOf(model, id),
        ...(n?.isPage ? { isPage: true } : {}),
    };
}

export function textMatches(text: string, ref: string, match: MatchMode): boolean {
    const full = String(text || '').trim();
    const head = firstLine(text).trim();
    const r = String(ref).trim();
    if (match === 'exact') { return full === r || head === r; }
    const lf = full.toLowerCase();
    const lr = r.toLowerCase();
    if (match === 'prefix') { return lf.startsWith(lr); }
    return lf.includes(lr);
}

/**
 * ノードを id か本文で特定する。
 * - id が一致すればそれ
 * - 本文は match（既定 exact = 本文全体か先頭行が完全一致）。0 件なら NOT_FOUND（部分一致の候補付き）、
 *   2 件以上なら AMBIGUOUS（候補 = id / 本文 / パンくず）。黙って先頭を選ばない（監査 B-8）
 */
export function resolveNodeRef(model: OutlinerModel, ref: string, opts: { match?: MatchMode; what: string }): string {
    const match = opts.match ?? 'exact';
    if (model.nodes[ref]) { return ref; }
    const hits = Object.keys(model.nodes).filter((id) => textMatches(model.nodes[id].text, ref, match));
    if (hits.length === 1) { return hits[0]; }
    if (hits.length === 0) {
        const suggestions = match === 'contains' ? [] : Object.keys(model.nodes)
            .filter((id) => textMatches(model.nodes[id].text, ref, 'contains')).slice(0, 10)
            .map((id) => nodeCandidate(model, id));
        throw new ToolError('NOT_FOUND',
            `${opts.what}「${ref}」に${match === 'exact' ? '完全一致する' : '一致する'}ノードがありません。${suggestions.length ? 'suggestions の id で指定するか、match: "contains" を使ってください。' : 'fractal_get でノード木を確かめてください。'}`,
            { ref, match, suggestions });
    }
    const candidates = hits.slice(0, 30).map((id) => nodeCandidate(model, id));
    throw new ToolError('AMBIGUOUS',
        `${opts.what}「${ref}」に一致するノードが ${hits.length} 件あります。candidates の id で指定してください（黙って選びません）。`,
        { ref, match, count: hits.length, candidates });
}

// ─── 位置（UI の addNode / moveNode と同じ意味） ─────────────

export type Position = 'child' | 'first' | 'after' | 'before';

/**
 * 新しいノードを UI と同じ規則で足す（outliner-model.js）。
 * - child（既定）: ref の子の末尾（ref 無し = ルートの末尾）= UI の addNode(parentId, null)
 * - first: ref の子の先頭（ref 無し = ルートの先頭）= addNodeAtStart
 * - after: ref の直後の兄弟 = addNode(ref.parentId, ref.id)
 * - before: ref の直前の兄弟 = addNodeBefore(ref.parentId, ref.id)
 */
export function addNodeAt(model: OutlinerModel, refId: string | null, position: Position, text: string): OutNode {
    if (position === 'after' || position === 'before') {
        if (!refId) { throw new ToolError('INVALID', `position: "${position}" には基準ノード（parent）が必要です`); }
        const ref = model.nodes[refId];
        return position === 'after' ? model.addNode(ref.parentId || null, refId, text) : model.addNodeBefore(ref.parentId || null, refId, text);
    }
    if (position === 'first') { return model.addNodeAtStart(refId, text); }
    return model.addNode(refId, null, text);
}

/** 既存ノードを UI の moveNode で動かす（位置の意味は addNodeAt と同じ）。自分・子孫の中へは動かさない */
export function moveNodeTo(model: OutlinerModel, nodeId: string, refId: string | null, position: Position): void {
    let newParent: string | null;
    let afterId: string | null;
    if (position === 'after' || position === 'before') {
        if (!refId) { throw new ToolError('INVALID', `position: "${position}" には基準ノード（moveTo）が必要です`); }
        if (refId === nodeId) { throw new ToolError('INVALID', '自分自身を基準に移動できません'); }
        const ref = model.nodes[refId];
        newParent = ref.parentId || null;
        if (position === 'after') {
            afterId = refId;
        } else {
            const sibs = (newParent ? model.nodes[newParent].children : model.rootIds).filter((x) => x !== nodeId);
            const i = sibs.indexOf(refId);
            afterId = i > 0 ? sibs[i - 1] : null;
        }
    } else {
        newParent = refId;
        if (position === 'first') { afterId = null; } else {
            const sibs = (newParent ? model.nodes[newParent].children : model.rootIds).filter((x) => x !== nodeId);
            afterId = sibs.length ? sibs[sibs.length - 1] : null;
        }
    }
    if (newParent && (newParent === nodeId || model.isDescendant(newParent, nodeId))) {
        throw new ToolError('INVALID', 'ノードを自分自身・自分の子孫の中へは移動できません');
    }
    model.moveNode(nodeId, newParent, afterId);
}

// ─── fractal_get のノード木 ─────────────────────────

export interface NodeView {
    id: string;
    text: string;
    children?: NodeView[];
    childCount?: number;
    checked?: boolean;
    isPage?: true;
    pageId?: string;
    pageMdPath?: string;
    images?: string[];
    filePath?: string;
    fileAbsPath?: string;
    subtext?: string;
    tags?: string[];
    collapsed?: true;
}

export function nodeView(doc: LoadedOut, id: string, depth: number, maxDepth: number | null): NodeView {
    const n = doc.model.nodes[id];
    const v: NodeView = { id, text: n.text || '' };
    if (n.checked === true || n.checked === false) { v.checked = n.checked; }
    if (n.isPage && n.pageId) { v.isPage = true; v.pageId = n.pageId; v.pageMdPath = pagePathOf(doc, n.pageId); }
    if (n.images && n.images.length) { v.images = n.images.slice(); }
    if (n.filePath) { v.filePath = n.filePath; v.fileAbsPath = path.resolve(doc.noteDir, n.filePath); }
    if (n.subtext) { v.subtext = n.subtext; }
    if (n.tags && n.tags.length) { v.tags = n.tags.slice(); }
    if (n.collapsed) { v.collapsed = true; }
    const kids = (n.children || []).filter((c) => doc.model.nodes[c]);
    if (kids.length) {
        if (maxDepth !== null && depth >= maxDepth) { v.childCount = kids.length; } else {
            v.children = kids.map((c) => nodeView(doc, c, depth + 1, maxDepth));
        }
    }
    return v;
}
