/**
 * md.ts — md 本文の読み取り（見出し・subpage・添付）と、位置を決めた挿入（fractal_attach / fractal_add の md へのリンク挿入）。
 * 見出しの解釈は正典 src/shared/md-h1-utils.ts（D9: mjs の H1 ミラーは廃止）。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractFirstH1, parseAtxHeadingText } from '../../../src/shared/md-h1-utils';
import { ToolError } from './guard';
import { MatchMode, textMatches, truncate } from './outdoc';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser = require('../../../src/shared/markdown-link-parser');

export interface Heading { level: number; text: string; line: number; path: string }

function eolOf(body: string): string { return body.includes('\r\n') ? '\r\n' : '\n'; }

/** 見出し一覧（``` / ~~~ フェンスの中は見出しにしない。テキストは正典 parseAtxHeadingText） */
export function scanHeadings(body: string): Heading[] {
    const lines = body.split('\n');
    const out: Heading[] = [];
    const stack: Heading[] = [];
    let fence: string | null = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].replace(/\r$/, '');
        const f = line.match(/^ {0,3}(```|~~~)/);
        if (f) { if (!fence) { fence = f[1]; } else if (line.trimStart().startsWith(fence)) { fence = null; } continue; }
        if (fence) { continue; }
        const m = line.match(/^ {0,3}(#{1,6})[ \t]/);
        if (!m) { continue; }
        const text = parseAtxHeadingText(line);
        if (text === null) { continue; }
        const level = m[1].length;
        while (stack.length && stack[stack.length - 1].level >= level) { stack.pop(); }
        const h: Heading = { level, text, line: i, path: [...stack.map((s) => s.text), text].join(' > ') };
        stack.push(h);
        out.push(h);
    }
    return out;
}

export function resolveHeading(body: string, ref: string, match: MatchMode = 'exact'): Heading {
    const hs = scanHeadings(body);
    const hits = hs.filter((h) => textMatches(h.text, ref, match) || (match === 'exact' && h.path === ref.trim()));
    if (hits.length === 1) { return hits[0]; }
    const cand = (h: Heading) => ({ text: truncate(h.text, 80), level: h.level, line: h.line + 1, path: h.path });
    if (hits.length === 0) {
        throw new ToolError('NOT_FOUND', `見出し「${ref}」がありません。headings から選んでください（fractal_get の headings）。`,
            { ref, match, headings: hs.slice(0, 50).map(cand) });
    }
    throw new ToolError('AMBIGUOUS', `見出し「${ref}」が ${hits.length} 個あります。親の見出しを含めた path（例: "親 > 子"）で指定してください。`,
        { ref, match, count: hits.length, candidates: hits.slice(0, 30).map(cand) });
}

export type MdPosition = 'end' | 'start';

/**
 * block（1 行以上の md）を本文に入れる。前後は空行 1 つで区切る。
 * - heading 指定: その見出しの節の末尾（end・既定 = 次の同じか上のレベルの見出しの前）/ 見出しの直後（start）
 * - heading 無し: 本文の末尾（end・既定）/ 先頭 H1 の直後（start。H1 が無ければ先頭）
 */
export function insertBlock(body: string, block: string, opts: { heading?: string; match?: MatchMode; position?: MdPosition }): { body: string; insertedAtLine: number } {
    const eol = eolOf(body);
    const lines = body.split(/\r?\n/);
    const blockLines = block.replace(/\r\n/g, '\n').replace(/\n+$/, '').split('\n');
    const position = opts.position ?? 'end';
    let at: number; // 挿入する行 index（この前に入る）
    if (opts.heading) {
        const h = resolveHeading(body, opts.heading, opts.match);
        if (position === 'start') {
            at = h.line + 1;
        } else {
            const hs = scanHeadings(body);
            const next = hs.find((x) => x.line > h.line && x.level <= h.level);
            at = next ? next.line : lines.length;
        }
    } else if (position === 'start') {
        const h1 = scanHeadings(body).find((x) => x.level === 1);
        const firstNonEmpty = lines.findIndex((l) => l.trim() !== '');
        at = h1 && h1.line === firstNonEmpty ? h1.line + 1 : 0;
    } else {
        at = lines.length;
    }
    // 挿入位置の前の空行を詰め（節の末尾の空行の後ろでなく中身の直後に付ける）、前後に空行 1 つ
    const before = lines.slice(0, at);
    const after = lines.slice(at);
    while (before.length && before[before.length - 1].trim() === '') { before.pop(); }
    let afterTrim = after;
    while (afterTrim.length && afterTrim[0].trim() === '') { afterTrim = afterTrim.slice(1); }
    const sepBefore = before.length ? [''] : [];
    const sepAfter = afterTrim.length ? [''] : [];
    const insertedAtLine = before.length + sepBefore.length;
    const outLines = [...before, ...sepBefore, ...blockLines, ...sepAfter, ...afterTrim];
    let out = outLines.join(eol);
    if (!afterTrim.length) { out += eol; }
    return { body: out, insertedAtLine: insertedAtLine + 1 };
}

// ─── md の参照（get 用） ─────────────────────────────

export interface MdLinks {
    subpages: { label: string; href: string; absPath: string; exists: boolean }[];
    images: { href: string; absPath: string; exists: boolean }[];
    files: { label: string; href: string; absPath: string; exists: boolean }[];
}

function decodeHref(href: string): string {
    const clean = String(href || '').trim().replace(/^<|>$/g, '').replace(/\s+["'][^"']*["']\s*$/, '').split(/[?#]/)[0];
    try { return decodeURIComponent(clean); } catch { return clean; }
}

const isRemote = (u: string) => /^[a-z][a-z0-9+.-]*:/i.test(u) || u.startsWith('#') || u.startsWith('/');

/** md 本文のローカル参照（正典 markdown-link-parser の parseMarkdownLinks。空白・括弧入りのパスも扱える） */
export function collectMdLinks(mdAbs: string, body: string): MdLinks {
    const dir = path.dirname(mdAbs);
    const out: MdLinks = { subpages: [], images: [], files: [] };
    for (const t of parser.parseMarkdownLinks(body) as Array<{ kind: string; alt: string; url: string; isSubpage?: boolean }>) {
        const raw = String(t.url || '').trim();
        if (!raw || isRemote(raw)) { continue; }
        const rel = decodeHref(raw);
        if (!rel) { continue; }
        const abs = path.resolve(dir, rel);
        const exists = fs.existsSync(abs);
        if (t.kind === 'image') { out.images.push({ href: raw, absPath: abs, exists }); continue; }
        const alt = String(t.alt || '').trim();
        if (alt.indexOf('📎') === 0) { out.files.push({ label: alt.replace(/^📎\s*/, ''), href: raw, absPath: abs, exists }); continue; }
        if (/\.(md|markdown)$/i.test(rel)) { out.subpages.push({ label: alt, href: raw, absPath: abs, exists }); }
    }
    return out;
}

export function h1Of(body: string): string | null { return extractFirstH1(body); }
