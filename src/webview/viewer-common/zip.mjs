/**
 * viewer-common/zip.mjs — webview 内 zip リーダ（viewer-zip 基盤）
 *
 * 出自: src/shared/doc-text-extract.ts の ZIP layer（EOCD 逆走査 + 偽出現除外 / ZIP64 reject /
 * PK magic による保護ファイル早期検出）の写経移植（Buffer → Uint8Array/DataView・
 * inflateRawSync → DecompressionStream('deflate-raw')）。正典側は 1 バイトも変更しない（INV-1）。
 *
 * zip 三重ガード（ADRL-0094）:
 *  ① 宣言 uncompressedSize の事前検証（inflate 前に reject）
 *  ② 展開 reader ループの累積カウント打ち切り + cancel（DecompressionStream に上限オプションは仕様上存在しない）
 *  ③ openZip 単位の累積展開量 budget（複数エントリの総量増幅対策）
 */

export const MAX_ENTRY_UNCOMPRESSED = 100 * 1024 * 1024; // 既存正典と同値
export const MAX_TOTAL_UNCOMPRESSED = 300 * 1024 * 1024; // ③ 新設（ADRL-0094）

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CEN_SIG = 0x02014b50;  // PK\x01\x02
const LOC_SIG = 0x04034b50;  // PK\x03\x04

export class ViewerZipError extends Error {
    constructor(code, message) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}

function findEocd(view, len) {
    if (len < 22) { throw new ViewerZipError('NOT_ZIP', `file too small (${len} bytes)`); }
    const scanStart = len - Math.min(len, 22 + 65535);
    for (let i = len - 22; i >= scanStart; i--) {
        if (view.getUint32(i, true) !== EOCD_SIG) { continue; }
        const commentLen = view.getUint16(i + 20, true);
        if (i + 22 + commentLen !== len) { continue; } // 圧縮データ内の偽出現を除外
        return i;
    }
    throw new ViewerZipError('NOT_ZIP', 'EOCD not found (encrypted CFB container or non-zip file?)');
}

function readZipEntries(bytes, view) {
    if (bytes.length < 4 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) {
        // 例: パスワード保護 docx/xlsx は OLE/CFB (D0 CF 11 E0...) — ZIP ではない
        throw new ViewerZipError('NOT_ZIP', 'bad leading magic (password-protected or non-zip file?)');
    }
    const eocd = findEocd(view, bytes.length);
    const totalEntries = view.getUint16(eocd + 10, true);
    const cdSize = view.getUint32(eocd + 12, true);
    const cdOffset = view.getUint32(eocd + 16, true);
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new ViewerZipError('ZIP64_UNSUPPORTED', 'ZIP64 sentinel in EOCD — refusing to read garbage offsets');
    }
    if (cdOffset + cdSize > eocd) { throw new ViewerZipError('ZIP_CORRUPT', 'central directory extends past EOCD'); }
    const entries = new Map();
    const utf8 = new TextDecoder('utf-8');
    let p = cdOffset;
    for (let n = 0; n < totalEntries; n++) {
        if (view.getUint32(p, true) !== CEN_SIG) {
            throw new ViewerZipError('ZIP_CORRUPT', `bad central directory signature at offset ${p}`);
        }
        const method = view.getUint16(p + 10, true);
        const compressedSize = view.getUint32(p + 20, true);
        const uncompressedSize = view.getUint32(p + 24, true);
        const nameLen = view.getUint16(p + 28, true);
        const extraLen = view.getUint16(p + 30, true);
        const commentLen = view.getUint16(p + 32, true);
        const localOffset = view.getUint32(p + 42, true);
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new ViewerZipError('ZIP64_UNSUPPORTED', 'ZIP64 sentinel in central directory entry');
        }
        const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
        entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

/** raw deflate を reader ループで展開（累積 limit 超過で cancel + throw = ガード②/③） */
async function inflateRawLimited(raw, limit, limitCode) {
    const ds = new DecompressionStream('deflate-raw');
    const writer = ds.writable.getWriter();
    // write/close は read 側と並行に進める（backpressure デッドロック回避）。cancel 時の reject は握る。
    writer.write(raw).catch(() => { });
    writer.close().catch(() => { });
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (; ;) {
            const { done, value } = await reader.read();
            if (done) { break; }
            total += value.byteLength;
            if (total > limit) {
                await reader.cancel().catch(() => { });
                throw new ViewerZipError(limitCode || 'ENTRY_TOO_LARGE', `inflated size exceeded ${limit} bytes (forged declaration?)`);
            }
            chunks.push(value);
        }
    } catch (e) {
        if (e instanceof ViewerZipError) { throw e; }
        throw new ViewerZipError('ZIP_CORRUPT', `inflate failed: ${e && e.message ? e.message : e}`);
    }
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out;
}

/**
 * openZip(input: ArrayBuffer|Uint8Array, opts?) →
 *   { entries(): Map<name, {method, compressedSize, uncompressedSize}>, readEntry(name): Promise<Uint8Array> }
 * opts.maxEntryBytes / opts.maxTotalBytes はテスト注入用（既定 = 100MB / 300MB）。
 */
export async function openZip(input, opts) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const maxEntry = (opts && opts.maxEntryBytes !== undefined) ? opts.maxEntryBytes : MAX_ENTRY_UNCOMPRESSED;
    const maxTotal = (opts && opts.maxTotalBytes !== undefined) ? opts.maxTotalBytes : MAX_TOTAL_UNCOMPRESSED;
    const entries = readZipEntries(bytes, view);
    let budgetUsed = 0; // ガード③（openZip 単位の累積展開量）
    return {
        entries() { return entries; },
        async readEntry(name) {
            const entry = entries.get(name);
            if (!entry) { throw new ViewerZipError('ENTRY_NOT_FOUND', name); }
            if (budgetUsed >= maxTotal) {
                throw new ViewerZipError('ZIP_BUDGET_EXCEEDED', `cumulative inflated bytes exceeded ${maxTotal}`);
            }
            // ガード①: 宣言サイズの事前検証（inflate 前）
            if (entry.uncompressedSize > maxEntry) {
                throw new ViewerZipError('ENTRY_TOO_LARGE', `declared uncompressed size ${entry.uncompressedSize} exceeds limit`);
            }
            const { localOffset, method, compressedSize } = entry;
            if (view.getUint32(localOffset, true) !== LOC_SIG) {
                throw new ViewerZipError('ZIP_CORRUPT', `bad local header signature at offset ${localOffset}`);
            }
            // data 開始位置は local header 自身の nameLen/extraLen から計算（CD の extra 長流用は不可 — 正典と同じ）
            const nameLen = view.getUint16(localOffset + 26, true);
            const extraLen = view.getUint16(localOffset + 28, true);
            const dataStart = localOffset + 30 + nameLen + extraLen;
            const raw = bytes.subarray(dataStart, dataStart + compressedSize);
            let out;
            if (method === 8) {
                // エントリ単位の実効上限は「エントリ上限」と「budget 残」の小さい方（③を reader ループでも守る）
                const budgetLeft = maxTotal - budgetUsed;
                const effLimit = Math.min(maxEntry, budgetLeft);
                const limitCode = budgetLeft < maxEntry ? 'ZIP_BUDGET_EXCEEDED' : 'ENTRY_TOO_LARGE';
                out = await inflateRawLimited(raw, effLimit, limitCode);
                if (budgetUsed + out.byteLength > maxTotal) {
                    throw new ViewerZipError('ZIP_BUDGET_EXCEEDED', `cumulative inflated bytes exceeded ${maxTotal}`);
                }
            } else if (method === 0) {
                out = raw;
            } else {
                throw new ViewerZipError('UNSUPPORTED_COMPRESSION', `method ${method} (OPC allows deflate/stored only)`);
            }
            budgetUsed += out.byteLength;
            return out;
        },
    };
}
