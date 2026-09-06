/**
 * folder-export — outliner「Export folder」の名前正規化と出力計画
 * （DOM-FsNameSanitize / DOM-ExportTreePlan・FR-EXF-02/03/04/05）
 * Sprint 20260827-172802 第 2 ラウンド（ADRL-0104: node 木 = ディレクトリ木 / ADRL-0105: sanitize は
 * 新規 1 本・連番 uniquify は既存正典 generateUniqueFileNamePreserving に委ねる）。
 *
 * fs / vscode 非依存の部分（sanitizeFsName）は pure に保つ（unit で直 import するため）。
 */

import * as fs from 'fs';
import * as path from 'path';
import { handlePageAssets, handleFileAsset, generateUniqueFileNamePreserving } from './paste-asset-handler';

/** Windows の予約デバイス名（大小無視・拡張子を除いた base で判定） */
const WINDOWS_RESERVED = new Set([
    'con', 'prn', 'aux', 'nul',
    'com1', 'com2', 'com3', 'com4', 'com5', 'com6', 'com7', 'com8', 'com9',
    'lpt1', 'lpt2', 'lpt3', 'lpt4', 'lpt5', 'lpt6', 'lpt7', 'lpt8', 'lpt9',
]);

/**
 * node text が空のときの既定名（ユーザー裁定 2026-08-30 確定）: **文字列 `blank`** を使う。
 * 旧 `'export'`（発明語）は廃止。連番は **同名が衝突したときだけ** 付ける
 * （`blank` → `blank-1` → `blank-2`。衝突解決は既存正典 generateUniqueFileNamePreserving に委ねる）。
 */
const DEFAULT_NAME = 'blank';

/** UTF-8 の最大ファイル名長（NAME_MAX） */
const MAX_NAME_BYTES = 255;

/**
 * 不可視の書式文字（幅ゼロで描画されず、ファイル名に入ると「名前が無い」ように見える）。
 * U+00AD soft hyphen / U+200B-200F zero-width 群 / U+2028-202E 行・段落区切り + 双方向制御 /
 * U+2060-2064 word joiner 群 / U+FEFF BOM。
 */
const INVISIBLE_FORMAT_CHARS = /[\u00AD\u200B-\u200F\u2028-\u202E\u2060-\u2064\uFEFF]/g;

/** 末尾のドット・空白（Unicode 空白 `\s` = NBSP / 全角空白 / U+2000-200A を含む） */
const TRAILING_DOT_SPACE = /[\s.]+$/;

/** grapheme 単位に分割（結合文字・サロゲートペアを壊さないため。Intl.Segmenter 不在時は code point 単位） */
function splitGraphemes(text: string): string[] {
    const seg = (Intl as any)?.Segmenter;
    if (typeof seg === 'function') {
        try {
            return Array.from(new seg('und', { granularity: 'grapheme' }).segment(text) as Iterable<{ segment: string }>)
                .map((s) => s.segment);
        } catch { /* fall through */ }
    }
    return Array.from(text); // code point 単位（サロゲートペアは保たれる）
}

/**
 * node text → FS 安全な 1 パス構成要素（FR-EXF-04 / design §C3）。
 *
 * 適用順（この順序が仕様 — TC-EXF-04 / TC-EXF-04b が pin する）:
 *   0. 不可視の書式文字（ZWSP / BOM / soft hyphen 等）を除去（2026-09-04 実機の「-1」名バグ）
 *   1. `/ \ : * ? " < > |` と制御文字（\x00-\x1f）→ `_`
 *   2. 末尾の `.` と空白（Unicode 空白 = NBSP / 全角空白を含む）を除去
 *   3. 空 / `.` / `..` になったら DEFAULT_NAME
 *   4. Windows 予約名（拡張子を除いた base・大小無視）なら先頭に `_`
 *   5. UTF-8 で (255 - reserveBytes) バイトへクランプ（grapheme 境界を壊さない）
 *
 * @param opts.reserveBytes 呼び出し側が後で付ける拡張子等のバイト数（'.md' なら 3）。
 *        クランプはこの分を空けて行う（§C3-b: クランプの実施点はこの関数だけ）。
 */
export function sanitizeFsName(text: string, opts?: { reserveBytes?: number }): string {
    // 0. 不可視の書式文字（ZWSP / ZWNJ / ZWJ / BOM / word joiner / soft hyphen 等）を落とす。
    //    2026-09-04 実機: node text が U+3000（全角空白）や U+200B だけの「見た目は空」の node を
    //    「linkedfd に送る」と、不可視文字 1 文字の名前が作られ、2 件目が `<不可視>-1` = 「-1」と
    //    見える名前になった（TC-EXF-04b）。既定名 `blank` の判定は**見た目の空**で行う。
    let name = String(text ?? '').replace(INVISIBLE_FORMAT_CHARS, '');

    // 1. 禁止文字・制御文字
    /* eslint-disable-next-line no-control-regex */
    name = name.replace(/[/\\:*?"<>|\x00-\x1f]/g, '_');

    // 2. 末尾のドット・空白（Windows は末尾ドット/空白のファイルを作れない）。
    //    空白は Unicode 空白全般（NBSP U+00A0 / 全角空白 U+3000 / U+2000-200A 等 = `\s`）を含める
    name = name.replace(TRAILING_DOT_SPACE, '');

    // 3. 空・`.`・`..`（2 で消えて空になるケースを含む）→ 既定名 `blank`
    if (name === '.' || name === '..') { name = ''; }
    if (name === '') { return DEFAULT_NAME; }

    // 4. 予約名は先頭 `_` を前置（判定は拡張子を除いた base・前置は全体に対して）
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name;
    if (WINDOWS_RESERVED.has(base.toLowerCase())) { name = `_${name}`; }

    // 5. UTF-8 バイト長でクランプ（grapheme 境界を保つ）
    const limit = Math.max(1, MAX_NAME_BYTES - Math.max(0, opts?.reserveBytes ?? 0));
    if (Buffer.byteLength(name, 'utf8') > limit) {
        let out = '';
        let bytes = 0;
        for (const g of splitGraphemes(name)) {
            const b = Buffer.byteLength(g, 'utf8');
            if (bytes + b > limit) { break; }
            out += g;
            bytes += b;
        }
        // クランプで末尾ドット/空白が露出することがあるので 2 を再適用（3 の再判定も行う）
        out = out.replace(TRAILING_DOT_SPACE, '');
        name = out || DEFAULT_NAME;   // クランプで全部落ちたら既定名
    }

    return name;
}

// ────────────────────────────────────────────
// DOM-ExportTreePlan / DOM-ExportAssetDelegation（FR-EXF-02/03/05・design §C2/§C4）
// ────────────────────────────────────────────

/** webview から渡る subtree の 1 node（DOM-ExportPayload。children を持つ再帰形） */
export interface ExportNode {
    id?: string;
    text: string;
    subtext?: string;
    pageId?: string | null;
    filePath?: string | null;
    images?: string[];
    children?: ExportNode[];
}

export interface FolderExportDeps {
    /** showOpenDialog（フォルダのみ・単一・openLabel:'Export here'）。undefined = キャンセル */
    pickDestination(): Promise<string | undefined> | string | undefined;
    /** 総エントリ数 > 閾値 の確認 modal。false = 出力しない */
    confirmLarge(totalCount: number): Promise<boolean> | boolean;
    /** 完了通知（exportFolderDone に件数を差し込む） */
    notifyDone(folders: number, files: number, skipped: number): void;
    srcOutDir: string;
    srcPagesDir: string;
    srcFileDir: string;
    srcImageDir: string;
    /** 既定は既存正典。unit が spy を差すために注入可（新規コピー経路は書かない — ADRL-0105） */
    exportMd?: typeof handlePageAssets;
    exportFile?: typeof handleFileAsset;
    limits?: { confirmThreshold?: number };
}

export interface FolderExportOutcome {
    status: 'cancelled' | 'declined' | 'exported';
    destRoot?: string;
    folders: number;
    files: number;
    skipped: number;
}

/** 200 超で確認 modal（Import 側 FOLDER_IMPORT_CONFIRM_THRESHOLD と同じ閾値系譜） */
export const FOLDER_EXPORT_CONFIRM_THRESHOLD = 200;

const hasChildren = (n: ExportNode): boolean => Array.isArray(n.children) && n.children.length > 0;

/** その node が生む「エントリ数」（フォルダ 1 or ファイル 1）+ 子孫の合計 */
function countEntries(nodes: ExportNode[]): number {
    let n = 0;
    for (const node of nodes) {
        n += 1;
        if (hasChildren(node)) { n += countEntries(node.children as ExportNode[]); }
    }
    return n;
}

/**
 * node 木を出力先のディレクトリ木として書き出す（FR-EXF-02・ADRL-0104）。
 *
 * - 名前は sanitizeFsName(node text)。連番は既存 generateUniqueFileNamePreserving + dir ごとの
 *   usedNames Set の 2 重判定（§C3-a: existsSync だけでは「まだ書いていない兄弟」と衝突を検出できない）
 * - 資産は既存正典へ委譲（§C4）。新規のコピー・衝突解決ロジックは書かない
 * - 個別失敗は skip して続行し console.warn（silent 握り禁止）。dir 作成失敗は subtree ごと skip
 */
export async function runFolderExport(tree: ExportNode[], deps: FolderExportDeps): Promise<FolderExportOutcome> {
    const destRoot = await deps.pickDestination();
    if (!destRoot) { return { status: 'cancelled', folders: 0, files: 0, skipped: 0 }; }

    const total = countEntries(tree);
    const threshold = deps.limits?.confirmThreshold ?? FOLDER_EXPORT_CONFIRM_THRESHOLD;
    if (total > threshold && !(await deps.confirmLarge(total))) {
        return { status: 'declined', folders: 0, files: 0, skipped: 0 };
    }

    const exportMd = deps.exportMd ?? handlePageAssets;
    const exportFile = deps.exportFile ?? handleFileAsset;
    let folders = 0, files = 0, skipped = 0;

    const warn = (what: string, target: string, reason: unknown): void => {
        console.warn(`[Outliner] folder export: ${what} skipped:`, target, reason);
    };

    /**
     * dir 内で一意な名前を確定して予約する（§C3-a の順序契約: usedNames ∪ existsSync）。
     *
     * 書き込みは walk 順で即時に行うため、成功パスでは existsSync だけでも足りる。
     * usedNames が load-bearing なのは**書き込みが失敗した名前**（実体が無いので existsSync では
     * 見えない）で、予約を残すことで「同名の別 node が同じ名前を取り、skip 件数と出力物の対応が
     * 追えなくなる」ことを防ぐ（TC-EXF-11 の失敗ケースが番人）。
     */
    const reserveName = (dir: string, used: Set<string>, desired: string): string => {
        let name = generateUniqueFileNamePreserving(dir, desired);
        while (used.has(name.toLowerCase())) {
            // existsSync では見えない「まだ書いていない兄弟」との衝突を解消する
            const ext = path.extname(name);
            const base = path.basename(name, ext);
            const m = /^(.*)-(\d+)$/.exec(base);
            const next = m ? `${m[1]}-${Number(m[2]) + 1}${ext}` : `${base}-1${ext}`;
            name = generateUniqueFileNamePreserving(dir, next);
        }
        used.add(name.toLowerCase());
        return name;
    };

    /**
     * node text に拡張子を足して出力ファイル名を作る（二重拡張子を作らない）。
     *
     * Import folder は file 添付 node の text を**拡張子込みのファイル名**にするため（§A4）、素朴に
     * `${text}${ext}` とすると `report.pdf.pdf` / `guide.md.md` になる（2026-08-29 実機の手動テストで確認）。
     * text が既に同じ拡張子（大小無視）で終わっているならそのまま使う。
     */
    const composeName = (text: string, ext: string): string => {
        const lower = ext.toLowerCase();
        const already = lower !== '' && path.extname(text).toLowerCase() === lower;
        const base = sanitizeFsName(text, { reserveBytes: already ? 0 : Buffer.byteLength(ext, 'utf8') });
        return path.extname(base).toLowerCase() === lower ? base : `${base}${ext}`;
    };

    /** md 添付を出力（handlePageAssets へ委譲）。失敗は skipped++ + warn で縮退（兄弟 writer と同じ void 契約） */
    const writeMd = (node: ExportNode, dir: string, baseName: string): void => {
        try {
            const res = exportMd({
                srcOutDir: deps.srcOutDir,
                srcPagesDir: deps.srcPagesDir,
                destOutDir: dir,
                destPagesDir: dir,
                pageId: String(node.pageId),
                newPageId: baseName,          // 非 null 必須（null は cut 意味論 — §C4）
                nodeImages: node.images || [],
            });
            const mdAbs = path.join(dir, `${baseName}.md`);
            if (!fs.existsSync(mdAbs)) { skipped++; warn('md', mdAbs, 'page md not produced'); return; }
            files++;
            // 直付き画像のリンクを md 末尾へ追記（§C2-a: md 添付ありの node）
            const newImgs = res.newNodeImages || [];   // PasteAssetResult.newNodeImages は必須フィールド
            if (newImgs.length > 0) {
                const lines = newImgs.map((rel: string) => `![](${String(rel).split(path.sep).join('/')})`);
                fs.appendFileSync(mdAbs, `\n${lines.join('\n')}\n`, 'utf8');
            }
        } catch (e) { skipped++; warn('md', `${dir}/${baseName}.md`, e); }
    };

    /** file 添付を出力（handleFileAsset へ委譲・dest 名は composeName 済みの確定名） */
    const writeFile = (node: ExportNode, dir: string, destName: string): void => {
        try {
            const res = exportFile({
                srcOutDir: deps.srcOutDir,
                srcFileDir: deps.srcFileDir,
                destOutDir: dir,
                destFileDir: dir,
                filePath: String(node.filePath),
                useCollisionSuffix: true,
                destName,
            });
            if (!res || !res.newFilePath) { skipped++; warn('file', String(node.filePath), 'copy failed'); return; }
            files++;
        } catch (e) { skipped++; warn('file', String(node.filePath), e); }
    };

    /** 直付き画像のみの node: images/ へ実体を出し、<name>.md にリンクを書く（§C2-a） */
    const writeImagesOnly = (node: ExportNode, dir: string, baseName: string): void => {
        const imagesDir = path.join(dir, 'images');
        const rels: string[] = [];
        for (const img of node.images || []) {
            try {
                const res = exportFile({
                    srcOutDir: deps.srcOutDir,
                    srcFileDir: deps.srcImageDir,
                    destOutDir: dir,
                    destFileDir: imagesDir,
                    filePath: img,
                    useCollisionSuffix: true,
                });
                if (res && res.newFilePath) {
                    rels.push(String(res.newFilePath).split(path.sep).join('/'));
                    files++;
                } else { skipped++; warn('image', img, 'copy failed'); }
            } catch (e) { skipped++; warn('image', img, e); }
        }
        const mdAbs = path.join(dir, `${baseName}.md`);
        const body = `# ${node.text || ''}\n\n${rels.map((r) => `![](${r})`).join('\n')}\n`;
        try { fs.writeFileSync(mdAbs, body, 'utf8'); files++; }
        catch (e) { skipped++; warn('md', mdAbs, e); }
    };

    /** 添付なし・画像なしの node: <name>.md に text + subtext を書く（§C2-a） */
    const writeTextMd = (node: ExportNode, dir: string, baseName: string): void => {
        const mdAbs = path.join(dir, `${baseName}.md`);
        const sub = (node.subtext || '').trim();
        const body = `# ${node.text || ''}\n${sub ? `\n${sub}\n` : ''}`;
        try { fs.writeFileSync(mdAbs, body, 'utf8'); files++; }
        catch (e) { skipped++; warn('md', mdAbs, e); }
    };

    const exportInto = (dir: string, used: Set<string>, nodes: ExportNode[]): void => {
        for (const node of nodes) {
            const hasMd = !!node.pageId;
            const hasFile = !!node.filePath;
            const imgs = node.images || [];

            if (hasChildren(node)) {
                // 子あり → フォルダ。自身の添付はそのフォルダ直下へ
                const dirName = reserveName(dir, used, sanitizeFsName(node.text));
                const childDir = path.join(dir, dirName);
                try { fs.mkdirSync(childDir, { recursive: true }); }
                catch (e) {
                    // dir が作れない（パス長超過等）→ subtree ごと skip（1 + 配下のエントリ数）
                    skipped += 1 + countEntries(node.children as ExportNode[]);
                    warn('directory', childDir, e);
                    continue;
                }
                folders++;
                // 自身の添付もこの dir の usedNames に予約する（子 node と同名でも衝突しない）
                const childUsed = new Set<string>();
                if (hasMd) {
                    const name = reserveName(childDir, childUsed, composeName(node.text, '.md'));
                    writeMd(node, childDir, path.basename(name, '.md'));
                }
                if (hasFile) {
                    const ext = path.extname(String(node.filePath));
                    writeFile(node, childDir, reserveName(childDir, childUsed, composeName(node.text, ext)));
                }
                // 直付き画像: md 添付が無いなら（file 添付の有無に関わらず）images/ + 画像 md を出す
                // 〔reviewer iter4 DESIGN-1: 旧実装は file 添付と併存すると子なし側で画像が無音欠落した〕
                if (!hasMd && imgs.length > 0) {
                    const name = reserveName(childDir, childUsed, composeName(node.text, '.md'));
                    writeImagesOnly(node, childDir, path.basename(name, '.md'));
                }
                exportInto(childDir, childUsed, node.children as ExportNode[]);
                continue;
            }

            // 子なし → 親 dir 直下にファイルとして出す
            if (hasMd) {
                const name = reserveName(dir, used, composeName(node.text, '.md'));
                writeMd(node, dir, path.basename(name, '.md'));
            }
            if (hasFile) {
                const ext = path.extname(String(node.filePath));
                writeFile(node, dir, reserveName(dir, used, composeName(node.text, ext)));
            }
            // md 添付が無い node の直付き画像は file 添付と併存しても出す（DESIGN-1 の修正）。
            // 添付も画像も無ければ text + subtext の md を作る。
            if (!hasMd && imgs.length > 0) {
                const name = reserveName(dir, used, composeName(node.text, '.md'));
                writeImagesOnly(node, dir, path.basename(name, '.md'));
            } else if (!hasMd && !hasFile) {
                const name = reserveName(dir, used, composeName(node.text, '.md'));
                writeTextMd(node, dir, path.basename(name, '.md'));
            }
        }
    };

    exportInto(destRoot, new Set<string>(), tree);
    deps.notifyDone(folders, files, skipped);
    return { status: 'exported', destRoot, folders, files, skipped };
}
