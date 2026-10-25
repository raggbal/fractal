#!/usr/bin/env node
/**
 * fractal-mcp — Fractal の skill 群（search / edit / summary / doctor / structure）を
 * 1 つの MCP サーバー（stdio）として出す。
 *
 * - 依存なし: MCP の stdio transport（改行区切りの JSON-RPC 2.0）を直接話す。
 *   kiro は skill dir を copy 配置するので node_modules を持てない（spec 20261025-2350 D1）
 * - ロジックは持たない: 各 tool は兄弟 dir の既存 mjs を execFile（shell なし・引数配列）で呼ぶ（D2）。
 *   scripts の置き場所は ai_skills/fractal-*\/scripts のまま（register-fractal.mjs が参照している）
 * - stdout には JSON-RPC 以外を書かない（ログは stderr）
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILLS = path.resolve(HERE, '..');
const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

const script = (skill, file) => path.join(SKILLS, skill, 'scripts', file);
const SEARCH = script('fractal-search', 'fractal-search.mjs');
const MD = script('fractal-edit', 'fractal-md.mjs');
const MODIFY = script('fractal-edit', 'fractal-modify.mjs');
const ATTACH = script('fractal-edit', 'fractal-attach.mjs');
const SUMMARY = script('fractal-summary', 'fractal-summary.mjs');
const DOCTOR = script('fractal-doctor', 'fractal-doctor.mjs');
const STRUCTURE_MD = path.join(HERE, 'structure.md');

// ─── 引数の組み立て ─────────────────────────────────

class ToolInputError extends Error {}

/** `-` で始まる値は後ろの CLI がフラグと取り違える（--md は次の -- まで集める）ので拒否する */
function str(v, name) {
    if (typeof v !== 'string' || v === '') throw new ToolInputError(`${name} は空でない文字列で指定してください`);
    if (v.startsWith('-')) throw new ToolInputError(`${name} は "-" で始められません: ${v}`);
    return v;
}
/** --text / --set-text の本文は 1 個ぶんしか読まれないので "-" 始まりでもよい */
const text = (v, name) => {
    if (typeof v !== 'string') throw new ToolInputError(`${name} は文字列で指定してください`);
    return v;
};
const list = (v, name) => {
    if (v === undefined) return [];
    const arr = Array.isArray(v) ? v : [v];
    return arr.map((x, i) => str(x, `${name}[${i}]`));
};
const num = (v, name) => {
    if (!Number.isInteger(v) || v < 1) throw new ToolInputError(`${name} は 1 以上の整数で指定してください`);
    return String(v);
};
const oneOf = (v, name, allowed) => {
    if (!allowed.includes(v)) throw new ToolInputError(`${name} は ${allowed.join(' / ')} のどれかです`);
    return v;
};
const need = (a, ...names) => {
    for (const n of names) if (a[n] === undefined) throw new ToolInputError(`${n} は必須です`);
};

/** 値ありフラグ: a[key] があれば [flag, conv(a[key])] を足す */
function flags(a, spec) {
    const out = [];
    for (const [key, flag, conv] of spec) {
        if (a[key] === undefined || a[key] === false) continue;
        if (conv === true) { out.push(flag); continue; }        // bool フラグ
        if (conv === list) { for (const v of list(a[key], key)) out.push(flag, v); continue; }
        out.push(flag, conv(a[key], key));
    }
    return out;
}

const POSITION = { type: 'string', enum: ['child', 'after'], description: 'child = parent の子の末尾（既定） / after = parent の直後の兄弟' };
const S = (description) => ({ type: 'string', description });
const A = (description) => ({ type: 'array', items: { type: 'string' }, description });
const B = (description) => ({ type: 'boolean', description });
const N = (description) => ({ type: 'integer', minimum: 1, description });

// ─── tools ─────────────────────────────────────────

const TOOLS = [
    {
        name: 'fractal_structure',
        description: 'Fractal の Notes / Outliner(.out) / outline.note / Page(md) / 画像・ファイルのデータモデルと、Notes フォルダの見つけ方の説明を返す。Fractal のファイルを読む・書く前に一度読む。',
        inputSchema: { type: 'object', properties: {} },
        run: () => ({ text: fs.readFileSync(STRUCTURE_MD, 'utf-8') }),
    },
    {
        name: 'fractal_list_folders',
        description: '登録済みの Fractal Notes フォルダ（VSCode / Cursor / Kiro / VSCodium / Antigravity / Electron の設定から自動検出）を JSON で返す。',
        inputSchema: { type: 'object', properties: {} },
        run: () => ({ file: SEARCH, args: ['--list-folders', '--json'] }),
    },
    {
        name: 'fractal_list_notes',
        description: 'Notes フォルダ内の note（outline.note 単位）を JSON で一覧する。folders を省略すると登録済みフォルダを全部見る。',
        inputSchema: {
            type: 'object',
            properties: {
                folders: A('Notes フォルダの絶対パス（省略時は自動検出）'),
                noteName: A('note 名の部分一致で絞る（複数は AND ではなく OR）'),
            },
        },
        run: (a) => ({
            file: SEARCH,
            args: ['--list-notes', ...folderArgs(a), ...flags(a, [['noteName', '--note-name', list]]), '--json'],
        }),
    },
    {
        name: 'fractal_search',
        description: 'Fractal の outline ノード / page md / ルート md / 添付ファイルを横断検索し、JSON で返す。全フィルタは AND（note → outliner → md(H1) → 行）。tag / checked / outlineName / h1 を指定すれば query は省略できる。',
        inputSchema: {
            type: 'object',
            properties: {
                query: S('検索語'),
                folders: A('Notes フォルダの絶対パス（省略時は自動検出）'),
                regex: B('query を正規表現として扱う'),
                caseSensitive: B('大文字小文字を区別する'),
                wholeWord: B('単語単位で一致'),
                scope: { type: 'array', items: { type: 'string', enum: ['outline', 'node', 'page', 'md', 'file'] }, description: '検索対象の種類' },
                tags: A('タグで絞る（# なしでも可）'),
                checked: { type: 'string', enum: ['true', 'false', 'none', 'any'], description: 'タスク状態で絞る' },
                noteName: A('note 名の部分一致'),
                excludeNote: A('除外する note 名'),
                outlineName: S('.out のタイトルの部分一致'),
                h1: S('md 先頭 H1 の部分一致'),
                maxResults: N('結果の上限'),
                maxPerFile: N('1 ファイルあたりの上限'),
                summary: B('件数の要約だけ返す'),
                noCache: B('キャッシュを使わない'),
            },
        },
        run: (a) => {
            if (a.query === undefined && !a.tags && !a.checked && !a.outlineName && !a.h1) {
                throw new ToolInputError('query か tags / checked / outlineName / h1 のどれかが必要です');
            }
            const args = [];
            if (a.query !== undefined) args.push('--query', text(a.query, 'query'));
            args.push(...folderArgs(a));
            args.push(...flags(a, [
                ['regex', '--regex', true], ['caseSensitive', '--case-sensitive', true], ['wholeWord', '--whole-word', true],
                ['tags', '--tag', list], ['noteName', '--note-name', list], ['excludeNote', '--exclude-note', list],
                ['outlineName', '--outline-name', text], ['h1', '--h1', text],
                ['checked', '--checked', (v, n) => oneOf(v, n, ['true', 'false', 'none', 'any'])],
                ['maxResults', '--max-results', num], ['maxPerFile', '--max-per-file', num],
                ['summary', '--summary', true], ['noCache', '--no-cache', true],
            ]));
            if (a.scope !== undefined) args.push('--scope', list(a.scope, 'scope').map((s) => oneOf(s, 'scope', ['outline', 'node', 'page', 'md', 'file'])).join(','));
            args.push('--json');
            return { file: SEARCH, args };
        },
    },
    {
        name: 'fractal_summary',
        description: 'Outliner(.out) か md（subpage を再帰で含む）の全内容を 1 本の Markdown にして返す（読むだけ）。要約・質問に答えるための入力に使う。',
        inputSchema: {
            type: 'object',
            properties: {
                note: S('.out の絶対パス（md と排他）'),
                node: S('note のうち、このノード（id か本文）以下だけ'),
                md: S('md の絶対パス（note と排他）'),
            },
        },
        run: (a) => {
            if ((a.note === undefined) === (a.md === undefined)) throw new ToolInputError('note か md のどちらか 1 つを指定してください');
            return { file: SUMMARY, args: flags(a, [['note', '--note', str], ['node', '--node', text], ['md', '--md', str]]) };
        },
    },
    {
        name: 'fractal_doctor',
        description: 'note フォルダの整合性を検査する（読むだけ）: 未移行レイアウト、壊れた参照（画像 / 添付 / page md）、孤児アセット、outline.note の不整合、1:1 所有違反。',
        inputSchema: {
            type: 'object',
            properties: { noteDir: S('note フォルダ（outline.note がある dir）の絶対パス') },
            required: ['noteDir'],
        },
        // exit 1 = 警告あり / 2 = エラーあり は検査の結果なので失敗扱いにしない
        okExitCodes: [0, 1, 2],
        run: (a) => { need(a, 'noteDir'); return { file: DOCTOR, args: ['--note-dir', str(a.noteDir, 'noteDir'), '--json'] }; },
    },
    {
        name: 'fractal_add',
        description: 'Fractal に書き込む（追加系）。(1) note(.out) に text ノード、または md を page ノードとして取り込む（md は複数可・groupName でまとめる） (2) createOutliner + notesDir で新しい .out を作り outline.note に登録 (3) createMd + notesDir で独立 md を作り登録 (4) targetMd の md に subpage（md か text）を足す。',
        inputSchema: {
            type: 'object',
            properties: {
                note: S('書き込む .out の絶対パス'),
                text: S('追加するノードの本文（targetMd では subpage のタイトル）'),
                md: A('page として取り込む md のパス（複数可）'),
                parent: S('親ノード（id か本文）。省略時はルート'),
                position: POSITION,
                groupName: S('md を複数取り込むとき、まとめる親ノードの名前'),
                createOutliner: S('新しい .out のタイトル（notesDir と一緒に）'),
                createMd: S('新しい独立 md のタイトル（notesDir と一緒に）'),
                notesDir: S('createOutliner / createMd の作成先 note フォルダ'),
                targetMd: S('subpage を足す md の絶対パス'),
            },
        },
        run: (a) => {
            const modes = ['note', 'createOutliner', 'createMd', 'targetMd'].filter((k) => a[k] !== undefined);
            if (modes.length !== 1) throw new ToolInputError('note / createOutliner / createMd / targetMd のどれか 1 つを指定してください');
            if ((a.createOutliner !== undefined || a.createMd !== undefined) && a.notesDir === undefined) throw new ToolInputError('notesDir は必須です');
            if ((a.note !== undefined || a.targetMd !== undefined) && a.text === undefined && a.md === undefined) throw new ToolInputError('text か md が必要です');
            const args = flags(a, [
                ['note', '--note', str], ['targetMd', '--target-md', str],
                ['createOutliner', '--create-outliner', text], ['createMd', '--create-md', text], ['notesDir', '--notes-dir', str],
                ['text', '--text', text], ['parent', '--parent', text],
                ['position', '--position', (v, n) => oneOf(v, n, ['child', 'after'])], ['groupName', '--group-name', text],
            ]);
            // --md は次の "--" までを全部集めるので最後に置く
            if (a.md !== undefined) args.push('--md', ...list(a.md, 'md'));
            return { file: MD, args };
        },
    },
    {
        name: 'fractal_modify',
        description: 'note(.out) の既存ノードを 1 つ変更する: 本文の書き換え / チェック / チェック外し / チェックボックスを消す / 削除（子孫ごと） / 移動。dryRun で変更内容だけ確かめられる。',
        inputSchema: {
            type: 'object',
            properties: {
                note: S('.out の絶対パス'),
                target: S('対象ノード（id か本文）'),
                op: { type: 'string', enum: ['set-text', 'check', 'uncheck', 'clear-check', 'delete', 'move'], description: '操作' },
                text: S('set-text の新しい本文'),
                moveTo: S('move の移動先ノード（id か本文、ルートは "root"）'),
                position: POSITION,
                dryRun: B('書き込まずに結果だけ返す'),
            },
            required: ['note', 'target', 'op'],
        },
        run: (a) => {
            need(a, 'note', 'target', 'op');
            const op = oneOf(a.op, 'op', ['set-text', 'check', 'uncheck', 'clear-check', 'delete', 'move']);
            const args = ['--note', str(a.note, 'note'), '--target', text(a.target, 'target')];
            if (op === 'set-text') { need(a, 'text'); args.push('--set-text', text(a.text, 'text')); }
            else if (op === 'move') {
                need(a, 'moveTo');
                args.push('--move-to', text(a.moveTo, 'moveTo'));
                if (a.position !== undefined) args.push('--position', oneOf(a.position, 'position', ['child', 'after']));
            } else args.push(`--${op}`);
            if (a.dryRun) args.push('--dry-run');
            return { file: MODIFY, args };
        },
    },
    {
        name: 'fractal_attach',
        description: '画像・ファイルを Fractal に取り込む（コピーして相対パスで参照）。(1) note(.out) に画像ノード / ファイルノードを足す (2) target + append で既存ノードに後付け (3) targetMd の md の末尾にリンクを足す。',
        inputSchema: {
            type: 'object',
            properties: {
                note: S('.out の絶対パス（targetMd と排他）'),
                targetMd: S('リンクを足す md の絶対パス'),
                images: A('画像ファイルのパス'),
                files: A('添付ファイルのパス'),
                parent: S('親ノード（id か本文）'),
                position: POSITION,
                text: S('新しいノードの本文'),
                target: S('append の対象ノード（id か本文）'),
                append: B('target の既存ノードに後付けする'),
            },
        },
        run: (a) => {
            if ((a.note === undefined) === (a.targetMd === undefined)) throw new ToolInputError('note か targetMd のどちらか 1 つを指定してください');
            if (!a.images?.length && !a.files?.length) throw new ToolInputError('images か files が必要です');
            return {
                file: ATTACH,
                args: flags(a, [
                    ['note', '--note', str], ['targetMd', '--target-md', str],
                    ['images', '--image', list], ['files', '--file', list],
                    ['parent', '--parent', text], ['position', '--position', (v, n) => oneOf(v, n, ['child', 'after'])],
                    ['text', '--text', text], ['target', '--target', text], ['append', '--append', true],
                ]),
            };
        },
    },
];

function folderArgs(a) {
    const folders = list(a.folders, 'folders');
    return folders.length ? folders.flatMap((f) => ['--folder', f]) : ['--auto'];
}

// ─── 実行 ──────────────────────────────────────────

function runScript({ file, args }, okExitCodes = [0]) {
    return new Promise((resolve) => {
        execFile(process.execPath, [file, ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
            if (code !== null && okExitCodes.includes(code)) {
                resolve({ isError: false, text: stdout || stderr || '(出力なし)' });
                return;
            }
            const why = err?.killed ? `timeout（${TIMEOUT_MS / 1000} 秒）` : err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? '出力が大きすぎます' : `exit ${code ?? err?.code}`;
            resolve({ isError: true, text: `${path.basename(file)} が失敗しました（${why}）\n${(stderr || stdout || '').trim()}` });
        });
    });
}

async function callTool(name, args) {
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return { content: [{ type: 'text', text: `unknown tool: ${name}` }], isError: true };
    try {
        const plan = tool.run(args ?? {});
        const r = plan.text !== undefined ? { isError: false, text: plan.text } : await runScript(plan, tool.okExitCodes);
        return { content: [{ type: 'text', text: r.text }], isError: r.isError };
    } catch (e) {
        if (e instanceof ToolInputError) return { content: [{ type: 'text', text: e.message }], isError: true };
        throw e;
    }
}

// ─── JSON-RPC（stdio） ─────────────────────────────

const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

async function handle(req) {
    switch (req.method) {
        case 'initialize':
            return {
                protocolVersion: PROTOCOL_VERSION,
                capabilities: { tools: {} },
                serverInfo: { name: 'fractal', version: '1.0.0' },
                instructions: 'Fractal（アウトライナー .out / outline.note / page md）を読み書きする tools。初めて触るときは fractal_structure を読む。Notes フォルダが分からなければ fractal_list_folders、候補が複数ならユーザーに選んでもらう。書き込み（fractal_add / fractal_modify / fractal_attach）は対象の .out / md の絶対パスを確かめてから行う。',
            };
        case 'ping':
            return {};
        case 'tools/list':
            return { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) };
        case 'tools/call':
            return callTool(req.params?.name, req.params?.arguments);
        default: {
            const e = new Error(`Method not found: ${req.method}`);
            e.rpcCode = -32601;
            throw e;
        }
    }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
    if (!line.trim()) return;
    let req;
    try {
        req = JSON.parse(line);
    } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        return;
    }
    const isNotification = req.id === undefined;
    try {
        const result = await handle(req);
        if (!isNotification) send({ id: req.id, result });
    } catch (e) {
        if (isNotification) return;
        send({ id: req.id, error: { code: e.rpcCode ?? -32603, message: e.message } });
    }
});
rl.on('close', () => process.exit(0));
