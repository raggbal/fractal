/**
 * tools-write.ts — 書き込み系 tool の実体（fractal_add / fractal_modify / fractal_attach / fractal_tree）
 *
 * md の本文はエージェントが直接編集する（ユーザー判断 2026-10-27。拡張機能は入力中の外部変更を 3-way で合成する）ので
 * md 本文の編集 tool（旧 fractal_md_edit）は持たない。H1 とタイトルの同期は fractal_tree rename（md item）/
 * fractal_modify set-text（page ノード）が正典の経路で行う
 *
 * spec 20261027-1700-mcp-full-ops: 処理は src/shared の正典（NotesFileManager / notes-ops-core /
 * markdown-import / file-import / drop-import / paste-asset-handler / md-h1-utils）と、webview と同じ
 * OutlinerModel を呼ぶだけにし、ここには引数の検査・対象の特定・JSON の返り値だけを書く。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import {
    createPageMdFile, pageH1TextFromNodeText, syncPageH1FromNodeText, importMdItemIntoOutCore,
    importOutPageNodeAsMdCore, moveOutNodesIntoOtherOutCore, transferOutNodesToOtherNoteCore,
    duplicateTreeItemEntity, buildFileLinkMarkdown, promoteLocalFileLinksToAttachments,
} from '../../src/shared/notes-ops-core';
import { importMdFilesCore } from '../../src/shared/markdown-import';
import { importFiles } from '../../src/shared/file-import';
import { saveImageBuffer } from '../../src/shared/drop-import';
import { generateUniqueFileNamePreserving, sanitizeSubpageLabel } from '../../src/shared/paste-asset-handler';
import { resolveImagesDirForMd, resolveFilesDirForMd } from '../../src/shared/flat-layout';
import { extractFirstH1 } from '../../src/shared/md-h1-utils';
import {
    ToolError, assertInside, atomicWriteFile, checkExpectedHash, lockNote, requireAbs, requireDir, requireFile, requireNoteRoot,
} from './guard';
import {
    MatchMode, OutNode, Position, addNodeAt, filesDirOf, imagesDirOf, loadOut, moveNodeTo, pagePathOf, pagesDirOf,
    resolveNodeRef, saveOut,
} from './outdoc';
import { NoteStructureView, TreeItem, buildTree, flattenTree, itemKind, parentFolderOf, readStructure, resolveTreeItem } from './notes';
import { MdPosition, insertBlock } from './md';
import { WriteOutcome, dryRunNote, runWrite } from './runtime';

type Json = Record<string, unknown>;

function finish<T extends Json>(out: WriteOutcome<T>, destructive = false): Json {
    const result: Json = { ...out.result };
    if (out.dryRun) { delete result.lockWarning; } // dryRun は書いていない
    return {
        ok: true,
        ...result,
        dryRun: out.dryRun,
        changed: out.changes.changed,
        created: out.changes.created,
        trashed: out.trashed,
        ...(out.changes.removed.length ? { removed: out.changes.removed } : {}),
        ...(out.dryRun ? dryRunNote(destructive) : {}),
    };
}

/**
 * NotesFileManager を開いて outline.note を先に読み込む（拡張機能では常に読み込み済み）。
 * 読み込み前に createFile すると、書いたばかりの .out を loadStructure の disk 同期が「未登録の .out」として
 * 末尾に足し、続けて createFile も先頭に足すので 2 回並ぶ（拡張機能では起きない順序）。
 */
function openFm(noteDir: string): NotesFileManager {
    const fm = new NotesFileManager(noteDir);
    fm.getStructure();
    return fm;
}

function noteRootOfNotesDir(dir: string, what: string): string {
    requireDir(dir, what);
    if (!fs.existsSync(path.join(dir, 'outline.note'))) {
        throw new ToolError('OUTSIDE_NOTES', `${what}（${dir}）に outline.note がありません。Fractal の Notes フォルダを指定してください（fractal_list_folders）。`, { absPath: dir });
    }
    return path.resolve(dir);
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp']);

function requireSources(list: string[] | undefined, what: string, kind: 'image' | 'file' | 'md'): string[] {
    const out: string[] = [];
    for (const p of list || []) {
        const abs = requireAbs(p, what);
        requireFile(abs, what);
        if (kind === 'image' && !IMAGE_EXT.has(path.extname(abs).toLowerCase())) {
            throw new ToolError('INVALID', `${what} は画像ファイル（${[...IMAGE_EXT].join(' ')}）にしてください: ${abs}。画像以外は files で添付します。`);
        }
        if (kind === 'md' && !/\.(md|markdown)$/i.test(abs)) { throw new ToolError('INVALID', `${what} は .md ファイルにしてください: ${abs}`); }
        out.push(abs);
    }
    return out;
}

/** "-" 区切りなど一括指定（ディレクトリ/*.md）を展開する（旧 fractal-md.mjs の --md と同じ受け方） */
function expandMd(patterns: string[]): string[] {
    const files: string[] = [];
    for (const p of patterns) {
        const abs = requireAbs(p, 'md');
        if (fs.existsSync(abs) && fs.statSync(abs).isFile()) { files.push(abs); continue; }
        const dir = path.dirname(abs);
        const base = path.basename(abs);
        if (base.includes('*') && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            const re = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            for (const e of fs.readdirSync(dir).sort()) { if (re.test(e) && /\.md$/i.test(e)) { files.push(path.join(dir, e)); } }
            continue;
        }
        throw new ToolError('NOT_FOUND', `md が見つかりません: ${abs}`, { absPath: abs });
    }
    if (files.length === 0) { throw new ToolError('NOT_FOUND', 'md が 1 つも見つかりません'); }
    return [...new Set(files)];
}

/** 外部の md 1 本を page md として取り込む（正典 importMdFilesCore + 📎 化。画像・添付・subpage も複製して書き換え） */
function importOneMd(srcAbs: string, pagesDir: string, imagesDir: string, filesDir: string): { pageId: string; title: string } {
    const raw = fs.readFileSync(srcAbs, 'utf8');
    const sourceDir = path.dirname(srcAbs);
    const title = extractFirstH1(raw) || path.basename(srcAbs).replace(/\.(md|markdown)$/i, '');
    const content = promoteLocalFileLinksToAttachments(raw, sourceDir);
    const [r] = importMdFilesCore([{ name: path.basename(srcAbs), content, sourceDir }], pagesDir, imagesDir, {
        title, fileDir: filesDir, restrictSourceRoots: [sourceDir],
    });
    return { pageId: r.pageId, title };
}

function resolveFolderRef(st: NoteStructureView, ref: string | undefined, match: MatchMode | undefined): string | null {
    if (ref === undefined || ref === null || ref === '' || ref === 'root') { return null; }
    return resolveTreeItem(st, ref, { match, what: 'parentFolder', types: ['folder'] }).id;
}

/** ツリーでの置き場（parentFolder / after）→ { parentId, afterId, index }（after があれば after の親フォルダ） */
function treePlacement(st: NoteStructureView, a: { parentFolder?: string; after?: string; position?: 'first' | 'last'; match?: MatchMode }, movingId?: string) {
    let parentId = resolveFolderRef(st, a.parentFolder, a.match);
    let afterId: string | null = null;
    if (a.after) {
        afterId = resolveTreeItem(st, a.after, { match: a.match, what: 'after' }).id;
        if (afterId === movingId) { throw new ToolError('INVALID', 'after に自分自身は指定できません'); }
        const p = parentFolderOf(st, afterId);
        if (a.parentFolder !== undefined && a.parentFolder !== '' && p !== parentId) {
            throw new ToolError('INVALID', 'after の項目は parentFolder の中にありません（after だけでも置き場は決まります）');
        }
        parentId = p;
    }
    const sibs: string[] = ((parentId ? st.items[parentId]?.childIds : st.rootIds) || []).filter((x: string) => x !== movingId);
    let index: number;
    if (afterId) { index = sibs.indexOf(afterId) + 1; } else { index = a.position === 'first' ? 0 : sibs.length; }
    return { parentId, afterId, index, lastSibling: sibs.length ? sibs[sibs.length - 1] : null };
}

function itemView(noteDir: string, id: string): Json {
    const st = readStructure(noteDir);
    const it = flattenTree(buildTree(st)).find((x) => x.id === id);
    if (!it) { return { itemId: id }; }
    return { itemId: id, type: it.type, title: it.title, ...(it.absPath ? { absPath: it.absPath } : {}), folderPath: it.folderPath };
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_add
// ═══════════════════════════════════════════════════════════════════════════

export interface AddArgs {
    note?: string; text?: string; md?: string[]; parent?: string; position?: Position; groupName?: string;
    createOutliner?: string; createMd?: string; notesDir?: string; parentFolder?: string; after?: string;
    targetMd?: string; heading?: string; mdPosition?: MdPosition; match?: MatchMode; expectedHash?: string;
}

export async function toolAdd(a: AddArgs): Promise<Json> {
    const modes = (['note', 'createOutliner', 'createMd', 'targetMd'] as const).filter((k) => a[k] !== undefined);
    if (modes.length !== 1) { throw new ToolError('INVALID', 'note / createOutliner / createMd / targetMd のどれか 1 つを指定してください'); }

    // ── 新しい .out / 独立 md を作ってツリーに登録（正典 NotesFileManager.createFile / createMarkdownFile） ──
    if (a.createOutliner !== undefined || a.createMd !== undefined) {
        if (a.notesDir === undefined) { throw new ToolError('INVALID', 'notesDir は必須です'); }
        const notesDir = noteRootOfNotesDir(requireAbs(a.notesDir, 'notesDir'), 'notesDir');
        const isOut = a.createOutliner !== undefined;
        const title = String(isOut ? a.createOutliner : a.createMd) || 'Untitled';
        const out = await runWrite({ roots: [notesDir] }, { notesDir }, (x) => {
            const lock = checkExpectedHash(path.join(x.notesDir, 'outline.note'), a.expectedHash);
            const st = readStructure(x.notesDir);
            const pl = treePlacement(st, { parentFolder: a.parentFolder, after: a.after, position: 'first', match: a.match });
            const fm = openFm(x.notesDir);
            const filePath = isOut ? fm.createFile(title, pl.parentId, pl.afterId) : fm.createMarkdownFile(title, pl.parentId, pl.afterId);
            const itemId = path.basename(filePath).replace(/\.(out|md)$/, '');
            return { op: isOut ? 'create-outliner' : 'create-md', absPath: filePath, itemId, title, noteDir: x.notesDir, parentFolderId: pl.parentId, ...lockNote(lock) };
        });
        return finish(out);
    }

    // ── md に subpage を足す（md を取り込む / 空の subpage を作る）+ リンクを見出しの下などに入れる ──
    if (a.targetMd !== undefined) {
        const targetMd = requireAbs(a.targetMd, 'targetMd');
        requireFile(targetMd, 'targetMd', '.md');
        const root = requireNoteRoot(targetMd, 'targetMd');
        const sources = a.md?.length ? expandMd(a.md) : [];
        if (!sources.length && a.text === undefined) { throw new ToolError('INVALID', 'targetMd には md（取り込む md）か text（新しい subpage のタイトル）が必要です'); }
        const out = await runWrite({ roots: [root] }, { targetMd, root }, (x) => {
            const lock = checkExpectedHash(x.targetMd, a.expectedHash);
            const dir = path.dirname(x.targetMd);
            const imagesDir = resolveImagesDirForMd(x.targetMd);
            const filesDir = resolveFilesDirForMd(x.targetMd);
            for (const d of [dir, imagesDir, filesDir]) { assertInside(x.root, d); }
            const made: { absPath: string; title: string; link: string }[] = [];
            if (sources.length) {
                for (const src of sources) {
                    const r = importOneMd(src, dir, imagesDir, filesDir);
                    made.push({ absPath: path.join(dir, `${r.pageId}.md`), title: r.title, link: `[[${sanitizeSubpageLabel(r.title)}]](${r.pageId}.md)` });
                }
            } else {
                const title = String(a.text);
                const pageId = crypto.randomUUID(); // page md の id は UI と同じ UUID（outliner-model.generatePageId と同じ形）
                const p = createPageMdFile(dir, pageId, title);
                made.push({ absPath: p, title, link: `[[${sanitizeSubpageLabel(title)}]](${pageId}.md)` });
            }
            const body = fs.readFileSync(x.targetMd, 'utf8');
            const ins = insertBlock(body, made.map((m) => m.link).join('\n\n'), { heading: a.heading, match: a.match, position: a.mdPosition });
            atomicWriteFile(x.targetMd, ins.body);
            return { op: 'add-subpage', absPath: x.targetMd, insertedAtLine: ins.insertedAtLine, subpages: made, ...lockNote(lock) };
        });
        return finish(out);
    }

    // ── .out にノード / page ノードを足す（OutlinerModel = 画面と同じ位置・tags・taskMode） ──
    const outPath = requireAbs(a.note, 'note');
    requireFile(outPath, 'note', '.out');
    const root = requireNoteRoot(outPath, 'note');
    const sources = a.md?.length ? expandMd(a.md) : [];
    if (!sources.length && a.text === undefined) { throw new ToolError('INVALID', 'text か md が必要です'); }
    const out = await runWrite({ roots: [root] }, { outPath, root }, (x) => {
        const lock = checkExpectedHash(x.outPath, a.expectedHash);
        const doc = loadOut(x.outPath);
        const refId = a.parent !== undefined && a.parent !== 'root' ? resolveNodeRef(doc.model, a.parent, { match: a.match, what: 'parent' }) : null;
        const position: Position = a.position ?? 'child';
        if (!sources.length) {
            const node = addNodeAt(doc.model, refId, position, String(a.text));
            saveOut(doc);
            return { op: 'add-node', absPath: x.outPath, nodeId: node.id, parentId: node.parentId, text: node.text, tags: node.tags, checked: node.checked, ...lockNote(lock) };
        }
        const pagesDir = pagesDirOf(doc);
        const imagesDir = imagesDirOf(doc);
        const filesDir = filesDirOf(doc);
        for (const d of [pagesDir, imagesDir, filesDir]) { assertInside(x.root, d, 'page / 画像 / 添付の保存先（.out の pageDir / imageDir / fileDir）'); }
        const pages: Json[] = [];
        let groupNodeId: string | undefined;
        const asPage = (nodeId: string, pageId: string) => {
            const n = doc.model.nodes[nodeId];
            n.isPage = true; n.pageId = pageId; n.filePath = null;
        };
        if (sources.length > 1) {
            const group = addNodeAt(doc.model, refId, position, String(a.groupName ?? a.text ?? 'Imported'));
            groupNodeId = group.id;
            for (const src of sources) {
                const r = importOneMd(src, pagesDir, imagesDir, filesDir);
                const n = doc.model.addNode(group.id, null, r.title);
                asPage(n.id, r.pageId);
                pages.push({ nodeId: n.id, pageId: r.pageId, pageMdPath: pagePathOf(doc, r.pageId), title: r.title, source: src });
            }
        } else {
            const r = importOneMd(sources[0], pagesDir, imagesDir, filesDir);
            const n = addNodeAt(doc.model, refId, position, a.text !== undefined ? String(a.text) : r.title);
            asPage(n.id, r.pageId);
            pages.push({ nodeId: n.id, pageId: r.pageId, pageMdPath: pagePathOf(doc, r.pageId), title: doc.model.nodes[n.id].text, source: sources[0] });
        }
        saveOut(doc);
        return { op: 'add-pages', absPath: x.outPath, ...(groupNodeId ? { groupNodeId } : {}), pages, ...lockNote(lock) };
    });
    return finish(out);
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_modify
// ═══════════════════════════════════════════════════════════════════════════

export type ModifyOp = 'set-text' | 'check' | 'uncheck' | 'clear-check' | 'delete' | 'move' | 'make-page' | 'unpage' | 'page-to-md' | 'md-to-page';

export interface ModifyArgs {
    note: string; target?: string; op: ModifyOp; text?: string; moveTo?: string; position?: Position;
    toOut?: string; mdItem?: string; parentFolder?: string; after?: string;
    dryRun?: boolean; expectedHash?: string; targetExpectedHash?: string; match?: MatchMode;
}

export async function toolModify(a: ModifyArgs): Promise<Json> {
    const outPath = requireAbs(a.note, 'note');
    requireFile(outPath, 'note', '.out');
    const root = requireNoteRoot(outPath, 'note');
    if (a.op !== 'md-to-page' && (a.target === undefined || a.target === '')) { throw new ToolError('INVALID', `${a.op} には target（対象ノードの id か本文）が必要です`); }
    if (a.op === 'set-text' && a.text === undefined) { throw new ToolError('INVALID', 'set-text には text が必要です'); }
    if (a.op === 'md-to-page' && !a.mdItem) { throw new ToolError('INVALID', 'md-to-page には mdItem（ページにする md item の id / タイトル / 絶対パス）が必要です'); }
    if (a.op === 'move' && a.moveTo === undefined && a.toOut === undefined) { throw new ToolError('INVALID', 'move には moveTo（移動先ノード。ルートは "root"）か toOut（別の .out）が必要です'); }

    let toOut: string | undefined;
    let toRoot: string | undefined;
    if (a.op === 'move' && a.toOut !== undefined) {
        toOut = requireAbs(a.toOut, 'toOut');
        requireFile(toOut, 'toOut', '.out');
        toRoot = requireNoteRoot(toOut, 'toOut');
        if (path.resolve(toOut) === outPath) { toOut = undefined; toRoot = undefined; }
    }
    const crossNote = !!(toRoot && toRoot !== root);
    const destructive = a.op === 'delete' || a.op === 'unpage' || crossNote;
    const roots = toRoot ? [root, toRoot] : [root];

    const out = await runWrite({ roots, dryRun: a.dryRun, destructive }, { outPath, toOut, root, toRoot }, async (x) => {
        const lock = checkExpectedHash(x.outPath, a.expectedHash);
        const doc = loadOut(x.outPath);
        const model = doc.model;
        const tid = a.op === 'md-to-page' ? null : resolveNodeRef(model, String(a.target), { match: a.match, what: 'target' });
        const node = tid ? model.nodes[tid] : null;
        const base = { op: a.op, absPath: x.outPath, ...(tid ? { nodeId: tid } : {}), ...lockNote(lock) };
        switch (a.op) {
            case 'set-text': {
                const before = node!.text;
                model.updateText(tid!, String(a.text));
                saveOut(doc);
                let pageMdSynced: string | undefined;
                if (node!.isPage && node!.pageId) {
                    // UI と同じ: page ノードの本文の先頭行を page md の H1 に同期（正典 notes-ops-core.syncPageH1FromNodeText）
                    const h1 = pageH1TextFromNodeText(String(a.text));
                    const pagePath = pagePathOf(doc, node!.pageId);
                    if (h1 && syncPageH1FromNodeText(pagePath, h1)) { pageMdSynced = pagePath; }
                }
                return { ...base, before, after: model.nodes[tid!].text, tags: model.nodes[tid!].tags, ...(pageMdSynced ? { pageMdSynced } : {}) };
            }
            case 'check': case 'uncheck': case 'clear-check': {
                node!.checked = a.op === 'check' ? true : a.op === 'uncheck' ? false : null;
                saveOut(doc);
                return { ...base, checked: node!.checked };
            }
            case 'delete': {
                const removedNodeIds = [tid!, ...model.getDescendantIds(tid!)];
                model.removeNode(tid!);
                saveOut(doc);
                return { ...base, removedNodeIds };
            }
            case 'move': {
                if (!x.toOut) {
                    const refId = a.moveTo === undefined || a.moveTo === 'root' ? null : resolveNodeRef(model, a.moveTo, { match: a.match, what: 'moveTo' });
                    moveNodeTo(model, tid!, refId, a.position ?? 'child');
                    saveOut(doc);
                    const n = model.nodes[tid!];
                    const sibs = n.parentId ? model.nodes[n.parentId].children : model.rootIds;
                    return { ...base, parentId: n.parentId, index: sibs.indexOf(tid!) };
                }
                // 別の .out へ: 同じ note なら参照を引き継ぐ（正典 moveOutNodesIntoOtherOutCore）、別の note なら実体を複製してから移す
                checkExpectedHash(x.toOut, a.targetExpectedHash, 'targetExpectedHash');
                let newRootId: string;
                let pageIdMap: Record<string, string> = {};
                if (!crossNote) {
                    const r = moveOutNodesIntoOtherOutCore(x.outPath, x.toOut, [tid!]);
                    if (r.status === 'dirs-differ') {
                        throw new ToolError('INVALID', '移動元と移動先の .out が別の asset フォルダ（legacy layout）を使っているため移動できません（UI と同じ制限）');
                    }
                    if (r.status !== 'moved') { throw new ToolError('FAILED', '移動できませんでした'); }
                    newRootId = r.newRootIds[0];
                } else {
                    const r = transferOutNodesToOtherNoteCore(x.outPath, x.toOut, [tid!]);
                    if (!r) { throw new ToolError('FAILED', '移動できませんでした'); }
                    newRootId = r.newRootIds[0];
                    pageIdMap = r.pageIdMap;
                }
                // 移動先での位置（既定 = ルートの先頭 = UI の D&D と同じ。moveTo / position で変えられる）
                if ((a.moveTo !== undefined && a.moveTo !== 'root') || (a.position !== undefined && a.position !== 'first')) {
                    const tdoc = loadOut(x.toOut);
                    const refId = a.moveTo === undefined || a.moveTo === 'root' ? null : resolveNodeRef(tdoc.model, a.moveTo, { match: a.match, what: 'moveTo（移動先の .out の中）' });
                    moveNodeTo(tdoc.model, newRootId, refId, a.position ?? 'child');
                    saveOut(tdoc);
                }
                const t = loadOut(x.toOut);
                const n = t.model.nodes[newRootId];
                return { ...base, nodeId: newRootId, previousNodeId: tid, toOut: x.toOut, crossNote, parentId: n?.parentId ?? null, pageIdMap };
            }
            case 'make-page': {
                if (node!.isPage) { throw new ToolError('INVALID', 'このノードはもうページです'); }
                if (node!.filePath) { throw new ToolError('INVALID', '添付ファイル付きのノードはページにできません（page と file は排他）。子ノードを作ってそちらをページにしてください。'); }
                const pageId = model.makePage(tid!)!;
                // UI（outliner.js makePage）と同じ: 先頭行を H1 にした page md を作る（正典 createPageMdFile）
                const title = String(node!.text || '').split('\n')[0].trim();
                const pagesDir = pagesDirOf(doc);
                assertInside(x.root, pagesDir, 'page の保存先（.out の pageDir）');
                const pageMdPath = createPageMdFile(pagesDir, pageId, title);
                saveOut(doc);
                return { ...base, pageId, pageMdPath };
            }
            case 'unpage': {
                if (!node!.isPage || !node!.pageId) { throw new ToolError('INVALID', 'このノードはページではありません'); }
                const pageMdPath = pagePathOf(doc, node!.pageId);
                const pageId = model.removePage(tid!);
                saveOut(doc);
                // page md は孤児になる → runWrite（destructive）がゴミ箱へ移す
                return { ...base, previousPageId: pageId, pageMdPath };
            }
            case 'page-to-md': {
                if (!node!.isPage || !node!.pageId) { throw new ToolError('INVALID', 'このノードはページではありません'); }
                const st = readStructure(x.root);
                const pl = treePlacement(st, { parentFolder: a.parentFolder, after: a.after, position: 'first', match: a.match });
                const fm = openFm(x.root);
                // 正典 notes-ops-core.importOutPageNodeAsMdCore（UI の page node → ツリー D&D と同じ。元 node は空にして残す）
                const r = importOutPageNodeAsMdCore(fm, { outFileKey: x.outPath, nodeId: tid!, pageId: node!.pageId, title: node!.text }, pl.parentId, pl.index, { clearSourceNode: true });
                if (!r) { throw new ToolError('FAILED', 'page md が見つからないため md にできませんでした'); }
                return { ...base, mdItemId: r.mdId, ...itemView(x.root, r.mdId), sourceNodeCleared: !!r.clearedOutData, note: '元のノードは UI と同じく空のノードとして残ります（要らなければ fractal_modify delete）' };
            }
            case 'md-to-page': {
                const st = readStructure(x.root);
                const it = resolveTreeItem(st, String(a.mdItem), { match: a.match, what: 'mdItem', types: ['md'] });
                const refId = a.target !== undefined && a.target !== '' && a.target !== 'root' ? resolveNodeRef(model, a.target, { match: a.match, what: 'target' }) : null;
                const pos: Position = a.position ?? 'child';
                const corePos = refId ? (pos === 'first' || pos === 'child' ? 'child' : pos) : null;
                const fm = openFm(x.root);
                // 正典 notes-ops-core.importMdItemIntoOutCore（UI の md item → outliner D&D と同じ。md item はツリーから外れて page になる）
                const r = importMdItemIntoOutCore(fm, it.id, path.basename(x.outPath, '.out'), refId, corePos);
                if (!r) { throw new ToolError('FAILED', 'md をページにできませんでした（.out / md の実体を確かめてください）'); }
                // 位置の意味を他の op とそろえる（child = 子の末尾 / 基準無し = ルートの末尾）
                if (pos === 'child') {
                    const tdoc = loadOut(x.outPath);
                    moveNodeTo(tdoc.model, r.newNodeId, refId, 'child');
                    saveOut(tdoc);
                }
                return { ...base, nodeId: r.newNodeId, pageId: r.pageId, pageMdPath: pagePathOf(loadOut(x.outPath), r.pageId), title: r.title, removedItemId: it.id };
            }
        }
        throw new ToolError('INVALID', `unknown op: ${a.op}`);
    });
    return finish(out, destructive);
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_attach
// ═══════════════════════════════════════════════════════════════════════════

export interface AttachArgs {
    note?: string; targetMd?: string; images?: string[]; files?: string[]; parent?: string; position?: Position;
    text?: string; target?: string; append?: boolean; replace?: boolean; heading?: string; mdPosition?: MdPosition;
    match?: MatchMode; expectedHash?: string;
}

/** 添付の名前を md リンクで壊れない形にする（正典 NotesFileManager.sanitizeTreeFileName。監査 B-7） */
function safeAttachmentName(src: string): string {
    return NotesFileManager.sanitizeTreeFileName(path.basename(src)) || 'file';
}

export async function toolAttach(a: AttachArgs): Promise<Json> {
    if ((a.note === undefined) === (a.targetMd === undefined)) { throw new ToolError('INVALID', 'note か targetMd のどちらか 1 つを指定してください'); }
    // 書き始める前に全部の入力を確かめる（途中で失敗して images/ や孤児を残さない — 監査 B-12）
    const images = requireSources(a.images, 'images', 'image');
    const files = requireSources(a.files, 'files', 'file');
    if (!images.length && !files.length) { throw new ToolError('INVALID', 'images か files が必要です'); }

    if (a.targetMd !== undefined) {
        const md = requireAbs(a.targetMd, 'targetMd');
        requireFile(md, 'targetMd', '.md');
        const root = requireNoteRoot(md, 'targetMd');
        if (a.append || a.target || a.parent) { throw new ToolError('INVALID', 'targetMd では append / target / parent は使えません（位置は heading / mdPosition で指定）'); }
        const out = await runWrite({ roots: [root] }, { md, root }, (x) => {
            const lock = checkExpectedHash(x.md, a.expectedHash);
            const mdDir = path.dirname(x.md);
            const imagesDir = resolveImagesDirForMd(x.md);
            const filesDir = resolveFilesDirForMd(x.md);
            assertInside(x.root, imagesDir); assertInside(x.root, filesDir);
            const body = fs.readFileSync(x.md, 'utf8');
            const links: string[] = [];
            const assets: Json[] = [];
            for (const src of images) {
                // 画像の保存は正典 drop-import.saveImageBuffer（image_<ts>_<rand>.<ext>）
                const r = saveImageBuffer(fs.readFileSync(src), path.extname(src).slice(1).toLowerCase(), { imageDir: imagesDir, outDir: mdDir });
                links.push(`![](${r.imagePath})`);
                assets.push({ kind: 'image', source: src, absPath: path.resolve(mdDir, r.imagePath), rel: r.imagePath });
            }
            for (const src of files) {
                fs.mkdirSync(filesDir, { recursive: true });
                const name = generateUniqueFileNamePreserving(filesDir, safeAttachmentName(src));
                const dest = path.join(filesDir, name);
                fs.copyFileSync(src, dest);
                const rel = path.relative(mdDir, dest).replace(/\\/g, '/');
                // 添付リンクは UI と同じ [📎 name](rel)（正典 buildFileLinkMarkdown。Cleanup が数える形 — 監査 B-6）
                links.push(buildFileLinkMarkdown(name, rel));
                assets.push({ kind: 'file', source: src, absPath: dest, rel });
            }
            const ins = insertBlock(body, links.join('\n\n'), { heading: a.heading, match: a.match, position: a.mdPosition });
            atomicWriteFile(x.md, ins.body);
            return { op: 'attach-md', absPath: x.md, insertedAtLine: ins.insertedAtLine, links, assets, ...lockNote(lock) };
        });
        return finish(out);
    }

    const outPath = requireAbs(a.note, 'note');
    requireFile(outPath, 'note', '.out');
    const root = requireNoteRoot(outPath, 'note');
    if (images.length && files.length) { throw new ToolError('INVALID', '.out への images と files は 1 回にどちらか一方にしてください'); }
    if (a.append && !a.target) { throw new ToolError('INVALID', 'append には target が必要です'); }
    const destructive = !!(a.append && a.replace);
    const out = await runWrite({ roots: [root], destructive }, { outPath, root }, (x) => {
        const lock = checkExpectedHash(x.outPath, a.expectedHash);
        const doc = loadOut(x.outPath);
        const model = doc.model;
        const imagesDir = imagesDirOf(doc);
        const filesDir = filesDirOf(doc);
        assertInside(x.root, imagesDir, '画像の保存先（.out の imageDir）');
        assertInside(x.root, filesDir, '添付の保存先（.out の fileDir）');
        const saveImg = (src: string): string => saveImageBuffer(fs.readFileSync(src), path.extname(src).slice(1).toLowerCase(), { imageDir: imagesDir, outDir: doc.noteDir }).imagePath;
        // 添付の保存は正典 file-import.importFiles（UI の Import files と同じ。衝突は -1 -2）
        const saveFile = (src: string) => {
            const [r] = importFiles([src], filesDir, doc.noteDir);
            if (!r) { throw new ToolError('FAILED', `添付をコピーできませんでした: ${src}`); }
            return r;
        };

        if (a.append) {
            const tid = resolveNodeRef(model, String(a.target), { match: a.match, what: 'target' });
            const n = model.nodes[tid];
            if (images.length) {
                const rels = images.map(saveImg);
                for (const r of rels) { model.addImage(tid, r); }
                saveOut(doc);
                return { op: 'attach-append', absPath: x.outPath, nodeId: tid, images: model.nodes[tid].images, added: rels, ...lockNote(lock) };
            }
            if (files.length > 1) { throw new ToolError('INVALID', '既存ノードに付けられる添付は 1 つです（files は 1 件だけ）'); }
            // 監査 B-1: page ノードに添付を付けると page と file の排他でページが消える → 拒否する
            if (n.isPage) { throw new ToolError('INVALID', 'page ノードには添付ファイルを付けられません（page と file は排他。付けるとページの md が失われます）。子ノードとして足すか（append を外して parent にこのノード）、page md に添付してください（targetMd）。'); }
            if (n.filePath && !a.replace) { throw new ToolError('INVALID', `このノードにはもう添付（${n.filePath}）があります。置き換えるなら replace: true（古い添付はゴミ箱へ）`); }
            const r = saveFile(files[0]);
            const prev = n.filePath;
            n.filePath = r.filePath;
            if (!n.text) { model.updateText(tid, r.title); }
            saveOut(doc);
            return { op: 'attach-append', absPath: x.outPath, nodeId: tid, filePath: r.filePath, fileAbsPath: path.resolve(doc.noteDir, r.filePath), ...(prev ? { replaced: prev } : {}), ...lockNote(lock) };
        }

        const refId = a.parent !== undefined && a.parent !== 'root' ? resolveNodeRef(model, a.parent, { match: a.match, what: 'parent' }) : null;
        const position: Position = a.position ?? 'child';
        if (images.length) {
            // 1 ノードに全画像（UI の画像ノードと同じ形）
            const rels = images.map(saveImg);
            const node = addNodeAt(model, refId, position, String(a.text ?? ''));
            for (const r of rels) { model.addImage(node.id, r); }
            saveOut(doc);
            return { op: 'attach-new-node', absPath: x.outPath, nodeIds: [node.id], nodeId: node.id, images: rels, ...lockNote(lock) };
        }
        // 添付は 1 ファイル = 1 ノード（兄弟として並べる）
        const nodeIds: string[] = [];
        const added: Json[] = [];
        let last: string | null = null;
        for (const src of files) {
            const r = saveFile(src);
            const node: OutNode = last ? addNodeAt(model, last, 'after', String(a.text ?? r.title)) : addNodeAt(model, refId, position, String(a.text ?? r.title));
            node.filePath = r.filePath;
            nodeIds.push(node.id);
            added.push({ nodeId: node.id, filePath: r.filePath, fileAbsPath: path.resolve(doc.noteDir, r.filePath), source: src });
            last = node.id;
        }
        saveOut(doc);
        return { op: 'attach-new-node', absPath: x.outPath, nodeIds, nodeId: nodeIds[0], files: added, ...lockNote(lock) };
    });
    return finish(out, destructive);
}

// ═══════════════════════════════════════════════════════════════════════════
// fractal_tree
// ═══════════════════════════════════════════════════════════════════════════

export type TreeOp = 'rename' | 'delete' | 'move' | 'create-folder' | 'duplicate' | 'move-to-note';
export interface TreeArgs {
    noteDir: string; op: TreeOp; item?: string; title?: string; parentFolder?: string; after?: string; position?: 'first' | 'last';
    toNoteDir?: string; dryRun?: boolean; expectedHash?: string; targetExpectedHash?: string; match?: MatchMode;
}

function isFolderDescendant(st: NoteStructureView, ancestorId: string, targetId: string): boolean {
    const stack = [...(st.items[ancestorId]?.childIds || [])];
    while (stack.length) {
        const id = stack.pop()!;
        if (id === targetId) { return true; }
        const it = st.items[id];
        if (it?.type === 'folder') { stack.push(...(it.childIds || [])); }
    }
    return false;
}

export async function toolTree(a: TreeArgs): Promise<Json> {
    const noteDir = noteRootOfNotesDir(requireAbs(a.noteDir, 'noteDir'), 'noteDir');
    if (a.op !== 'create-folder' && !a.item) { throw new ToolError('INVALID', `${a.op} には item（項目の id / タイトル / 絶対パス）が必要です`); }
    if ((a.op === 'rename' || a.op === 'create-folder') && !a.title) { throw new ToolError('INVALID', `${a.op} には title が必要です`); }
    let toNoteDir: string | undefined;
    if (a.op === 'move-to-note') {
        if (!a.toNoteDir) { throw new ToolError('INVALID', 'move-to-note には toNoteDir（移動先の Notes フォルダ）が必要です'); }
        toNoteDir = noteRootOfNotesDir(requireAbs(a.toNoteDir, 'toNoteDir'), 'toNoteDir');
        if (toNoteDir === noteDir) { throw new ToolError('INVALID', 'toNoteDir が同じ Notes フォルダです（同じ note の中の移動は op: "move"）'); }
    }
    // 先に対象を特定して、destructive かどうかを決める（ゴミ箱の要否）
    const st0 = readStructure(noteDir);
    const item0: TreeItem | null = a.item ? resolveTreeItem(st0, a.item, { match: a.match, what: 'item' }) : null;
    const destructive = (a.op === 'delete' && !!item0 && ['out', 'md', 'file'].includes(item0.type)) || a.op === 'move-to-note';
    const roots = toNoteDir ? [noteDir, toNoteDir] : [noteDir];

    const out = await runWrite({ roots, dryRun: a.dryRun, destructive }, { noteDir, toNoteDir, itemAbs: item0?.absPath }, async (x, ctx) => {
        const lock = checkExpectedHash(path.join(x.noteDir, 'outline.note'), a.expectedHash);
        const st = readStructure(x.noteDir);
        const item = a.item ? resolveTreeItem(st, item0 ? item0.id : a.item, { match: a.match, what: 'item' }) : null;
        const fm = openFm(x.noteDir);
        const base = { op: a.op, noteDir: x.noteDir, outlineNotePath: path.join(x.noteDir, 'outline.note'), ...lockNote(lock) };
        switch (a.op) {
            case 'rename': {
                const it = item!;
                if (it.type === 'folder') { fm.renameFolder(it.id, String(a.title)); }
                else if (it.type === 'folderLink') { fm.setFolderLinkTitle(it.id, String(a.title)); }
                else {
                    // 正典 NotesFileManager.renameTitle: .out は title、md は先頭 H1、outline.note の title も同期
                    const abs = itemKind(x.noteDir, st.items[it.id]).absPath;
                    if (!abs || !fs.existsSync(abs)) { throw new ToolError('NOT_FOUND', `実体がありません: ${abs}`); }
                    fm.renameTitle(abs, String(a.title));
                }
                return { ...base, ...itemView(x.noteDir, it.id), previousTitle: it.title };
            }
            case 'delete': {
                const it = item!;
                if (it.type === 'folder') { fm.deleteFolder(it.id); return { ...base, itemId: it.id, type: it.type, note: '仮想フォルダだけを消しました（中身は親の階層へ移ります）' }; }
                if (it.type === 'folderLink') { fm.removeFolderLink(it.id); return { ...base, itemId: it.id, type: it.type, note: 'リンクだけを外しました（実フォルダには触っていません）' }; }
                const abs = itemKind(x.noteDir, st.items[it.id]).absPath!;
                // 正典 NotesFileManager.deleteFile / deleteTreeFile（ゴミ箱へ。.out は持っている page md も）
                if (it.type === 'file') { await fm.deleteTreeFile(it.id); } else { await fm.deleteFile(abs); }
                if (fs.existsSync(abs)) { throw new ToolError('FAILED', `削除できませんでした（ゴミ箱へ移せませんでした）: ${abs}`); }
                void ctx;
                return { ...base, itemId: it.id, type: it.type, absPath: abs };
            }
            case 'move': {
                const it = item!;
                const pl = treePlacement(st, { parentFolder: a.parentFolder, after: a.after, position: a.position ?? 'last', match: a.match }, it.id);
                if (pl.parentId && (pl.parentId === it.id || isFolderDescendant(st, it.id, pl.parentId))) {
                    throw new ToolError('INVALID', 'フォルダを自分自身・自分の中のフォルダへは移動できません');
                }
                fm.moveItem(it.id, pl.parentId, pl.index);
                return { ...base, ...itemView(x.noteDir, it.id), parentFolderId: pl.parentId, index: pl.index };
            }
            case 'create-folder': {
                const pl = treePlacement(st, { parentFolder: a.parentFolder, after: a.after, position: a.position ?? 'first', match: a.match });
                const before = new Set(Object.keys(fm.getStructure().items));
                const afterId = pl.afterId ?? (a.position === 'last' ? pl.lastSibling : null);
                const s2 = fm.createFolder(String(a.title), pl.parentId, afterId);
                const newId = Object.keys(s2.items).find((k) => !before.has(k))!;
                return { ...base, ...itemView(x.noteDir, newId), parentFolderId: pl.parentId };
            }
            case 'duplicate': {
                const it = item!;
                if (!['out', 'md', 'file'].includes(it.type)) { throw new ToolError('INVALID', 'duplicate できるのは .out / md / file の項目です'); }
                // 正典 notes-ops-core.duplicateTreeItemEntity（UI の Duplicate と同じ。資産も複製して 1:1 所有）
                const newId = duplicateTreeItemEntity(fm, it.id);
                if (!newId) { throw new ToolError('FAILED', '複製できませんでした'); }
                return { ...base, ...itemView(x.noteDir, newId), sourceItemId: it.id };
            }
            case 'move-to-note': {
                const it = item!;
                if (!['out', 'md', 'file'].includes(it.type)) { throw new ToolError('INVALID', 'move-to-note できるのは .out / md / file の項目です'); }
                checkExpectedHash(path.join(x.toNoteDir!, 'outline.note'), a.targetExpectedHash, 'targetExpectedHash');
                // 正典 NotesFileManager.moveFileItemToOtherNote（UI の Move to Other Note と同じ。page md・subpage・資産ごと）
                const newId = fm.moveFileItemToOtherNote(it.id, x.toNoteDir!);
                if (!newId) { throw new ToolError('FAILED', '別の note へ移動できませんでした'); }
                return { ...base, previousItemId: it.id, toNoteDir: x.toNoteDir, ...itemView(x.toNoteDir!, newId) };
            }
        }
        throw new ToolError('INVALID', `unknown op: ${a.op}`);
    });
    return finish(out, destructive);
}
