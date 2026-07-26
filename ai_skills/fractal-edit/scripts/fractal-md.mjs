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
 *
 *   # 新規アウトライナー（.outファイル）を作成し outline.note のトップレベルに追加
 *   node scripts/fractal-md.mjs --create-outliner "タイトル" --notes-dir /path/to/notes
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

// ── フラットレイアウト解決（正典: fractal/src/shared/flat-layout.ts のミラー・ADRL-0018）──
// フラット規約（sprint 20260707-124018 以降）: page md = <noteDir>/<pageId>.md（直下）、
// 画像/添付 = <noteDir>/images・<noteDir>/files（共有）。FLAT_OUT_HINTS = { pageDir:'.', imageDir:'./images', fileDir:'./files' }。

/** flat-layout.ts:56 isFlatOut のミラー */
export function isFlatOut(pageDir) {
    if (typeof pageDir !== 'string') return false;
    const norm = pageDir.replace(/^\.\//, '').replace(/\/+$/, '');
    return norm === '' || norm === '.';
}

/** page md の置き場（新フラットレイアウト前提: hint 尊重・無ければ noteDir 直下。legacy fallback なし = ユーザー決定 2026-07-26） */
export function resolvePagesDirMjs(noteDir, basename, hints) {
    void basename; // 署名互換（旧 <basename>/ default は廃止）
    const pd = hints && typeof hints.pageDir === 'string' ? hints.pageDir : undefined;
    if (isFlatOut(pd)) return noteDir;
    if (pd) return path.isAbsolute(pd) ? pd : path.resolve(noteDir, pd);
    return noteDir; // 新デフォルト = note 直下
}

/** 画像/添付 dir（新フラットレイアウト前提: hint 尊重・無ければ共有 <noteDir>/<sub>） */
export function resolveSharedSubMjs(noteDir, basename, sub, hint) {
    void basename;
    if (hint) return path.isAbsolute(hint) ? hint : path.resolve(noteDir, hint);
    return path.join(noteDir, sub); // 共有 default（未作成でもパスは返す。呼び出し側が mkdir）
}

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
 * 衝突回避用 unique 名: foo.pdf → foo.pdf / foo-1.pdf / foo-2.pdf ...
 * fractal-attach.mjs の uniqueFileName と同じ。
 */
function uniqueFileName(dir, name) {
    if (!fs.existsSync(path.join(dir, name))) return name;
    const ext = path.extname(name);
    const base = path.basename(name, ext);
    for (let i = 1; i < 10000; i++) {
        const candidate = `${base}-${i}${ext}`;
        if (!fs.existsSync(path.join(dir, candidate))) return candidate;
    }
    throw new Error(`Cannot generate unique name for ${name}`);
}

/**
 * Markdown 内の通常リンク `[text](path)` を解析し、ローカルファイル参照をコピー + path 書き換え。
 * - URL / mailto / anchor はスキップ
 * - 画像 `![]()` は対象外 (lookbehind で除外、 processImages が担当)
 * - 存在しないファイルは放置
 * - 存在すれば fileDir にコピーし、pageDir からの相対 path に書き換え (collision 時 `-1` suffix)
 */
function processFileLinks(mdContent, sourceDir, fileDir, pageDir) {
    return mdContent.replace(/(?<!!)\[([^\]]*)\]\(([^)]+)\)/g, (match, text, linkPath) => {
        // URL / mailto / tel / 内部 anchor はスキップ
        if (/^(https?|ftp|mailto|tel|file):/i.test(linkPath) || linkPath.startsWith('#')) {
            return match;
        }
        // クエリ/フラグメント除去
        const cleanPath = linkPath.split(/[?#]/)[0];
        if (!cleanPath) return match;
        // URLデコード
        let decodedPath;
        try { decodedPath = decodeURIComponent(cleanPath); } catch { decodedPath = cleanPath; }
        const absSrc = path.resolve(sourceDir, decodedPath);
        if (!fs.existsSync(absSrc) || !fs.statSync(absSrc).isFile()) return match;

        if (!fs.existsSync(fileDir)) fs.mkdirSync(fileDir, { recursive: true });
        const safeName = path.basename(absSrc);
        if (safeName.includes('..')) return match;
        const uniqueName = uniqueFileName(fileDir, safeName);
        const destPath = path.join(fileDir, uniqueName);
        fs.copyFileSync(absSrc, destPath);
        const relativePath = path.relative(pageDir, destPath).replace(/\\/g, '/');
        return `[${text}](${relativePath})`;
    });
}

/**
 * MD ファイルを読み込み、正規化・画像/ファイル参照処理して <outDir>/<basename>/ に保存する。
 * src/shared/markdown-import.ts の importMdFile と同等 + skill 独自の file link 処理を追加。
 */
function importMdFile(sourcePath, pageDir, imageDir, fileDir) {
    let rawContent;
    try {
        rawContent = fs.readFileSync(sourcePath, 'utf-8');
    } catch {
        return null;
    }

    const title = extractH1(rawContent) || path.basename(sourcePath, '.md');

    // Markdown正規化
    let content = normalizeMultiLineTableCells(rawContent);

    // 参照処理: 画像 → imageDir、 他のファイル/MD → fileDir
    const sourceDir = path.dirname(sourcePath);
    content = processImages(content, sourceDir, imageDir, pageDir);
    if (fileDir) {
        content = processFileLinks(content, sourceDir, fileDir, pageDir);
    }

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
        createOutliner: null,
        createMd: null,
        targetMd: null,
        notesDir: null,
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
            case '--create-outliner':
                args.createOutliner = argv[++i];
                break;
            case '--create-md':
                args.createMd = argv[++i];
                break;
            case '--target-md':
                args.targetMd = argv[++i];
                break;
            case '--notes-dir':
                args.notesDir = argv[++i];
                break;
            case '--position':
                args.position = argv[++i];
                if (args.position !== 'child' && args.position !== 'after') {
                    console.error(`Error: --position must be "child" or "after", got "${args.position}"`);
                    process.exit(1);
                }
                break;
            case '-h': case '--help':
                console.log('Usage: fractal-md.mjs --note <path.out> (--text <str> | --md <files...>) [--parent <id|text>] [--position child|after] [--group-name <str>]');
                console.log('       fractal-md.mjs --create-outliner "Title" --notes-dir <path>   # 新規 .out（フラット）+ outline.note 登録');
                console.log('       fractal-md.mjs --create-md "Title" --notes-dir <path>         # 新規 独立 md item + outline.note 登録');
                console.log('       fractal-md.mjs --target-md <path.md> (--md <source.md> | --text "Title")  # md に subpage 追加');
                process.exit(0);
                break;
            default:
                console.error(`Unknown option: ${argv[i]}`);
                process.exit(1);
        }
        i++;
    }

    // --create-outliner / --create-md モードは --note 不要
    if (args.createOutliner !== null || args.createMd !== null) {
        return args;
    }

    // --target-md モード（md への subpage 追加）: --note 不要、--md or --text が必要
    if (args.targetMd !== null) {
        if (args.mdPatterns.length === 0 && !args.text) {
            console.error('Error: --target-md requires --md <source.md> or --text <title>');
            process.exit(1);
        }
        return args;
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
        images: [],
        filePath: null,
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

// --- 新規アウトライナー作成 ---

function generateOutlineId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function createOutliner(title, notesDir) {
    const mainFolder = path.resolve(notesDir || process.cwd());
    if (!fs.existsSync(mainFolder) || !fs.statSync(mainFolder).isDirectory()) {
        console.error(`Error: notes directory not found: ${mainFolder}`);
        process.exit(1);
    }

    const id = generateOutlineId();
    const filePath = path.join(mainFolder, `${id}.out`);

    const firstNodeId = generateNodeId();
    // フラット規約（正典: src/shared/flat-layout.ts FLAT_OUT_HINTS / notes-file-manager.ts:1073）:
    // page md は note 直下・images/files は共有。per-outliner サブフォルダは作らない
    const data = {
        version: 1,
        title: title || 'Untitled',
        pageDir: '.',
        imageDir: './images',
        fileDir: './files',
        rootIds: [firstNodeId],
        nodes: {
            [firstNodeId]: {
                id: firstNodeId,
                parentId: null,
                children: [],
                text: '',
                tags: [],
                isPage: false,
                pageId: null,
                collapsed: false,
                checked: null,
                subtext: '',
                images: [],
                filePath: null,
            },
        },
    };

    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    // outline.note 構造を更新（あれば）
    const notePath = path.join(mainFolder, 'outline.note');
    let structure;
    if (fs.existsSync(notePath)) {
        try {
            structure = JSON.parse(fs.readFileSync(notePath, 'utf-8'));
        } catch {
            structure = null;
        }
    }
    if (!structure || typeof structure !== 'object') {
        structure = { version: 1, rootIds: [], items: {} };
    }
    structure.items = structure.items || {};
    structure.rootIds = structure.rootIds || [];
    structure.items[id] = { type: 'file', id, title: title || 'Untitled' };
    if (!structure.rootIds.includes(id)) {
        structure.rootIds.unshift(id);
    }
    fs.writeFileSync(notePath, JSON.stringify(structure, null, 2), 'utf-8');

    console.log(`\u2705 Outliner created: "${title}"`);
    console.log(`   File:     ${filePath}`);
    console.log(`   Layout:   flat (pageDir ".", shared images/ files/)`);
    console.log(`   Registered in ${notePath}`);
}

// --- md \u3078\u306e subpage \u8ffd\u52a0\uff08--target-md\uff09 ---

/**
 * subpage \u30ea\u30f3\u30af\u306e\u30e9\u30d9\u30eb\u30b5\u30cb\u30bf\u30a4\u30ba\uff08\u6b63\u5178: chrome-extension/lib/clipper-core.js sanitizeSubpageTitle \u306e 1:1 \u30df\u30e9\u30fc\uff09\u3002
 * \u672c\u4f53\u30d1\u30fc\u30b5 markdown-link-parser.js:74 \u306f\u30e9\u30d9\u30eb\u5185\u306e `]` \u3067 label \u304c\u5207\u308c\u308b\u305f\u3081\u3001`]`/`[` \u3092\u5168\u6570\u5168\u89d2\u5316\u3059\u308b\u3002
 */
export function sanitizeSubpageTitle(title) {
    const t = String(title || '').replace(/[\r\n]+/g, ' ').trim();
    if (!t) return '(untitled)';
    return t.replace(/\]/g, '\uff3d').replace(/\[/g, '\uff3b');
}

/**
 * \u65e2\u5b58 md \u306e subpage \u3068\u3057\u3066 source md \u3092\u53d6\u308a\u8fbc\u3080\uff08clipper clipToMd \u306e skill \u30df\u30e9\u30fc\uff09:
 *   1. source md \u3092\u6b63\u898f\u5316\u30fb\u753b\u50cf/\u30d5\u30a1\u30a4\u30eb\u53c2\u7167\u3092 targetMd \u96a3\u306e images/ files/ \u306b\u30b3\u30d4\u30fc\u3057\u3066\u66f8\u63db
 *   2. <targetMdDir>/<uuid>.md \u3068\u3057\u3066\u4fdd\u5b58
 *   3. targetMd \u672b\u5c3e\u306b `[[title]](<uuid>.md)` \u3092\u8ffd\u8a18\uff08\u76f8\u5bfe\u30ea\u30f3\u30af\u306f dirname(targetMd) \u57fa\u6e96 = notesEditorProvider.ts:1278\uff09
 * text \u3092\u6e21\u3059\u3068 source md \u306a\u3057\u3067\u30ea\u30f3\u30af\u5148\u306e\u7a7a md\uff08`# text\n`\uff09\u3092\u4f5c\u308b\u3002
 */
export function addSubpageToMd(targetMdPath, { sourceMdPath = null, text = null } = {}) {
    const targetAbs = path.resolve(targetMdPath);
    if (!fs.existsSync(targetAbs) || !fs.statSync(targetAbs).isFile()) {
        throw new Error(`target md not found: ${targetAbs}`);
    }
    const targetDir = path.dirname(targetAbs);
    const imageDir = path.join(targetDir, 'images');
    const fileDir = path.join(targetDir, 'files');

    let title;
    let content;
    if (sourceMdPath) {
        const raw = fs.readFileSync(path.resolve(sourceMdPath), 'utf-8');
        title = extractH1(raw) || path.basename(sourceMdPath, '.md');
        content = normalizeMultiLineTableCells(raw);
        const sourceDir = path.dirname(path.resolve(sourceMdPath));
        content = processImages(content, sourceDir, imageDir, targetDir);
        content = processFileLinks(content, sourceDir, fileDir, targetDir);
    } else {
        title = text || 'Untitled';
        content = `# ${title}\n`;
    }

    const uuid = generatePageId();
    const newMdName = `${uuid}.md`;
    fs.writeFileSync(path.join(targetDir, newMdName), content, 'utf-8');

    // \u672b\u5c3e\u306b subpage \u30ea\u30f3\u30af\u8ffd\u8a18\uff08clipper buildMdClipResult \u3068\u540c\u5f62\u5f0f\uff09
    const base = fs.readFileSync(targetAbs, 'utf-8').replace(/\s+$/, '');
    const link = `[[${sanitizeSubpageTitle(title)}]](${newMdName})`;
    fs.writeFileSync(targetAbs, (base ? base + '\n\n' : '') + link + '\n', 'utf-8');

    return { title, uuid, newMdPath: path.join(targetDir, newMdName), targetMdPath: targetAbs };
}

/**
 * \u65b0\u898f standalone md item \u3092\u4f5c\u6210\u3057\u3066 outline.note \u306b\u767b\u9332\u3059\u308b\uff08FR-CMD-01/02\uff09\u3002
 * \u6b63\u5178: src/shared/notes-file-manager.ts createMarkdownFile(:1469) \u306e\u30d5\u30e9\u30c3\u30c8\u30df\u30e9\u30fc \u2014
 *   <notesDir>/<id>.md \u3092 `# Title\n` \u3067\u4f5c\u6210\u3057\u3001items \u306b { type:'file', id, title, ext:'md' }\u3001
 *   rootIds \u5148\u982d\u306b\u633f\u5165\u3002id \u63a1\u756a\u3082\u540c\u898f\u7d04\uff08Date36 + rand4 = generateOutlineId\uff09\u3002
 * pure-ish\uff08fs read/write \u306e\u307f\u30fbunit \u5bfe\u8c61\uff09\u3002
 */
export function createMdItem(notesDir, title) {
    const mainFolder = path.resolve(notesDir || process.cwd());
    if (!fs.existsSync(mainFolder) || !fs.statSync(mainFolder).isDirectory()) {
        throw new Error(`notes directory not found: ${mainFolder}`);
    }
    const id = generateOutlineId();
    const filePath = path.join(mainFolder, `${id}.md`);
    fs.writeFileSync(filePath, `# ${title || 'Untitled'}\n`, 'utf-8');

    const notePath = path.join(mainFolder, 'outline.note');
    let structure = null;
    if (fs.existsSync(notePath)) {
        try { structure = JSON.parse(fs.readFileSync(notePath, 'utf-8')); } catch { structure = null; }
    }
    if (!structure || typeof structure !== 'object') {
        structure = { version: 1, rootIds: [], items: {} };
    }
    structure.items = structure.items || {};
    structure.rootIds = structure.rootIds || [];
    structure.items[id] = { type: 'file', id, title: title || 'Untitled', ext: 'md' };
    if (!structure.rootIds.includes(id)) structure.rootIds.unshift(id);
    fs.writeFileSync(notePath, JSON.stringify(structure, null, 2), 'utf-8');
    return { id, filePath, notePath };
}

async function main() {
    const args = parseArgs(process.argv);

    // === 新規アウトライナー作成モード ===
    if (args.createOutliner !== null) {
        createOutliner(args.createOutliner, args.notesDir);
        return;
    }

    // === 新規 standalone md item 作成モード（FR-CMD-01） ===
    if (args.createMd !== null) {
        const { id, filePath, notePath } = createMdItem(args.notesDir, args.createMd);
        console.log(`✅ Markdown item created: "${args.createMd}"`);
        console.log(`   File: ${filePath} (id: ${id})`);
        console.log(`   Registered in ${notePath} (ext: 'md')`);
        return;
    }

    // === md への subpage 追加モード（--target-md） ===
    if (args.targetMd !== null) {
        const sources = args.mdPatterns.length > 0 ? expandMdFiles(args.mdPatterns) : [null];
        if (args.mdPatterns.length > 0 && sources.length === 0) {
            console.error('Error: no markdown files found');
            process.exit(1);
        }
        for (const src of sources) {
            const r = addSubpageToMd(args.targetMd, { sourceMdPath: src, text: args.text });
            console.log(`📄 Subpage added: "${r.title}" → ${path.basename(r.newMdPath)}`);
        }
        console.log(`\n✅ ${sources.length} subpage(s) linked at end of ${path.resolve(args.targetMd)}`);
        return;
    }

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

    // pages ディレクトリ特定（フラット規約: <noteDir> 直下。hint 優先 → legacy fallback。ADRL-0018 ミラー）
    const noteDir = path.dirname(notePath);
    const basename = path.basename(notePath, '.out');
    const pageDir = resolvePagesDirMjs(noteDir, basename, data);

    // imageDir / fileDir は共有 <noteDir>/{images,files}（hint 優先 → legacy <basename>/ fallback）
    const imageDir = resolveSharedSubMjs(noteDir, basename, 'images', data.imageDir);
    const fileDir = resolveSharedSubMjs(noteDir, basename, 'files', data.fileDir);

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
            const imported = importMdFile(mdFile, pageDir, imageDir, fileDir);
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
        const imported = importMdFile(mdFile, pageDir, imageDir, fileDir);
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

// CLI 直接実行時のみ main を走らせる（unit が import した時に暴発しない・design §B5）
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch(err => {
        console.error(err);
        process.exit(1);
    });
}
