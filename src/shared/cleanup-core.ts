/**
 * cleanup-core.ts
 *
 * Core cleanup logic without VSCode dependencies (for unit testing)
 */

import * as fs from 'fs';
import * as path from 'path';
import { extractMarkdownImagePaths } from './markdown-image-utils';
import { safeResolveUnderDir } from './path-safety';
import { resolveMdFilesDir } from './flat-layout';
const { extractMarkdownFileLinks } = require('./markdown-link-parser');

export async function listOutFiles(mainFolderPath: string): Promise<string[]> {
    if (!fs.existsSync(mainFolderPath)) { return []; }
    const entries = fs.readdirSync(mainFolderPath, { withFileTypes: true });
    return entries
        .filter(e => e.isFile() && e.name.endsWith('.out'))
        .map(e => path.join(mainFolderPath, e.name));
}

export async function listAllMd(mainFolderPath: string): Promise<string[]> {
    return walkRecursive(mainFolderPath, ['.md']);
}

export async function listAllImages(mainFolderPath: string): Promise<string[]> {
    return walkRecursive(mainFolderPath, ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp']);
}

export async function listAllFiles(mainFolderPath: string): Promise<string[]> {
    // Walk files/ directories and return ALL files (any extension)
    const result: string[] = [];
    if (!fs.existsSync(mainFolderPath)) { return result; }

    // Find all "files" directories recursively
    const filesDir = path.join(mainFolderPath, 'files');
    if (fs.existsSync(filesDir)) {
        walkFilesDir(filesDir, result);
    }

    // Also scan {id}/files/ directories for notes mode
    const entries = fs.readdirSync(mainFolderPath, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isDirectory()) {
            const noteFilesDir = path.join(mainFolderPath, entry.name, 'files');
            if (fs.existsSync(noteFilesDir)) {
                walkFilesDir(noteFilesDir, result);
            }
        }
    }

    return result;
}

function walkFilesDir(dir: string, result: string[]): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            walkFilesDir(fullPath, result);
        } else if (entry.isFile()) {
            result.push(fullPath);
        }
    }
}

export function walkRecursive(dir: string, extensions: string[]): string[] {
    const result: string[] = [];
    if (!fs.existsSync(dir)) { return result; }

    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...walkRecursive(fullPath, extensions));
        } else if (entry.isFile()) {
            const ext = path.extname(entry.name).toLowerCase();
            if (extensions.includes(ext)) {
                result.push(fullPath);
            }
        }
    }
    return result;
}

/**
 * outline.note を読み、structure.items のうち ext==='md' のファイルを
 * `_notes_md/<id>.md` の絶対パスとして liveMd に追加する。
 *
 * v0.207.92: notes editor 配下の .md (ADR-008) は `.out` の node.pageId 由来ではなく
 * outline.note の structure に登録されているため、cleanup 対象から守るためには
 * structure を読み込んで live set に加える必要がある。これをしないと notes-md が
 * 全件 orphan-md として誤検出され、Clean Unused Files で破壊的に削除される。
 */
function addNotesMdToLiveSet(mainFolderPath: string, liveMd: Set<string>): void {
    const noteFilePath = path.join(mainFolderPath, 'outline.note');
    if (!fs.existsSync(noteFilePath)) return;

    let structure: any;
    try {
        const content = fs.readFileSync(noteFilePath, 'utf8');
        structure = JSON.parse(content);
    } catch (e) {
        console.warn('[Fractal] Failed to parse outline.note for cleanup:', noteFilePath, e);
        return;
    }

    const items = structure?.items;
    if (!items || typeof items !== 'object') return;

    // notes-flat-storage (2026-07-07) + MEDIUM-1: md=mainFolder 直下（新）と _notes_md/（legacy）の
    // 両方を live に足す（安全側）。cleanup の false-negative（生存 md を live から漏らす）は
    // trash=データロスなので致命。false-positive（orphan 過小検出）は無害。移行途中・S3 で
    // 新旧混在した Note でも生存 md を落とさないよう、両方の候補パスを live に加える。
    const legacyMdRoot = path.join(mainFolderPath, '_notes_md');
    for (const id of Object.keys(items)) {
        const item = items[id];
        if (!item || item.type !== 'file' || item.ext !== 'md') continue;
        liveMd.add(path.join(mainFolderPath, `${id}.md`));      // 新: basedir 直下
        liveMd.add(path.join(legacyMdRoot, `${id}.md`));         // legacy: _notes_md/
    }
}

/**
 * outline.note の structure を読み、tree に登録された添付ファイル（ext==='file'）の
 * 実体パスを liveFiles に追加する。addNotesMdToLiveSet（md 版）と同型（FR-TF-07 🔴）。
 *
 * tree file は node/md どこからも参照されない（filename が実体への唯一の参照）ため、
 * これをしないと Clean Unused Files が tree 登録済みの添付を orphan-file として誤検出し
 * 破壊的に削除する。false-negative（生存 file を live から漏らす）は trash=データロスなので致命。
 *
 * filename は structure 由来だが、防御として safeResolveUnderDir で files/ 配下に clamp する
 * （traversal filename は null → live 化しない。resolveMdFilePath 等の path-safety と同一方針）。
 */
export function addNotesFilesToLiveSet(structure: any, mainFolderPath: string, liveFiles: Set<string>): void {
    const items = structure?.items;
    if (!items || typeof items !== 'object') return;

    const filesDir = resolveMdFilesDir(mainFolderPath); // flat-layout 正典（共有 files/）
    for (const id of Object.keys(items)) {
        const item = items[id];
        if (!item || item.type !== 'file' || item.ext !== 'file' || !item.filename) continue;
        const safeAbs = safeResolveUnderDir(filesDir, item.filename);
        if (safeAbs) { liveFiles.add(safeAbs); }
    }
}

export async function buildLiveSetPass1(
    outFiles: string[],
    mainFolderPath: string
): Promise<{ liveMd: Set<string>; liveImages: Set<string>; liveFiles: Set<string> }> {
    const liveMd = new Set<string>();
    const liveImages = new Set<string>();
    const liveFiles = new Set<string>();

    // notes editor の .md (outline.note structure 経由) を liveMd に追加
    addNotesMdToLiveSet(mainFolderPath, liveMd);

    for (const outPath of outFiles) {
        try {
            const content = fs.readFileSync(outPath, 'utf8');
            const data = JSON.parse(content);
            const nodes = data.nodes || {};
            const outDir = path.dirname(outPath);

            // pageDir を解決
            let pageDirAbs = outDir;
            if (data.pageDir) {
                pageDirAbs = path.isAbsolute(data.pageDir)
                    ? data.pageDir
                    : path.resolve(outDir, data.pageDir);
            }

            for (const nodeId of Object.keys(nodes)) {
                const node = nodes[nodeId];

                // node.images[] は path.relative(outDir, destPath) で保存されているため outDir 基準で resolve
                // 参考: notesEditorProvider.ts:298, outlinerProvider.ts:516 の saveOutlinerImage ハンドラ
                // 注意: safeResolveUnderDir は存在チェックしないため、必ず outDir 基準のみ使う。
                // pageDir 基準を最初に試すと {id}/images/... を {mainFolderPath}/{id}/{id}/images/... と誤 resolve する
                if (Array.isArray(node.images)) {
                    for (const imgRel of node.images) {
                        const safeAbs = safeResolveUnderDir(outDir, imgRel);
                        if (safeAbs) { liveImages.add(safeAbs); }
                    }
                }

                // node.filePath → file attachment (v8)
                if (node.filePath) {
                    const safeAbs = safeResolveUnderDir(outDir, node.filePath);
                    if (safeAbs) { liveFiles.add(safeAbs); }
                }

                // node.pageId → .md
                if (node.pageId) {
                    const mdPath = path.join(pageDirAbs, `${node.pageId}.md`);
                    liveMd.add(mdPath);
                }
            }
        } catch (e) {
            console.warn('[Fractal] Failed to parse .out for cleanup:', outPath, e);
        }
    }

    return { liveMd, liveImages, liveFiles };
}

export async function buildPass2LiveImages(
    liveMdPass1: Set<string>,
    liveImagesPass1: Set<string>,
    mainFolderPath: string
): Promise<Set<string>> {
    const liveImages = new Set(liveImagesPass1);
    const allMd = await listAllMd(mainFolderPath);
    const aliveMd = allMd.filter(p => liveMdPass1.has(p));

    for (const mdPath of aliveMd) {
        try {
            const content = fs.readFileSync(mdPath, 'utf8');
            const imagePaths = extractMarkdownImagePaths(content);
            const mdDir = path.dirname(mdPath);
            for (const rel of imagePaths) {
                const safeAbs = safeResolveUnderDir(mdDir, rel);
                if (safeAbs) { liveImages.add(safeAbs); }
            }
        } catch (e) {
            console.warn('[Fractal] Failed to read md for cleanup:', mdPath, e);
        }
    }

    return liveImages;
}

export async function buildPass2LiveFiles(
    liveMdPass1: Set<string>,
    liveFilesPass1: Set<string>,
    mainFolderPath: string
): Promise<Set<string>> {
    const liveFiles = new Set(liveFilesPass1);
    const allMd = await listAllMd(mainFolderPath);
    const aliveMd = allMd.filter(p => liveMdPass1.has(p));

    for (const mdPath of aliveMd) {
        try {
            const content = fs.readFileSync(mdPath, 'utf8');
            const filePaths = extractMarkdownFileLinks(content);
            const mdDir = path.dirname(mdPath);
            for (const rel of filePaths) {
                const safeAbs = safeResolveUnderDir(mdDir, rel);
                if (safeAbs) { liveFiles.add(safeAbs); }
            }

            // NT-17 配慮（MD-45 連動）: drawio.svg / drawio.png は ![]() 構文だが
            // fileDir 配下に保存される（OL-19B file 経路）。`extractMarkdownFileLinks`
            // は 📎 alt-text しか拾わないため、ここで ![](*.drawio.svg / *.drawio.png) を
            // 別途追加して orphan-file 誤判定を防ぐ。
            const imagePaths = extractMarkdownImagePaths(content);
            for (const rel of imagePaths) {
                const lower = rel.toLowerCase();
                if (lower.endsWith('.drawio.svg') || lower.endsWith('.drawio.png')) {
                    const safeAbs = safeResolveUnderDir(mdDir, rel);
                    if (safeAbs) { liveFiles.add(safeAbs); }
                }
            }
        } catch (e) {
            console.warn('[Fractal] Failed to read md for cleanup:', mdPath, e);
        }
    }

    return liveFiles;
}

/**
 * cleanup 専用の md→md リンク抽出。
 *
 * 目的: 「どこかの live md からリンクされている md は全部 cleanup から守る」。
 * paste-asset-handler の `extractAllAssetRefs(body).mdLinks` は **プレーン `[](x.md)` のみ**拾い
 * `[[label]](x.md)`（サブページ二重括弧形式）を落とす（`markdown-link-parser.js` の parseMarkdownLinks は
 * `[[x](y)]`（URL が外側 `[` の内側にある Wikipedia 引用形式）だけを wrapper として処理し、
 * `[[x]](y)` の url は emit しない。実測で確認済み）。
 * そのため cleanup ではローカル正規表現で **プレーンと `[[]]` の両形式**の `.md`/`.markdown` url を拾う。
 * paste-asset-handler の regex は複製ゲート sprint と干渉させないため変更しない。
 *
 * 正規表現: `(!?)\[\[?[^\]]*\]\]?\(([^)\s]+)\)`
 *   group1 = 先頭 `!`（image マーカー → 除外）, group2 = url
 *   単括弧 `[a](x)` と 二重括弧 `[[a]](x)` の両方にマッチ。
 * http/https/data/file/fractal プロトコル・純アンカー（`#...`）は除外。query/fragment は除去。
 */
const CLEANUP_MD_LINK_RE = /(!?)\[\[?[^\]]*\]\]?\(([^)\s]+)\)/g;

function extractMdLinkTargets(body: string): string[] {
    const results: string[] = [];
    if (!body) { return results; }
    const seen = new Set<string>();
    CLEANUP_MD_LINK_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CLEANUP_MD_LINK_RE.exec(body)) !== null) {
        if (m[1] === '!') { continue; }                      // image → not an md link
        let url = (m[2] || '').trim().replace(/^<|>$/g, '');
        if (!url) { continue; }
        if (/^(https?:|data:|file:|fractal:)/i.test(url)) { continue; }
        const cleaned = url.split(/[?#]/)[0];                // strip query / fragment (pure #anchor → '')
        if (!cleaned) { continue; }
        const lower = cleaned.toLowerCase();
        if (!(lower.endsWith('.md') || lower.endsWith('.markdown'))) { continue; }
        if (seen.has(cleaned)) { continue; }
        seen.add(cleaned);
        results.push(cleaned);
    }
    return results;
}

/**
 * Pass1-live な md 群を起点に md→md リンクを BFS で辿り、note root 内（safeResolveUnderDir で clamp）の
 * 実在 md を live に追加して返す（起点を含む拡張後 superset）。
 *
 * これをしないと `[label](x.md)` / `[[label]](x.md)` でしかリンクされていない md が
 * 「どの .out node.pageId にも outline.note structure にも登録されていない」ため orphan-md 誤検出され、
 * Clean Unused Files で破壊的に削除される（本 sprint のバグ）。
 *
 * - 循環検出: visited set（add-before-enqueue）で A↔B も必ず終了する。
 * - note root 外リンク（`../other/x.md`）は safeResolveUnderDir が null → live 化しない（過剰保護しない）。
 * - 誰からもリンクされない md は BFS で到達しない → 従来どおり orphan（過剰保護しない）。
 */
export async function buildMdLinkClosureLive(
    liveMdPass1: Set<string>,
    mainFolderPath: string
): Promise<Set<string>> {
    const live = new Set<string>(liveMdPass1);
    const visited = new Set<string>();
    const queue: string[] = [];

    // 起点: Pass1-live な md を visited 登録 + enqueue（存在しない候補パスは read で弾かれる）
    for (const p of liveMdPass1) {
        if (!visited.has(p)) {
            visited.add(p);
            queue.push(p);
        }
    }

    while (queue.length > 0) {
        const mdPath = queue.shift() as string;
        let content: string;
        try {
            content = fs.readFileSync(mdPath, 'utf8');
        } catch {
            continue; // 実体が無い（例: legacy _notes_md 候補）→ 辿るものが無い
        }
        const mdDir = path.dirname(mdPath);
        for (const rel of extractMdLinkTargets(content)) {
            const abs = safeResolveUnderDir(mdDir, rel);
            if (!abs) { continue; }                          // note root 外 → 守らない
            const lower = abs.toLowerCase();
            if (!(lower.endsWith('.md') || lower.endsWith('.markdown'))) { continue; }
            let isFile = false;
            try { isFile = fs.statSync(abs).isFile(); } catch { isFile = false; }
            if (!isFile) { continue; }                       // 実在 md ファイルのみ
            live.add(abs);
            if (!visited.has(abs)) {                         // 未訪問だけ enqueue（循環でも終了）
                visited.add(abs);
                queue.push(abs);
            }
        }
    }

    return live;
}

/**
 * CleanupCandidate — vscode 依存なしの候補型
 */
export interface CleanupCandidateCore {
    absPath: string;
    relPath: string;
    type: 'orphan-md' | 'orphan-image' | 'orphan-file';
    sizeBytes: number;
}

/**
 * 1 note の orphan 候補を返す (vscode 依存なし、unit テスト対象)
 */
export async function scanSingleNoteCore(mainFolderPath: string): Promise<CleanupCandidateCore[]> {
    const outFiles = await listOutFiles(mainFolderPath);
    const { liveMd: liveMd0, liveImages: initialLiveImages, liveFiles: initialLiveFiles } = await buildLiveSetPass1(outFiles, mainFolderPath);

    // FR-TF-07: outline.note に登録された tree 添付ファイル（ext==='file'）を live 化する。
    // node/md から未参照でも tree 登録されていれば生存扱い（addNotesMdToLiveSet の file 版）。
    // Pass2 は initialLiveFiles を copy して起点にするため、Pass2 の前に足せば最終 liveFiles に残る。
    const noteFilePath = path.join(mainFolderPath, 'outline.note');
    if (fs.existsSync(noteFilePath)) {
        try {
            const structure = JSON.parse(fs.readFileSync(noteFilePath, 'utf8'));
            addNotesFilesToLiveSet(structure, mainFolderPath, initialLiveFiles);
        } catch (e) {
            console.warn('[Fractal] Failed to parse outline.note for file live-set:', noteFilePath, e);
        }
    }

    // md→md リンク推移閉包で live を拡張してから Pass2 を回す。
    // 順序が load-bearing: Pass2（画像/添付）は liveMd を起点に md 本文を読むため、
    // 先に md-liveness を確定させないと、推移的に live 化した md の画像/添付が守られない（TC-CM-06）。
    const liveMd = await buildMdLinkClosureLive(liveMd0, mainFolderPath);

    const liveImages = await buildPass2LiveImages(liveMd, initialLiveImages, mainFolderPath);
    const liveFiles = await buildPass2LiveFiles(liveMd, initialLiveFiles, mainFolderPath);

    const allMd = await listAllMd(mainFolderPath);
    const orphanMd = allMd.filter(p => !liveMd.has(p));

    const allImages = await listAllImages(mainFolderPath);
    const orphanImages = allImages.filter(p => !liveImages.has(p));

    const allFiles = await listAllFiles(mainFolderPath);
    const orphanFiles = allFiles.filter(p => !liveFiles.has(p));

    const result: CleanupCandidateCore[] = [];
    for (const p of orphanMd) {
        try {
            result.push({
                absPath: p,
                relPath: path.relative(mainFolderPath, p),
                type: 'orphan-md',
                sizeBytes: fs.statSync(p).size
            });
        } catch { /* skip */ }
    }
    for (const p of orphanImages) {
        try {
            result.push({
                absPath: p,
                relPath: path.relative(mainFolderPath, p),
                type: 'orphan-image',
                sizeBytes: fs.statSync(p).size
            });
        } catch { /* skip */ }
    }
    for (const p of orphanFiles) {
        try {
            result.push({
                absPath: p,
                relPath: path.relative(mainFolderPath, p),
                type: 'orphan-file',
                sizeBytes: fs.statSync(p).size
            });
        } catch { /* skip */ }
    }
    return result;
}

/**
 * 複数 note を順にスキャンして、note ごとに grouping した候補 Map を返す。
 * vscode 依存なし、unit テスト対象 (FR-7 全 note モードのコア)
 */
export async function buildAllNotesCleanupGrouped(
    mainFolderPaths: string[]
): Promise<Map<string, CleanupCandidateCore[]>> {
    const result = new Map<string, CleanupCandidateCore[]>();
    for (const mainFolderPath of mainFolderPaths) {
        try {
            const candidates = await scanSingleNoteCore(mainFolderPath);
            if (candidates.length > 0) {
                result.set(mainFolderPath, candidates);
            }
        } catch (e) {
            console.warn(`[Fractal] Failed to scan ${mainFolderPath}:`, e);
        }
    }
    return result;
}
