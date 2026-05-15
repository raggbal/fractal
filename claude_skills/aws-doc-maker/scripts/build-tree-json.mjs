#!/usr/bin/env node
/**
 * build-tree-json.mjs
 *
 * Scan an aws-doc-maker output directory (containing 00-index.md and a set of
 * NN-<slug>.md axis files) and emit a tree JSON suitable for
 * `register-fractal.mjs --mode tree`.
 *
 * Tree shape:
 *   {
 *     "title": "<service title from 00-index.md H1, or fallback>",
 *     "file":  "00-index.md",
 *     "children": [
 *       { "title": "<H1 of NN-<slug>.md>", "file": "NN-<slug>.md", "children": [] },
 *       ...
 *     ]
 *   }
 *
 * The root entry uses 00-index.md as its `file`, and every other top-level
 * NN-<slug>.md becomes a leaf child. If 00-index.md is absent, the first
 * NN-<slug>.md (sorted) becomes the root and the rest become siblings — this
 * matches the structure register-fractal.mjs expects.
 *
 * Children are included in numeric order based on the NN- prefix. Sub-axis
 * directories (e.g., 07-authz/index.md + 07-authz/<topic>.md) are flattened
 * under the matching NN- root: index.md becomes the section page, and its
 * siblings become children.
 *
 * Usage:
 *   node build-tree-json.mjs <md-base> [--title "Service Title"] [-o tree.json]
 *
 * If --title is not given, the H1 of 00-index.md is used; if 00-index.md is
 * missing too, the basename of <md-base> is used.
 *
 * Stdout: pretty-printed JSON (also written to -o if given).
 */

import fs from 'node:fs';
import path from 'node:path';

function usage(msg) {
    if (msg) console.error(`Error: ${msg}\n`);
    console.error(
        `Usage: build-tree-json.mjs <md-base> [--title "..."] [-o <output.json>]`
    );
    process.exit(1);
}

function parseArgs(argv) {
    const args = { positional: [] };
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const v = argv[i + 1];
        switch (a) {
            case '--title': args.title = v; i++; break;
            case '-o':
            case '--output': args.output = v; i++; break;
            case '-h':
            case '--help': usage(); break;
            default:
                if (a.startsWith('--')) usage(`unknown option: ${a}`);
                args.positional.push(a);
                break;
        }
    }
    return args;
}

function readH1(mdPath) {
    try {
        const txt = fs.readFileSync(mdPath, 'utf-8');
        const m = txt.match(/^\s*#\s+(.+?)\s*$/m);
        if (m) return m[1].trim();
    } catch {
        // ignore
    }
    return null;
}

function listAxisEntries(mdBase) {
    // Files: NN-<slug>.md  (NN = 2 digits, slug = anything)
    // Dirs:  NN-<slug>/    with index.md + sibling .md files
    const entries = [];
    const items = fs.readdirSync(mdBase, { withFileTypes: true });
    for (const it of items) {
        const name = it.name;
        const m = name.match(/^(\d{2})-(.+?)(\.md)?$/);
        if (!m) continue;
        if (m[3] === '.md' && it.isFile()) {
            entries.push({ kind: 'file', n: parseInt(m[1], 10), name });
        } else if (it.isDirectory()) {
            entries.push({ kind: 'dir', n: parseInt(m[1], 10), name });
        }
    }
    entries.sort((a, b) => a.n - b.n);
    return entries;
}

function buildChild(entry, mdBase) {
    if (entry.kind === 'file') {
        const rel = entry.name;
        const abs = path.join(mdBase, rel);
        return {
            title: readH1(abs) || rel.replace(/\.md$/, ''),
            file: rel,
            children: [],
        };
    }
    // Directory: <dir>/index.md is the section page; siblings become children.
    const dir = entry.name;
    const dirAbs = path.join(mdBase, dir);
    const indexRel = path.join(dir, 'index.md');
    const indexAbs = path.join(mdBase, indexRel);
    const node = {
        title:
            (fs.existsSync(indexAbs) && readH1(indexAbs)) ||
            dir,
        file: fs.existsSync(indexAbs) ? indexRel : null,
        children: [],
    };
    if (!node.file) delete node.file;

    const childItems = fs
        .readdirSync(dirAbs, { withFileTypes: true })
        .filter((it) => it.isFile() && it.name.endsWith('.md') && it.name !== 'index.md')
        .sort((a, b) => a.name.localeCompare(b.name));

    for (const ci of childItems) {
        const rel = path.join(dir, ci.name);
        const abs = path.join(mdBase, rel);
        node.children.push({
            title: readH1(abs) || ci.name.replace(/\.md$/, ''),
            file: rel,
            children: [],
        });
    }
    return node;
}

function buildTree(mdBase, titleOverride) {
    const indexAbs = path.join(mdBase, '00-index.md');
    const entries = listAxisEntries(mdBase);

    if (entries.length === 0) {
        console.error(`No NN-<slug>.md files found under: ${mdBase}`);
        process.exit(1);
    }

    let rootTitle =
        titleOverride ||
        (fs.existsSync(indexAbs) && readH1(indexAbs)) ||
        path.basename(path.resolve(mdBase));
    let rootFile = null;
    let childEntries = entries;

    if (fs.existsSync(indexAbs)) {
        rootFile = '00-index.md';
        // 00 entry would already be in `entries`; drop it from children.
        childEntries = entries.filter((e) => !(e.kind === 'file' && e.name === '00-index.md'));
    } else if (entries[0].kind === 'file') {
        // No index — promote the first file to the root, the rest become siblings.
        const head = entries[0];
        rootTitle = titleOverride || readH1(path.join(mdBase, head.name)) || head.name.replace(/\.md$/, '');
        rootFile = head.name;
        childEntries = entries.slice(1);
    }

    const root = {
        title: rootTitle,
        children: childEntries.map((e) => buildChild(e, mdBase)),
    };
    if (rootFile) root.file = rootFile;
    return root;
}

const args = parseArgs(process.argv);
if (args.positional.length !== 1) usage('exactly one <md-base> argument is required');

const mdBase = path.resolve(args.positional[0]);
if (!fs.existsSync(mdBase) || !fs.statSync(mdBase).isDirectory()) {
    console.error(`md-base directory not found: ${mdBase}`);
    process.exit(1);
}

const tree = buildTree(mdBase, args.title);
const out = JSON.stringify(tree, null, 2);

if (args.output) {
    fs.writeFileSync(path.resolve(args.output), out + '\n', 'utf-8');
    console.error(`Wrote tree JSON to: ${path.resolve(args.output)}`);
}
process.stdout.write(out + '\n');
