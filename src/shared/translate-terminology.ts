/**
 * translate-terminology.ts — 用語集（Amazon Translate の Custom Terminology）の設定 fractal.translateTerminology（ADRL-0141）
 *
 * 設定は 1 つ: CSV / TMX のファイル（絶対・~・ワークスペースからの相対）か、Amazon Translate に登録済みの用語集の名前。
 * - 名前の形（英数字・-・_）なら名前として翻訳に使う。
 * - それ以外はファイル。「Fractal: Update Translate Terminology」でファイル名から作った名前でアップロードし、翻訳にもその名前を使う。
 * vscode 非依存。
 */
import * as os from 'os';
import * as path from 'path';

/** Amazon Translate の用語集の名前の形（ImportTerminology の Name） */
export const TERMINOLOGY_NAME_RE = /^([A-Za-z0-9-]_?)+$/;
const TERMINOLOGY_NAME_MAX = 256;

export interface TerminologySetting {
    /** 翻訳に使う名前（無ければ用語集を使わない） */
    name?: string;
    /** アップロードするファイルの絶対パス（設定がファイルのとき） */
    filePath?: string;
}

/** ファイルのパス（絶対 / ~ / 相対）を絶対パスに。相対はワークスペース（無ければ cwd）から */
export function resolveTerminologyPath(rawPath: string, workspaceRoot?: string): string {
    if (!rawPath) {
        return '';
    }
    let p = rawPath.trim();
    if (p.startsWith('~')) {
        p = path.join(os.homedir(), p.slice(1));
    }
    if (path.isAbsolute(p)) {
        return p;
    }
    return path.resolve(workspaceRoot || process.cwd(), p);
}

/** ファイル名（拡張子を除く）から用語集の名前を作る: 使えない文字は -、_ は続けない・先頭に置かない、空なら fractal-terminology */
export function terminologyNameFromFile(filePath: string): string {
    const base = path.basename(filePath, path.extname(filePath));
    const name = base
        .replace(/[^A-Za-z0-9_-]+/g, '-')
        .replace(/_+/g, '_')
        .replace(/^_+/, '')
        .replace(/^-+|-+$/g, '')
        .slice(0, TERMINOLOGY_NAME_MAX);
    return name && TERMINOLOGY_NAME_RE.test(name) ? name : 'fractal-terminology';
}

/** 設定 fractal.translateTerminology の値を、翻訳に使う名前とアップロードするファイルに分ける */
export function parseTerminologySetting(value: unknown, workspaceRoot?: string): TerminologySetting {
    const v = typeof value === 'string' ? value.trim() : '';
    if (!v) {
        return {};
    }
    if (TERMINOLOGY_NAME_RE.test(v) && v.length <= TERMINOLOGY_NAME_MAX) {
        return { name: v };
    }
    const filePath = resolveTerminologyPath(v, workspaceRoot);
    return { name: terminologyNameFromFile(filePath), filePath };
}
