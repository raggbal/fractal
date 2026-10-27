/**
 * notes-ops-core — Notes の fs 操作の正典（拡張機能と MCP が同じ関数を呼ぶ）。
 *
 * spec 20261027-1700-mcp-full-ops D1 / ADR-0012:
 *   notesEditorProvider.ts / notes-message-handler.ts のクロージャの中にあった fs ロジックを
 *   DI 付き（fileManager 等を引数で受ける）の純関数としてここへ切り出した。
 *   拡張機能（provider / handler）はこの関数を呼んでから webview への通知だけを行い、
 *   MCP（agent-capability/mcp/dist/server.mjs）は同じ関数を呼んで JSON を返す。
 *
 * このファイルは vscode に依存しない（import しない）。vscode・webview に依存する処理
 * （postMessage / showErrorMessage / openFile による UI 反映）は呼び出し側に残す。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { NotesFileManager } from './notes-file-manager';
import { resolvePagesDir, resolveImagesDir, resolveFilesDir } from './flat-layout';
import { safeResolveUnderDir } from './path-safety';
import { extractFirstH1, setFirstH1, writeFileIfChanged } from './md-h1-utils';
import { resolveSubpageTitle } from './md-subpage-utils';
import { importMdFiles } from './markdown-import';
import { moveSubtreeToOtherOut, collectSubtreeIds, OutDoc, OutNode } from './out-node-move';
import { handlePageAssets, copyImageAssets, copyFileAsset, extractAllAssetRefs } from './paste-asset-handler';

// ─────────────────────────────────────────────────────────────────────────────
// 小さな書式・位置の正典
// ─────────────────────────────────────────────────────────────────────────────

/**
 * §4y: files/ 添付を markdown リンクにする際の書式生成（旧 notes-message-handler.ts の buildFileLinkMarkdown）。
 * title（alt スロット）の label 終端衝突文字 `]`→`］` + 改行→空白。`[` は parser 上無害なので保持。
 * relPath（url スロット）は呼び出し側で sanitize 済み filename から組んだ相対パスを渡す。
 * UI の Cleanup（cleanup-core → markdown-link-parser.extractMarkdownFileLinks）は `[📎 ...](...)` だけを
 * 添付の参照として数えるため、md に添付を書く経路は必ずこの関数を通す（MCP も同じ）。
 */
export function buildFileLinkMarkdown(title: string, relPath: string): string {
    const safeTitle = String(title || '').replace(/\]/g, '］').replace(/[\r\n]+/g, ' ');
    return `[📎 ${safeTitle}](${relPath})`;
}

/**
 * FR-TF-14 (§4i(3) 2026-08-10): .out データへ新規 node を drop 位置（before/after/child）で挿入する
 * pure seam。targetNodeId が無い / position が不明なら従来どおり rootIds 先頭 unshift（後方互換）。
 * notesImportMdIntoOut（page node）が使用。node は呼び出し側が outData.nodes に登録済みであること。
 * （旧 notes-message-handler.ts の insertNodeAtDropPosition。handler は re-export する）
 */
export function insertNodeAtDropPosition(
    outData: { nodes: Record<string, any>; rootIds: string[] },
    newNodeId: string,
    targetNodeId: string | null | undefined,
    position: string | null | undefined
): void {
    const newNode = outData.nodes[newNodeId];
    const target = targetNodeId ? outData.nodes[targetNodeId] : null;
    if (target && position === 'child') {
        newNode.parentId = target.id;
        target.children = target.children || [];
        target.children.unshift(newNodeId);
        return;
    }
    if (target && (position === 'before' || position === 'after')) {
        newNode.parentId = target.parentId || null;
        const siblings: string[] = target.parentId && outData.nodes[target.parentId]
            ? (outData.nodes[target.parentId].children = outData.nodes[target.parentId].children || [])
            : outData.rootIds;
        const ti = siblings.indexOf(targetNodeId as string);
        const at = ti === -1 ? siblings.length : (position === 'before' ? ti : ti + 1);
        siblings.splice(at, 0, newNodeId);
        return;
    }
    outData.rootIds.unshift(newNodeId);
}

// ─────────────────────────────────────────────────────────────────────────────
// page md の作成・H1 同期（旧 notes-message-handler.ts の makePage / syncNodeTextToPageH1 case）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ページ化（makePage）で page md を作る。`<pagesDir>/<pageId>.md` に `# title\n` を書く。
 * webview は node.isPage / pageId をモデルで立ててから host に依頼する（outliner.js makePage）。
 * @returns 書いた page md の絶対パス
 */
export function createPageMdFile(pagesDir: string, pageId: string, title: string): string {
    if (!fs.existsSync(pagesDir)) { fs.mkdirSync(pagesDir, { recursive: true }); }
    const pagePath = path.join(pagesDir, `${pageId}.md`);
    fs.writeFileSync(pagePath, `# ${title}\n`, 'utf8');
    return pagePath;
}

/**
 * page node の text → page md の H1 に渡す文字列（outliner.js syncPageH1FromNodeText / makePage と同じ規則）。
 * H1 は 1 行しか表せないので先頭行だけを trim して使う。空なら null（同期しない）。
 */
export function pageH1TextFromNodeText(text: string): string | null {
    const first = String(text || '').split('\n')[0].trim();
    return first ? first : null;
}

/**
 * FR-TH-04: page node の text 確定 → 添付 page md の先頭 H1 を text に同期する（冪等・byte skip）。
 * @returns 書き換えたら true
 */
export function syncPageH1FromNodeText(pagePath: string | null | undefined, text: string): boolean {
    if (!pagePath || !fs.existsSync(pagePath)) { return false; }
    const body = fs.readFileSync(pagePath, 'utf8');
    return writeFileIfChanged(pagePath, setFirstH1(body, text));
}

// ─────────────────────────────────────────────────────────────────────────────
// md item → .out の page node（旧 notesEditorProvider.ts notesImportMdIntoOut の fs 部分）
// ─────────────────────────────────────────────────────────────────────────────

export interface ImportMdIntoOutResult {
    outFilePath: string;
    outData: any;
    newNodeId: string;
    pageId: string;
    title: string;
}

/**
 * Notes 内の md item を .out の page node にする（v0.207.77 D&D Feature A の fs 部分）。
 * 1. .out の pageDir を正典 resolvePagesDir で解決
 * 2. md が pagesDir にあればそのまま参照（pageId = ファイル名 stem）、無ければ import コピー
 * 3. page node を drop 位置（targetNodeId/position。無ければ root 先頭）に追加して .out を保存
 * 4. md item を outline.note からだけ外す（物理 md は page として使い続ける）
 * webview への反映（updateData / notesFileListChanged）は呼び出し側が行う。
 * @returns 失敗（対象が無い・.out でない等）は null。例外は呼び出し側へ投げる
 */
export function importMdItemIntoOutCore(
    fileManager: NotesFileManager,
    mdFileId: string,
    targetOutId: string,
    targetNodeId?: string | null,
    position?: string | null
): ImportMdIntoOutResult | null {
    const mdSourcePath = fileManager.getFilePathById(mdFileId);
    const outFilePath = fileManager.getFilePathById(targetOutId);
    if (!mdSourcePath || !outFilePath) { return null; }
    if (!fs.existsSync(mdSourcePath) || !fs.existsSync(outFilePath)) { return null; }
    if (!outFilePath.endsWith('.out')) { return null; }

    // 1. 対象 .out の json 読込 + pageDir 解決 (target が currentFile でなくても解決できる)
    // US-08 (sprint 20260804-145603): 自前計算（legacy <outDir>/<stem>/ default）を
    // 正典 flat-layout.resolvePagesDir に置換（flat note では note 直下を返す =
    // 本体の page 読み取りと同じ解決。ミラー実装乖離の教訓 designer_failures 2026-07-26）。
    const outRaw = fs.readFileSync(outFilePath, 'utf8');
    const outData = JSON.parse(outRaw);
    const pagesDir = resolvePagesDir(outFilePath, fileManager.getMainFolderPath(), {
        pageDir: outData.pageDir,
        imageDir: outData.imageDir,
        fileDir: outData.fileDir,
    });
    const imagesDir = fileManager.getOutlinerImageDirPath();

    // 2. md を page 化する。
    // US-08 (sprint 20260804-145603): note 内 D&D で pagesDir が md の現在地と同じ
    //（flat 構成の通常ケース）なら、コピー・リネームせず**既存ファイルをそのまま**
    // page として参照する（pageId = 既存ファイル名 stem・ファイル名不変）。
    // pagesDir が別の場所（legacy pageDir 指定の .out）のときだけ従来どおり import コピー。
    let r: { title: string; pageId: string };
    if (path.resolve(path.dirname(mdSourcePath)) === path.resolve(pagesDir)) {
        const content = fs.readFileSync(mdSourcePath, 'utf8');
        r = {
            title: resolveSubpageTitle(content, path.basename(mdSourcePath)),
            pageId: path.basename(mdSourcePath, '.md'),
        };
    } else {
        const imported = importMdFiles([mdSourcePath], pagesDir, imagesDir);
        if (!imported || imported.length === 0) { return null; }
        r = imported[0];
    }

    // 3. page-node を追加。FR-TF-14 (2026-08-10): targetNodeId/position 指定時は
    // drop 位置（補助線の位置 = before/after/child）に挿入。省略時は従来の rootIds 先頭
    //（tree 内 md→out item の中央 50% 経路 = 後方互換）。
    // outliner-model.js と一致するノード構造 (children / parentId / isPage / pageId / 等)
    const newNodeId = 'n' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    outData.nodes = outData.nodes || {};
    outData.rootIds = outData.rootIds || [];
    const newNode: Record<string, unknown> = {
        id: newNodeId,
        parentId: null,
        children: [],
        text: r.title || '',
        tags: [],
        isPage: true,
        pageId: r.pageId,
        collapsed: false,
        checked: null,
        subtext: '',
        images: [],
        filePath: null,
    };
    outData.nodes[newNodeId] = newNode;
    insertNodeAtDropPosition(outData, newNodeId, targetNodeId, position);

    // 4. .out 保存
    fs.writeFileSync(outFilePath, JSON.stringify(outData, null, 2), 'utf8');

    // 5. v0.207.78: outliner cut/paste と同じく「画面上のデータは消す、
    // 物理ファイルは消さない」方針に合わせ、コピー元 Notes panel エントリを除去
    fileManager.unregisterMdFromStructureOnly(mdFileId);

    return { outFilePath, outData, newNodeId, pageId: r.pageId, title: r.title || '' };
}

// ─────────────────────────────────────────────────────────────────────────────
// .out の page node → 独立 md item（旧 notesEditorProvider.ts notesImportOutPageNodeAsMd の fs 部分）
// ─────────────────────────────────────────────────────────────────────────────

export interface ImportOutPageNodeAsMdResult {
    /** 登録した md item の id（flat note では pageId そのまま） */
    mdId: string;
    /** clearSourceNode=true で元 node を空にした後の .out データ（書けなかった / しなかったら null） */
    clearedOutData: any | null;
}

/**
 * page node を Notes の独立 md item にする（v0.207.77 D&D Feature B の fs 部分）。
 * 1. 元 .out の pageDir を正典 resolvePagesDir で解決し `<pageDir>/<pageId>.md` を safe resolve
 * 2. H1（正典 extractFirstH1）→ payload.title → 'Untitled' でタイトルを決める
 * 3. flat（page md が note 直下）なら既存ファイルをそのまま登録、legacy は複製登録
 * 4. clearSourceNode のとき元 node の isPage/pageId/text/images を空にする（node・children は残す。
 *    UI の cmd+x 単一ノードと同じ「画面上のデータは消す、物理ファイルは消さない」）
 * @returns 対象が無いときは null。例外は呼び出し側へ投げる
 */
export function importOutPageNodeAsMdCore(
    fileManager: NotesFileManager,
    payload: { outFileKey: string; nodeId: string; pageId: string; title: string },
    parentId: string | null,
    index: number,
    opts: { clearSourceNode: boolean }
): ImportOutPageNodeAsMdResult | null {
    if (!payload || !payload.outFileKey || !payload.pageId) { return null; }
    const srcOutPath = payload.outFileKey;
    if (!srcOutPath.endsWith('.out')) { return null; }
    if (!fs.existsSync(srcOutPath)) { return null; }

    // 1. 元 .out の pageDir を解決。
    // (3) 2026-08-05: 自前計算（legacy <outDir>/<stem>/ default）を正典
    // flat-layout.resolvePagesDir に置換（flat note では note 直下を返す）。
    const outRaw = fs.readFileSync(srcOutPath, 'utf8');
    const outData = JSON.parse(outRaw);
    const srcPageDir = resolvePagesDir(srcOutPath, fileManager.getMainFolderPath(), {
        pageDir: outData.pageDir,
        imageDir: outData.imageDir,
        fileDir: outData.fileDir,
    });

    // 2. 安全に <pageDir>/<pageId>.md を解決
    const srcMdPath = safeResolveUnderDir(srcPageDir, `${payload.pageId}.md`);
    if (!srcMdPath || !fs.existsSync(srcMdPath)) { return null; }

    // 3. 中身を読み、H1 を抽出 (空 → payload.title → 'Untitled')
    const mdContent = fs.readFileSync(srcMdPath, 'utf8');
    // H1 抽出は正典 md-h1-utils.extractFirstH1 に一本化する。
    // 独自実装は closing hash の**前置空白を要求しない**ため、`# C#` / `# F#` の
    // タイトルから末尾の `#` を削っていた（実測: C# → C）。
    // 併せて ``` フェンス内の見出しを誤検出する問題も正典側で解決される。
    const h1 = extractFirstH1(mdContent) || '';
    const fallback = (payload.title || '').trim();
    const title = h1 || fallback || 'Untitled';

    // 4. ツリーへ登録。
    // (3) 2026-08-05: 同一 note 内（page md が mainFolder 直下 = flat）なら
    // コピー・リネームせず既存ファイルをそのまま登録（id = pageId・ファイル名不変）。
    // legacy 配置（サブフォルダ pageDir）のみ従来どおり複製登録。
    let mdId: string;
    const isFlatInNote = path.resolve(path.dirname(srcMdPath)) === path.resolve(fileManager.getMainFolderPath());
    if (isFlatInNote) {
        fileManager.registerExistingMdFile(payload.pageId, title, parentId, index);
        mdId = payload.pageId;
    } else {
        mdId = fileManager.registerMarkdownFile(mdContent, title, parentId, index);
    }

    // 5. v0.207.78: outliner cmd+x 単一ノードと同じく「画面上のデータは消す、
    // 物理ファイルは消さない」方針。元の page-node の isPage/pageId/text/images
    // をクリア (ノード自体は残し、children も保つ)。物理 .md は元の pageDir に残存。
    let clearedOutData: any | null = null;
    if (opts.clearSourceNode) {
        try {
            const freshRaw = fs.readFileSync(srcOutPath, 'utf8');
            const freshData = JSON.parse(freshRaw);
            const target = freshData.nodes?.[payload.nodeId];
            if (target) {
                target.isPage = false;
                target.pageId = null;
                target.text = '';
                target.images = [];
                fs.writeFileSync(srcOutPath, JSON.stringify(freshData, null, 2), 'utf8');
                clearedOutData = freshData;
            }
        } catch (clearErr) {
            console.error('[Notes] clear source page-node error:', clearErr);
        }
    }
    return { mdId, clearedOutData };
}

// ─────────────────────────────────────────────────────────────────────────────
// node サブツリーを同じ note の別 .out へ move（旧 notesEditorProvider.ts notesMoveOutNodeSubtreeIntoOut の fs 部分）
// ─────────────────────────────────────────────────────────────────────────────

export type MoveNodesToOtherOutResult =
    | { status: 'moved'; srcData: OutDoc; targetData: OutDoc; moved: number; newRootIds: string[] }
    | { status: 'dirs-differ' }
    | { status: 'noop' };

/** 2 つの .out が同じ pages / images / files dir を共有するか（参照引き継ぎ move の前提） */
export function outsShareAssetDirs(srcOutPath: string, srcData: any, targetOutPath: string, targetData: any): boolean {
    const srcHints = { pageDir: srcData.pageDir as string | undefined, imageDir: srcData.imageDir as string | undefined, fileDir: srcData.fileDir as string | undefined };
    const tgtHints = { pageDir: targetData.pageDir as string | undefined, imageDir: targetData.imageDir as string | undefined, fileDir: targetData.fileDir as string | undefined };
    return resolvePagesDir(srcOutPath, undefined, srcHints) === resolvePagesDir(targetOutPath, undefined, tgtHints) &&
        resolveImagesDir(srcOutPath, undefined, srcHints) === resolveImagesDir(targetOutPath, undefined, tgtHints) &&
        resolveFilesDir(srcOutPath, undefined, srcHints) === resolveFilesDir(targetOutPath, undefined, tgtHints);
}

/**
 * node（複数可・選択集合の root を表示順で）を別 .out の root 先頭へ move し、両 .out を保存する。
 * - 同一 .out / 対象 node 無し → noop
 * - HIGH-2 安全ガード: 参照引き継ぎ（物理移動なし）は「src と target が同じ pages/images/files dir を
 *   共有する」flat レイアウト前提でのみ成立する。dir が食い違う場合は書かずに dirs-differ を返す。
 * webview への反映と警告表示は呼び出し側が行う。
 */
export function moveOutNodesIntoOtherOutCore(
    srcOutPath: string,
    targetOutFilePath: string,
    nodeIds: string[],
    idSeed?: string
): MoveNodesToOtherOutResult {
    if (!srcOutPath.endsWith('.out') || !targetOutFilePath.endsWith('.out')) { return { status: 'noop' }; }
    // 同一 .out への move は no-op（同一 outliner 内の並べ替えは webview 側の tree D&D が担う）
    if (srcOutPath === targetOutFilePath) { return { status: 'noop' }; }
    if (!fs.existsSync(srcOutPath) || !fs.existsSync(targetOutFilePath)) { return { status: 'noop' }; }

    // 1. src / target の .out json を読む（どちらも currentFile でなくても自前で読む）
    const srcData = JSON.parse(fs.readFileSync(srcOutPath, 'utf8')) as OutDoc;
    const targetData = JSON.parse(fs.readFileSync(targetOutFilePath, 'utf8')) as OutDoc;
    const moveIds = (nodeIds || []).filter((id) => !!(srcData.nodes && srcData.nodes[id]));
    if (moveIds.length === 0) { return { status: 'noop' }; }

    // 1.5 HIGH-2 安全ガード（上記）。legacy per-id .out 混在等で dir が異なると、参照だけ引き継いでも
    //     移動先で解決できず（broken ref）、src 削除で cleanup が物理削除するとデータロス。
    if (!outsShareAssetDirs(srcOutPath, srcData, targetOutFilePath, targetData)) {
        return { status: 'dirs-differ' };
    }

    // 2. 純関数でサブツリー転記（target root 先頭挿入 + src 削除）。
    //    dirsShared=true を確認済みなので、pageId/images/filePath の参照文字列を
    //    そのまま引き継ぐ（物理移動不要・1:1 所有の付替え）。src 削除でアセット物理ファイルは消さない。
    const seed = idSeed ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    // moveSubtreeToOtherOut は target root 先頭へ unshift する → 表示順を保つため**逆順**に回す
    let moved = 0;
    const newRootIds: string[] = [];
    for (let mi = moveIds.length - 1; mi >= 0; mi--) {
        const res = moveSubtreeToOtherOut(srcData, targetData, moveIds[mi], seed + mi.toString(36));
        if (res) { moved++; newRootIds.unshift(res.newRootId); }
    }
    if (moved === 0) { return { status: 'noop' }; }

    // 3. 両 .out を保存
    fs.writeFileSync(targetOutFilePath, JSON.stringify(targetData, null, 2), 'utf8');
    fs.writeFileSync(srcOutPath, JSON.stringify(srcData, null, 2), 'utf8');
    return { status: 'moved', srcData, targetData, moved, newRootIds };
}

// ─────────────────────────────────────────────────────────────────────────────
// node サブツリーを別 note の .out へ（アセットを dest note へ複製してから転記）
// ─────────────────────────────────────────────────────────────────────────────

export interface TransferNodesToOtherNoteResult {
    srcData: OutDoc;
    targetData: OutDoc;
    /** target に入れたサブツリー root の新 id（入力順） */
    newRootIds: string[];
    /** 移した page の 元 pageId → 新 pageId */
    pageIdMap: Record<string, string>;
    /** 移動元 note に残った（もう参照されない）実体の候補: page md / 画像 / 添付 */
    srcAssetCandidates: string[];
}

/**
 * node サブツリーを **別 note** の .out へ移す（UI の cmd+x → 別 note の outliner へ cmd+v と同じ
 * アセット複製の正典 handlePageAssets / copyImageAssets / copyFileAsset を使う）。
 * - page md は新 pageId で dest note に複製（本文の画像 / 📎 / subpage も dest へ複製・書換）
 * - node 直付きの画像 / 添付も dest の images/ files/ へ一意名で複製（1:1 所有）
 * - サブツリーは moveSubtreeToOtherOut で target root 先頭へ（src からは削除）
 * - 両 .out を保存する。移動元の実体は消さない（候補を返す。消すかどうかは呼び出し側）
 */
export function transferOutNodesToOtherNoteCore(
    srcOutPath: string,
    targetOutFilePath: string,
    nodeIds: string[],
    idSeed?: string
): TransferNodesToOtherNoteResult | null {
    if (!fs.existsSync(srcOutPath) || !fs.existsSync(targetOutFilePath)) { return null; }
    const srcData = JSON.parse(fs.readFileSync(srcOutPath, 'utf8')) as OutDoc;
    const targetData = JSON.parse(fs.readFileSync(targetOutFilePath, 'utf8')) as OutDoc;
    const moveIds = (nodeIds || []).filter((id) => !!(srcData.nodes && srcData.nodes[id]));
    if (moveIds.length === 0) { return null; }

    const srcOutDir = path.dirname(srcOutPath);
    const dstOutDir = path.dirname(targetOutFilePath);
    const srcHints = { pageDir: srcData.pageDir as string | undefined, imageDir: srcData.imageDir as string | undefined, fileDir: srcData.fileDir as string | undefined };
    const dstHints = { pageDir: targetData.pageDir as string | undefined, imageDir: targetData.imageDir as string | undefined, fileDir: targetData.fileDir as string | undefined };
    const srcPagesDir = resolvePagesDir(srcOutPath, srcOutDir, srcHints);
    const dstPagesDir = resolvePagesDir(targetOutFilePath, dstOutDir, dstHints);
    const srcFilesDir = resolveFilesDir(srcOutPath, srcOutDir, srcHints);
    const dstFilesDir = resolveFilesDir(targetOutFilePath, dstOutDir, dstHints);

    const pageIdMap: Record<string, string> = {};
    const srcAssetCandidates: string[] = [];
    // 1. アセット複製（node を書き換えるのは src の node 自体。この後 moveSubtreeToOtherOut が target へ写す）
    for (const rootId of moveIds) {
        for (const id of collectSubtreeIds(srcData, rootId)) {
            const n = srcData.nodes[id] as OutNode;
            if (!n) { continue; }
            const images = Array.isArray(n.images) ? n.images.slice() : [];
            for (const img of images) {
                const abs = safeResolveUnderDir(srcOutDir, img);
                if (abs) { srcAssetCandidates.push(abs); }
            }
            if (n.isPage && n.pageId) {
                const newPageId = crypto.randomUUID();
                const srcMd = path.join(srcPagesDir, `${n.pageId}.md`);
                if (fs.existsSync(srcMd)) {
                    srcAssetCandidates.push(srcMd);
                    // page 本文の参照アセットも移動元の候補（他から参照されていなければ孤児になる）
                    try {
                        const body = fs.readFileSync(srcMd, 'utf8');
                        const refs = extractAllAssetRefs(body);
                        for (const ref of [...refs.images, ...refs.files, ...refs.mdLinks]) {
                            const abs = safeResolveUnderDir(path.dirname(srcMd), ref);
                            if (abs) { srcAssetCandidates.push(abs); }
                        }
                    } catch { /* 読めなければ候補なし */ }
                }
                const r = handlePageAssets({
                    srcOutDir, srcPagesDir, destOutDir: dstOutDir, destPagesDir: dstPagesDir,
                    pageId: n.pageId, newPageId, nodeImages: images, sameDirSkip: false,
                });
                pageIdMap[n.pageId] = newPageId;
                n.pageId = newPageId;
                n.images = r.newNodeImages;
            } else if (images.length > 0) {
                const r = copyImageAssets({
                    srcOutDir, srcPagesDir, destOutDir: dstOutDir, destPagesDir: dstPagesDir,
                    newNodeId: id, nodeImages: images,
                });
                n.images = r.newNodeImages;
            }
            if (n.filePath) {
                const abs = safeResolveUnderDir(srcOutDir, n.filePath);
                if (abs) { srcAssetCandidates.push(abs); }
                const r = copyFileAsset({
                    srcOutDir, srcFileDir: srcFilesDir, destOutDir: dstOutDir, destFileDir: dstFilesDir, filePath: n.filePath,
                });
                if (r.newFilePath) { n.filePath = r.newFilePath; }
            }
        }
    }

    // 2. サブツリー転記（表示順を保つため逆順に root 先頭へ）
    const seed = idSeed ?? (Date.now().toString(36) + Math.random().toString(36).slice(2, 6));
    const newRootIds: string[] = [];
    for (let mi = moveIds.length - 1; mi >= 0; mi--) {
        const res = moveSubtreeToOtherOut(srcData, targetData, moveIds[mi], seed + mi.toString(36));
        if (res) { newRootIds.unshift(res.newRootId); }
    }

    // 3. 両 .out を保存（先に target = 複製済みの参照を持つ側）
    fs.writeFileSync(targetOutFilePath, JSON.stringify(targetData, null, 2), 'utf8');
    fs.writeFileSync(srcOutPath, JSON.stringify(srcData, null, 2), 'utf8');
    return { srcData, targetData, newRootIds, pageIdMap, srcAssetCandidates: Array.from(new Set(srcAssetCandidates)) };
}

// ─────────────────────────────────────────────────────────────────────────────
// tree item の Duplicate（旧 notes-message-handler.ts duplicateTreeItemCore の fs 部分）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * FR-FTM-03 (sprint 20260818-183407): tree item（out/md/file）の Duplicate。
 * 実体複製は DuplicationCore（paste-asset-handler の duplicate*Entity — ADRL-0078・uniquify 正典）。
 * 台帳は元 item の直後に新 item を挿入（title は uniquify サフィックス追従 — 名前の発明なし）。
 * 複製後の 2 item は資産を一切共有しない（1:1 所有維持）。folder link / 実フォルダは対象外。
 * @returns 新しい item id（失敗・対象外は null）
 */
export function duplicateTreeItemEntity(fileManager: NotesFileManager, itemId: string): string | null {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const dup = require('./paste-asset-handler');
    const structure = fileManager.getStructure();
    const item = structure.items[itemId];
    if (!item || item.type !== 'file') { return null; }
    const mainFolder = fileManager.getMainFolderPath();

    /** siblings 配列（root or 親 folder の childIds）の元 item 直後に newId を挿入 */
    const insertAfterOriginal = (newId: string): void => {
        let siblings = structure.rootIds;
        for (const id of Object.keys(structure.items)) {
            const it = structure.items[id];
            if (it?.type === 'folder' && (it as { childIds?: string[] }).childIds?.includes(itemId)) {
                siblings = (it as { childIds: string[] }).childIds;
                break;
            }
        }
        const idx = siblings.indexOf(itemId);
        siblings.splice(idx >= 0 ? idx + 1 : siblings.length, 0, newId);
    };
    /** uniquify で付いたサフィックス（'-1' 等）を title に追従させる */
    const titleWithSuffix = (oldStem: string, newStem: string, title: string): string => {
        if (newStem.startsWith(oldStem)) { return (title || newStem) + newStem.slice(oldStem.length); }
        return title || newStem;
    };

    try {
        const ext = (item as { ext?: string }).ext;
        if (ext === 'file') {
            const filename = (item as { filename?: string }).filename;
            if (!filename) { return null; }
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const { resolveMdFilesDir } = require('./flat-layout');
            const filesDir = resolveMdFilesDir(mainFolder);
            const newName = dup.duplicateFileEntity(filesDir, filename);
            const newId = NotesFileManager.generateOutlineId();
            const oldStem = path.basename(filename, path.extname(filename));
            const newStem = path.basename(newName, path.extname(newName));
            structure.items[newId] = {
                type: 'file', id: newId,
                title: titleWithSuffix(oldStem, newStem, item.title),
                ext: 'file', filename: newName,
            } as typeof item;
            insertAfterOriginal(newId);
            fileManager.saveStructure();
            return newId;
        } else if (ext === 'md') {
            const mdPath = fileManager.getMdFilePath(itemId);
            if (!fs.existsSync(mdPath)) { return null; }
            const r = dup.duplicateMdEntity(mdPath, mainFolder);
            // 新 item id = 新 stem（getMdFilePath(id) = <note>/<id>.md の対応を保つ）
            structure.items[r.newStem] = {
                type: 'file', id: r.newStem,
                title: titleWithSuffix(itemId, r.newStem, item.title),
                ext: 'md',
            } as typeof item;
            insertAfterOriginal(r.newStem);
            fileManager.saveStructure();
            return r.newStem;
        } else if (ext === 'folder') {
            return null; // folder link は対象外（メニュー非表示と同じ）
        } else {
            // .out item（ext なし）
            const outPath = path.join(mainFolder, `${itemId}.out`);
            if (!fs.existsSync(outPath)) { return null; }
            const r = dup.duplicateOutEntity(outPath, mainFolder);
            structure.items[r.newOutId] = {
                type: 'file', id: r.newOutId,
                title: titleWithSuffix(itemId, r.newOutId, item.title),
            } as typeof item;
            insertAfterOriginal(r.newOutId);
            fileManager.saveStructure();
            return r.newOutId;
        }
    } catch (e) {
        console.error('[Notes] duplicateTreeItemCore failed:', itemId, e);
        return null;
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// 外部 md の取り込み前処理
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 外部の md を Notes へ取り込む前に、ローカルファイルへのプレーンリンク `[text](report.pdf)` を
 * 添付リンク `[📎 text](report.pdf)` にする（md / 画像 / URL / anchor / 既存の 📎 / subpage は触らない）。
 *
 * 随伴転送の正典 copyMdPasteAssets（importMdFilesCore の fileDir 指定時）は 📎 リンクだけを添付として
 * 複製し、UI の Cleanup も 📎 リンクだけを添付の参照として数える。プレーンリンクのままだと
 * 添付が複製されずリンク切れになるか、複製しても孤児と判定される（監査 B-6）。
 * @param sourceDir 相対リンクを解決する基準（取り込む md のフォルダ）
 */
export function promoteLocalFileLinksToAttachments(body: string, sourceDir: string): string {
    if (!body) { return body; }
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const parser = require('./markdown-link-parser');
    const toks = (parser.parseMarkdownLinks(body) as Array<{ kind: string; alt: string; url: string; isSubpage?: boolean; start: number; end: number }>)
        .filter((t) => t.kind === 'link' && !t.isSubpage && (t.alt || '').trim().indexOf('📎') !== 0)
        .filter((t) => {
            const raw = String(t.url || '').trim().replace(/^<|>$/g, '').replace(/\s+["'][^"']*["']\s*$/, '');
            if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('#')) { return false; }
            let rel = raw.split(/[?#]/)[0];
            try { rel = decodeURIComponent(rel); } catch { /* raw のまま */ }
            if (/\.(md|markdown)$/i.test(rel)) { return false; }
            const abs = path.resolve(sourceDir, rel);
            try { return fs.statSync(abs).isFile(); } catch { return false; }
        })
        .sort((a, b) => b.start - a.start);
    let out = body;
    for (const t of toks) {
        const alt = String(t.alt || '').trim() || path.basename(String(t.url || ''));
        out = out.slice(0, t.start) + `[📎 ${alt}](${t.url})` + out.slice(t.end);
    }
    return out;
}
