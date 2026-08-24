/**
 * viewer-docx/numbering.mjs — リスト番号の自前カウンタ（MOD-DocxStyleEngine / FR-DXV-04）
 *
 * CSS counter でなく **パース時に番号文字列を焼き込む**（ADRL 相当の設計裁定 — viewer-docx.md）:
 * startOverride / 全角・丸数字 / コピー・find 対象化が JS カウンタで正確に書ける。
 * カウンタ意味論: counters[numId][lvl] を出現順 increment・上位 lvl 出現で下位クリア・
 * 離れた同 numId は継続（Word と同じ）。
 */
import { element, elements, attr, intAttr } from '../viewer-common/xml.mjs';

const AIUEO = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン';
const AIUEO_HALF = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜｦﾝ';
const IROHA = 'イロハニホヘトチリヌルヲワカヨタレソツネナラムウヰノオクヤマケフコエテアサキユメミシヱヒモセス';
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';

function roman(n) {
    const table = [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']];
    let out = '';
    for (const [v, s] of table) { while (n >= v) { out += s; n -= v; } }
    return out;
}
function letters(n) {
    // 1→a .. 26→z, 27→aa（Word の桁上がり: 実際は 27→aa 28→bb だが一般解釈の aa/ab を採用 —
    // 高位は稀のため許容近似）
    let out = '';
    n -= 1;
    do { out = String.fromCharCode(97 + (n % 26)) + out; n = Math.floor(n / 26) - 1; } while (n >= 0);
    return out;
}
const fullWidthDigits = (n) => String(n).replace(/[0-9]/g, (d) => String.fromCharCode(0xFF10 + Number(d)));

export function formatNum(fmt, n) {
    switch (fmt) {
        case 'decimal': return String(n);
        case 'decimalZero': return String(n).padStart(2, '0');
        case 'decimalFullWidth': return fullWidthDigits(n);
        case 'decimalEnclosedCircle': return n >= 1 && n <= 20 ? CIRCLED[n - 1] : `(${n})`;
        case 'lowerLetter': return letters(n);
        case 'upperLetter': return letters(n).toUpperCase();
        case 'lowerRoman': return roman(n);
        case 'upperRoman': return roman(n).toUpperCase();
        case 'aiueo': return AIUEO_HALF[(n - 1) % AIUEO_HALF.length];
        case 'aiueoFullWidth': return AIUEO[(n - 1) % AIUEO.length];
        case 'iroha': case 'irohaFullWidth': return IROHA[(n - 1) % IROHA.length];
        case 'bullet': return '•';
        case 'none': return '';
        default: return String(n);
    }
}

const BULLET_MAP = new Map([['', '•'], ['', '■'], ['', '➢'], ['', '✓'], ['o', '○'], ['', '■'], ['', '◆']]);

export function buildNumbering(numberingDoc) {
    const abstract = new Map(); // abstractNumId → Map<ilvl, lvlDef>
    const nums = new Map();     // numId → {abstractId, overrides: Map<ilvl, {startOverride, lvl}>}
    if (!numberingDoc) { return { abstract, nums }; }
    const root = numberingDoc.documentElement;
    const parseLvl = (lvlEl) => {
        const startEl = element(lvlEl, 'start');
        const fmtEl = element(lvlEl, 'numFmt');
        const textEl = element(lvlEl, 'lvlText');
        const suffEl = element(lvlEl, 'suff');
        const pPrEl = element(lvlEl, 'pPr');
        const indEl = pPrEl && element(pPrEl, 'ind');
        return {
            start: startEl ? (intAttr(startEl, 'val') ?? 1) : 1,
            numFmt: fmtEl ? attr(fmtEl, 'val') : 'decimal',
            lvlText: textEl ? (attr(textEl, 'val') || '') : '',
            suff: suffEl ? attr(suffEl, 'val') : 'tab',
            indLeft: indEl ? (intAttr(indEl, 'left') ?? intAttr(indEl, 'start')) : null,
            hanging: indEl ? intAttr(indEl, 'hanging') : null,
        };
    };
    for (const ab of elements(root, 'abstractNum')) {
        const lvls = new Map();
        for (const lvl of elements(ab, 'lvl')) { lvls.set(intAttr(lvl, 'ilvl') ?? 0, parseLvl(lvl)); }
        abstract.set(intAttr(ab, 'abstractNumId'), lvls);
    }
    for (const num of elements(root, 'num')) {
        const abEl = element(num, 'abstractNumId');
        const overrides = new Map();
        for (const ov of elements(num, 'lvlOverride')) {
            const ilvl = intAttr(ov, 'ilvl') ?? 0;
            const so = element(ov, 'startOverride');
            const lvlEl = element(ov, 'lvl');
            overrides.set(ilvl, {
                startOverride: so ? intAttr(so, 'val') : null,
                lvl: lvlEl ? parseLvl(lvlEl) : null,
            });
        }
        nums.set(intAttr(num, 'numId'), { abstractId: abEl ? intAttr(abEl, 'val') : null, overrides });
    }
    return { abstract, nums };
}

export function createCounter(defs) {
    const counters = new Map(); // numId → number[]（lvl 別カウンタ）
    function lvlDef(numId, ilvl) {
        const num = defs.nums.get(numId);
        if (!num) { return null; }
        const ov = num.overrides.get(ilvl);
        if (ov && ov.lvl) { return { ...ov.lvl, startOverride: ov.startOverride }; }
        const lvls = defs.abstract.get(num.abstractId);
        const def = lvls ? lvls.get(ilvl) : null;
        return def ? { ...def, startOverride: ov ? ov.startOverride : null } : null;
    }
    return {
        /** 段落出現時に呼ぶ → {text, suff, indLeft, hanging} | null */
        next(numId, ilvl) {
            const def = lvlDef(numId, ilvl);
            if (!def) { return null; }
            if (!counters.has(numId)) { counters.set(numId, []); }
            const c = counters.get(numId);
            if (c[ilvl] === undefined) {
                c[ilvl] = (def.startOverride ?? def.start) - 1;
            }
            c[ilvl] += 1;
            c.length = ilvl + 1; // 下位レベルをリセット（上位出現時）
            if (def.numFmt === 'bullet') {
                const ch = def.lvlText || '•';
                return { text: BULLET_MAP.get(ch) || (ch.codePointAt(0) >= 0xF000 ? '•' : ch), suff: def.suff, indLeft: def.indLeft, hanging: def.hanging };
            }
            // lvlText の %1..%9 を各レベルの現在値で展開
            const text = (def.lvlText || `%${ilvl + 1}.`).replace(/%(\d)/g, (m, d) => {
                const li = parseInt(d, 10) - 1;
                const ld = lvlDef(numId, li);
                const v = c[li] !== undefined ? c[li] : (ld ? ld.start : 1);
                return formatNum(ld ? ld.numFmt : 'decimal', v);
            });
            return { text, suff: def.suff, indLeft: def.indLeft, hanging: def.hanging };
        },
    };
}
