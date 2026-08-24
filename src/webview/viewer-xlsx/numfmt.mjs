/**
 * viewer-xlsx/numfmt.mjs — numFmt サブセット文法エンジン（DOM-NumFmtEngine / FR-XLV-03）
 *
 * 完全な SSF 互換ではなく「実在ファイルの 97%+ を狙うサブセット」（設計 = viewer-xlsx.md）:
 *  - ビルトイン ID テーブル（en 基本 + ja 上書き層）→ 書式文字列 → 共通エンジン（専用経路を作らない）
 *  - 数値: 0#? / , 千位・末尾 , スケール / % / E+00 / セクション ; / [色] / [条件] / [$通貨-locale] / "リテラル" / \x / _x
 *  - 日付: yyyy..ss / AM/PM / [h][m][s] 経過 / g,gg,ggg+e 和暦 / .0 サブ秒。Date オブジェクト不使用の純関数
 *    （1900 閏年バグ: serial 60 = 架空の 1900/2/29・serial 0 = 1900/1/0・61 以降 epoch 1899-12-30。date1904 = +1462 日）
 *  - 縮退 3 段: 部分未対応トークンは無視 / 文法外 → General + fallback:'general' /
 *    日付トークン含有の文法外 → 汎用日付 + fallback:'date'。例外はセル単位で握る（throw しない契約）
 */

// ── ビルトイン書式テーブル ──────────────────────────────────────────────
const BUILTIN_EN = {
    0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00',
    5: '$#,##0_);($#,##0)', 6: '$#,##0_);[Red]($#,##0)',
    7: '$#,##0.00_);($#,##0.00)', 8: '$#,##0.00_);[Red]($#,##0.00)',
    9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
    14: 'm/d/yy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy',
    18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yy h:mm',
    37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)',
    45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mmss.0', 48: '##0.0E+0', 49: '@',
};
// ja 上書き層（実 Excel ja-JP の事実上の標準値 — v2 レポート §1(a)）
const BUILTIN_JA = {
    5: '"¥"#,##0;"¥"-#,##0', 6: '"¥"#,##0;[Red]"¥"-#,##0',
    7: '"¥"#,##0.00;"¥"-#,##0.00', 8: '"¥"#,##0.00;[Red]"¥"-#,##0.00',
    14: 'yyyy/m/d',
    27: '[$-411]ge.m.d', 28: '[$-411]ggge"年"m"月"d"日"', 29: '[$-411]ggge"年"m"月"d"日"',
    30: 'm/d/yy', 31: 'yyyy"年"m"月"d"日"', 32: 'h"時"mm"分"', 33: 'h"時"mm"分"ss"秒"',
    34: 'yyyy"年"m"月"', 35: 'm"月"d"日"', 36: '[$-411]ge.m.d',
    50: '[$-411]ge.m.d', 51: '[$-411]ggge"年"m"月"d"日"', 52: 'yyyy"年"m"月"', 53: 'm"月"d"日"',
    54: '[$-411]ggge"年"m"月"d"日"', 55: 'yyyy"年"m"月"', 56: 'm"月"d"日"',
    57: '[$-411]ge.m.d', 58: '[$-411]ggge"年"m"月"d"日"',
};

const COLORS = {
    black: '#000000', white: '#FFFFFF', red: '#FF0000', green: '#008000',
    blue: '#0000FF', yellow: '#FFFF00', magenta: '#FF00FF', cyan: '#00FFFF',
};

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOWS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// 和暦（開始日の降順）
const ERAS = [
    { y: 2019, m: 5, d: 1, g: 'R', gg: '令', ggg: '令和' },
    { y: 1989, m: 1, d: 8, g: 'H', gg: '平', ggg: '平成' },
    { y: 1926, m: 12, d: 25, g: 'S', gg: '昭', ggg: '昭和' },
    { y: 1912, m: 7, d: 30, g: 'T', gg: '大', ggg: '大正' },
    { y: 1868, m: 1, d: 1, g: 'M', gg: '明', ggg: '明治' },
];

class GrammarError extends Error { }

// ── トークナイザ（セクション文字列 → atom 列） ─────────────────────────
// atom: {t:'lit', v} | {t:'code', v(1 文字)} | {t:'color', v} | {t:'cond', op, num} | {t:'elapsed', v('h'|'m'|'s'), n}
const CODE_CHARS = '0#?.,%@ymdhsgeAP/:E+-';

function tokenizeSection(src) {
    const atoms = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '"') { // 引用リテラル（閉じ無しは末尾まで — lenient）
            const end = src.indexOf('"', i + 1);
            const lit = end === -1 ? src.slice(i + 1) : src.slice(i + 1, end);
            atoms.push({ t: 'lit', v: lit });
            i = end === -1 ? src.length : end + 1;
            continue;
        }
        if (ch === '\\') { atoms.push({ t: 'lit', v: src[i + 1] || '' }); i += 2; continue; }
        if (ch === '_') { atoms.push({ t: 'lit', v: ' ' }); i += 2; continue; }   // _x = 同幅スペース（半角 1 個で近似）
        if (ch === '*') { i += 2; continue; }                                      // *x = 充填 — 無視（部分未対応の縮退）
        if (ch === '[') {
            const end = src.indexOf(']', i);
            if (end === -1) { throw new GrammarError('unclosed bracket'); }
            const body = src.slice(i + 1, end);
            i = end + 1;
            const lower = body.toLowerCase();
            if (COLORS[lower]) { atoms.push({ t: 'color', v: COLORS[lower] }); continue; }
            if (/^color\s*\d+$/i.test(body)) { continue; }                          // [Color n] — 色は捨てて整形継続
            if (/^[hms]+$/i.test(body)) { atoms.push({ t: 'elapsed', v: lower[0], n: body.length }); continue; }
            const cond = /^(<=|>=|<>|<|>|=)([+-]?[\d.]+)$/.exec(body);
            if (cond) { atoms.push({ t: 'cond', op: cond[1], num: parseFloat(cond[2]) }); continue; }
            if (body[0] === '$') {                                                  // [$通貨-locale]
                const dash = body.lastIndexOf('-');
                const lit = dash === -1 ? body.slice(1) : body.slice(1, dash);
                if (lit) { atoms.push({ t: 'lit', v: lit }); }
                continue;
            }
            throw new GrammarError(`unsupported bracket [${body}]`);
        }
        // 仏暦等のカレンダー修飾（B1/B2）は文法外
        if ((ch === 'B' || ch === 'b') && (src[i + 1] === '1' || src[i + 1] === '2')) {
            throw new GrammarError('buddhist calendar modifier');
        }
        // AM/PM / A/P
        if (/^AM\/PM/i.test(src.slice(i))) { atoms.push({ t: 'ampm', wide: true }); i += 5; continue; }
        if (/^A\/P/i.test(src.slice(i))) { atoms.push({ t: 'ampm', wide: false }); i += 3; continue; }
        if (CODE_CHARS.indexOf(ch) !== -1) { atoms.push({ t: 'code', v: ch }); i++; continue; }
        atoms.push({ t: 'lit', v: ch });                                            // その他（¥ 空白 () 等）はリテラル
        i++;
    }
    return atoms;
}

// セクション分割（引用・ブラケットを跨がない ;）
function splitSections(fmt) {
    const out = [];
    let cur = '';
    let q = false, br = false;
    for (const ch of fmt) {
        if (q) { cur += ch; if (ch === '"') { q = false; } continue; }
        if (br) { cur += ch; if (ch === ']') { br = false; } continue; }
        if (ch === '"') { q = true; cur += ch; continue; }
        if (ch === '[') { br = true; cur += ch; continue; }
        if (ch === ';') { out.push(cur); cur = ''; continue; }
        cur += ch;
    }
    out.push(cur);
    return out;
}

// ── 日付コア（Date 不使用の純関数） ─────────────────────────────────────
function civilFromDays(z) { // z = days since 1970-01-01
    z += 719468;
    const era = Math.floor(z / 146097);
    const doe = z - era * 146097;
    const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
    const y = yoe + era * 400;
    const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
    const mp = Math.floor((5 * doy + 2) / 153);
    const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
    const m = mp < 10 ? mp + 3 : mp - 9;
    return { y: m <= 2 ? y + 1 : y, m, d };
}

/** serial → {y,m,d,dow,h,mi,s,subsec}（1900 閏年バグ + date1904 + 時刻繰り上げ） */
function serialToParts(serial, date1904, subsecDigits) {
    let days = Math.floor(serial);
    const frac = serial - days;
    const p = Math.pow(10, subsecDigits || 0);
    let totalSec = Math.round(frac * 86400 * p) / p;
    if (totalSec >= 86400) { days += 1; totalSec -= 86400; }
    const secInt = Math.floor(totalSec);
    const subsec = totalSec - secInt;
    const h = Math.floor(secInt / 3600);
    const mi = Math.floor((secInt % 3600) / 60);
    const s = secInt % 60;
    let y, m, d, z;
    if (date1904) {
        z = days + 1462 - 25569; // epoch 1899-12-30 → days since 1970-01-01
        ({ y, m, d } = civilFromDays(z));
    } else if (days === 60) {
        y = 1900; m = 2; d = 29; z = -25508; // 架空日（dow は Excel も矛盾を抱える — 前日扱い）
    } else if (days === 0) {
        y = 1900; m = 1; d = 0; z = -25568;
    } else if (days < 60) {
        z = days - 25568; // epoch 1899-12-31
        ({ y, m, d } = civilFromDays(z));
    } else {
        z = days - 25569; // epoch 1899-12-30
        ({ y, m, d } = civilFromDays(z));
    }
    const dow = ((z % 7) + 7 + 4) % 7; // 1970-01-01 = Thu(4)
    return { y, m, d, dow, h, mi, s, subsec, serial };
}

function eraOf(y, m, d) {
    for (const e of ERAS) {
        if (y > e.y || (y === e.y && (m > e.m || (m === e.m && d >= e.d)))) { return e; }
    }
    return ERAS[ERAS.length - 1];
}

const pad = (n, w) => String(n).padStart(w, '0');

// ── 日付エンジン ────────────────────────────────────────────────────────
function formatDate(atoms, value, opts) {
    // subsec 桁（ss 直後の .0..）を先に数える
    let subsecDigits = 0;
    for (let i = 0; i < atoms.length; i++) {
        if (atoms[i].t === 'code' && atoms[i].v === '.' && atoms[i + 1] && atoms[i + 1].t === 'code' && atoms[i + 1].v === '0') {
            let j = i + 1;
            while (atoms[j] && atoms[j].t === 'code' && atoms[j].v === '0') { subsecDigits++; j++; }
        }
    }
    const parts = serialToParts(value, !!opts.date1904, subsecDigits);
    // code 連続をトークン run に畳む
    const runs = [];
    for (let i = 0; i < atoms.length;) {
        const a = atoms[i];
        if (a.t === 'code' && /[ymdhsge0.]/.test(a.v)) {
            const ch = a.v;
            let n = 0;
            while (atoms[i] && atoms[i].t === 'code' && atoms[i].v === ch) { n++; i++; }
            runs.push({ t: 'run', ch, n });
            continue;
        }
        runs.push(a);
        i++;
    }
    // m 曖昧性解消: 直前が h（または経過 h）→ 分。次の run が s → 分。それ以外は月
    const isTime = (r) => r && ((r.t === 'run' && (r.ch === 'h' || r.ch === 's')) || (r.t === 'elapsed'));
    const prevDateRun = (idx) => { for (let j = idx - 1; j >= 0; j--) { const r = runs[j]; if (r.t === 'run' && /[ymdhsg]/.test(r.ch) || r.t === 'elapsed') { return r; } } return null; };
    const nextDateRun = (idx) => { for (let j = idx + 1; j < runs.length; j++) { const r = runs[j]; if (r.t === 'run' && /[ymdhsg]/.test(r.ch) || r.t === 'elapsed') { return r; } } return null; };
    const hasAmPm = runs.some((r) => r.t === 'ampm');
    let color;
    const out = [];
    const era = eraOf(parts.y, parts.m, parts.d);
    for (let i = 0; i < runs.length; i++) {
        const r = runs[i];
        if (r.t === 'lit') { out.push(r.v); continue; }
        if (r.t === 'color') { color = r.v; continue; }
        if (r.t === 'cond') { continue; }
        if (r.t === 'ampm') { out.push(parts.h < 12 ? (r.wide ? 'AM' : 'A') : (r.wide ? 'PM' : 'P')); continue; }
        if (r.t === 'elapsed') {
            const total = Math.round(parts.serial * 86400);
            if (r.v === 'h') { out.push(pad(Math.floor(total / 3600), r.n)); }
            else if (r.v === 'm') { out.push(pad(Math.floor(total / 60), r.n)); }
            else { out.push(pad(total, r.n)); }
            continue;
        }
        if (r.t === 'code') { out.push(r.v === 'E' || r.v === '+' ? r.v : r.v); continue; }
        // run
        switch (r.ch) {
            case 'y': out.push(r.n >= 3 ? pad(parts.y, 4) : pad(parts.y % 100, 2)); break;
            case 'm': {
                const prev = prevDateRun(i);
                const next = nextDateRun(i);
                const minute = (prev && ((prev.t === 'run' && prev.ch === 'h') || (prev.t === 'elapsed' && prev.v === 'h')))
                    || (next && next.t === 'run' && next.ch === 's');
                if (minute) { out.push(r.n >= 2 ? pad(parts.mi, 2) : String(parts.mi)); }
                else if (r.n >= 4) { out.push(MONTHS[parts.m - 1]); }
                else if (r.n === 3) { out.push(MONTHS[parts.m - 1].slice(0, 3)); }
                else { out.push(r.n === 2 ? pad(parts.m, 2) : String(parts.m)); }
                break;
            }
            case 'd':
                if (r.n >= 4) { out.push(DOWS[parts.dow]); }
                else if (r.n === 3) { out.push(DOWS[parts.dow].slice(0, 3)); }
                else { out.push(r.n === 2 ? pad(parts.d, 2) : String(parts.d)); }
                break;
            case 'h': {
                let h = parts.h;
                if (hasAmPm) { h = h % 12; if (h === 0) { h = 12; } }
                out.push(r.n >= 2 ? pad(h, 2) : String(h));
                break;
            }
            case 's': out.push(r.n >= 2 ? pad(parts.s, 2) : String(parts.s)); break;
            case 'g': out.push(r.n >= 3 ? era.ggg : r.n === 2 ? era.gg : era.g); break;
            case 'e': { // 和暦年（era 年）。ge 文脈以外（西暦 e）も era 年として扱う（サブセット）
                const ey = parts.y - era.y + 1;
                out.push(r.n >= 2 ? pad(ey, 2) : String(ey));
                break;
            }
            case '.': out.push('.'); break;
            case '0': { // サブ秒（.0..）
                const digits = r.n;
                out.push(String(Math.round(parts.subsec * Math.pow(10, digits))).padStart(digits, '0'));
                break;
            }
            default: out.push(r.ch.repeat(r.n));
        }
    }
    return { text: out.join(''), color };
}

// ── General ────────────────────────────────────────────────────────────
function generalNumber(v) {
    if (!Number.isFinite(v)) { return String(v); }
    if (v === 0) { return '0'; }
    const x = Number(v.toPrecision(15)); // 15 有効桁丸め（FP ノイズ除去）
    const ax = Math.abs(x);
    if (Number.isInteger(x) && ax < 1e11) { return String(x); }
    if (ax >= 1e11 || ax < 1e-4) {
        const es = x.toExponential(5); // 仮数 6 有効桁
        const [mant, exp] = es.split('e');
        const m = mant.replace(/\.?0+$/, '');
        const en = parseInt(exp, 10);
        return `${m}E${en < 0 ? '-' : '+'}${pad(Math.abs(en), 2)}`;
    }
    const intDigits = Math.max(1, Math.floor(Math.log10(ax)) + 1);
    const decs = Math.max(0, 10 - intDigits);
    let s = x.toFixed(decs);
    if (s.indexOf('.') !== -1) { s = s.replace(/0+$/, '').replace(/\.$/, ''); }
    return s;
}

// ── 数値エンジン ────────────────────────────────────────────────────────
function formatNumberSection(atoms, value, autoNegative) {
    let color;
    // 事前スキャン: %・末尾カンマスケール・E フォーマット・マスク
    let percents = 0;
    let hasFraction = false;
    let expIdx = -1;
    for (let i = 0; i < atoms.length; i++) {
        const a = atoms[i];
        if (a.t !== 'code') { continue; }
        if (a.v === '%') { percents++; }
        if (a.v === '/') { hasFraction = true; }
        if (a.v === 'E' && atoms[i + 1] && atoms[i + 1].t === 'code' && (atoms[i + 1].v === '+' || atoms[i + 1].v === '-')) { expIdx = i; }
    }
    if (hasFraction) { throw new GrammarError('fraction format (decimal degrade)'); }
    const isDigit = (a) => a && a.t === 'code' && (a.v === '0' || a.v === '#' || a.v === '?');
    // int/dec マスク収集（E の前まで）
    const limit = expIdx === -1 ? atoms.length : expIdx;
    let seenPoint = false;
    let intMask = '', decMask = '';
    let grouping = false, scale = 0;
    for (let i = 0; i < limit; i++) {
        const a = atoms[i];
        if (a.t !== 'code') { continue; }
        if (a.v === '.') { seenPoint = true; continue; }
        if (a.v === ',') {
            // 後続に digit placeholder があるか（あれば千位区切り・なければスケール）
            let hasLater = false;
            for (let j = i + 1; j < limit; j++) { if (isDigit(atoms[j])) { hasLater = true; break; } }
            if (hasLater) { grouping = true; } else if (!seenPoint) { scale++; }
            continue;
        }
        if (isDigit(a)) { (seenPoint ? decMask += a.v : intMask += a.v); }
    }
    let v = value;
    if (autoNegative) { v = Math.abs(v); }
    v = v * Math.pow(100, percents) / Math.pow(1000, scale);
    v = Number(v.toPrecision(15)); // スケーリング後にも 15 桁丸め（45.6% 問題）

    let intStr = '', decStr = '', expStr = '';
    if (expIdx !== -1) {
        // 指数: 仮数の整数桁数を intMask の placeholder 数に合わせる（engineering 対応）
        const intPh = Math.max(1, intMask.length);
        const decPh = decMask.length;
        let e = v === 0 ? 0 : Math.floor(Math.log10(Math.abs(v)));
        e = Math.floor(e / intPh) * intPh;
        let mant = v / Math.pow(10, e);
        mant = Number(mant.toFixed(decPh));
        const [mi, md] = String(mant.toFixed(decPh)).split('.');
        intStr = mi; decStr = md || '';
        // 指数部マスク（E の後の +/- と 0 の数）
        let expDigits = 0;
        for (let j = expIdx + 2; j < atoms.length; j++) {
            if (atoms[j].t === 'code' && atoms[j].v === '0') { expDigits++; } else { break; }
        }
        const showPlus = atoms[expIdx + 1].v === '+';
        expStr = 'E' + (e < 0 ? '-' : (showPlus ? '+' : '')) + pad(Math.abs(e), expDigits || 1);
    } else {
        const maxDec = decMask.length;
        const fixed = Math.abs(v) < 1e21 ? v.toFixed(maxDec) : String(v);
        const [i0, d0] = fixed.split('.');
        intStr = i0.replace('-', '');
        // dec: 末尾 # を trim（最後の '0' 位置までは残す）
        let minDec = 0;
        for (let j = decMask.length - 1; j >= 0; j--) { if (decMask[j] === '0') { minDec = j + 1; break; } }
        decStr = (d0 || '').slice(0, maxDec);
        while (decStr.length > minDec && decStr.endsWith('0')) { decStr = decStr.slice(0, -1); }
        // int: 最小桁ゼロ埋め（最初の '0' から右の長さ）
        const firstZero = intMask.indexOf('0');
        const minInt = firstZero === -1 ? 0 : intMask.length - firstZero;
        if (intStr === '0' && minInt === 0) { intStr = ''; }
        intStr = intStr.padStart(minInt, '0');
        if (grouping) { intStr = intStr.replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
    }
    const negative = value < 0 && !autoNegative ? false : value < 0; // autoNegative 時のみ '-' 前置
    const sign = (value < 0 && autoNegative) ? '-' : '';

    // 出力組み立て: 最初の digit run に int（+sign）、'.'、最初の dec run に dec、E 部
    const out = [];
    let intDone = false, decDone = false, pointDone = false, expDone = false;
    let i = 0;
    while (i < atoms.length) {
        const a = atoms[i];
        if (a.t === 'lit') { out.push(a.v); i++; continue; }
        if (a.t === 'color') { color = a.v; i++; continue; }
        if (a.t === 'cond') { i++; continue; }
        if (a.t === 'code') {
            if (a.v === 'E' && expIdx === i) {
                out.push(expStr);
                // E の後の +/-/0 群をスキップ
                i++;
                if (atoms[i] && atoms[i].t === 'code' && (atoms[i].v === '+' || atoms[i].v === '-')) { i++; }
                while (atoms[i] && atoms[i].t === 'code' && atoms[i].v === '0') { i++; }
                expDone = true;
                continue;
            }
            if (a.v === '%') { out.push('%'); i++; continue; }
            if (a.v === ',') { i++; continue; }
            if (a.v === '.') {
                if (!pointDone) {
                    pointDone = true;
                    if (decStr.length > 0) { out.push('.'); }
                }
                i++;
                continue;
            }
            if (a.v === '0' || a.v === '#' || a.v === '?') {
                if (!pointDone) {
                    if (!intDone) { out.push(sign + intStr); intDone = true; }
                } else if (!decDone) { out.push(decStr); decDone = true; }
                i++;
                continue;
            }
            out.push(a.v); // 想定外 code はリテラル扱い（部分未対応の縮退）
            i++;
            continue;
        }
        i++;
    }
    if (!intDone && (intStr || sign)) { out.unshift(sign + intStr); } // digit placeholder が無い異形
    return { text: out.join(''), color };
}

// ── セクション判定・エントリポイント ────────────────────────────────────
function sectionHasDateTokens(src) {
    // 引用・エスケープを除去。経過時間ブラケットは先に判定し、残りのブラケット（[Red]/[$..] 等）は
    // 中身ごと除去してから日付トークン文字を探す（"Red" の d / "Bogus" の g,s の誤判定防止）
    const noQuote = src.replace(/"[^"]*"/g, '').replace(/\\./g, '');
    if (/\[(h+|m+|s+)\]/i.test(noQuote) || /AM\/PM|A\/P/i.test(noQuote)) { return true; }
    const noBracket = noQuote.replace(/\[[^\]]*\]/g, '');
    const noExp = noBracket.replace(/[Ee][+-]/g, '');
    return /[ymdhsg]/i.test(noExp);
}

function sectionCondition(atoms) {
    for (const a of atoms) { if (a.t === 'cond') { return a; } }
    return null;
}
function matchCond(cond, v) {
    switch (cond.op) {
        case '<': return v < cond.num;
        case '<=': return v <= cond.num;
        case '>': return v > cond.num;
        case '>=': return v >= cond.num;
        case '=': return v === cond.num;
        case '<>': return v !== cond.num;
        default: return false;
    }
}

function formatTextSection(src, value) {
    const atoms = tokenizeSection(src);
    const out = [];
    let color;
    for (const a of atoms) {
        if (a.t === 'lit') { out.push(a.v); }
        else if (a.t === 'color') { color = a.v; }
        else if (a.t === 'code' && a.v === '@') { out.push(String(value)); }
    }
    return { text: out.join(''), color };
}

const GENERIC_DATE_FMT = 'yyyy/m/d h:mm';

/**
 * formatCell(value, type, fmt, opts) → { text, alignHint, color?, fallback? }
 *  type: 'n' | 'str' | 'b' | 'e'（str は共有文字列/inlineStr/数式文字列を包含）
 *  fmt: ビルトイン ID（number）or 書式文字列。opts: { date1904?, locale? = 'ja' }
 */
export function formatCell(value, type, fmt, opts = {}) {
    // 非数値タイプは書式適用外（Excel 同様、テキストは @ セクション以外そのまま）
    if (type === 'b') { return { text: value ? 'TRUE' : 'FALSE', alignHint: 'center' }; }
    if (type === 'e') { return { text: String(value), alignHint: 'center' }; }
    const fmtStr = typeof fmt === 'number'
        ? ((opts.locale !== 'en' && BUILTIN_JA[fmt]) || BUILTIN_EN[fmt] || 'General')
        : String(fmt || 'General');

    if (type !== 'n') {
        // テキスト: @ を含むセクション（慣例上 4 番目 or 唯一）があれば適用
        const sections = splitSections(fmtStr);
        const textSec = sections.length >= 4 ? sections[3] : (sections.length === 1 && sections[0].indexOf('@') !== -1 ? sections[0] : null);
        if (textSec !== null) {
            try {
                const r = formatTextSection(textSec, value);
                return { text: r.text, alignHint: 'left', color: r.color };
            } catch { /* fallthrough */ }
        }
        return { text: String(value), alignHint: 'left' };
    }

    const v = Number(value);
    if (fmtStr === 'General') { return { text: generalNumber(v), alignHint: 'right' }; }
    try {
        const sections = splitSections(fmtStr);
        // 条件付きセクションの選択
        let chosen = null;
        let autoNegative = false;
        const conds = sections.map((s) => {
            try { return sectionCondition(tokenizeSection(s)); } catch { return null; }
        });
        const hasCond = conds.some((c) => c !== null);
        if (hasCond) {
            for (let i = 0; i < sections.length; i++) {
                if (conds[i] ? matchCond(conds[i], v) : true) { chosen = sections[i]; break; }
            }
            if (chosen === null) { chosen = sections[sections.length - 1]; }
        } else if (sections.length === 1) {
            chosen = sections[0]; autoNegative = true; // 負は自動 '-'（abs + sign 前置）
        } else if (sections.length === 2) {
            chosen = v < 0 ? sections[1] : sections[0];
        } else {
            chosen = v < 0 ? sections[1] : (v === 0 ? sections[2] : sections[0]);
        }
        const negAbs = !autoNegative && v < 0; // 明示負セクションは絶対値整形
        const atoms = tokenizeSection(chosen);
        if (sectionHasDateTokens(chosen)) {
            const r = formatDate(atoms, v, opts);
            return { text: r.text, alignHint: 'right', color: r.color };
        }
        const r = formatNumberSection(atoms, negAbs ? Math.abs(v) : v, autoNegative);
        return { text: r.text, alignHint: 'right', color: r.color };
    } catch (e) {
        // 縮退: 日付トークン含有 → 汎用日付 / それ以外 → General
        if (sectionHasDateTokens(fmtStr)) {
            try {
                const r = formatDate(tokenizeSection(GENERIC_DATE_FMT), v, opts);
                return { text: r.text, alignHint: 'right', fallback: 'date' };
            } catch { /* fallthrough */ }
        }
        return { text: generalNumber(v), alignHint: 'right', fallback: 'general' };
    }
}

export { generalNumber, serialToParts };
