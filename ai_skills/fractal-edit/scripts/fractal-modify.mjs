#!/usr/bin/env node
/**
 * fractal-modify.mjs — 既存 Outliner ノードの変更系 CLI（fractal-edit skill）
 *
 * fractal-md.mjs（追加系）の対になる変更系。1 コマンド 1 操作:
 *   --set-text <str>   : text 書換（tags 再計算）
 *   --check / --uncheck / --clear-check : checked = true / false / null
 *   --delete           : ノード + 子孫を構造から除去（物理ファイルは消さない）
 *   --move-to <id|text|root> [--position child|after] : 移動
 *
 * 使い方:
 *   node fractal-modify.mjs --note path/to/note.out --target "対象ノード" --set-text "新しいテキスト"
 *   node fractal-modify.mjs --note note.out --target nXXX --check
 *   node fractal-modify.mjs --note note.out --target "終わったタスク" --delete
 *   node fractal-modify.mjs --note note.out --target nXXX --move-to "移動先" --position child
 *   node fractal-modify.mjs --note note.out --target nXXX --delete --dry-run
 *
 * 安全規約:
 *   - --delete は .out 構造からの除去のみ。page md / 画像 / 添付の物理ファイルは残す
 *     （本体 outliner の cut 既定と整合。孤児は fractal-doctor が検出する）
 *   - --move-to で自分自身/自分の子孫への移動はエラー（循環防止・.out 不変）
 *   - --target 解決は fractal-md.mjs と同規約: ノード ID → text 完全一致 → 部分一致。不在/曖昧はエラー停止
 */
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';

// --- tags 再計算（正典: src/webview/outliner-model.js:64 parseTags の 1:1 ミラー） ---
export function parseTagsMirror(text) {
    const tags = [];
    let cleaned = String(text || '').replace(/`[^`]*`/g, '');       // inline code 内は除外
    cleaned = cleaned.replace(/https?:\/\/\S+/g, '');               // URL 内 @user 等は除外
    const regex = /(?<![&#\w\p{L}])([#@][\w\p{L}][\w\p{L}-]*)/gu;
    let m;
    while ((m = regex.exec(cleaned)) !== null) tags.push(m[1]);
    return tags;
}

// --- target 解決（fractal-md.mjs resolveParent と同規約・ただし throw 版） ---
export function resolveTargetId(data, targetArg) {
    if (data.nodes[targetArg]) return targetArg;
    let exact = null;
    let partial = null;
    for (const node of Object.values(data.nodes)) {
        if (node.text === targetArg) { exact = node.id; break; }
        if (!partial && node.text && node.text.includes(targetArg)) partial = node.id;
    }
    const found = exact || partial;
    if (!found) throw new Error(`target node not found: "${targetArg}"`);
    return found;
}

/** id の子孫すべて（自身含む）を集める */
export function collectSubtreeIds(data, rootId) {
    const ids = [];
    const stack = [rootId];
    while (stack.length) {
        const id = stack.pop();
        const n = data.nodes[id];
        if (!n) continue;
        ids.push(id);
        for (const c of (n.children || [])) stack.push(c);
    }
    return ids;
}

/** 親のリスト（rootIds or parent.children）から id を unlink */
function unlinkFromParent(data, id) {
    const n = data.nodes[id];
    if (!n) return;
    if (n.parentId && data.nodes[n.parentId]) {
        const arr = data.nodes[n.parentId].children || [];
        const idx = arr.indexOf(id);
        if (idx !== -1) arr.splice(idx, 1);
    } else {
        const idx = data.rootIds.indexOf(id);
        if (idx !== -1) data.rootIds.splice(idx, 1);
    }
}

/**
 * pure: data を破壊的に変更して変更サマリを返す（fs 非依存・unit 対象）。
 * op: { kind: 'set-text'|'check'|'uncheck'|'clear-check'|'delete'|'move',
 *       targetId, text?, moveToId?  (null=root), position? }
 */
export function applyModify(data, op) {
    const node = data.nodes[op.targetId];
    if (!node) throw new Error(`node not found in data: ${op.targetId}`);

    switch (op.kind) {
        case 'set-text': {
            const before = node.text;
            node.text = op.text;
            node.tags = parseTagsMirror(op.text); // 正典 parseTags ミラーで再計算
            return { kind: 'set-text', id: node.id, before, after: op.text };
        }
        case 'check':
        case 'uncheck':
        case 'clear-check': {
            const before = node.checked;
            node.checked = op.kind === 'check' ? true : op.kind === 'uncheck' ? false : null;
            return { kind: op.kind, id: node.id, before, after: node.checked };
        }
        case 'delete': {
            const ids = collectSubtreeIds(data, op.targetId);
            unlinkFromParent(data, op.targetId);
            for (const id of ids) delete data.nodes[id];
            return { kind: 'delete', id: op.targetId, removedCount: ids.length, removedIds: ids };
        }
        case 'move': {
            // 循環防止: 自分自身 / 自分の子孫への移動は不可
            if (op.moveToId) {
                const subtree = new Set(collectSubtreeIds(data, op.targetId));
                if (subtree.has(op.moveToId)) {
                    throw new Error(`cannot move node into itself or its descendant: ${op.moveToId}`);
                }
                if (!data.nodes[op.moveToId]) throw new Error(`move-to node not found: ${op.moveToId}`);
            }
            unlinkFromParent(data, op.targetId);
            const position = op.position || 'child';
            if (!op.moveToId) {
                // root へ
                node.parentId = null;
                if (position === 'after') data.rootIds.push(node.id);
                else data.rootIds.unshift(node.id);
            } else if (position === 'after') {
                const target = data.nodes[op.moveToId];
                node.parentId = target.parentId || null;
                const arr = target.parentId ? data.nodes[target.parentId].children : data.rootIds;
                const idx = arr.indexOf(op.moveToId);
                arr.splice(idx + 1, 0, node.id);
            } else {
                node.parentId = op.moveToId;
                data.nodes[op.moveToId].children.unshift(node.id);
            }
            return { kind: 'move', id: node.id, newParent: node.parentId, position };
        }
        default:
            throw new Error(`unknown op: ${op.kind}`);
    }
}

// --- CLI ---

function parseArgs(argv) {
    const a = { note: null, target: null, op: null, text: null, moveTo: null, position: 'child', dryRun: false };
    const setOp = (kind) => {
        if (a.op) { console.error(`Error: 1 コマンド 1 操作です（${a.op} と ${kind} を同時指定）`); process.exit(1); }
        a.op = kind;
    };
    for (let i = 2; i < argv.length; i++) {
        switch (argv[i]) {
            case '--note': a.note = argv[++i]; break;
            case '--target': a.target = argv[++i]; break;
            case '--set-text': setOp('set-text'); a.text = argv[++i]; break;
            case '--check': setOp('check'); break;
            case '--uncheck': setOp('uncheck'); break;
            case '--clear-check': setOp('clear-check'); break;
            case '--delete': setOp('delete'); break;
            case '--move-to': setOp('move'); a.moveTo = argv[++i]; break;
            case '--position':
                a.position = argv[++i];
                if (a.position !== 'child' && a.position !== 'after') {
                    console.error(`Error: --position must be "child" or "after"`); process.exit(1);
                }
                break;
            case '--dry-run': a.dryRun = true; break;
            case '-h': case '--help':
                console.log('Usage: fractal-modify.mjs --note <path.out> --target <id|text> <operation> [--dry-run]');
                console.log('Operations: --set-text <str> | --check | --uncheck | --clear-check | --delete | --move-to <id|text|root> [--position child|after]');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`); process.exit(1);
        }
    }
    if (!a.note) { console.error('Error: --note is required'); process.exit(1); }
    if (!a.target) { console.error('Error: --target is required'); process.exit(1); }
    if (!a.op) { console.error('Error: operation is required (--set-text/--check/--uncheck/--clear-check/--delete/--move-to)'); process.exit(1); }
    return a;
}

function main() {
    const args = parseArgs(process.argv);
    let notePath = path.resolve(args.note);
    if (!notePath.endsWith('.out')) notePath += '.out';
    if (!fs.existsSync(notePath)) { console.error(`Error: .out not found: ${notePath}`); process.exit(1); }

    const data = JSON.parse(fs.readFileSync(notePath, 'utf-8'));
    let targetId, moveToId = null;
    try {
        targetId = resolveTargetId(data, args.target);
        if (args.op === 'move' && args.moveTo && args.moveTo !== 'root') {
            moveToId = resolveTargetId(data, args.moveTo);
        }
    } catch (e) {
        console.error(`Error: ${e.message}`); process.exit(1);
    }

    let summary;
    try {
        summary = applyModify(data, {
            kind: args.op, targetId, text: args.text, moveToId, position: args.position
        });
    } catch (e) {
        console.error(`Error: ${e.message}`); process.exit(1);
    }

    if (args.dryRun) {
        console.log('[dry-run] 変更内容（書き込みません）:');
        console.log(JSON.stringify(summary, null, 2));
        return;
    }
    fs.writeFileSync(notePath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`✅ ${summary.kind}: ${JSON.stringify(summary)}`);
    console.log(`   File: ${notePath}`);
    if (summary.kind === 'delete') {
        console.log('   注: 物理ファイル（page md / 画像 / 添付）は削除していません。孤児の確認は fractal-doctor skill で。');
    }
}

// unit import 時に実行されないよう main guard（designer_failures 2026-07-26）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main();
}
