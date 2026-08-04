// md-subpage-utils — 外部 .md D&D の subpage 登録（FR-B07 / sprint 20260804-145603）の共有純関数。
//
// editorProvider（standalone md）と notesEditorProvider（Notes md）の両 host が
// 同一実装を import する（同名 local shadow を作らない）。
import * as fs from 'fs';
import * as path from 'path';
import { extractFirstH1 } from './md-h1-utils';
import { generateUniqueFileNamePreserving } from './paste-asset-handler';

/**
 * subpage リンクの表示タイトルを解決する。
 * 先頭 H1 → 無ければファイル名 stem。
 *
 * markdown-link-parser.js の subpage 分岐はラベル終端を最初の `]` で切る
 * （ラベルに `]` 単体を含められない）ため、`[` `]` は全て除去する。
 */
export function resolveSubpageTitle(content: string, fileName: string): string {
    const h1 = extractFirstH1(content || '');
    const stem = String(fileName || '').replace(/\.md$/i, '').replace(/^.*[\\/]/, '');
    const raw = (h1 && h1.trim()) ? h1.trim() : (stem || 'untitled');
    const safe = raw.replace(/[\[\]]/g, '').trim();
    return safe || 'untitled';
}

/** D&D されたファイル名が .md か（classifyDroppedFile は md を 'file' に落とすため別判定） */
export function isMdDropFileName(fileName: string): boolean {
    return /\.md$/i.test(String(fileName || ''));
}

/**
 * D&D された md を「対象 md と同じフォルダ」に一意名で保存し、subpage リンク情報を返す。
 *
 * 置き場を dirname(対象 md) にするのは本体のリンク解決（相対 .md href は
 * dirname(currentMd) 基準）と一致させるため（designer_failures 2026-07-26:
 * note ルート固定にすると legacy 配置 md からリンク切れ）。Notes は md ルート直下
 * flat・standalone は編集中 md の隣 = どちらも「同じフォルダ」で仕様どおり。
 *
 * @returns relPath = 対象 md からの相対パス（= ファイル名）・title = H1 or stem（[] 除去済み）
 */
export function saveDroppedMdAsSubpage(
    targetMdPath: string,
    content: string,
    fileName: string
): { relPath: string; title: string; fileName: string } {
    const dir = path.dirname(targetMdPath);
    fs.mkdirSync(dir, { recursive: true });
    const unique = generateUniqueFileNamePreserving(dir, path.basename(String(fileName || 'untitled.md')));
    const destPath = path.join(dir, unique);
    fs.writeFileSync(destPath, content, 'utf8');
    return {
        relPath: unique,
        title: resolveSubpageTitle(content, unique),
        fileName: unique,
    };
}

/** dataUrl（base64）を utf8 文字列にデコードする（D&D の FileReader 経路用） */
export function dataUrlToUtf8(dataUrl: string): string {
    const base64 = String(dataUrl || '').replace(/^data:[^;]*;base64,/, '');
    return Buffer.from(base64, 'base64').toString('utf8');
}
