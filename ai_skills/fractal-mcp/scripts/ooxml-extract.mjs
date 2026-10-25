// ooxml-extract.mjs — OOXML (docx/xlsx/pptx) ゼロ依存テキスト抽出（CLI ミラー）
// 依存: node built-ins のみ (node:zlib / node:fs / node:url)。外部 npm 依存 0。
//
// ⚠️ ミラー同期（ADRL-0059）: 正典は src/shared/doc-text-extract.ts。
//    正典を変更したらこのファイルにも 1:1 転記し、一致 TC（TC-DS-26 —
//    test/specs/doc-search-cli.spec.ts）で lines 完全一致を確認すること。
//
// 設計根拠: .harness/poc/20260813-094552-docsearch-pdf-ooxml/v1/research/research-bh-03.md
//   - ZIP: EOCD 後方スキャン → central directory 列挙 → data offset は local header の
//     nameLen/extraLen から計算 (CD の extra 長流用は不可 — 実ファイルで異なる例あり)
//   - method 8 = inflateRawSync (inflateSync 不可 = raw deflate) / method 0 = stored 素通し
//   - ZIP64 sentinel / 未知 method / 非 ZIP は fail loudly (silent 空文字禁止)
//   - docx: <w:t> 精密 regex (instrText/delText/tab を tagName 境界で自然排除) + trim 禁止
//   - xlsx: si 単位で <rPh> (ふりがな) strip 必須 + sharedStrings <t> + inline <is><t> 両対応
//   - pptx: ppt/slides/slide\d+.xml glob (layouts/masters/notesSlides は prefix 差で除外)

import { inflateRawSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export class OoxmlError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// --- ZIP layer --------------------------------------------------------------

const EOCD_SIG = 0x06054b50; // PK\x05\x06
const CEN_SIG = 0x02014b50; // PK\x01\x02
const LOC_SIG = 0x04034b50; // PK\x03\x04

function findEocd(buf) {
  if (buf.length < 22) throw new OoxmlError('NOT_ZIP', `file too small (${buf.length} bytes)`);
  const scanStart = buf.length - Math.min(buf.length, 22 + 65535);
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) !== EOCD_SIG) continue;
    const commentLen = buf.readUInt16LE(i + 20);
    if (i + 22 + commentLen !== buf.length) continue; // 圧縮データ内の偽出現を除外
    return i;
  }
  throw new OoxmlError('NOT_ZIP', 'EOCD not found (encrypted CFB container or non-zip file?)');
}

// ZIP central directory を列挙し name → entry メタの Map を返す
export function readZipEntries(buf) {
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
  if (cdOffset + cdSize > eocd) throw new OoxmlError('ZIP_CORRUPT', 'central directory extends past EOCD');
  const entries = new Map();
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

// zip bomb ガード（SEC-1・正典 1:1 ミラー）: 単一エントリの伸長後サイズ上限。
const MAX_ENTRY_UNCOMPRESSED = 100 * 1024 * 1024;

// entry の非圧縮データを返す。data 開始位置は local header 自身の nameLen/extraLen から計算
export function readZipEntryData(buf, entry) {
  const { localOffset, method, compressedSize, uncompressedSize } = entry;
  if (buf.readUInt32LE(localOffset) !== LOC_SIG) {
    throw new OoxmlError('ZIP_CORRUPT', `bad local header signature at offset ${localOffset}`);
  }
  // 二段構え: 宣言値の事前検証 + maxOutputLength（宣言詐称対策）— 正典と同一
  if (uncompressedSize > MAX_ENTRY_UNCOMPRESSED) {
    throw new OoxmlError('ENTRY_TOO_LARGE', `declared uncompressed size ${uncompressedSize} exceeds limit`);
  }
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const raw = buf.subarray(dataStart, dataStart + compressedSize);
  if (method === 8) return inflateRawSync(raw, { maxOutputLength: MAX_ENTRY_UNCOMPRESSED }); // raw deflate (zlib ヘッダ無し)
  if (method === 0) return raw; // stored
  throw new OoxmlError('UNSUPPORTED_COMPRESSION', `method ${method} (OPC allows deflate/stored only)`);
}

// --- XML layer --------------------------------------------------------------

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// XML エンティティ 5 種 + 数値文字参照 (&#xNNNN; / &#NNNN;) をデコード
export function decodeXmlEntities(s) {
  return s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body) ? NAMED_ENTITIES[body] : m;
  });
}

// --- docx -------------------------------------------------------------------

// 段落チャンク内の w:t / w:tab / w:br / w:cr を出現順で文字化。
// <w:t の tagName 境界 (直後が \s か > か /) により w:tab / w:instrText / w:delText は
// 構造的にマッチしない。trim 禁止 (xml:space="preserve" の前後空白は run 結合で有意)。
const DOCX_TOKEN_RE = /<w:t(?:\s[^>]*)?\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:(?:br|cr)\b[^>]*\/>/g;

function extractDocxParagraph(chunk) {
  let out = '';
  for (const m of chunk.matchAll(DOCX_TOKEN_RE)) {
    const tok = m[0];
    if (tok.startsWith('<w:tab')) out += '\t';
    else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) out += '\n';
    else if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    // self-closing <w:t/> は空
  }
  return out;
}

export function extractDocx(entries, buf) {
  // main part は word/document.xml が常態だが document2.xml 等も合法 (research 反証 #4)
  const parts = [...entries.keys()].filter((n) => /^word\/document\d*\.xml$/.test(n)).sort();
  if (parts.length === 0) throw new OoxmlError('NO_MAIN_PART', 'no word/document*.xml part in package');
  const texts = [];
  for (const name of parts) {
    const xml = readZipEntryData(buf, entries.get(name)).toString('utf8');
    const lines = xml.split('</w:p>').map(extractDocxParagraph).filter((s) => s.length > 0);
    texts.push(lines.join('\n'));
  }
  return texts.join('\n');
}

// --- xlsx -------------------------------------------------------------------

// si (shared string item) / is (inline string) 共通: rPh (ふりがな) を先に strip してから
// <t> を全連結 (rich text run <r><t> 分割対応)。strip を怠ると 東京→東京トウキョウ に癒着する
// (実バグ事例: spreadsheet_decoder#43)。
function extractStringItem(item) {
  const cleaned = item
    .replace(/<rPh\b[\s\S]*?<\/rPh>/g, '')
    .replace(/<phoneticPr\b[^>]*\/?>/g, '');
  let out = '';
  for (const m of cleaned.matchAll(/<t(?:\s[^>]*)?\/>|<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) {
    if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
  }
  return out;
}

export function extractXlsx(entries, buf) {
  const texts = [];
  // sharedStrings (part 名 casing 差異の実在報告 SheetJS#439 → 大文字小文字を許容)
  const sstName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/sharedstrings.xml');
  if (sstName) {
    const xml = readZipEntryData(buf, entries.get(sstName)).toString('utf8');
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      const s = extractStringItem(m[1]);
      if (s.length > 0) texts.push(s);
    }
  }
  // worksheets の inline string <c t="inlineStr"><is>...</is></c>
  const sheets = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(n))
    .sort();
  for (const name of sheets) {
    const xml = readZipEntryData(buf, entries.get(name)).toString('utf8');
    for (const m of xml.matchAll(/<is\b[^>]*>([\s\S]*?)<\/is>/g)) {
      const s = extractStringItem(m[1]);
      if (s.length > 0) texts.push(s);
    }
  }
  if (!sstName && sheets.length === 0) {
    throw new OoxmlError('NO_MAIN_PART', 'no xl/sharedStrings.xml nor xl/worksheets/*.xml in package');
  }
  return texts.join('\n');
}

// --- pptx -------------------------------------------------------------------

export function extractPptx(entries, buf) {
  // slides のみ glob (notesSlides / slideLayouts / slideMasters は prefix 差で除外 —
  // layouts/masters を入れると "Click to add title" 等のテンプレ文字列を拾う)。
  // 全文検索用途はスライド順不問なので sldIdLst 解決は不要 (research Q4)。
  const slides = [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)[1]) - Number(b.match(/slide(\d+)\.xml$/)[1]));
  if (slides.length === 0) throw new OoxmlError('NO_MAIN_PART', 'no ppt/slides/slide*.xml part in package');
  const texts = [];
  for (const name of slides) {
    const xml = readZipEntryData(buf, entries.get(name)).toString('utf8');
    let out = '';
    for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t\/>|<a:br\b[^>]*\/>|<\/a:p>/g)) {
      const tok = m[0];
      if (tok === '</a:p>' || tok.startsWith('<a:br')) out += '\n';
      else if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    }
    texts.push(out.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, ''));
  }
  return { text: texts.join('\n'), slideCount: slides.length, slideParts: slides };
}

// --- 正規化（正典 normalizeExtracted / pushNormalized の 1:1 ミラー — FR-DS-07/09 両経路同一適用） -----

const LINE_CLAMP = 200;          // SearchMatch.lineText の webview 表示契約と同形
const TOTAL_CLAMP = 1024 * 1024; // 抽出テキスト上限 1MB

export function normalizeExtracted(text) {
  // NFKC: 康熙部首 → 統合漢字（macOS Hiragino 生成 PDF の U+2F00 系対策）
  const normalized = text.normalize('NFKC');
  const lines = [];
  let total = 0;
  let truncated = false;
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.length > LINE_CLAMP ? rawLine.substring(0, LINE_CLAMP) : rawLine;
    if (line.length === 0) continue;
    if (total + line.length > TOTAL_CLAMP) { truncated = true; break; }
    lines.push(line);
    total += line.length + 1;
  }
  return { lines, truncated };
}

// FR-DS-09: セグメント単位で正規化しながら loc（p.5 / slide 3 / シート名!B12）付きで積む
export function pushNormalized(out, state, text, loc) {
  if (state.truncated) return;
  const normalized = text.normalize('NFKC');
  for (const rawLine of normalized.split('\n')) {
    const line = rawLine.length > LINE_CLAMP ? rawLine.substring(0, LINE_CLAMP) : rawLine;
    if (line.length === 0) continue;
    if (state.total + line.length > TOTAL_CLAMP) { state.truncated = true; return; }
    out.push(loc ? { text: line, loc } : { text: line });
    state.total += line.length + 1;
  }
}

// --- skipReason 契約（正典 extractDocText と同じ ExtractResult 形） --------------

const CONTENT_SEARCH_OOXML_EXTS = ['.docx', '.xlsx', '.pptx'];
const skipResult = (reason) => ({ lines: [], truncated: false, skipReason: reason });

// FR-DS-09 / ADRL-0060: シート名解決（正典 resolveSheetNames の 1:1 ミラー）
function resolveSheetNamesMjs(entries, buf) {
  const result = new Map();
  try {
    const wbName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/workbook.xml');
    const relsName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/_rels/workbook.xml.rels');
    if (!wbName || !relsName) return result;
    const wb = readZipEntryData(buf, entries.get(wbName)).toString('utf8');
    const rels = readZipEntryData(buf, entries.get(relsName)).toString('utf8');
    const targetByRid = new Map();
    for (const m of rels.matchAll(/<Relationship\b[^>]*\bId="([^"]+)"[^>]*\bTarget="([^"]+)"[^>]*\/>/g)) {
      const target = m[2].replace(/^\//, '');
      targetByRid.set(m[1], target.startsWith('xl/') ? target : `xl/${target}`);
    }
    for (const m of wb.matchAll(/<sheet\b[^>]*\bname="([^"]*)"[^>]*\br:id="([^"]+)"[^>]*\/>/g)) {
      const part = targetByRid.get(m[2]);
      if (part) result.set(part, decodeXmlEntities(m[1]));
    }
  } catch { /* 解決不能 → index 縮退 */ }
  return result;
}

// FR-DS-09: xlsx セル走査（正典 extractXlsxLines の 1:1 ミラー — sharedStrings 直読みから改訂）
function extractXlsxLinesMjs(entries, buf) {
  const out = [];
  const state = { total: 0, truncated: false };
  const sstName = [...entries.keys()].find((n) => n.toLowerCase() === 'xl/sharedstrings.xml');
  const sharedStrings = [];
  if (sstName) {
    const xml = readZipEntryData(buf, entries.get(sstName)).toString('utf8');
    for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)) {
      sharedStrings.push(extractStringItem(m[1]));
    }
  }
  const sheets = [...entries.keys()]
    .filter((n) => /^xl\/worksheets\/sheet[^/]*\.xml$/i.test(n))
    .sort();
  if (!sstName && sheets.length === 0) {
    throw new OoxmlError('NO_MAIN_PART', 'no xl/sharedStrings.xml nor xl/worksheets/*.xml in package');
  }
  const nameByPart = resolveSheetNamesMjs(entries, buf);
  let sheetIdx = 0;
  for (const name of sheets) {
    sheetIdx++;
    const sheetLabel = nameByPart.get(name) || `Sheet${sheetIdx}`;
    const xml = readZipEntryData(buf, entries.get(name)).toString('utf8');
    for (const m of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      if (state.truncated) break;
      const attrs = m[1];
      const body = m[2];
      const refM = attrs.match(/\br="([A-Z]+\d+)"/);
      const cellRef = refM ? refM[1] : '';
      const typeM = attrs.match(/\bt="([^"]+)"/);
      const cellType = typeM ? typeM[1] : '';
      let text = '';
      if (cellType === 's') {
        const vM = body.match(/<v>(\d+)<\/v>/);
        if (vM) text = sharedStrings[Number(vM[1])] || '';
      } else if (cellType === 'inlineStr') {
        const isM = body.match(/<is\b[^>]*>([\s\S]*?)<\/is>/);
        if (isM) text = extractStringItem(isM[1]);
      } else if (cellType === 'str') {
        const vM = body.match(/<v>([\s\S]*?)<\/v>/);
        if (vM) text = decodeXmlEntities(vM[1]);
      }
      if (text.length > 0) {
        pushNormalized(out, state, text, cellRef ? `${sheetLabel}!${cellRef}` : sheetLabel);
      }
    }
    if (state.truncated) break;
  }
  return { lines: out, truncated: state.truncated };
}

// FR-DS-09: pptx スライド loc（正典 extractPptxLines の 1:1 ミラー）
function extractPptxLinesMjs(entries, buf) {
  const slides = [...entries.keys()]
    .filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => Number(a.match(/slide(\d+)\.xml$/)[1]) - Number(b.match(/slide(\d+)\.xml$/)[1]));
  if (slides.length === 0) throw new OoxmlError('NO_MAIN_PART', 'no ppt/slides/slide*.xml part in package');
  const outLines = [];
  const state = { total: 0, truncated: false };
  for (const name of slides) {
    const slideNo = Number(name.match(/slide(\d+)\.xml$/)[1]);
    const xml = readZipEntryData(buf, entries.get(name)).toString('utf8');
    let out = '';
    for (const m of xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:t\/>|<a:br\b[^>]*\/>|<\/a:p>/g)) {
      const tok = m[0];
      if (tok === '</a:p>' || tok.startsWith('<a:br')) out += '\n';
      else if (m[1] !== undefined) out += decodeXmlEntities(m[1]);
    }
    pushNormalized(outLines, state, out.replace(/\n{2,}/g, '\n').replace(/^\n+|\n+$/g, ''), `slide ${slideNo}`);
    if (state.truncated) break;
  }
  return { lines: outLines, truncated: state.truncated };
}

// --- テキスト sniff + decode（FR-DS-11 — 正典 sniffAndDecodeText の 5 分岐 1:1 ミラー） ---

const SNIFF_SIZE = 8192;                          // 正典と同一定数
const TEXT_DECODE_INPUT_CLAMP = 4 * 1024 * 1024;  // decode 前の入力 clamp（正典と同一）

// 判定順は不変条件: ① UTF-8 BOM ② UTF-16LE BOM ③ UTF-16BE BOM ④ 先頭 8KB NUL → null ⑤ fallback UTF-8。
// BOM 判定が NUL 検査より必ず先（UTF-16 は ASCII が NUL を含む — 逆順で UTF-16 全滅）。
export function sniffAndDecodeText(buf) {
  const clamp = (b) => b.length > TEXT_DECODE_INPUT_CLAMP
    ? { b: b.subarray(0, TEXT_DECODE_INPUT_CLAMP), truncated: true }
    : { b, truncated: false };

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {          // 分岐 1
    const { b, truncated } = clamp(buf.subarray(3));
    return { text: b.toString('utf8'), truncated };
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {                             // 分岐 2
    const { b, truncated } = clamp(buf.subarray(2));
    const even = b.length % 2 === 0 ? b : b.subarray(0, b.length - 1);
    return { text: even.toString('utf16le'), truncated };
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {                             // 分岐 3
    const { b, truncated } = clamp(buf.subarray(2));
    const even = b.length % 2 === 0 ? b : b.subarray(0, b.length - 1);
    const copy = Buffer.from(even);   // swap16 は破壊的 — 必ずコピーに対して
    copy.swap16();
    return { text: copy.toString('utf16le'), truncated };
  }
  const sniffLen = Math.min(buf.length, SNIFF_SIZE);                                       // 分岐 4
  for (let i = 0; i < sniffLen; i++) {
    if (buf[i] === 0x00) return null;
  }
  const { b, truncated } = clamp(buf);                                                     // 分岐 5
  return { text: b.toString('utf8'), truncated };
}

// --- HTML 本文抽出（FR-DS-12 — 正典 extractHtmlBody の 5 処理 1:1 ミラー） ---

const HTML_EXTRA_ENTITIES = { nbsp: ' ' };

// ① script/style/noscript 中身ごと除去（コメント除去より先）② コメント除去
// ③ タグ→半角スペース（'' 置換は <td> 癒着 — 禁止）④ 文字参照復号（③より後）⑤ 空白畳み（④より後）
export function extractHtmlBody(html) {
  let s = html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');  // ①
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');                                             // ②
  s = s.replace(/<[^>]*>/g, ' ');                                                     // ③
  s = s.replace(/&(#[xX]?[0-9a-fA-F]+|[a-z]+);/g, (m, body) => {                      // ④
    if (body[0] === '#') {
      const cp = body[1] === 'x' || body[1] === 'X'
        ? parseInt(body.slice(2), 16)
        : parseInt(body.slice(1), 10);
      return Number.isFinite(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : m;
    }
    if (Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, body)) return NAMED_ENTITIES[body];
    if (Object.prototype.hasOwnProperty.call(HTML_EXTRA_ENTITIES, body)) return HTML_EXTRA_ENTITIES[body];
    return m;
  });
  return s.split('\n')                                                                // ⑤
    .map((line) => line.replace(/[ \t]{2,}/g, ' ').trim())
    .join('\n');
}

// Buffer から正典 extractDocText と同一契約（{lines: [{text,loc?}], truncated, skipReason?, noCache?}）で抽出する。
// PDF は CLI では vendor バンドル経由（fractal-search.mjs 側の責務）— ここは OOXML + テキスト sniff。
// 判定パイプライン（正典 §2 ミラー）: ① OOXML 3 種 → 専用抽出 ② それ以外 → sniff（BOM→NUL→UTF-8）
// ③ .html/.htm のみ本文抽出 ④ normalizeExtracted。テキスト成功は noCache: true（NFR-DS-08）。
export async function extractDocTextMjs(buf, ext) {
  const lowerExt = String(ext || '').toLowerCase();
  if (CONTENT_SEARCH_OOXML_EXTS.includes(lowerExt)) {
    try {
      const entries = readZipEntries(buf);
      if (lowerExt === '.docx') {
        // docx は位置なし（正典と同一裁定）
        const { lines, truncated } = normalizeExtracted(extractDocx(entries, buf));
        return { lines: lines.map((text) => ({ text })), truncated };
      }
      return lowerExt === '.xlsx' ? extractXlsxLinesMjs(entries, buf) : extractPptxLinesMjs(entries, buf);
    } catch (e) {
      if (e instanceof OoxmlError && e.code === 'NOT_ZIP') return skipResult('encrypted_or_not_zip');
      return skipResult('extract_error');
    }
  }
  // テキスト sniff 経路（FR-DS-11）
  try {
    const decoded = sniffAndDecodeText(buf);
    if (decoded === null) return skipResult('binary');
    const text = (lowerExt === '.html' || lowerExt === '.htm')
      ? extractHtmlBody(decoded.text)                 // FR-DS-12（.svg/.xml 等は生テキスト）
      : decoded.text;
    const { lines, truncated } = normalizeExtracted(text);
    // noCache: テキスト成功結果は永続キャッシュに書かない（NFR-DS-08 / ADRL-0063）
    return { lines: lines.map((t) => ({ text: t })), truncated: truncated || decoded.truncated, noCache: true };
  } catch {
    return skipResult('extract_error');
  }
}

// --- public API ---------------------------------------------------------------

const FORMAT_BY_EXT = { '.docx': 'docx', '.xlsx': 'xlsx', '.pptx': 'pptx' };

// filePath の OOXML から全文検索用プレーンテキストを抽出する。
// 戻り値: { format, text, meta } / 失敗は OoxmlError (code で識別可能 — silent 空文字は返さない)
export function extractOoxmlText(filePath) {
  const dot = filePath.lastIndexOf('.');
  const ext = dot >= 0 ? filePath.slice(dot).toLowerCase() : '';
  const format = FORMAT_BY_EXT[ext];
  if (!format) throw new OoxmlError('UNSUPPORTED_EXT', `${ext || '(none)'} is not docx/xlsx/pptx`);
  const buf = readFileSync(filePath);
  const entries = readZipEntries(buf);
  if (format === 'docx') return { format, text: extractDocx(entries, buf), meta: {} };
  if (format === 'xlsx') return { format, text: extractXlsx(entries, buf), meta: {} };
  const { text, slideCount, slideParts } = extractPptx(entries, buf);
  return { format, text, meta: { slideCount, slideParts } };
}

// --- CLI (import 時は実行しない — import.meta.url ガード必須) -------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node ooxml-extract.mjs <file.docx|.xlsx|.pptx>');
    process.exit(2);
  }
  try {
    const { format, text, meta } = extractOoxmlText(file);
    console.error(`[${format}] ${file} — ${text.length} chars${meta.slideCount ? `, ${meta.slideCount} slides` : ''}`);
    console.log(text);
  } catch (e) {
    console.error(`EXTRACT_FAILED ${e.code || 'UNKNOWN'}: ${e.message}`);
    process.exit(1);
  }
}
