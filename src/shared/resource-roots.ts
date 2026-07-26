/**
 * resource-roots — webview localResourceRoots のアクセス範囲を settings から解決する純関数群。
 *
 * vscode 非依存（os / path のみ）。test/unit/ で単体テスト可能。
 * FR-RR-02（パス解決）/ FR-RR-04（範囲外画像検知）。
 *
 * 雛形: aws-translate.ts resolveTerminologyPath（~展開）/ path-safety.ts safeResolveUnderDir（配下判定・相対専用）。
 * 配下判定は絶対 vs 絶対 なので safeResolveUnderDir を使わず isPathUnderAnyRoot を新設（ADRL-0001 D5）。
 */
import * as os from 'os';
import * as path from 'path';
import { extractAllAssetRefs } from './paste-asset-handler';

/**
 * settings の fractal.resourceRoots (string[]) を「許可する絶対パス群」に解決する。
 * - 先頭 `~` を homedir に展開（`~` 単独 / `~/foo` 両方）
 * - 展開後に絶対パスのものだけ採用（相対・空文字・空白のみは除外＝安全側）
 * - 空配列 or 解決結果 0 件なら [homedir]（デフォルトフォールバック＝後方互換）
 * @param rawRoots settings 生値
 * @param homeDir テスト注入用（省略時 os.homedir()）
 */
export function resolveResourceRoots(rawRoots: string[] | undefined, homeDir?: string): string[] {
    const home = homeDir ?? os.homedir();
    const out: string[] = [];
    for (const raw of (rawRoots || [])) {
        if (typeof raw !== 'string') continue;
        let p = raw.trim();
        if (!p) continue;
        if (p === '~') {
            p = home;
        } else if (p.startsWith('~/') || p.startsWith('~\\')) {
            p = path.join(home, p.slice(2));
        }
        if (!path.isAbsolute(p)) continue; // 相対は無視
        const norm = path.normalize(p);
        if (!out.includes(norm)) out.push(norm);
    }
    if (out.length === 0) return [path.normalize(home)];
    return out;
}

/**
 * 絶対パス absPath が roots のいずれかの配下（同一含む）かを判定。
 * safeResolveUnderDir は相対専用なので、絶対 vs 絶対 の判定はこちらを使う。
 * @returns true = 配下（許可範囲内）
 */
export function isPathUnderAnyRoot(absPath: string, roots: string[]): boolean {
    if (!absPath || !path.isAbsolute(absPath)) return false;
    const target = path.normalize(absPath);
    for (const root of roots) {
        if (!root) continue;
        const r = path.normalize(root);
        if (target === r) return true;
        const rel = path.relative(r, target);
        // rel が空=同一 / '..' で始まらず絶対でもない = 配下
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
    }
    return false;
}

/**
 * md 本文の画像参照のうち、許可範囲外のものを列挙する。
 * @param mdBody md テキスト
 * @param mdDir  md ファイルのあるディレクトリ（相対画像の解決基準・絶対）
 * @param roots  resolveResourceRoots の結果（絶対パス群）
 * @param homeDir テスト注入用（省略時 os.homedir()）
 * @returns 範囲外画像の絶対パス配列（空 = 全て範囲内）
 */
export function findOutOfRangeImages(
    mdBody: string,
    mdDir: string,
    roots: string[],
    homeDir?: string
): string[] {
    const home = homeDir ?? os.homedir();
    const refs = extractAllAssetRefs(mdBody).images; // 画像 url 文字列（raw）
    const out: string[] = [];
    for (const url of refs) {
        // http(s)/data URL は対象外（webview が直接読める）
        if (/^(https?:|data:)/i.test(url)) continue;
        let abs: string;
        if (path.isAbsolute(url)) {
            abs = path.normalize(url);
        } else if (url === '~') {
            abs = path.normalize(home);
        } else if (url.startsWith('~/') || url.startsWith('~\\')) {
            abs = path.normalize(path.join(home, url.slice(2)));
        } else {
            abs = path.resolve(mdDir, url);
        }
        if (!isPathUnderAnyRoot(abs, roots)) {
            if (!out.includes(abs)) out.push(abs);
        }
    }
    return out;
}
