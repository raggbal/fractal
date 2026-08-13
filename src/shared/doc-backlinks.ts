/**
 * doc-backlinks.ts — 添付ファイルの逆参照（参照元 md / outliner node）解決
 *
 * sprint 20260813-133248-search-doc-content / FR-DS-10 / ADRL-0061。
 *
 * - 照合は basename（collectSurvivingAssetRefs = notes-asset-mover.ts:52 の走査規則を踏襲:
 *   .out 全 node の images/filePath + md 本文の `](url)` リンク。cleanup の生存判定と同じ
 *   セマンティクスなので「cleanup が守るファイル = 逆参照が出るファイル」で一貫）。
 * - 検索を遅くしない（ユーザー明示）— 呼び出し側（notes-message-handler）が End 送出後に
 *   非同期で呼ぶ。mtime インデックスキャッシュで 2 回目以降ほぼ即時。
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface BacklinkRef {
    kind: 'node' | 'md';
    /** kind=node: 参照元 .out の fileId（basename から .out を除いた id） */
    outFileId?: string;
    nodeId?: string;
    /** kind=md: 参照元 md の絶対パス */
    mdPath?: string;
    /** 表示ラベル（node = "outタイトル > nodeテキスト先頭" / md = md 名） */
    label: string;
}

interface BacklinkIndex {
    /** インデックス生成時の走査対象（.out/.md）の mtime シグネチャ */
    signature: string;
    /** basename → 参照元一覧 */
    refs: Record<string, BacklinkRef[]>;
}

const LABEL_CLAMP = 60;

function clampLabel(s: string): string {
    const t = String(s || '').trim();
    return t.length > LABEL_CLAMP ? t.substring(0, LABEL_CLAMP) : t;
}

/** md 本文から画像/添付リンクの URL を抽出（notes-asset-mover extractMdLinkUrls の 1:1 転記） */
function extractMdLinkUrls(body: string): string[] {
    const urls: string[] = [];
    const re = /\]\(([^)\s]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { urls.push(m[1]); }
    return urls;
}

/** 参照文字列から basename を取り出す（refBasenames と同じスキップ規則） */
function refBasename(r: string): string | null {
    if (typeof r !== 'string' || !r) { return null; }
    if (/^(https?:|data:|file:)/i.test(r) || r.startsWith('/')) { return null; }
    return path.posix.basename(r.replace(/\\/g, '/'));
}

/** 走査対象（note 直下の .out/.md）の mtime シグネチャ — 1 つでも変わればインデックス無効 */
function computeSignature(mainFolderPath: string): string {
    const parts: string[] = [];
    let entries: string[] = [];
    try { entries = fs.readdirSync(mainFolderPath).sort(); } catch { return 'unreadable'; }
    for (const entry of entries) {
        if (!entry.endsWith('.out') && !entry.endsWith('.md')) { continue; }
        try {
            const st = fs.statSync(path.join(mainFolderPath, entry));
            parts.push(`${entry}:${st.mtimeMs}:${st.size}`);
        } catch { /* 消えた等は無視 */ }
    }
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 16);
}

/** note 全体を走査して basename → 参照元一覧のインデックスを作る（collectSurvivingAssetRefs 同型） */
function buildIndex(mainFolderPath: string): BacklinkIndex {
    const refs: Record<string, BacklinkRef[]> = {};
    const add = (basename: string | null, ref: BacklinkRef): void => {
        if (!basename) { return; }
        (refs[basename] = refs[basename] || []).push(ref);
    };

    let entries: string[] = [];
    try { entries = fs.readdirSync(mainFolderPath).sort(); } catch { /* empty */ }

    for (const entry of entries) {
        const full = path.join(mainFolderPath, entry);
        if (entry.endsWith('.out')) {
            try {
                const data = JSON.parse(fs.readFileSync(full, 'utf8'));
                const outFileId = entry.replace(/\.out$/, '');
                const outTitle = (data.title as string) || outFileId;
                const nodes = (data.nodes || {}) as Record<string, { text?: string; images?: unknown; filePath?: unknown }>;
                for (const [nodeId, n] of Object.entries(nodes)) {
                    const label = clampLabel(`${outTitle} › ${(n.text || '').split('\n')[0] || nodeId}`);
                    if (typeof n.filePath === 'string') {
                        add(refBasename(n.filePath), { kind: 'node', outFileId, nodeId, label });
                    }
                    if (Array.isArray(n.images)) {
                        for (const img of n.images as string[]) {
                            add(refBasename(img), { kind: 'node', outFileId, nodeId, label });
                        }
                    }
                }
            } catch { /* parse error は無視（collectSurvivingAssetRefs と同じ） */ }
        } else if (entry.endsWith('.md')) {
            try {
                const body = fs.readFileSync(full, 'utf8');
                const label = clampLabel(entry);
                for (const url of extractMdLinkUrls(body)) {
                    add(refBasename(url), { kind: 'md', mdPath: full, label });
                }
            } catch { /* 無視 */ }
        }
    }
    return { signature: computeSignature(mainFolderPath), refs };
}

export class DocBacklinksResolver {
    private cacheDir: string | null;
    private memo: BacklinkIndex | null = null;

    /** @param cacheDir インデックスの永続キャッシュ置き場（null = メモリのみ）。note フォルダ外であること */
    constructor(cacheDir: string | null) {
        this.cacheDir = cacheDir || null;
    }

    private cacheFilePath(mainFolderPath: string): string | null {
        if (!this.cacheDir) { return null; }
        const key = crypto.createHash('sha256').update(mainFolderPath).digest('hex').slice(0, 16);
        return path.join(this.cacheDir, `backlinks-${key}.json`);
    }

    /**
     * files/ 相対パス（fileId の `files/` prefix 除去前でも可）の一覧に対する逆参照を返す。
     * signature（.out/.md の mtime セット）一致ならキャッシュ・メモから即時。
     */
    resolve(mainFolderPath: string, fileRelPaths: string[]): Map<string, BacklinkRef[]> {
        const signature = computeSignature(mainFolderPath);
        let index = this.memo && this.memo.signature === signature ? this.memo : null;

        if (!index) {
            const cachePath = this.cacheFilePath(mainFolderPath);
            if (cachePath) {
                try {
                    const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as BacklinkIndex;
                    if (cached && cached.signature === signature && cached.refs) { index = cached; }
                } catch { /* miss */ }
            }
        }
        if (!index) {
            index = buildIndex(mainFolderPath);
            this.memo = index;
            const cachePath = this.cacheFilePath(mainFolderPath);
            if (cachePath) {
                try {
                    fs.mkdirSync(this.cacheDir as string, { recursive: true });
                    fs.writeFileSync(cachePath, JSON.stringify(index), 'utf8');
                } catch { /* best-effort */ }
            }
        } else {
            this.memo = index;
        }

        const result = new Map<string, BacklinkRef[]>();
        for (const rel of fileRelPaths) {
            const base = path.basename(rel.replace(/^files\//, ''));
            result.set(rel, index.refs[base] || []);
        }
        return result;
    }
}
