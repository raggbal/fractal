#!/usr/bin/env node
/**
 * register-fractal.mjs
 *
 * Register collected Markdown content into a Fractal outliner using the
 * structure:
 *
 *   <outline root>
 *   └── YYYY-MM-DD            ← date node (reused if exists at root)
 *       └── <title>           ← title node (always newly created)
 *           └── single MD page node
 *               or sitemap tree of nodes (web-crawler tree mode)
 *
 * This script orchestrates calls to fractal-edit's fractal-md.mjs:
 *   - creates date / title plain nodes
 *   - imports MD as page node(s)
 *   - for tree mode, recursively replicates a sitemap (e.g., map.json)
 *
 * Usage (single mode — for youtube-md / doc-md / arxiv-md / pptx-pages-md):
 *   node register-fractal.mjs \
 *     --mode single --md path/to/foo.md --fractal-title "Foo" \
 *     --fractal-out /path/notes/abc.out
 *
 *   node register-fractal.mjs \
 *     --mode single --md foo.md --fractal-title "Foo" \
 *     --fractal-notes /Users/you/Desktop/notes --fractal-outline "Research"
 *
 * Usage (tree mode — for web-crawler-md / aws-doc-maker):
 *   node register-fractal.mjs --mode tree \
 *     --tree-json output/map.json --md-base output \
 *     --fractal-title "Stripe API docs" \
 *     --fractal-notes /path/notes --fractal-outline "WebRefs"
 *
 * Options (one of for outline target):
 *   --fractal-out <path.out>       Direct .out file path
 *   --fractal-notes <folder>       Notes folder (used with --fractal-outline)
 *   --fractal-outline <title>      Outline title; auto-creates if missing
 *
 * Required:
 *   --mode single|tree
 *   --fractal-title <text>         Title node text under the date node
 *
 * Single mode:
 *   --md <path>                    Path to the .md file
 *
 * Tree mode:
 *   --tree-json <path>             Sitemap JSON describing the tree
 *   --md-base <dir>                Base directory for file paths in tree JSON
 *
 * Optional:
 *   --fractal-date <YYYY-MM-DD>    Override date (default: today, local timezone)
 *   --fractal-md-script <path>     Path to fractal-edit's fractal-md.mjs
 *                                  (auto-resolved if fractal-edit skill is installed)
 *
 * NOTE: This script does NOT consult any environment variables. Environment
 *       variable handling (e.g., FRACTAL_DEFAULT_OUT) is the responsibility of
 *       the caller (typically the `collect` skill). Callers must resolve the
 *       target outline up-front and pass it via the CLI flags above.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ───────────────────────────── args ─────────────────────────────

function usage(msg) {
    if (msg) console.error(`Error: ${msg}\n`);
    console.error(
        `Usage: register-fractal.mjs --mode single|tree [options]

Outline (one of):
  --fractal-out <path.out>
  --fractal-notes <folder> --fractal-outline <title>

Required:
  --mode single|tree
  --fractal-title <text>

Single mode:
  --md <path>

Tree mode:
  --tree-json <path>
  --md-base <dir>           Base directory for file paths in tree JSON

Optional:
  --fractal-date <YYYY-MM-DD>
  --fractal-md-script <path>`
    );
    process.exit(1);
}

function parseArgs(argv) {
    const args = {};
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];
        const v = argv[i + 1];
        const needs = () => {
            if (v === undefined || v.startsWith('--')) usage(`${a} requires a value`);
        };
        switch (a) {
            case '--mode':              needs(); args.mode = v; i++; break;
            case '--md':                needs(); args.md = v; i++; break;
            case '--tree-json':         needs(); args.treeJson = v; i++; break;
            case '--md-base':           needs(); args.mdBase = v; i++; break;
            case '--fractal-out':       needs(); args.outPath = v; i++; break;
            case '--fractal-notes':     needs(); args.notesDir = v; i++; break;
            case '--fractal-outline':   needs(); args.outlineTitle = v; i++; break;
            case '--fractal-title':     needs(); args.titleNode = v; i++; break;
            case '--fractal-date':      needs(); args.date = v; i++; break;
            case '--fractal-md-script': needs(); args.fractalMdScript = v; i++; break;
            case '-h': case '--help':   usage(); break;
            default:                    usage(`unknown option: ${a}`);
        }
    }
    return args;
}

function expandUser(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

// ─────────────────────── locate fractal-md.mjs ────────────────────────

function locateFractalMd(explicit) {
    if (explicit) {
        const abs = path.resolve(explicit);
        if (!fs.existsSync(abs)) {
            console.error(`fractal-md.mjs not found at: ${abs}`);
            process.exit(1);
        }
        return abs;
    }
    const candidates = [
        path.resolve(__dirname, '..', '..', 'fractal-edit', 'scripts', 'fractal-md.mjs'),
        path.join(os.homedir(), '.claude', 'skills', 'fractal-edit', 'scripts', 'fractal-md.mjs'),
    ];
    for (const c of candidates) {
        if (fs.existsSync(c)) return c;
    }
    console.error(
        `fractal-md.mjs not found. Tried:\n  ${candidates.join('\n  ')}\n` +
        `Pass --fractal-md-script <path> or install the fractal-edit skill.`
    );
    process.exit(1);
}

// ─────────────────────────── helpers ───────────────────────────

function todayISO() {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function isValidDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function readOut(outPath) {
    return JSON.parse(fs.readFileSync(outPath, 'utf-8'));
}

function runFractalMd(script, scriptArgs) {
    const r = spawnSync('node', [script, ...scriptArgs], {
        stdio: ['inherit', 'pipe', 'pipe'],
        encoding: 'utf-8',
    });
    if (r.status !== 0) {
        console.error(`fractal-md.mjs failed (exit ${r.status})`);
        console.error(`  args: ${scriptArgs.join(' ')}`);
        if (r.stdout) console.error(r.stdout);
        if (r.stderr) console.error(r.stderr);
        process.exit(1);
    }
    return r.stdout || '';
}

function findRootNodeByText(data, text) {
    for (const id of data.rootIds || []) {
        const n = data.nodes?.[id];
        if (n && n.text === text) return id;
    }
    return null;
}

function diffNewIds(beforeData, afterData) {
    const before = new Set(Object.keys(beforeData.nodes || {}));
    return Object.keys(afterData.nodes || {}).filter((id) => !before.has(id));
}

function pickNewNodeByParent(afterData, newIds, parentId) {
    for (const id of newIds) {
        if (afterData.nodes[id].parentId === parentId) return id;
    }
    return newIds[0] ?? null;
}

// ───────────────────── outline resolution ─────────────────────

function resolveOutline(args, fractalMd) {
    if (args.outPath) {
        let p = path.resolve(expandUser(args.outPath));
        if (!p.endsWith('.out')) p += '.out';
        if (!fs.existsSync(p)) {
            console.error(`Outline file not found: ${p}`);
            process.exit(1);
        }
        return p;
    }

    if (args.notesDir && args.outlineTitle) {
        const notesDir = path.resolve(args.notesDir);
        if (!fs.existsSync(notesDir) || !fs.statSync(notesDir).isDirectory()) {
            console.error(`Notes folder not found: ${notesDir}`);
            process.exit(1);
        }

        const outlineNotePath = path.join(notesDir, 'outline.note');
        const findExisting = () => {
            if (!fs.existsSync(outlineNotePath)) return null;
            let structure;
            try {
                structure = JSON.parse(fs.readFileSync(outlineNotePath, 'utf-8'));
            } catch {
                return null;
            }
            for (const [id, item] of Object.entries(structure.items || {})) {
                if (item.type === 'file' && item.title === args.outlineTitle) {
                    const candidate = path.join(notesDir, `${id}.out`);
                    if (fs.existsSync(candidate)) return candidate;
                }
            }
            return null;
        };

        const existing = findExisting();
        if (existing) return existing;

        // Not found → auto-create via fractal-md.mjs
        console.log(`Creating new outline: "${args.outlineTitle}" in ${notesDir}`);
        runFractalMd(fractalMd, [
            '--create-outliner',
            args.outlineTitle,
            '--notes-dir',
            notesDir,
        ]);

        const created = findExisting();
        if (!created) {
            console.error(`Failed to locate newly-created outline: ${args.outlineTitle}`);
            process.exit(1);
        }
        return created;
    }

    usage('must specify --fractal-out OR (--fractal-notes + --fractal-outline)');
}

// ─────────────────────── date / title nodes ───────────────────────

function ensureDateNode(outPath, dateText, fractalMd) {
    const before = readOut(outPath);
    const existing = findRootNodeByText(before, dateText);
    if (existing) {
        console.log(`Reusing date node: ${dateText} (${existing})`);
        return existing;
    }
    runFractalMd(fractalMd, ['--note', outPath, '--text', dateText]);
    const after = readOut(outPath);
    const created = findRootNodeByText(after, dateText);
    if (!created) {
        console.error(`Failed to create date node: ${dateText}`);
        process.exit(1);
    }
    console.log(`Created date node: ${dateText} (${created})`);
    return created;
}

function createTitleNode(outPath, dateNodeId, titleText, fractalMd) {
    const before = readOut(outPath);
    runFractalMd(fractalMd, [
        '--note', outPath,
        '--text', titleText,
        '--parent', dateNodeId,
    ]);
    const after = readOut(outPath);
    const newIds = diffNewIds(before, after);
    const id = pickNewNodeByParent(after, newIds, dateNodeId);
    if (!id) {
        console.error(`Failed to create title node: ${titleText}`);
        process.exit(1);
    }
    console.log(`Created title node: "${titleText}" (${id})`);
    return id;
}

// ─────────────────────── single MD registration ────────────────────────

function registerSingleMd(outPath, parentNodeId, mdPath, fractalMd) {
    const before = readOut(outPath);
    runFractalMd(fractalMd, [
        '--note', outPath,
        '--md', mdPath,
        '--parent', parentNodeId,
    ]);
    const after = readOut(outPath);
    const newIds = diffNewIds(before, after);
    const id = pickNewNodeByParent(after, newIds, parentNodeId);
    if (!id) {
        console.error(`Failed to register MD page node`);
        process.exit(1);
    }
    return id;
}

// ─────────────────────── tree (sitemap) registration ────────────────────

/**
 * Process a sitemap tree node. Inserts it under `parentNodeId`, or as the
 * sibling after `prevSiblingId` (so children preserve sitemap order).
 *
 * Returns the new node's id (becomes the prevSibling for its next sibling).
 */
function processTreeNode(treeNode, outPath, parentNodeId, prevSiblingId, mdBase, fractalMd) {
    const title = treeNode.title || '(untitled)';
    const insertArgs = ['--note', outPath];

    if (prevSiblingId) {
        insertArgs.push('--parent', prevSiblingId, '--position', 'after');
    } else {
        insertArgs.push('--parent', parentNodeId, '--position', 'child');
    }

    let useFile = null;
    if (treeNode.file) {
        const mdPath = path.join(mdBase, treeNode.file);
        if (fs.existsSync(mdPath)) {
            useFile = mdPath;
        } else {
            console.warn(`  MD missing, creating plain node: ${mdPath}`);
        }
    }

    if (useFile) {
        insertArgs.push('--md', useFile, '--text', title);
    } else {
        insertArgs.push('--text', title);
    }

    const before = readOut(outPath);
    runFractalMd(fractalMd, insertArgs);
    const after = readOut(outPath);
    const newIds = diffNewIds(before, after);

    // Resolve the new node's actual parent (== prevSibling.parentId in 'after' mode)
    const expectedParent = prevSiblingId
        ? after.nodes[prevSiblingId].parentId
        : parentNodeId;
    const createdId = pickNewNodeByParent(after, newIds, expectedParent);

    if (!createdId) {
        console.error(`Failed to create tree node: ${title}`);
        process.exit(1);
    }

    // Recurse into children
    let childPrev = null;
    for (const child of treeNode.children || []) {
        childPrev = processTreeNode(child, outPath, createdId, childPrev, mdBase, fractalMd);
    }

    return createdId;
}

// ────────────────────────────── main ──────────────────────────────

const args = parseArgs(process.argv);

if (!args.mode || !['single', 'tree'].includes(args.mode)) {
    usage('--mode must be "single" or "tree"');
}
if (!args.titleNode) usage('--fractal-title is required');
if (args.date && !isValidDate(args.date)) usage('--fractal-date must be YYYY-MM-DD');

if (args.mode === 'single' && !args.md) usage('--md is required in single mode');
if (args.mode === 'tree' && !args.treeJson) usage('--tree-json is required in tree mode');
if (args.mode === 'tree' && !args.mdBase) usage('--md-base is required in tree mode');

const fractalMd = locateFractalMd(args.fractalMdScript);
const outPath = resolveOutline(args, fractalMd);
const dateText = args.date || todayISO();

console.log(`Outline: ${outPath}`);
console.log(`Date:    ${dateText}`);
console.log(`Title:   ${args.titleNode}`);

const dateId = ensureDateNode(outPath, dateText, fractalMd);
const titleId = createTitleNode(outPath, dateId, args.titleNode, fractalMd);

if (args.mode === 'single') {
    const mdAbs = path.resolve(args.md);
    if (!fs.existsSync(mdAbs)) {
        console.error(`MD file not found: ${mdAbs}`);
        process.exit(1);
    }
    registerSingleMd(outPath, titleId, mdAbs, fractalMd);
    console.log(`\n✅ Registered MD to ${path.basename(outPath)}`);
    console.log(`   ${dateText} > ${args.titleNode} > ${path.basename(mdAbs)}`);
} else {
    const treeJsonAbs = path.resolve(args.treeJson);
    const mdBaseAbs = path.resolve(args.mdBase);
    if (!fs.existsSync(treeJsonAbs)) {
        console.error(`Tree JSON not found: ${treeJsonAbs}`);
        process.exit(1);
    }
    if (!fs.existsSync(mdBaseAbs) || !fs.statSync(mdBaseAbs).isDirectory()) {
        console.error(`MD base directory not found: ${mdBaseAbs}`);
        process.exit(1);
    }

    let tree;
    try {
        tree = JSON.parse(fs.readFileSync(treeJsonAbs, 'utf-8'));
    } catch (e) {
        console.error(`Invalid tree JSON: ${e.message}`);
        process.exit(1);
    }

    // map.json root represents the start URL. Process it as the first child of titleNode.
    processTreeNode(tree, outPath, titleId, null, mdBaseAbs, fractalMd);
    console.log(`\n✅ Registered sitemap tree to ${path.basename(outPath)}`);
    console.log(`   ${dateText} > ${args.titleNode} > (tree of ${countTreeNodes(tree)} nodes)`);
}

function countTreeNodes(node) {
    let n = 1;
    for (const c of node.children || []) n += countTreeNodes(c);
    return n;
}
