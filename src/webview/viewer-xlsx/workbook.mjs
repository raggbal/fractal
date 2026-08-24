/**
 * viewer-xlsx/workbook.mjs — workbook モデル（MOD-XlsxParser / DOM-WorkbookModel / FR-XLV-02）
 *
 * sheet 一覧は **workbook.xml.rels 経由**で実ファイル解決（sheetId・ファイル名を当てにしない）。
 * sharedStrings は rich run 連結 + rPh（ふりがな）除去。theme は clrScheme 10 色を
 * **スワップ表（0=lt1, 1=dk1, 2=lt2, 3=dk2, 4..9=accent1..6）**で並べる（最重要の罠 — FR-XLV-04）。
 */
import { openZip } from '../viewer-common/zip.mjs';
import { parseXml, element, elements, attr } from '../viewer-common/xml.mjs';
import { richText } from './sheet-parse.mjs';

// theme 属性 index → clrScheme 要素名（dk1/lt1 スワップ込み）
const THEME_ORDER = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];

function themeColorsFrom(themeDoc) {
    const out = [];
    if (!themeDoc) { return out; }
    let scheme = null;
    (function find(el) {
        for (const c of elements(el)) {
            if (c.localName === 'clrScheme') { scheme = c; return; }
            find(c);
            if (scheme) { return; }
        }
    })(themeDoc.documentElement);
    if (!scheme) { return out; }
    const byName = new Map();
    for (const c of elements(scheme)) {
        const srgb = element(c, 'srgbClr');
        const sys = element(c, 'sysClr');
        const hex = srgb ? attr(srgb, 'val') : (sys ? attr(sys, 'lastClr') : null);
        if (hex) { byName.set(c.localName, hex.toUpperCase()); }
    }
    for (const name of THEME_ORDER) { out.push(byName.get(name) || null); }
    return out;
}

function parseSharedStrings(sstDoc) {
    const out = [];
    if (!sstDoc) { return out; }
    for (const si of elements(sstDoc.documentElement, 'si')) { out.push(richText(si)); }
    return out;
}

/** 分解済み XML 文字列群 → WorkbookModel（unit テスト用の pure 入口） */
export function parseWorkbook({ workbookXml, relsXml, sharedStringsXml, themeXml, stylesXml }) {
    const wbDoc = parseXml(workbookXml);
    const relsDoc = relsXml ? parseXml(relsXml) : null;
    const rels = new Map();
    if (relsDoc) {
        for (const rel of elements(relsDoc.documentElement)) {
            if (rel.localName === 'Relationship') { rels.set(attr(rel, 'Id'), attr(rel, 'Target')); }
        }
    }
    const root = wbDoc.documentElement;
    const wbPr = element(root, 'workbookPr');
    const date1904 = !!wbPr && (attr(wbPr, 'date1904') === '1' || attr(wbPr, 'date1904') === 'true');
    let activeTab = 0;
    const views = element(root, 'bookViews');
    if (views) {
        const v = element(views, 'workbookView');
        if (v && attr(v, 'activeTab') !== null) { activeTab = parseInt(attr(v, 'activeTab'), 10); }
    }
    const sheets = [];
    const sheetsEl = element(root, 'sheets');
    if (sheetsEl) {
        for (const s of elements(sheetsEl, 'sheet')) {
            sheets.push({
                name: attr(s, 'name') || '',
                state: attr(s, 'state') || 'visible',
                target: rels.get(attr(s, 'id')) || null, // r:id → rels（唯一の正解）
            });
        }
    }
    return {
        date1904, activeTab, sheets,
        sharedStrings: parseSharedStrings(sharedStringsXml ? parseXml(sharedStringsXml) : null),
        themeColors: themeColorsFrom(themeXml ? parseXml(themeXml) : null),
        stylesXml: stylesXml || null, // styles の解決は styles.mjs（TASK-13）
    };
}

/** ArrayBuffer/Uint8Array → { model, sheetXml(name) }（webview 実行入口） */
export async function openWorkbook(buf) {
    const zip = await openZip(buf);
    const dec = new TextDecoder('utf-8');
    const readText = async (name) => (zip.entries().has(name) ? dec.decode(await zip.readEntry(name)) : null);
    const workbookXml = await readText('xl/workbook.xml');
    if (!workbookXml) { throw new Error('xl/workbook.xml not found'); }
    const model = parseWorkbook({
        workbookXml,
        relsXml: await readText('xl/_rels/workbook.xml.rels'),
        sharedStringsXml: await readText('xl/sharedStrings.xml'),
        themeXml: await readText('xl/theme/theme1.xml'),
        stylesXml: await readText('xl/styles.xml'),
    });
    return {
        model,
        /** sheets[i].target（'worksheets/sheet1.xml'）→ XML 文字列 */
        async sheetXml(target) {
            const p = target && target.startsWith('/') ? target.slice(1) : `xl/${target}`;
            return readText(p);
        },
    };
}
