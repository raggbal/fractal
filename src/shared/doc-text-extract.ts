/**
 * doc-text-extract.ts — 添付ファイル（PDF/docx/xlsx/pptx）中身検索のテキスト抽出正典
 *
 * sprint 20260813-133248-search-doc-content / FR-DS-02(OOXML)・FR-DS-03(PDF)・FR-DS-07(正規化)・FR-DS-08(skip)。
 * design/system.md §1 / ADRL-0057・0059。
 *
 * - vscode / fs 非依存の pure 関数（入力 = Buffer）。キャッシュ・パス解決は呼び出し側の責務。
 * - OOXML 部は poc 実証コード（.harness/poc/20260813-094552-docsearch-pdf-ooxml/v1/bh-03/ooxml-extract.mjs）
 *   の分岐 1:1 転記。CLI ミラー = ai_skills/fractal-search/scripts/ooxml-extract.mjs（ADRL-0059 —
 *   ここを変更したらミラーにも転記し、一致 TC（TC-DS-26）で同期を確認すること）。
 * - PDF は pdfjs-dist@4.10.38（exact pin）を関数内遅延 require。モジュールスコープに pdfjs 参照を
 *   置かない（Electron が out/shared を生 CJS require するため — 失敗時は pdf_unavailable に縮退）。
 * - 抽出不能は必ず truthy skipReason（silent 空文字の禁止 — FR-DS-08）。
 */

import { inflateRawSync } from 'zlib';

// ── 型（design/system.md §1） ──────────────────────────────────────────────

export type SkipReason = 'encrypted_or_not_zip' | 'too_large' | 'pdf_unavailable'
                       | 'pdf_no_text' | 'unsupported_ext' | 'extract_error';

/** FR-DS-09: 位置メタ付き抽出行。loc は表示用文字列（`p.5` / `slide 3` / `売上集計!B12`）— ADRL-0060 */
export interface ExtractedLine {
    text: string;           // 正規化済み（NFKC + 行 200 字 clamp）
    loc?: string;           // PDF=ページ / pptx=スライド / xlsx=シート名!セル。docx は無し（ユーザー裁定）
}

export interface ExtractResult {
    lines: ExtractedLine[]; // 全体 1MB 打ち切り
    truncated: boolean;     // 1MB 打ち切りが起きたか
    skipReason?: SkipReason; // 設定時 lines=[]（truthy record 用）
}

export interface ExtractOpts {
    /** テスト専用: pdfjs ローダ注入（throw で pdf_unavailable を決定的に踏む） */
    pdfjsLoader?: () => Promise<unknown>;
}

export const CONTENT_SEARCH_EXTS = ['.pdf', '.docx', '.xlsx', '.pptx'];

const LINE_CLAMP = 200;                 // SearchMatch.lineText の webview 表示契約（既存 md 検索と同形）
const TOTAL_CLAMP = 1024 * 1024;        // 抽出テキスト上限 1MB（FR-DS-07(c)）

// ── 正規化（FR-DS-07 — extension と CLI ミラーで同一実装にすること） ─────────

export function normalizeExtracted(text: string): { lines: string[]; truncated: boolean } {
    // NFKC: 康熙部首 → 統合漢字（macOS Hiragino 生成 PDF の U+2F00 系対策 — poc 申し送り）
    const normalized = text.normalize('NFKC');
    const lines: string[] = [];
    let total = 0;
    let truncated = false;
    for (const rawLine of normalized.split('\n')) {
        const line = rawLine.length > LINE_CLAMP ? rawLine.substring(0, LINE_CLAMP) : rawLine;
        if (line.length === 0) { continue; }
        if (total + line.length > TOTAL_CLAMP) { truncated = true; break; }
        lines.push(line);
        total += line.length + 1;
    }
    return { lines, truncated };
}

// FR-DS-09: セグメント（ページ/スライド/セル）単位で正規化しながら loc 付きで積む。
// budget（1MB）はファイル全体で共有（state 経由）— normalizeExtracted と同じ clamp 規則
interface NormState { total: number; truncated: boolean; }

function pushNormalized(out: ExtractedLine[], state: NormState, text: string, loc?: string): void {
    if (state.truncated) { return; }
    const normalized = text.normalize('NFKC');
    for (const rawLine of normalized.split('\n')) {
        const line = rawLine.length > LINE_CLAMP ? rawLine.substring(0, LINE_CLAMP) : rawLine;
        if (line.length === 0) { continue; }
        if (state.total + line.length > TOTAL_CLAMP) { state.truncated = true; return; }
        out.push(loc ? { text: line, loc } : { text: line });
        state.total += line.length + 1;
    }
}

const skip = (reason: SkipReason): ExtractResult => ({ lines: [], truncated: false, skipReason: reason });

// ── ZIP layer（poc ooxml-extract.mjs 1:1 転記） ────────────────────────────

class OoxmlError extends Error {
    code: string;
    constructor(code: string, message: string) {
        super(`${code}: ${message}`);
        this.code = code;
    }
}

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CEN_SIG = 0x02014b50;  // PK\x01\x02
const LOC_SIG = 0x04034b50;  // PK\x03\x04

interface ZipEntry { method: number; compressedSize: number; uncompressedSize: number; localOffset: number; }

function findEocd(buf: Buffer): number {
    if (buf.length < 22) { throw new OoxmlError('NOT_ZIP', `file too small (${buf.length} bytes)`); }
    const scanStart = buf.length - Math.min(buf.length, 22 + 65535);
    for (let i = buf.length - 22; i >= scanStart; i--) {
        if (buf.readUInt32LE(i) !== EOCD_SIG) { continue; }
        const commentLen = buf.readUInt16LE(i + 20);
        if (i + 22 + commentLen !== buf.length) { continue; } // 圧縮データ内の偽出現を除外
        return i;
    }
    throw new OoxmlError('NOT_ZIP', 'EOCD not found (encrypted CFB container or non-zip file?)');
}

function readZipEntries(buf: Buffer): Map<string, ZipEntry> {
    if (buf.length < 4 || buf[0] !== 0x50 || buf[1] !== 0x4b) {
        // 例: パスワード保護 docx/xlsx は OLE/CFB (D0 CF 11 E0...) — ZIP ではない
        throw new OoxmlError('NOT_ZIP', `bad leading magic 0x${buf.subarray(0, 4).toString('hex')}`);
    }
    const eocd = findEocd(buf);
    const totalEntries = buf.readUInt16LE(eocd + 10);
    const cdSize = buf.readUInt32LE(eocd + 12);
    const cdOffset = buf.readUInt32LE(eocd + 16);
    if (totalEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
        throw new OoxmlError('ZIP64_UNSUPPORTED', 'ZIP64 sentinel in EOCD — refusing to read garbage offsets');
    }
    if (cdOffset + cdSize > eocd) { throw new OoxmlError('ZIP_CORRUPT', 'central directory extends past EOCD'); }
    const entries = new Map<string, ZipEntry>();
    let p = cdOffset;
    for (let n = 0; n < totalEntries; n++) {
        if (buf.readUInt32LE(p) !== CEN_SIG) {
            throw new OoxmlError('ZIP_CORRUPT', `bad central directory signature at offset ${p}`);
        }
        const method = buf.readUInt16LE(p + 10);
        const compressedSize = buf.readUInt32LE(p + 20);
        const uncompressedSize = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const localOffset = buf.readUInt32LE(p + 42);
        if (compressedSize === 0xffffffff || uncompressedSize === 0xffffffff || localOffset === 0xffffffff) {
            throw new OoxmlError('ZIP64_UNSUPPORTED', 'ZIP64 sentinel in central directory entry');
        }
        const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
        entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

// zip bomb ガード（SEC-1）: 単一エントリの伸長後サイズ上限。ファイル全体の 50MB 上限は
// 圧縮後サイズなので、高圧縮エントリ（deflate は 1000:1 超可）の増幅はここでしか防げない。
const MAX_ENTRY_UNCOMPRESSED = 100 * 1024 * 1024;

// entry の非圧縮データを返す。data 開始位置は local header 自身の nameLen/extraLen から計算
// （CD の extra 長流用は不可 — 実ファイルで異なる例あり）
function readZipEntryData(buf: Buffer, entry: ZipEntry): Buffer {
    const { localOffset, method, compressedSize, uncompressedSize } = entry;
    if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
        throw new OoxmlError('ZIP_CORRUPT', `bad local header signature at offset ${localOffset}`);
    }
    // 二段構え: 宣言値（CD の uncompressedSize）の事前検証 + maxOutputLength（宣言詐称対策）
    if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) {
        throw new OoxmlError('ENTRY_TOO_LARGE', `declared uncompressed size ${uncompressedSize} exceeds limit`);
    }
    const nameLen = buf.readUInt16LE(localOffset + 26);
    const extraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compressedSize);
    if (method === 8) { return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED }); } // raw deflate（zlib ヘッダ無し。inflateSync 不可）
    if (method === 0) { return raw; }                  // stored
    throw new OoxmlError('UNSUPPORTED_COMPRESSION', `method ${method} (OPC allows deflate/stored only)`);
}

// ── XML layer ───────────────────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXmlEntities(s: string): string {
    return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-z]+);/g, (m, body: string) => {
        if (body[0] === '#') {
            const cp = body[1] === 'x' || body[1] === 'X'
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
        }
        return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
    });
}

// ── docx ────────────────────────────────────────────────────────────────────

// <w:t の tagName 境界により w:tab / w:instrText / w:delText は構造的にマッチしない。
// trim 禁止（xml:space="preserve" の前後空白は run 結合で有意）。
const DOCX_TOKEN_RE = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;

function extractDocxParagraph(chunk: string): string {
    let out = '';
    for (const m of chunk.matchAll(DOCX_TOKEN_RE)) {
        const tok = m[0];
        if (tok.startsWith('<w:tab')) { out += '\t'; }
        else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) { out += '\n'; }
        else if (m[1] !== undefined) { out += decodeXmlEntities(m[1]); }
        // self-closing <w:t/> は空
    }
    return out;
}

function extractDocx(entries: Map<string, ZipEntry>, buf: Buffer): string {
    // main part は word/document.xml が常態だが document2.xml 等も合法（Word の Compare/修復）
    const parts = [...entries.keys()].filter((n) => /^word\/document\d*\.xml$/.test(n)).sort();
    if (parts.length === 0) { throw new OoxmlError('NO_MAIN_PART', 'no word/document*.xml part in package'); }
    const texts: string[] = [];
    for (const name of parts) {
        const xml = readZipEntryData(buf, entries.get(name) as ZipEntry).toString('utf8');
        const lines = xml.split('</w:p>').map(extractDocxParagraph).filter((s) => s.length > 0);
        texts.push(lines.join('\n'));
    }
    return texts.join('\n');
}

// ── xlsx ────────────────────────────────────────────────────────────────────

// si / is 共通: rPh（ふりがな）を先に strip してから <t> を全連結（rich text run 分割対応）。
// strip を怠ると 東京→東京トウキョウ に癒着する（実バグ事例: spreadsheet_decoder#43）。
function extractStringItem(item: string): string {
    const cleaned = item
        .replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
        .replace(/<phoneticPr\b[^>]*\/?>/g, '');
    let out = '';
    for (const m of cleaned.matchAll(/<t(?:\s[^>]*)?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
        if (m[1] !== undefined) { out += decodeXmlEntities(m[1]); }
    }
    return out;
}

// FR-DS-09 / ADRL-0060: xlsx はシート xml のセル走査でシート名+セル参照の loc を付ける
// （rev.2 までの sharedStrings 直読みはセル/シート対応が取れないため改訂）。
// シート名は workbook.xml の <sheet name= r:id=> + workbook.xml.rels の Target から解決、
// 取れなければシート index（Sheet<n>）に縮退。
function resolveSheetNames(entries: Map<string, ZipEntry>, buf: Buffer): Map<string, string> {
    // 戻り値: シート part 名（xl/worksheets/sheet1.xml）→ 表示名（"売上集計"）
    const result = new Map<string, string>();
    try {
        const wbName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/workbook.xml');
        const relsName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/_rels/workbook.xml.rels');
        if (!wbName || !relsName) { return result; }
        const wb = readZipEntryData(buf, entries.get(wbName) as ZipEntry).toString('utf8');
        const rels = readZipEntryData(buf, entries.get(relsName) as ZipEntry).toString('utf8');
        // rId → part 名
        const targetByRid = new Map<string, string>();
        for (const m of rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)) {
            const target = m[2].replace(/^\//, '');
            targetByRid.set(m[1], target.startsWith('xl/') ? target : `xl/${target}`);
        }
        // sheet name → rId → part 名
        for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"[^>]*\/>/g)) {
            const part = targetByRid.get(m[2]);
            if (part) { result.set(part, decodeXmlEntities(m[1])); }
        }
    } catch { /* 解決不能 → index 縮退 */ }
    return result;
}

function extractXlsxLines(entries: Map<string, ZipEntry>, buf: Buffer): { lines: ExtractedLine[]; truncated: boolean } {
    const out: ExtractedLine[] = [];
    const state: NormState = { total: 0, truncated: false };
    // sharedStrings は「プール」として読む（直接行にはしない — セル側から index 解決）
    const sstName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/sharedstrings.xml');
    const sharedStrings: string[] = [];
    if (sstName) {
        const xml = readZipEntryData(buf, entries.get(sstName) as ZipEntry).toString('utf8');
        for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
            sharedStrings.push(extractStringItem(m[1]));   // 空も index 維持のため push
        }
    }
    const sheets = [...entries.keys()]
        .filter((n) => /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(n))
        .sort();
    if (!sstName && sheets.length === 0) {
        throw new OoxmlError('NO_MAIN_PART', 'no xl/sharedStrings.xml nor xl/worksheets/*.xml in package');
    }
    const nameByPart = resolveSheetNames(entries, buf);
    let sheetIdx = 0;
    for (const name of sheets) {
        sheetIdx++;
        const sheetLabel = nameByPart.get(name) || `Sheet${sheetIdx}`;
        const xml = readZipEntryData(buf, entries.get(name) as ZipEntry).toString('utf8');
        // セル走査: <c r="B3" t="s"><v>idx</v></c>（共有文字列）/ <c r="B3" t="inlineStr"><is>..</is></c>
        for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
            if (state.truncated) { break; }
            const attrs = m[1];
            const body = m[2];
            const refM = attrs.match(/\br="([A-Z]+\d+)"/);
            const cellRef = refM ? refM[1] : '';
            const typeM = attrs.match(/\bt="([^"]+)"/);
            const cellType = typeM ? typeM[1] : '';
            let text = '';
            if (cellType === 's') {
                const vM = body.match(/<v>(\d+)<\/v>/);
                if (vM) { text = sharedStrings[Number(vM[1])] || ''; }
            } else if (cellType === 'inlineStr') {
                const isM = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
                if (isM) { text = extractStringItem(isM[1]); }
            } else if (cellType === 'str') {
                // 数式の文字列結果 <c t="str"><v>text</v></c>
                const vM = body.match(/<v>([\s\S]*?)<\/v>/);
                if (vM) { text = decodeXmlEntities(vM[1]); }
            }
            if (text.length > 0) {
                pushNormalized(out, state, text, cellRef ? `${sheetLabel}!${cellRef}` : sheetLabel);
            }
        }
        if (state.truncated) { break; }
    }
    return { lines: out, truncated: state.truncated };
}

// ── pptx ────────────────────────────────────────────────────────────────────

function extractPptxLines(entries: Map<string, ZipEntry>, buf: Buffer): { lines: ExtractedLine[]; truncated: boolean } {
    // slides のみ glob（notesSlides / slideLayouts / slideMasters は prefix 差で除外 —
    // layouts/masters を入れると "Click to add title" 等のテンプレ文字列を拾う）。
    const slides = [...entries.keys()]
        .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
        .sort((a, b) => Number((a.match(/slide(\d+)\.xml$/) as RegExpMatchArray)[1])
                      - Number((b.match(/slide(\d+)\.xml$/) as RegExpMatchArray)[1]));
    if (slides.length === 0) { throw new OoxmlError('NO_MAIN_PART', 'no ppt/slides/slide*.xml part in package'); }
    const outLines: ExtractedLine[] = [];
    const state: NormState = { total: 0, truncated: false };
    for (const name of slides) {
        const slideNo = Number((name.match(/slide(\d+)\.xml$/) as RegExpMatchArray)[1]);   // FR-DS-09: loc = slide 番号
        const xml = readZipEntryData(buf, entries.get(name) as ZipEntry).toString('utf8');
        let out = '';
        for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t\/>|<a:br\b[^>]*\/>|<\/a:p>/g)) {
            const tok = m[0];
            if (tok === '</a:p>' || tok.startsWith('<a:br')) { out += '\n'; }
            else if (m[1] !== undefined) { out += decodeXmlEntities(m[1]); }
        }
        pushNormalized(outLines, state, out.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, ''), `slide ${slideNo}`);
        if (state.truncated) { break; }
    }
    return { lines: outLines, truncated: state.truncated };
}

// ── PDF（pdfjs-dist@4.10.38 遅延ロード — TASK-03） ──────────────────────────

// モジュールスコープに pdfjs の参照・require を置かない（Electron 生 CJS require 制約）。
// undefined = 未試行 / null = ロード不可（キャッシュして再試行しない）
let pdfjsModule: unknown | null | undefined;

async function loadPdfjs(): Promise<unknown | null> {
    if (pdfjsModule !== undefined) { return pdfjsModule; }
    try {
        // fake worker: legacy worker を同一バンドルに畳み globalThis.pdfjsWorker 代入（poc BH-02 実証）。
        // esbuild は関数内 require も静的に畳む。Electron（tsc per-file emit の out/shared を生 require、
        // pdfjs-dist 非同梱）ではここが throw → null → pdf_unavailable が想定挙動。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const worker = require('pdfjs-dist/legacy/build/pdf.worker.mjs');
        (globalThis as Record<string, unknown>).pdfjsWorker = worker;
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        pdfjsModule = require('pdfjs-dist/legacy/build/pdf.mjs');
    } catch {
        pdfjsModule = null;
    }
    return pdfjsModule;
}

async function extractPdf(buf: Buffer, opts?: ExtractOpts): Promise<ExtractResult> {
    let pdfjs: unknown | null;
    if (opts?.pdfjsLoader) {
        try { pdfjs = await opts.pdfjsLoader(); } catch { pdfjs = null; }
    } else {
        pdfjs = await loadPdfjs();
    }
    if (!pdfjs) { return skip('pdf_unavailable'); }
    try {
        const lib = pdfjs as {
            getDocument: (o: { data: Uint8Array; verbosity?: number }) => { promise: Promise<{
                numPages: number;
                getPage: (n: number) => Promise<{ getTextContent: () => Promise<{ items: Array<{ str?: string }> }> }>;
                destroy: () => Promise<void>;
            }> };
        };
        // pdfjs は buffer を転送で消費しうるためコピーを渡す。verbosity 0 = errors のみ
        // （Warning が console/stdout を汚染し CLI --json の出力を壊すのを防ぐ — CLI ミラーと同値）
        const doc = await lib.getDocument({ data: new Uint8Array(buf), verbosity: 0 }).promise;
        const lines: ExtractedLine[] = [];
        const state: NormState = { total: 0, truncated: false };
        let rawLen = 0;
        try {
            for (let i = 1; i <= doc.numPages; i++) {
                const page = await doc.getPage(i);
                const content = await page.getTextContent();
                const pageText = content.items.map((it) => it.str || '').join('');
                rawLen += pageText.trim().length;
                pushNormalized(lines, state, pageText, `p.${i}`);   // FR-DS-09: loc = ページ番号
                if (state.truncated) { break; }
            }
        } finally {
            await doc.destroy().catch(() => { /* ignore */ });
        }
        if (rawLen === 0) {
            // predefined CMap 依存（ToUnicode 非埋込・cmaps 非同梱）は抽出 0 文字になる — ADRL-0057
            return skip('pdf_no_text');
        }
        return { lines, truncated: state.truncated };
    } catch {
        return skip('extract_error');
    }
}

// ── public API ──────────────────────────────────────────────────────────────

/**
 * 添付ファイルの Buffer から検索用テキストを抽出する（FR-DS-02/03/07/08）。
 * 抽出不能は throw せず必ず truthy skipReason を返す。
 * @param ext 拡張子（`.pdf` 等・大文字小文字不問）
 */
export async function extractDocText(buf: Buffer, ext: string, opts?: ExtractOpts): Promise<ExtractResult> {
    const lowerExt = String(ext || '').toLowerCase();
    if (!CONTENT_SEARCH_EXTS.includes(lowerExt)) { return skip('unsupported_ext'); }
    if (lowerExt === '.pdf') { return extractPdf(buf, opts); }
    try {
        const entries = readZipEntries(buf);
        if (lowerExt === '.docx') {
            // docx は位置なし（ページ/行番号はレンダリング結果でフォーマットに存在しない — ユーザー裁定）
            const { lines, truncated } = normalizeExtracted(extractDocx(entries, buf));
            return { lines: lines.map((text) => ({ text })), truncated };
        }
        return lowerExt === '.xlsx' ? extractXlsxLines(entries, buf) : extractPptxLines(entries, buf);
    } catch (e) {
        if (e instanceof OoxmlError && e.code === 'NOT_ZIP') { return skip('encrypted_or_not_zip'); }
        // ZIP_CORRUPT / ZIP64 / UNSUPPORTED_COMPRESSION / NO_MAIN_PART / inflate 失敗等
        return skip('extract_error');
    }
}
