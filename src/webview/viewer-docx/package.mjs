/**
 * viewer-docx/package.mjs — docx パッケージ解決（MOD-DocxParser / DOM-DocxPackage）
 *
 * _rels/.rels → officeDocument → document.xml + styles/numbering/theme/document.xml.rels/media。
 * strict OOXML（purl.org 名前空間）は明示的な非対応エラー。
 */
import { openZip } from '../viewer-common/zip.mjs';
import { parseXml, elements, attr } from '../viewer-common/xml.mjs';

const REL_OFFICE_DOC = '/officeDocument';
const STRICT_NS = 'purl.oclc.org';

function dirname(p) {
    const i = p.lastIndexOf('/');
    return i === -1 ? '' : p.slice(0, i);
}
function joinPath(base, rel) {
    if (rel.startsWith('/')) { return rel.slice(1); }
    const parts = (base ? base.split('/') : []).concat(rel.split('/'));
    const out = [];
    for (const seg of parts) {
        if (seg === '' || seg === '.') { continue; }
        if (seg === '..') { out.pop(); continue; }
        out.push(seg);
    }
    return out.join('/');
}

async function readXmlEntry(zip, name) {
    const bytes = await zip.readEntry(name);
    return parseXml(new TextDecoder('utf-8').decode(bytes));
}

function parseRels(relsDoc) {
    const map = new Map();
    if (!relsDoc) { return map; }
    for (const rel of elements(relsDoc.documentElement)) {
        if (rel.localName !== 'Relationship') { continue; }
        map.set(attr(rel, 'Id'), { type: attr(rel, 'Type') || '', target: attr(rel, 'Target') || '', mode: attr(rel, 'TargetMode') });
    }
    return map;
}

export async function openDocxPackage(buf) {
    const zip = await openZip(buf);
    // _rels/.rels → officeDocument（正攻法 — document.xml 直打ちにしない）
    const rootRels = parseRels(await readXmlEntry(zip, '_rels/.rels'));
    let mainPath = null;
    for (const rel of rootRels.values()) {
        if (rel.type.includes(STRICT_NS)) { throw new Error('strict OOXML (Transitional のみ対応)'); }
        if (rel.type.endsWith(REL_OFFICE_DOC)) { mainPath = joinPath('', rel.target); break; }
    }
    if (!mainPath) { throw new Error('officeDocument relationship not found'); }
    const mainDir = dirname(mainPath);
    const documentXml = await readXmlEntry(zip, mainPath);

    // main の rels（word/_rels/document.xml.rels）
    const relsName = `${mainDir}/_rels/${mainPath.slice(mainDir.length + 1)}.rels`;
    let rels = new Map();
    if (zip.entries().has(relsName)) { rels = parseRels(await readXmlEntry(zip, relsName)); }

    // Type suffix でパーツ解決（styles / numbering / theme）
    async function partByTypeSuffix(suffix) {
        for (const rel of rels.values()) {
            if (rel.type.endsWith(suffix) && rel.mode !== 'External') {
                const p = joinPath(mainDir, rel.target);
                if (zip.entries().has(p)) { return readXmlEntry(zip, p); }
            }
        }
        return null;
    }
    const styles = await partByTypeSuffix('/styles');
    const numbering = await partByTypeSuffix('/numbering');
    const theme = await partByTypeSuffix('/theme');

    const mediaCache = new Map();
    return {
        documentXml, styles, numbering, theme, rels,
        /** relId → Uint8Array（media 実体。External / 不在は null） */
        async media(relId) {
            if (mediaCache.has(relId)) { return mediaCache.get(relId); }
            const rel = rels.get(relId);
            let out = null;
            if (rel && rel.mode !== 'External') {
                const p = joinPath(mainDir, rel.target);
                if (zip.entries().has(p)) { out = await zip.readEntry(p); }
            }
            mediaCache.set(relId, out);
            return out;
        },
        relTarget(relId) {
            const rel = rels.get(relId);
            return rel ? rel.target : null;
        },
    };
}
