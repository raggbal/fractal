#!/usr/bin/env node
/**
 * fractal-summary.mjs — Outliner / md の全内容を 1 本の Markdown にまとめる（read-only）
 *
 * AI が「要約して」「全体を読んで」に答えるための入力を作る。対象は 2 種:
 *
 * 【Outliner】--note <path.out>
 *   # <outline title>
 *   （ネスト箇条書きツリー。checked は - [x] / - [ ]、page ノードは (→ Pages) 印）
 *   ## Pages
 *   ### <node text>   ← page ごと
 *   <page md 本文（相対パスは絶対パス化）>
 *
 * 【md】--md <path.md>
 *   起点 md の本文 + subpage リンク `[[label]](x.md)` を再帰的に辿って全 subpage の本文を
 *   `## Subpages` セクションに展開（循環は visited で打ち切り・深さ優先）。
 *
 * 使い方:
 *   node fractal-summary.mjs --note path/to/note.out                     # stdout へ
 *   node fractal-summary.mjs --note note.out --out /tmp/summary.md       # ファイルへ
 *   node fractal-summary.mjs --note note.out --node "特定ノード"          # 部分木のみ
 *   node fractal-summary.mjs --md path/to/note/xxx.md                    # md + subpage 再帰
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

/** page md 本文の相対ローカルパスを絶対パスに書き換え（FR-EXP-03）。URL / anchor / 絶対は不変 */
export function absolutizeLocalPaths(md, baseDir) {
    return String(md || '').replace(/(!?\[[^\]]*\]\()([^)\s]+)((?:\s+"[^"]*")?\))/g, (whole, pre, url, post) => {
        if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return whole; // http: / mailto: / fractal: 等
        if (url.startsWith('#') || url.startsWith('/')) return whole;
        let decoded = url;
        try { decoded = decodeURIComponent(url); } catch { /* 生のまま */ }
        return pre + path.resolve(baseDir, decoded) + post;
    });
}

/** target 解決: id → text 完全一致 → 部分一致（fractal-modify と同規約） */
export function resolveNodeId(data, arg) {
    if (data.nodes[arg]) return arg;
    let exact = null, partial = null;
    for (const node of Object.values(data.nodes)) {
        if (node.text === arg) { exact = node.id; break; }
        if (!partial && node.text && node.text.includes(arg)) partial = node.id;
    }
    const found = exact || partial;
    if (!found) throw new Error(`node not found: "${arg}"`);
    return found;
}

/**
 * pure-ish（page md を fs read するのみ）: outliner まとめ markdown 文字列を返す。
 * opts: { rootNodeId?: string|null }
 */
export function summarizeOutline(noteDir, outData, opts = {}) {
    const lines = [];
    const pages = []; // { text, pageId, body }

    const bullet = (n) => {
        const check = n.checked === true ? '[x] ' : n.checked === false ? '[ ] ' : '';
        const pageMark = n.isPage && n.pageId ? ' *(→ Pages)*' : '';
        const fileMark = n.filePath ? ` *(file: ${n.filePath})*` : '';
        const imgMark = (n.images && n.images.length) ? ` *(images: ${n.images.join(', ')})*` : '';
        return `${check}${n.text || '(untitled)'}${pageMark}${fileMark}${imgMark}`;
    };

    const walk = (id, depth) => {
        const n = outData.nodes[id];
        if (!n) return;
        lines.push(`${'  '.repeat(depth)}- ${bullet(n)}`);
        if (n.isPage && n.pageId) {
            const mdAbs = path.join(noteDir, `${n.pageId}.md`);
            let body = null;
            try { body = fs.readFileSync(mdAbs, 'utf-8'); } catch { body = null; }
            pages.push({ text: n.text || '(untitled)', pageId: n.pageId, body });
        }
        for (const c of (n.children || [])) walk(c, depth + 1);
    };

    const rootIds = opts.rootNodeId ? [opts.rootNodeId] : (outData.rootIds || []);
    for (const id of rootIds) walk(id, 0);

    const out = [];
    out.push(`# ${outData.title || 'Untitled'}`);
    out.push('');
    out.push(...lines);
    if (pages.length > 0) {
        out.push('');
        out.push('## Pages');
        for (const p of pages) {
            out.push('');
            out.push(`### ${p.text}`);
            out.push('');
            if (p.body === null) {
                out.push(`*(page md not found: ${p.pageId}.md)*`);
            } else {
                // 本文の相対パスは export md がどこに置かれても切れないよう絶対化
                out.push(absolutizeLocalPaths(p.body, noteDir).trimEnd());
            }
        }
    }
    out.push('');
    return out.join('\n');
}

// ─────────────── md モード（subpage 再帰） ───────────────

/**
 * md 本文から subpage リンク `[[label]](url)` を抽出する
 * （正典: src/webview/markdown-link-parser.js の subpage 分岐。ラベルに `]` は含まない前提）。
 * ローカル相対 .md のみ返す（URL / anchor / 絶対パスは対象外）。
 */
export function extractSubpageLinks(md) {
    const links = [];
    const re = /\[\[([^\]]*)\]\]\(([^)\s]+)\)/g;
    let m;
    while ((m = re.exec(String(md || ''))) !== null) {
        const url = m[2];
        if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith('#') || url.startsWith('/')) continue;
        let decoded = url;
        try { decoded = decodeURIComponent(url); } catch { /* 生のまま */ }
        if (!decoded.toLowerCase().endsWith('.md')) continue;
        links.push({ label: m[1], url: decoded });
    }
    return links;
}

/**
 * pure-ish（md を fs read するのみ）: 起点 md + subpage 再帰の全内容を 1 本の markdown で返す。
 * 相対リンク解決は dirname(現md) 基準（本体 notesEditorProvider.ts:1278 と同規約）。
 * 循環・重複は visited（絶対パス）で 1 回だけ展開。
 */
export function summarizeMd(rootMdPath) {
    const rootAbs = path.resolve(rootMdPath);
    if (!fs.existsSync(rootAbs)) throw new Error(`md not found: ${rootAbs}`);

    const visited = new Set([rootAbs]);
    const subpages = []; // { label, abs, body|null } 深さ優先の発見順
    const walk = (mdAbs, body) => {
        for (const { label, url } of extractSubpageLinks(body)) {
            const abs = path.resolve(path.dirname(mdAbs), url); // dirname(現md) 基準
            if (visited.has(abs)) continue;
            visited.add(abs);
            let childBody = null;
            try { childBody = fs.readFileSync(abs, 'utf-8'); } catch { /* 欠落は注記 */ }
            subpages.push({ label, abs, body: childBody });
            if (childBody !== null) walk(abs, childBody);
        }
    };

    const rootBody = fs.readFileSync(rootAbs, 'utf-8');
    walk(rootAbs, rootBody);

    const out = [];
    out.push(absolutizeLocalPaths(rootBody, path.dirname(rootAbs)).trimEnd());
    if (subpages.length > 0) {
        out.push('');
        out.push('## Subpages');
        for (const s of subpages) {
            out.push('');
            out.push(`### ${s.label || path.basename(s.abs)}`);
            out.push('');
            if (s.body === null) {
                out.push(`*(subpage md not found: ${s.abs})*`);
            } else {
                out.push(absolutizeLocalPaths(s.body, path.dirname(s.abs)).trimEnd());
            }
        }
    }
    out.push('');
    return out.join('\n');
}

// --- CLI ---

function main() {
    const argv = process.argv;
    let note = null, mdArg = null, outFile = null, nodeArg = null;
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--note': note = argv[++i]; break;
            case '--md': mdArg = argv[++i]; break;
            case '--out': outFile = argv[++i]; break;
            case '--node': nodeArg = argv[++i]; break;
            case '-h': case '--help':
                console.log('Usage: fractal-summary.mjs (--note <path.out> [--node <id|text>] | --md <path.md>) [--out <file.md>]');
                console.log('Outliner または md（subpage 再帰込み）の全内容を 1 本の markdown にまとめる。--out 省略時 stdout。');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`); process.exit(1);
        }
    }
    if (!note && !mdArg) { console.error('Error: --note or --md is required'); process.exit(1); }
    if (note && mdArg) { console.error('Error: --note and --md are mutually exclusive'); process.exit(1); }

    let md;
    if (mdArg) {
        // md モード（subpage 再帰）
        if (nodeArg) { console.error('Error: --node is only for --note mode'); process.exit(1); }
        try { md = summarizeMd(mdArg); }
        catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
    } else {
        let notePath = path.resolve(note);
        if (!notePath.endsWith('.out')) notePath += '.out';
        if (!fs.existsSync(notePath)) { console.error(`Error: .out not found: ${notePath}`); process.exit(1); }

        const data = JSON.parse(fs.readFileSync(notePath, 'utf-8'));
        const noteDir = path.dirname(notePath);

        let rootNodeId = null;
        if (nodeArg) {
            try { rootNodeId = resolveNodeId(data, nodeArg); }
            catch (e) { console.error(`Error: ${e.message}`); process.exit(1); }
        }
        md = summarizeOutline(noteDir, data, { rootNodeId });
    }

    if (outFile) {
        fs.writeFileSync(path.resolve(outFile), md, 'utf-8');
        console.error(`✅ Summary written: ${path.resolve(outFile)} (${md.length} chars)`);
    } else {
        process.stdout.write(md);
    }
}

// unit import 時に実行されないよう main guard
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
