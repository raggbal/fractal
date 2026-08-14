/**
 * doc-extract-cache.ts — 添付抽出テキストのファイル単位キャッシュ
 *
 * sprint 20260813-133248-search-doc-content / FR-DS-04・FR-DS-08 / ADRL-0058。
 *
 * - cacheDir = null でキャッシュ無効（都度抽出）。NotesFileManager の vscode 非依存を保つため、
 *   globalStorageUri は notesEditorProvider が string で注入する（未注入 = null fallback）。
 * - キー = sha256(absPath) 先頭 16 桁（ファイル単位 — 1 添付の更新で他を invalidate しない）。
 * - ヒット判定 = mtimeMs + size の完全一致。
 * - skipReason も ExtractResult ごと truthy で保存する（falsy 記録は毎回再抽出になる —
 *   CLI getCachedOrParse の `&& entry.data` guard と同型の穴。FR-DS-08）。
 * - 50MB 超は読み込み・抽出の前に too_large を記録（FR-DS-07(d)、FR-TF-01 の precedent）。
 * - キャッシュ IO は best-effort（読み書きの失敗が検索を止めない）。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ExtractResult, extractDocText } from './doc-text-extract';

const MAX_FILE_SIZE = 50 * 1024 * 1024;

// FR-DS-09: ExtractResult の形式が変わったら bump（旧形式キャッシュを invalidate — TC-DS-55）
// v2: lines が string[] → ExtractedLine[]（{text, loc?}）
// v3（sprint 20260815 / FR-DS-04 rev.2）: unsupported_ext 廃止 + テキスト sniff 導入。
//    旧キャッシュの .txt/.html には unsupported_ext が truthy 記録済みで、mtime+size 不変な限り
//    永遠に skip され続ける（bump しないと「拡張したのに前に検索した .txt がヒットしない」silent bug）
const CACHE_FORMAT_VERSION = 3;

interface DocCacheEntry {
    formatVersion?: number;
    mtimeMs: number;
    size: number;
    result: ExtractResult;
}

export type ExtractFn = (buf: Buffer, ext: string) => Promise<ExtractResult>;

export class DocExtractCache {
    private cacheDir: string | null;
    private extract: ExtractFn;

    /**
     * @param cacheDir キャッシュ置き場（null = 無効・都度抽出）。note フォルダ外であること（NFR-DS-06）
     * @param extractFn テスト用の抽出関数差し替え口（省略時は正典 extractDocText）
     */
    constructor(cacheDir: string | null, extractFn?: ExtractFn) {
        this.cacheDir = cacheDir || null;
        this.extract = extractFn || ((buf, ext) => extractDocText(buf, ext));
    }

    private cacheFilePath(absPath: string): string | null {
        if (!this.cacheDir) { return null; }
        const key = crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 16);
        return path.join(this.cacheDir, `${key}.json`);
    }

    /**
     * 実体削除に連動してキャッシュエントリを消す（SEC-3: 削除済み添付の本文テキストを
     * globalStorage に残さない — ライフサイクル対称性）。best-effort（失敗は削除を止めない）。
     */
    evict(absPath: string): void {
        const cachePath = this.cacheFilePath(absPath);
        if (!cachePath) { return; }
        try { fs.rmSync(cachePath, { force: true }); } catch { /* best-effort */ }
    }

    async getOrExtract(absPath: string): Promise<ExtractResult> {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(absPath);
        } catch {
            return { lines: [], truncated: false, skipReason: 'extract_error' };
        }

        const cachePath = this.cacheFilePath(absPath);

        // ヒット判定（skipReason 込みのエントリもヒットさせる — 再抽出ループ防止）
        if (cachePath) {
            try {
                const entry = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as DocCacheEntry;
                if (entry && entry.result && entry.formatVersion === CACHE_FORMAT_VERSION
                    && entry.mtimeMs === stat.mtimeMs && entry.size === stat.size) {
                    return entry.result;
                }
            } catch { /* 壊れ・不在は miss 扱い */ }
        }

        // サイズ上限は読み込み前に判定（巨大ファイルを Buffer に載せない）
        let result: ExtractResult;
        if (stat.size > MAX_FILE_SIZE) {
            result = { lines: [], truncated: false, skipReason: 'too_large' };
        } else {
            let buf: Buffer;
            try {
                buf = fs.readFileSync(absPath);
            } catch {
                return { lines: [], truncated: false, skipReason: 'extract_error' };
            }
            result = await this.extract(buf, path.extname(absPath).toLowerCase());
        }

        // FR-DS-04 rev.2 / NFR-DS-08（ADRL-0063）: noCache（テキスト経路の成功結果）は書かない
        // — .env/.pem 等の秘密テキストの平文複製を構造的に回避。skip 結果（binary 等）は
        // lines が空でコンテンツを含まないため従来どおり書く（2 回目以降 stat のみ = NFR-DS-02）
        if (cachePath && !result.noCache) {
            try {
                fs.mkdirSync(this.cacheDir as string, { recursive: true });
                const entry: DocCacheEntry = { formatVersion: CACHE_FORMAT_VERSION, mtimeMs: stat.mtimeMs, size: stat.size, result };
                fs.writeFileSync(cachePath, JSON.stringify(entry), 'utf8');
            } catch { /* best-effort — キャッシュ書き込み失敗は検索を止めない */ }
        }
        return result;
    }
}
