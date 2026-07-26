#!/usr/bin/env node
/**
 * fractal-attach.mjs
 * Fractal の .out に画像ノード / ファイル添付ノードを追加、
 * または既存ノードに画像・ファイルを後付けするスクリプト。
 *
 * Usage:
 *   # 新規画像ノード
 *   node fractal-attach.mjs --note <.out> --image <path> [--parent X] [--position child|after] [--text T]
 *   # 新規ファイル添付ノード
 *   node fractal-attach.mjs --note <.out> --file <path> [--parent X] [--position child|after] [--text T]
 *   # 既存ノードに画像 append
 *   node fractal-attach.mjs --note <.out> --image <path> --target X --append
 *   # 既存ノードに filePath 上書き
 *   node fractal-attach.mjs --note <.out> --file <path> --target X --append
 *   # md に画像/ファイルを添付（md 末尾にリンク追記。--note でなく --target-md）
 *   node fractal-attach.mjs --target-md <path.md> --image <path>
 *   node fractal-attach.mjs --target-md <path.md> --file <path>
 *
 * 画像は <imageDir>/image_<ts>_<rand>.<ext> にコピー、ファイルは <fileDir>/<basename> にコピー。
 * 相対パスは .out ディレクトリ基準（--target-md では md の場所基準）で格納（本体仕様と同じ）。
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// ─────────────── ID ───────────────

let idCounter = 0;
function generateNodeId() {
    const ts = (Date.now() + idCounter++).toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return 'n' + ts + rand;
}

// ─────────────── Args ───────────────

function parseArgs(argv) {
    const a = {
        note: null,
        targetMd: null,
        images: [],
        files: [],
        parent: null,
        target: null,
        append: false,
        position: 'child',
        text: null,
        imageDir: null,
        fileDir: null,
    };
    for (let i = 2; i < argv.length; i++) {
        const k = argv[i];
        const v = () => argv[++i];
        switch (k) {
            case '--note': a.note = v(); break;
            case '--target-md': a.targetMd = v(); break;
            case '--image': a.images.push(v()); break;
            case '--file': a.files.push(v()); break;
            case '--parent': a.parent = v(); break;
            case '--target': a.target = v(); break;
            case '--append': a.append = true; break;
            case '--position':
                a.position = v();
                if (a.position !== 'child' && a.position !== 'after') {
                    console.error(`Error: --position must be "child" or "after"`);
                    process.exit(1);
                }
                break;
            case '--text': a.text = v(); break;
            case '--image-dir': a.imageDir = v(); break;
            case '--file-dir': a.fileDir = v(); break;
            case '-h': case '--help':
                console.log('Usage: fractal-attach.mjs --note <path.out> (--image <p>... | --file <p>...) [--parent <id|text>] [--position child|after] [--text T]');
                console.log('       fractal-attach.mjs --note <path.out> (--image <p> | --file <p>) --target <id|text> --append   # 既存ノードへ後付け');
                console.log('       fractal-attach.mjs --target-md <path.md> (--image <p>... | --file <p>...)                     # md 末尾にリンク追記');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${k}`);
                process.exit(1);
        }
    }
    if (!a.note && !a.targetMd) { console.error('Error: --note or --target-md is required'); process.exit(1); }
    if (a.note && a.targetMd) { console.error('Error: --note and --target-md are mutually exclusive'); process.exit(1); }
    if (a.images.length === 0 && a.files.length === 0) {
        console.error('Error: --image or --file is required');
        process.exit(1);
    }
    if (a.images.length > 0 && a.files.length > 0) {
        console.error('Error: mixing --image and --file in one invocation is not supported');
        process.exit(1);
    }
    if (a.append && !a.target) {
        console.error('Error: --append requires --target');
        process.exit(1);
    }
    if (a.targetMd && (a.append || a.target || a.parent)) {
        console.error('Error: --target-md does not support --append/--target/--parent (md 末尾追記のみ)');
        process.exit(1);
    }
    return a;
}

// ─────────────── Path helpers ───────────────

/**
 * Outliner asset dir 解決（新フラットレイアウト前提: 共有 <outDir>/<subdir>。legacy fallback なし）:
 * - 明示指定 (引数 or .out 内 imageDir/fileDir) があればそれを使う (絶対 or .out dir 基準の相対)
 * - 未指定なら共有 <outDir>/<subdir>
 */
export function resolveOutlinerAssetDir(outFilePath, explicitDir, subdir) {
    if (explicitDir) {
        return path.isAbsolute(explicitDir)
            ? explicitDir
            : path.resolve(path.dirname(outFilePath), explicitDir);
    }
    return path.resolve(path.dirname(outFilePath), subdir); // 共有 default
}

function uniqueFileName(dir, name) {
    // fractal 本体と同じ: collision があれば "-1", "-2" suffix
    if (!fs.existsSync(path.join(dir, name))) return name;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    for (let i = 1; i < 10000; i++) {
        const candidate = `${base}-${i}${ext}`;
        if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    }
    throw new Error(`Cannot generate unique name for ${name}`);
}

// ─────────────── Copy helpers ───────────────

function copyImage(srcAbs, imageDir, outDir) {
    if (!fs.existsSync(srcAbs)) throw new Error(`image not found: ${srcAbs}`);
    const ext = (path.extname(srcAbs).toLowerCase().replace('.', '') || 'png').replace('jpeg', 'jpg');
    const name = `image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    fs.mkdirSync(imageDir, { recursive: true });
    const dest = path.join(imageDir, name);
    fs.copyFileSync(srcAbs, dest);
    return path.relative(outDir, dest).replace(/\\/g, '/');
}

function copyFileAttachment(srcAbs, fileDir, outDir) {
    if (!fs.existsSync(srcAbs)) throw new Error(`file not found: ${srcAbs}`);
    const safeName = path.basename(srcAbs);
    if (safeName.includes('..')) throw new Error(`Invalid file name: ${safeName}`);
    fs.mkdirSync(fileDir, { recursive: true });
    const name = uniqueFileName(fileDir, safeName);
    const dest = path.join(fileDir, name);
    fs.copyFileSync(srcAbs, dest);
    return { relPath: path.relative(outDir, dest).replace(/\\/g, '/'), title: safeName };
}

// ─────────────── md への添付（--target-md） ───────────────

/**
 * 既存 md の末尾に画像/ファイルリンクを追記する。
 * 実体は md 隣の images/ files/ にコピー（本体 resolveImagesDirForMd と同じ「md の場所基準」規約 =
 * flat-layout.ts:132。リンクも md からの相対）。
 * kind: 'image' → `![](images/image_<ts>_<rand>.<ext>)` / 'file' → `[<name>](files/<name>)`
 */
export function attachToMd(targetMdPath, srcPaths, kind) {
    const targetAbs = path.resolve(targetMdPath);
    if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
        throw new Error(`target md not found: ${targetAbs}`);
    }
    const mdDir = path.dirname(targetAbs);
    const assetDir = path.join(mdDir, kind === 'image' ? 'images' : 'files');

    const links = [];
    const copied = [];
    for (const src of srcPaths) {
        if (kind === 'image') {
            const rel = copyImage(path.resolve(src), assetDir, mdDir);
            links.push(`![](${rel})`);
            copied.push(rel);
        } else {
            const { relPath, title } = copyFileAttachment(path.resolve(src), assetDir, mdDir);
            links.push(`[${title}](${relPath})`);
            copied.push(relPath);
        }
    }

    const base = fs.readFileSync(targetAbs, 'utf-8').replace(/\s+$/, '');
    fs.writeFileSync(targetAbs, (base ? base + '\n\n' : '') + links.join('\n\n') + '\n', 'utf-8');
    return { targetMdPath: targetAbs, copied, links };
}

// ─────────────── Parent/target resolve ───────────────

function resolveNodeRef(data, ref) {
    if (!ref) return null;
    if (data.nodes[ref]) return ref;
    let exact = null, partial = null;
    for (const node of Object.values(data.nodes)) {
        if (node.text === ref) { exact = node.id; break; }
        if (!partial && node.text && String(node.text).includes(ref)) partial = node.id;
    }
    const found = exact || partial;
    if (!found) {
        console.error(`Error: node not found: "${ref}"`);
        process.exit(1);
    }
    return found;
}

// ─────────────── Node create / insert ───────────────

function createNode({ parentId, text, isPage = false, pageId = null, images = [], filePath = null }) {
    return {
        id: generateNodeId(),
        parentId: parentId || null,
        children: [],
        text: text || '',
        tags: [],
        isPage,
        pageId,
        collapsed: false,
        checked: null,
        subtext: '',
        images,
        filePath,
    };
}

function insertNode(data, node, targetNodeId, position, childPosition = 'top') {
    data.nodes[node.id] = node;
    if (position === 'after') {
        if (!targetNodeId) {
            node.parentId = null;
            data.rootIds.push(node.id);
            return;
        }
        const target = data.nodes[targetNodeId];
        node.parentId = target.parentId;
        if (!target.parentId) {
            const idx = data.rootIds.indexOf(targetNodeId);
            data.rootIds.splice(idx + 1, 0, node.id);
        } else {
            const parent = data.nodes[target.parentId];
            const idx = parent.children.indexOf(targetNodeId);
            parent.children.splice(idx + 1, 0, node.id);
        }
        return;
    }
    // 'child'
    if (!targetNodeId) {
        node.parentId = null;
        if (childPosition === 'top') data.rootIds.unshift(node.id);
        else data.rootIds.push(node.id);
    } else {
        node.parentId = targetNodeId;
        const parent = data.nodes[targetNodeId];
        if (childPosition === 'top') parent.children.unshift(node.id);
        else parent.children.push(node.id);
    }
}

// ─────────────── Main ───────────────

function main() {
    const args = parseArgs(process.argv);

    // === md への添付モード（--target-md） ===
    if (args.targetMd) {
        const kind = args.images.length > 0 ? 'image' : 'file';
        const srcs = kind === 'image' ? args.images : args.files;
        const r = attachToMd(args.targetMd, srcs, kind);
        console.log(`✅ attached ${srcs.length} ${kind}(s) to ${r.targetMdPath}`);
        for (const l of r.links) console.log(`   → ${l}`);
        return;
    }

    // .out 解決
    let notePath = args.note;
    if (!notePath.endsWith('.out')) notePath += '.out';
    notePath = path.resolve(notePath);
    if (!fs.existsSync(notePath)) {
        console.error(`Error: note file not found: ${notePath}`);
        process.exit(1);
    }

    const data = JSON.parse(fs.readFileSync(notePath, 'utf-8'));
    data.nodes = data.nodes || {};
    data.rootIds = data.rootIds || [];

    const outDir = path.dirname(notePath);
    const imageDir = resolveOutlinerAssetDir(notePath, args.imageDir || data.imageDir, 'images');
    const fileDir = resolveOutlinerAssetDir(notePath, args.fileDir || data.fileDir, 'files');

    // === APPEND mode (update existing node) ===
    if (args.append) {
        const targetId = resolveNodeRef(data, args.target);
        const target = data.nodes[targetId];
        if (!target) { console.error(`Error: target node not found: ${args.target}`); process.exit(1); }

        if (args.images.length > 0) {
            target.images = target.images || [];
            const added = [];
            for (const src of args.images) {
                const rel = copyImage(path.resolve(src), imageDir, outDir);
                target.images.push(rel);
                added.push(rel);
            }
            console.log(`✅ appended ${added.length} image(s) to node "${target.text || targetId}" (${targetId})`);
            for (const r of added) console.log(`   → ${r}`);
        } else {
            // file: node.filePath を上書き（単一のみ）
            if (args.files.length > 1) {
                console.error('Error: --append with --file supports only one file per invocation');
                process.exit(1);
            }
            const prev = target.filePath;
            const { relPath, title } = copyFileAttachment(path.resolve(args.files[0]), fileDir, outDir);
            target.filePath = relPath;
            target.isPage = false;
            target.pageId = null;
            if (!target.text) target.text = title;
            if (prev) console.log(`⚠️  overwrote existing filePath: ${prev}`);
            console.log(`✅ attached file to node "${target.text}" (${targetId})`);
            console.log(`   → ${relPath}`);
        }

        fs.writeFileSync(notePath, JSON.stringify(data, null, 2), 'utf-8');
        return;
    }

    // === CREATE mode (new nodes) ===
    const targetId = args.parent ? resolveNodeRef(data, args.parent) : null;

    if (args.images.length > 0) {
        // 1 ノードに全画像を格納（outliner の image ノードと同じ形）
        const rels = args.images.map(src => copyImage(path.resolve(src), imageDir, outDir));
        const parentForInsert =
            args.position === 'after'
                ? (targetId ? data.nodes[targetId].parentId : null)
                : targetId;
        const node = createNode({
            parentId: parentForInsert,
            text: args.text || '',
            images: rels,
        });
        insertNode(data, node, targetId, args.position, 'top');
        console.log(`🖼  image node created (${node.id}) — ${rels.length} image(s)`);
        for (const r of rels) console.log(`   → ${r}`);
        console.log(`   position: ${args.position} "${args.parent || 'root'}"`);
    } else {
        // file attachments: 1 ファイル = 1 ノード（兄弟として並べる）
        let lastId = null;
        for (let i = 0; i < args.files.length; i++) {
            const src = args.files[i];
            const { relPath, title } = copyFileAttachment(path.resolve(src), fileDir, outDir);

            let parentForInsert, effectiveTarget, effectivePosition;
            if (i === 0) {
                parentForInsert = args.position === 'after'
                    ? (targetId ? data.nodes[targetId].parentId : null)
                    : targetId;
                effectiveTarget = targetId;
                effectivePosition = args.position;
            } else {
                // 2 つ目以降は直前ノードの直後（兄弟）
                const prev = data.nodes[lastId];
                parentForInsert = prev.parentId;
                effectiveTarget = lastId;
                effectivePosition = 'after';
            }

            const node = createNode({
                parentId: parentForInsert,
                text: args.text || title,
                filePath: relPath,
            });
            insertNode(data, node, effectiveTarget, effectivePosition, 'top');
            console.log(`📎 file node "${node.text}" (${node.id}) → ${relPath}`);
            lastId = node.id;
        }
    }

    fs.writeFileSync(notePath, JSON.stringify(data, null, 2), 'utf-8');
}

// CLI 直接実行時のみ main（unit import 時に暴発しない・design §B5）
// CLI 直接実行判定（TASK-B5 sprint 20260727-065214）: install.sh は claude/cursor/antigravity に
// symlink 配置するが、Node は main entry の import.meta.url を realpath 解決するため、
// argv[1]（symlink パス）との素の比較は不一致 → main() が走らない silent no-op になる。
// argv[1] を realpathSync で解決してから比較する（解決失敗時は素の argv[1] に fallback）。
function __isCliInvocation() {
    if (!process.argv[1]) return false;
    let entry = process.argv[1];
    try { entry = fs.realpathSync(entry); } catch { /* 存在しない等 → 素の argv[1] で比較 */ }
    return import.meta.url === pathToFileURL(entry).href;
}
if (__isCliInvocation()) {
    try {
        main();
    } catch (err) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
    }
}
