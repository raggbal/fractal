#!/usr/bin/env node
/**
 * fractal-md.mjs
 * Fractal の .out ノートにノード（ページノード含む）を登録する
 *
 * Usage:
 *   # ノードだけ追加（MDなし）
 *   node scripts/fractal-md.mjs --note path/to/note.out --text "ノード名" --parent "親ノード"
 *
 *   # MD付きページノード（親の子として）
 *   node scripts/fractal-md.mjs --note path/to/note.out --md file.md --parent "親ノード"
 *
 *   # MD付きページノード（兄弟として指定ノードの直後に挿入）
 *   node scripts/fractal-md.mjs --note path/to/note.out --md file.md --parent "基準ノード" --position after
 *
 *   # テキスト指定 + MD付き
 *   node scripts/fractal-md.mjs --note path/to/note.out --md file.md --text "カスタム名"
 *
 *   # 一括登録
 *   node scripts/fractal-md.mjs --note path/to/note.out --md "docs/*.md" --group-name "リサーチ結果"
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

// --- ID生成 ---

let nodeIdCounter = 0;

function generateNodeId() {
    const ts = (Date.now() + nodeIdCounter++).toString(36);
    const rand = Math.random().toString(36).slice(2, 8);
    return 'n' + ts + rand;
}

function generatePageId() {
    return crypto.randomUUID();
}

// --- H1抽出 ---

function extractH1(mdContent) {
    const match = mdContent.match(/^# (.+)$/m);
    return match ? match[1].trim() : null;
}

// ────────────────────────────────────────────
// Markdown正規化（markdown-import.ts から移植）
// ────────────────────────────────────────────

/**
 * セル内改行テーブルの正規化。
 * src/shared/markdown-import.ts の normalizeMultiLineTableCells と同等ロジック。
 */
function normalizeMultiLineTableCells(text) {
    // Step 1: 平坦化解除 — | <br> | → |\n|
    text = text.replace(/\|\s*<br>\s*(?=\|)/gi, '|\n');

    // Step 2: 孤立セパレータ行除去
    const lines = text.split('\n');
    let result = [];
    let separatorSeen = false;
    let inTable = false;

    for (let i = 0; i < lines.length; i++) {
        const trimmed = lines[i].trim();
        const isTableRow = trimmed.charAt(0) === '|' && trimmed.charAt(trimmed.length - 1) === '|' && trimmed.length > 2;

        if (isTableRow) {
            let isSep = false;
            const inner = trimmed.slice(1, -1);
            const cells = inner.split('|');
            if (cells.length > 0) {
                isSep = true;
                for (const cell of cells) {
                    if (!/^\s*:?-+:?\s*$/.test(cell)) {
                        isSep = false;
                        break;
                    }
                }
            }

            if (isSep) {
                if (separatorSeen && inTable) {
                    continue; // 重複セパレータをスキップ
                }
                separatorSeen = true;
            }
            inTable = true;
        } else {
            inTable = false;
            separatorSeen = false;
        }

        result.push(lines[i]);
    }

    // Step 3: 折れた行結合
    const lines2 = result;
    result = [];
    let i2 = 0;

    while (i2 < lines2.length) {
        const trimmed2 = lines2[i2].trimEnd();

        if (trimmed2.length > 1 && trimmed2.charAt(0) === '|' && trimmed2.charAt(trimmed2.length - 1) !== '|') {
            let combined = trimmed2;
            let j = i2 + 1;
            let found = false;
            const maxJoin = 50;

            while (j < lines2.length && (j - i2) <= maxJoin) {
                const nextTrimmed = lines2[j].trimEnd();

                if (nextTrimmed === '') {
                    combined += '<br>';
                    j++;
                    continue;
                }

                combined += '<br>' + nextTrimmed;
                j++;

                if (nextTrimmed.charAt(nextTrimmed.length - 1) === '|') {
                    found = true;
                    break;
                }
            }

            if (found) {
                combined = combined.replace(/(<br>)+/g, '<br>');
                result.push(combined);
                i2 = j;
            } else {
                result.push(lines2[i2]);
                i2++;
            }
        } else {
            result.push(lines2[i2]);
            i2++;
        }
    }

    return result.join('\n');
}

/**
 * Markdown 内の画像参照を解析し、画像ファイルをコピーしてパスを書き換える。
 * src/shared/markdown-import.ts の processImages と同等ロジック。
 */
function processImages(mdContent, sourceDir, imageDir, pageDir) {
    return mdContent.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt, imgPath) => {
        // URL はスキップ
        if (imgPath.startsWith('http://') || imgPath.startsWith('https://')) {
            return `![${alt}](${imgPath})`;
        }

        // パスにクエリパラメータやフラグメントがある場合は除去
        const cleanPath = imgPath.split(/[?#]/)[0];

        // URLエンコードをデコード（Notion等のエクスポートで %20 等が使われる）
        let decodedPath;
        try {
            decodedPath = decodeURIComponent(cleanPath);
        } catch {
            decodedPath = cleanPath;
        }

        // 元ファイルからの相対パスで解決
        const absoluteImgPath = path.resolve(sourceDir, decodedPath);

        // ファイルが存在しない場合はそのまま
        if (!fs.existsSync(absoluteImgPath)) {
            return `![${alt}](${imgPath})`;
        }

        // 画像ディレクトリ作成
        if (!fs.existsSync(imageDir)) {
            fs.mkdirSync(imageDir, { recursive: true });
        }

        // リネームしてコピー
        const ext = path.extname(absoluteImgPath).toLowerCase().replace('jpeg', 'jpg') || '.png';
        const newFileName = `image_${Date.now()}_${Math.random().toString(36).slice(2, 6)}${ext}`;
        const destPath = path.join(imageDir, newFileName);
        fs.copyFileSync(absoluteImgPath, destPath);

        // pageDir からの相対パスに書き換え
        const relativePath = path.relative(pageDir, destPath).replace(/\\/g, '/');
        return `![${alt}](${relativePath})`;
    });
}

/**
 * MD ファイルを読み込み、正規化・画像処理して pages/ に保存する。
 * src/shared/markdown-import.ts の importMdFile と同等ロジック。
 */
function importMdFile(sourcePath, pageDir, imageDir) {
    let rawContent;
    try {
        rawContent = fs.readFileSync(sourcePath, 'utf-8');
    } catch {
        return null;
    }

    const title = extractH1(rawContent) || path.basename(sourcePath, '.md');

    // Markdown正規化
    let content = normalizeMultiLineTableCells(rawContent);

    // 画像処理
    const sourceDir = path.dirname(sourcePath);
    content = processImages(content, sourceDir, imageDir, pageDir);

    // pageId 生成
    const pageId = generatePageId();

    // ディレクトリ作成
    fs.mkdirSync(pageDir, { recursive: true });

    // ページファイル保存
    const pagePath = path.join(pageDir, `${pageId}.md`);
    fs.writeFileSync(pagePath, content, 'utf-8');

    return { title, content, pageId };
}

// --- 引数パース ---

function parseArgs(argv) {
    const args = {
        note: null,
        mdPatterns: [],
        parent: null,
        groupName: null,
        text: null,
        position: 'child', // 'child' or 'after'
    };

    let i = 2; // skip node, script
    while (i < argv.length) {
        switch (argv[i]) {
            case '--note':
                args.note = argv[++i];
                break;
            case '--md':
                i++;
                // --md 以降、次の -- フラグまでを全て MD パターンとして収集
                while (i < argv.length && !argv[i].startsWith('--')) {
                    args.mdPatterns.push(argv[i]);
                    i++;
                }
                continue; // i は既に進んでいるので increment しない
            case '--parent':
                args.parent = argv[++i];
                break;
            case '--group-name':
                args.groupName = argv[++i];
                break;
            case '--text':
                args.text = argv[++i];
                break;
            case '--position':
                args.position = argv[++i];
                if (args.position !== 'child' && args.position !== 'after') {
                    console.error(`Error: --position must be "child" or "after", got "${args.position}"`);
                    process.exit(1);
                }
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`);
                process.exit(1);
        }
        i++;
    }

    if (!args.note) {
        console.error('Error: --note is required');
        process.exit(1);
    }
    // --md も --text もない場合はエラー
    if (args.mdPatterns.length === 0 && !args.text) {
        console.error('Error: --md or --text is required');
        process.exit(1);
    }

    return args;
}

// --- glob展開 ---

function expandMdFiles(patterns) {
    const files = [];
    for (const pattern of patterns) {
        // そのままファイルとして存在するか確認
        if (fs.existsSync(pattern) && fs.statSync(pattern).isFile()) {
            files.push(path.resolve(pattern));
            continue;
        }
        // glob 展開 (簡易: ディレクトリ + *.md パターン)
        const dir = path.dirname(pattern);
        const base = path.basename(pattern);
        if (fs.existsSync(dir) && fs.statSync(dir).isDirectory()) {
            const re = new RegExp('^' + base.replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
            for (const entry of fs.readdirSync(dir)) {
                if (re.test(entry) && entry.endsWith('.md')) {
                    files.push(path.resolve(dir, entry));
                }
            }
        } else {
            console.error(`Warning: pattern "${pattern}" matched no files`);
        }
    }
    // 重複排除 & ソート
    return [...new Set(files)].sort();
}

// --- 差し込み位置の解決 ---

function resolveParent(data, parentArg) {
    if (!parentArg) return null;

    // ノードIDで直接指定
    if (data.nodes[parentArg]) {
        return parentArg;
    }

    // テキストで検索（完全一致優先、なければ部分一致）
    let exactMatch = null;
    let partialMatch = null;
    for (const node of Object.values(data.nodes)) {
        if (node.text === parentArg) {
            exactMatch = node.id;
            break;
        }
        if (!partialMatch && node.text.includes(parentArg)) {
            partialMatch = node.id;
        }
    }
    const found = exactMatch || partialMatch;
    if (!found) {
        console.error(`Error: parent node not found: "${parentArg}"`);
        process.exit(1);
    }
    return found;
}

// --- ノード作成 ---

function createNode({ parentId, text, isPage, pageId }) {
    return {
        id: generateNodeId(),
        parentId: parentId || null,
        children: [],
        text: text || '',
        tags: [],
        isPage: !!isPage,
        pageId: pageId || null,
        collapsed: false,
        checked: null,
        subtext: '',
    };
}

// --- ノードを .out データに挿入 ---

/**
 * @param {object} data - .out の JSON データ
 * @param {object} node - 挿入するノードオブジェクト
 * @param {string|null} targetNodeId - 基準ノードID
 * @param {'child'|'after'} position - 挿入位置
 *   - 'child': targetNodeId の children 先頭に挿入（targetNodeId=null ならルート先頭）
 *   - 'after': targetNodeId のすぐ下の兄弟として挿入
 * @param {'top'|'bottom'} childPosition - position='child' の場合の挿入位置
 */
function insertNode(data, node, targetNodeId, position = 'child', childPosition = 'top') {
    data.nodes[node.id] = node;

    if (position === 'after') {
        // targetNodeId の兄弟として直後に挿入
        if (!targetNodeId) {
            // targetNodeId 未指定の場合はルート末尾
            node.parentId = null;
            data.rootIds.push(node.id);
            return;
        }

        const targetNode = data.nodes[targetNodeId];
        if (!targetNode) {
            console.error(`Error: target node ${targetNodeId} not found in data`);
            process.exit(1);
        }

        const parentId = targetNode.parentId;
        node.parentId = parentId;

        if (!parentId) {
            // targetNode はルートノード → rootIds 内で直後に挿入
            const idx = data.rootIds.indexOf(targetNodeId);
            data.rootIds.splice(idx + 1, 0, node.id);
        } else {
            // targetNode は子ノード → 親の children 内で直後に挿入
            const parent = data.nodes[parentId];
            const idx = parent.children.indexOf(targetNodeId);
            parent.children.splice(idx + 1, 0, node.id);
        }
        return;
    }

    // position === 'child' (デフォルト)
    if (!targetNodeId) {
        // ルートに挿入
        node.parentId = null;
        if (childPosition === 'top') {
            data.rootIds.unshift(node.id);
        } else {
            data.rootIds.push(node.id);
        }
    } else {
        // 指定ノードの子に挿入
        node.parentId = targetNodeId;
        const parent = data.nodes[targetNodeId];
        if (!parent) {
            console.error(`Error: parent node ${targetNodeId} not found in data`);
            process.exit(1);
        }
        if (childPosition === 'top') {
            parent.children.unshift(node.id);
        } else {
            parent.children.push(node.id);
        }
    }
}

// --- メイン処理 ---

async function main() {
    const args = parseArgs(process.argv);

    // .out パス解決
    let notePath = args.note;
    if (!notePath.endsWith('.out')) {
        notePath += '.out';
    }
    notePath = path.resolve(notePath);

    if (!fs.existsSync(notePath)) {
        console.error(`Error: note file not found: ${notePath}`);
        process.exit(1);
    }

    // .out 読み込み
    const data = JSON.parse(fs.readFileSync(notePath, 'utf-8'));

    // pages ディレクトリ特定
    const noteDir = path.dirname(notePath);
    const pageDir = data.pageDir
        ? (path.isAbsolute(data.pageDir) ? data.pageDir : path.resolve(noteDir, data.pageDir))
        : path.resolve(noteDir, 'pages');

    // imageDir は常に pageDir/images（本体と同じ）
    const imageDir = path.join(pageDir, 'images');

    // ディレクトリ作成
    fs.mkdirSync(pageDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });

    // 差し込み位置解決
    const targetNodeId = resolveParent(data, args.parent);

    // === MDなし: ノードだけ追加 ===
    if (args.mdPatterns.length === 0) {
        const node = createNode({
            parentId: args.position === 'after' ? (targetNodeId ? data.nodes[targetNodeId].parentId : null) : targetNodeId,
            text: args.text || '',
            isPage: false,
            pageId: null,
        });
        insertNode(data, node, targetNodeId, args.position, 'top');

        fs.writeFileSync(notePath, JSON.stringify(data, null, 2), 'utf-8');
        console.log(`\u2705 Node created: "${node.text}" (${node.id})`);
        console.log(`   Position: ${args.position} "${args.parent || 'root'}"`);
        return;
    }

    // MD ファイル展開
    const mdFiles = expandMdFiles(args.mdPatterns);
    if (mdFiles.length === 0) {
        console.error('Error: no markdown files found');
        process.exit(1);
    }

    const results = [];
    const isBulk = mdFiles.length > 1;

    if (isBulk) {
        // === 一括登録モード ===
        const groupName = args.groupName || args.text || 'Imported';
        const groupNode = createNode({
            parentId: args.position === 'after' ? (targetNodeId ? data.nodes[targetNodeId].parentId : null) : targetNodeId,
            text: groupName,
            isPage: false,
            pageId: null,
        });
        insertNode(data, groupNode, targetNodeId, args.position, 'top');
        console.log(`\ud83d\udcc1 Group node: "${groupName}" (${groupNode.id})`);

        for (const mdFile of mdFiles) {
            const imported = importMdFile(mdFile, pageDir, imageDir);
            if (!imported) {
                console.error(`  Warning: failed to import ${mdFile}`);
                continue;
            }

            const text = args.text ? args.text : imported.title;
            const node = createNode({
                parentId: groupNode.id,
                text,
                isPage: true,
                pageId: imported.pageId,
            });
            // 一括登録の子ノードは常にグループの末尾に追加
            insertNode(data, node, groupNode.id, 'child', 'bottom');

            results.push({ text, nodeId: node.id, pageId: imported.pageId, source: mdFile });
            console.log(`  \ud83d\udcc4 "${text}" \u2192 ${imported.pageId}.md`);
        }
    } else {
        // === 単一登録モード ===
        const mdFile = mdFiles[0];
        const imported = importMdFile(mdFile, pageDir, imageDir);
        if (!imported) {
            console.error(`Error: failed to import ${mdFile}`);
            process.exit(1);
        }

        const text = args.text ?? imported.title;
        const node = createNode({
            parentId: args.position === 'after' ? (targetNodeId ? data.nodes[targetNodeId].parentId : null) : targetNodeId,
            text,
            isPage: true,
            pageId: imported.pageId,
        });
        insertNode(data, node, targetNodeId, args.position, 'top');

        results.push({ text, nodeId: node.id, pageId: imported.pageId, source: mdFile });
        console.log(`\ud83d\udcc4 "${text}" \u2192 ${imported.pageId}.md`);
    }

    // .out 書き戻し
    fs.writeFileSync(notePath, JSON.stringify(data, null, 2), 'utf-8');

    // 結果サマリ
    console.log(`\n\u2705 ${results.length} page(s) registered to ${path.basename(notePath)}`);
    console.log(`   Pages dir: ${pageDir}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
