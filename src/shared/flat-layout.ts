/**
 * flat-layout — Note フォルダ配下の共有フラットレイアウトのパス解決（純ロジック）
 *
 * decision 2026-07-07 (sprint 20260707-124018-notes-flat-storage):
 *   - md（ページ）は basedir 直下（<basedir>/<pageId>.md）
 *   - 画像/添付は共有サブフォルダ（<basedir>/images・<basedir>/files）
 *   - basedir = Single Outliner では .out と同階層、Notes では Note フォルダ（mainFolder）
 *
 * この 1 モジュールを OutlinerProvider / NotesEditorProvider / NotesFileManager /
 * cleanup-core / s3-sync が共通で呼ぶ（4-mode 片側非対称の再発防止 = HIGH-1）。
 *
 * fallback（新 wins）:
 *   pages: 新 <basedir> 直下 → legacy <basedir>/<basename>/ → legacy <basedir>/pages/
 *   images/files: 新 <basedir>/images → legacy <basedir>/<basename>/images → legacy <basedir>/images(bare)
 * legacy 判定は「新レイアウトの実在」で行う（新 md/dir があれば新、無ければ旧を読む）。
 */
import * as fs from 'fs';
import * as path from 'path';

/** .out の JSON ヘッダ（pageDir/imageDir/fileDir）だけ渡す薄い型 */
export interface OutDirHints {
    pageDir?: string;
    imageDir?: string;
    fileDir?: string;
}

function existsDir(p: string): boolean {
    try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
function existsAny(p: string): boolean {
    try { fs.statSync(p); return true; } catch { return false; }
}

/**
 * basedir を決める。
 * - outFilePath があれば dirname（Single Outliner の .out と同階層 / Notes の <mainFolder>/<name>.out → mainFolder）
 * - なければ mainFolder（純 Notes-md）
 */
function baseDir(outFilePath: string | null, mainFolder?: string): string {
    if (outFilePath) return path.dirname(outFilePath);
    if (mainFolder) return mainFolder;
    throw new Error('flat-layout: outFilePath か mainFolder のどちらかが必要');
}

/** JSON ヒントの相対/絶対 dir を basedir 基準で解決（あれば最優先） */
function resolveHint(hint: string | undefined, base: string): string | null {
    if (!hint) return null;
    if (path.isAbsolute(hint)) return hint;
    return path.resolve(base, hint);
}

/**
 * .out の pageDir ヒントがフラット規約（basedir 直下 = "." or "" or "./"）を示すかを判定する。
 * flat 判定の唯一の正典（migration / cleanup / s3-sync / path builder が共通で使う）。
 */
export function isFlatOut(pageDir: unknown): boolean {
    if (typeof pageDir !== 'string') return false;
    const norm = pageDir.replace(/^\.\//, '').replace(/\/+$/, '');
    return norm === '' || norm === '.';
}

/**
 * ページ md の置き場（ディレクトリ）を返す。decision: 新レイアウトは basedir 直下。
 */
export function resolvePagesDir(outFilePath: string | null, mainFolder?: string, hints?: OutDirHints): string {
    const base = baseDir(outFilePath, mainFolder);
    // TASK-12: flat ヒント（pageDir="."）は最優先。legacy dir が併存しても disk-scan 前に base を返す
    // （hint 無し flat + legacy 併存時の誤 fallback を防ぐ）。
    if (isFlatOut(hints?.pageDir)) return base;
    const hinted = resolveHint(hints?.pageDir, base);
    if (hinted) return hinted; // 明示的な非フラット pageDir（絶対/相対サブ）
    // 新 default = basedir 直下。legacy は <base>/<basename>/ か <base>/pages。
    if (outFilePath) {
        const stem = path.basename(outFilePath, '.out');
        const legacyByStem = path.join(base, stem);
        const legacyPages = path.join(base, 'pages');
        // 新レイアウト（basedir 直下）に .md が既にあるか、または legacy が無ければ新。
        const hasFlatMd = fs.existsSync(base) && fs.readdirSync(base).some(f => f.endsWith('.md'));
        if (!hasFlatMd && existsDir(legacyByStem) && hasMdIn(legacyByStem)) return legacyByStem;
        if (!hasFlatMd && existsDir(legacyPages) && hasMdIn(legacyPages)) return legacyPages;
    }
    return base;
}

function hasMdIn(dir: string): boolean {
    try { return fs.readdirSync(dir).some(f => f.endsWith('.md')); } catch { return false; }
}

/** ページ md のフルパス */
export function resolvePageFilePath(outFilePath: string | null, pageId: string, mainFolder?: string, hints?: OutDirHints): string {
    return path.join(resolvePagesDir(outFilePath, mainFolder, hints), `${pageId}.md`);
}

/** 画像 dir（共有サブフォルダ images/）。新 wins → legacy <basename>/images → legacy images(bare) */
export function resolveImagesDir(outFilePath: string | null, mainFolder?: string, hints?: OutDirHints): string {
    return resolveSharedSub(outFilePath, mainFolder, 'images', hints?.imageDir);
}

/** 添付 dir（共有サブフォルダ files/）。 */
export function resolveFilesDir(outFilePath: string | null, mainFolder?: string, hints?: OutDirHints): string {
    return resolveSharedSub(outFilePath, mainFolder, 'files', hints?.fileDir);
}

function resolveSharedSub(outFilePath: string | null, mainFolder: string | undefined, sub: string, hint: string | undefined): string {
    const base = baseDir(outFilePath, mainFolder);
    const hinted = resolveHint(hint, base);
    if (hinted) return hinted;
    const flat = path.join(base, sub); // 新 default = <base>/images|files
    if (existsDir(flat)) return flat;
    if (outFilePath) {
        const stem = path.basename(outFilePath, '.out');
        const legacyByStem = path.join(base, stem, sub);
        if (existsDir(legacyByStem)) return legacyByStem;
    }
    // legacy _notes_md/images（純 Notes-md 旧レイアウト）
    const legacyNotesMd = path.join(base, '_notes_md', sub);
    if (existsDir(legacyNotesMd)) return legacyNotesMd;
    return flat; // 新 default（未作成でもパスは返す）
}

// ── md 絶対パス起点の共有 sub 解決（sprint 20260713-000000-sidepanel-paste-note-context） ──
// sidepanel で開いた任意の md（別 note / 非 note どちらも）に対し、その md の画像/添付 dir を
// 「開いている md の場所を basedir とみなして」解決する。note 構造に依存しない。
// フラット規約: md は basedir 直下 → images/files は <basedir>/images|files（md 隣の共有サブ）。
//
// legacy 吸収の非対称（意図的・design §1）:
//   - resolveSharedSub（outFilePath 起点）は stem を知れるので `<base>/<stem>/images` fallback を持つが、
//     md 起点版は .out の stem を知り得ないため **stem legacy は非対応**（フラット化済み実データに非該当）。
//   - `_notes_md` レイアウト（md = <note>/_notes_md/*.md）は md 隣 <note>/_notes_md/images が共有先なので
//     新 default（dirname(md)/images）がそのまま正しい → 親遡上不要。
//   - `pages/` レイアウト（md = <note>/pages/*.md）だけは共有 images が親 <note>/images にあるため親遡上が要る。
function resolveSharedSubForMd(mdAbsPath: string, sub: string): string {
    const base = path.dirname(mdAbsPath);      // フラット: note 直下 / legacy: pages・_notes_md 配下
    const flat = path.join(base, sub);         // <base>/images|files（新 default）
    if (existsDir(flat)) return flat;
    // legacy 吸収: md が <note>/pages/*.md なら共有は親 <note>/images
    if (path.basename(base) === 'pages') {
        const legacyShared = path.join(path.dirname(base), sub);
        if (existsDir(legacyShared)) return legacyShared;
    }
    return flat; // 新 default（未作成でもパスは返す。呼び出し側が mkdir）
}

/** md 絶対パス起点で画像 dir を解決（sidepanel で開いた md の隣の共有 images/）。 */
export function resolveImagesDirForMd(mdAbsPath: string): string {
    return resolveSharedSubForMd(mdAbsPath, 'images');
}

/** md 絶対パス起点で添付 dir を解決（sidepanel で開いた md の隣の共有 files/）。 */
export function resolveFilesDirForMd(mdAbsPath: string): string {
    return resolveSharedSubForMd(mdAbsPath, 'files');
}

/** 移行後 .out に書き込む正規ヘッダ（basedir 直下 md + 共有 images/files） */
export const FLAT_OUT_HINTS: Required<OutDirHints> = {
    pageDir: '.',
    imageDir: './images',
    fileDir: './files',
};

// ── 純 Notes-md（.out を持たない md item）のフラット解決 ──
// 新: <mainFolder>/<id>.md + <mainFolder>/images + <mainFolder>/files
// legacy: <mainFolder>/_notes_md/<id>.md + _notes_md/images + _notes_md/files
export const LEGACY_MD_DIR = '_notes_md';

/** Notes-md のルート（md 置き場）: 新=mainFolder 直下。legacy _notes_md は resolveMdFilePath で個別判定。 */
export function resolveMdRootDir(mainFolder: string): string {
    return mainFolder;
}
export function resolveMdImagesDir(mainFolder: string): string {
    return resolveImagesDir(null, mainFolder);
}
export function resolveMdFilesDir(mainFolder: string): string {
    return resolveFilesDir(null, mainFolder);
}
/** md ファイルのフルパス（新 wins: 新が実在すれば新、無く legacy が実在すれば legacy、既定は新） */
export function resolveMdFilePath(mainFolder: string, id: string): string {
    const flat = path.join(mainFolder, `${id}.md`);
    if (existsAny(flat)) return flat;
    const legacy = path.join(mainFolder, LEGACY_MD_DIR, `${id}.md`);
    if (existsAny(legacy)) return legacy;
    return flat; // 新規は basedir 直下
}

/**
 * Note フォルダ配下の Notes-md id を列挙する（新: mainFolder 直下 *.md、legacy: _notes_md/*.md 両方）。
 * .out / .note / outline.note は md ではないので除外（拡張子 .md のみ、かつ outline.note は .note）。
 */
export function listNotesMdIds(mainFolder: string): Set<string> {
    const ids = new Set<string>();
    const collect = (dir: string) => {
        let entries: string[];
        try { entries = fs.readdirSync(dir); } catch { return; }
        for (const entry of entries) {
            if (!entry.endsWith('.md')) continue;
            const fp = path.join(dir, entry);
            try { if (!fs.statSync(fp).isFile()) continue; } catch { continue; }
            ids.add(entry.replace(/\.md$/, ''));
        }
    };
    collect(mainFolder);                                  // 新: 直下
    collect(path.join(mainFolder, LEGACY_MD_DIR));        // legacy: _notes_md/
    return ids;
}
