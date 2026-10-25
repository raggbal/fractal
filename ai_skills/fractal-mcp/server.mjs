#!/usr/bin/env node
/**
 * fractal-mcp — Fractal の読み書き（search / edit / summary / doctor / structure）を
 * 1 つの MCP サーバー（stdio）として出す。
 *
 * - 公式 SDK（@modelcontextprotocol/sdk）の McpServer + stdio transport。引数の型・必須・enum は zod で検査する
 * - ロジックは持たない: 各 tool は scripts/ の既存 mjs を execFile（shell なし・引数配列）で呼ぶ
 * - skill としては配置しない。各 IDE の MCP 設定が repo のこのファイルを直接起動する（ai_skills/install.sh）
 * - stdout には JSON-RPC 以外を書かない（ログは stderr）
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;

const script = (file) => path.join(HERE, 'scripts', file);
const SEARCH = script('fractal-search.mjs');
const MD = script('fractal-md.mjs');
const MODIFY = script('fractal-modify.mjs');
const ATTACH = script('fractal-attach.mjs');
const SUMMARY = script('fractal-summary.mjs');
const DOCTOR = script('fractal-doctor.mjs');
const STRUCTURE_MD = path.join(HERE, 'structure.md');

// ─── 引数の型 ───────────────────────────────────────
// パス類は "-" で始められない（後ろの CLI がフラグと取り違える。--md は次の -- まで集める）。
// 本文（text / target 等）は 1 個ぶんしか読まれないので "-" 始まりでもよい。

const noDash = (what) => z.string().min(1).refine((v) => !v.startsWith('-'), { message: `${what} は "-" で始められません` });
const P = (description) => noDash('パス').describe(description).optional();
const PL = (description) => z.array(noDash('パス')).describe(description).optional();
const T = (description) => z.string().describe(description).optional();
const TL = (description) => z.array(noDash('値')).describe(description).optional();
const B = (description) => z.boolean().describe(description).optional();
const N = (description) => z.number().int().min(1).describe(description).optional();
const POSITION = z.enum(['child', 'after']).describe('child = parent の子の末尾（既定） / after = parent の直後の兄弟').optional();

class ToolInputError extends Error {}

/** [key, flag, kind] の表から CLI 引数を組み立てる。kind: 'value' | 'bool' | 'list' */
function flags(a, spec) {
    const out = [];
    for (const [key, flag, kind = 'value'] of spec) {
        const v = a[key];
        if (v === undefined || v === false) continue;
        if (kind === 'bool') out.push(flag);
        else if (kind === 'list') for (const x of v) out.push(flag, x);
        else out.push(flag, String(v));
    }
    return out;
}

const folderArgs = (a) => (a.folders?.length ? a.folders.flatMap((f) => ['--folder', f]) : ['--auto']);

// ─── 実行 ──────────────────────────────────────────

function runScript(file, args, okExitCodes = [0]) {
    return new Promise((resolve) => {
        execFile(process.execPath, [file, ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
            if (code !== null && okExitCodes.includes(code)) {
                resolve({ content: [{ type: 'text', text: stdout || stderr || '(出力なし)' }] });
                return;
            }
            const why = err?.killed ? `timeout（${TIMEOUT_MS / 1000} 秒）` : err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? '出力が大きすぎます' : `exit ${code ?? err?.code}`;
            resolve({ isError: true, content: [{ type: 'text', text: `${path.basename(file)} が失敗しました（${why}）\n${(stderr || stdout || '').trim()}` }] });
        });
    });
}

/** build(a) が [file, args] を返す tool の handler。ToolInputError は isError の結果にする */
const cli = (build, okExitCodes) => async (a) => {
    try {
        const [file, args] = build(a);
        return await runScript(file, args, okExitCodes);
    } catch (e) {
        if (e instanceof ToolInputError) return { isError: true, content: [{ type: 'text', text: e.message }] };
        throw e;
    }
};

// ─── tools ─────────────────────────────────────────

const server = new McpServer(
    { name: 'fractal', version: '1.0.0' },
    {
        instructions: 'Fractal（アウトライナー .out / outline.note / page md）を読み書きする tools。初めて触るときは fractal_structure を読む。Notes フォルダが分からなければ fractal_list_folders、候補が複数ならユーザーに選んでもらう。書き込み（fractal_add / fractal_modify / fractal_attach）は対象の .out / md の絶対パスを確かめてから行う。',
    },
);

server.registerTool('fractal_structure', {
    description: 'Fractal の Notes / Outliner(.out) / outline.note / Page(md) / 画像・ファイルのデータモデルと、Notes フォルダの見つけ方の説明を返す。Fractal のファイルを読む・書く前に一度読む。',
    annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: 'text', text: fs.readFileSync(STRUCTURE_MD, 'utf-8') }] }));

server.registerTool('fractal_list_folders', {
    description: '登録済みの Fractal Notes フォルダ（VSCode / Cursor / Kiro / VSCodium / Antigravity / Electron の設定から自動検出）を JSON で返す。',
    annotations: { readOnlyHint: true },
}, cli(() => [SEARCH, ['--list-folders', '--json']]));

server.registerTool('fractal_list_notes', {
    description: 'Notes フォルダ内の note（outline.note 単位）を JSON で一覧する。folders を省略すると登録済みフォルダを全部見る。',
    inputSchema: {
        folders: PL('Notes フォルダの絶対パス（省略時は自動検出）'),
        noteName: TL('note 名の部分一致で絞る'),
    },
    annotations: { readOnlyHint: true },
}, cli((a) => [SEARCH, ['--list-notes', ...folderArgs(a), ...flags(a, [['noteName', '--note-name', 'list']]), '--json']]));

server.registerTool('fractal_search', {
    description: 'Fractal の outline ノード / page md / ルート md / 添付ファイルを横断検索し、JSON で返す。全フィルタは AND（note → outliner → md(H1) → 行）。tags / checked / outlineName / h1 を指定すれば query は省略できる。',
    inputSchema: {
        query: T('検索語'),
        folders: PL('Notes フォルダの絶対パス（省略時は自動検出）'),
        regex: B('query を正規表現として扱う'),
        caseSensitive: B('大文字小文字を区別する'),
        wholeWord: B('単語単位で一致'),
        scope: z.array(z.enum(['outline', 'node', 'page', 'md', 'file'])).describe('検索対象の種類').optional(),
        tags: TL('タグで絞る（# なしでも可）'),
        checked: z.enum(['true', 'false', 'none', 'any']).describe('タスク状態で絞る').optional(),
        noteName: TL('note 名の部分一致'),
        excludeNote: TL('除外する note 名'),
        outlineName: T('.out のタイトルの部分一致'),
        h1: T('md 先頭 H1 の部分一致'),
        maxResults: N('結果の上限'),
        maxPerFile: N('1 ファイルあたりの上限'),
        summary: B('件数の要約だけ返す'),
        noCache: B('キャッシュを使わない'),
    },
    annotations: { readOnlyHint: true },
}, cli((a) => {
    if (a.query === undefined && !a.tags?.length && !a.checked && !a.outlineName && !a.h1) {
        throw new ToolInputError('query か tags / checked / outlineName / h1 のどれかが必要です');
    }
    const args = flags(a, [
        ['query', '--query'],
        ['regex', '--regex', 'bool'], ['caseSensitive', '--case-sensitive', 'bool'], ['wholeWord', '--whole-word', 'bool'],
        ['tags', '--tag', 'list'], ['noteName', '--note-name', 'list'], ['excludeNote', '--exclude-note', 'list'],
        ['outlineName', '--outline-name'], ['h1', '--h1'], ['checked', '--checked'],
        ['maxResults', '--max-results'], ['maxPerFile', '--max-per-file'],
        ['summary', '--summary', 'bool'], ['noCache', '--no-cache', 'bool'],
    ]);
    if (a.scope?.length) args.push('--scope', a.scope.join(','));
    return [SEARCH, [...args, ...folderArgs(a), '--json']];
}));

server.registerTool('fractal_summary', {
    description: 'Outliner(.out) か md（subpage を再帰で含む）の全内容を 1 本の Markdown にして返す（読むだけ）。要約・質問に答えるための入力に使う。',
    inputSchema: {
        note: P('.out の絶対パス（md と排他）'),
        node: T('note のうち、このノード（id か本文）以下だけ'),
        md: P('md の絶対パス（note と排他）'),
    },
    annotations: { readOnlyHint: true },
}, cli((a) => {
    if ((a.note === undefined) === (a.md === undefined)) throw new ToolInputError('note か md のどちらか 1 つを指定してください');
    return [SUMMARY, flags(a, [['note', '--note'], ['node', '--node'], ['md', '--md']])];
}));

server.registerTool('fractal_doctor', {
    description: 'note フォルダの整合性を検査する（読むだけ）: 未移行レイアウト、壊れた参照（画像 / 添付 / page md）、孤児アセット、outline.note の不整合、1:1 所有違反。',
    inputSchema: { noteDir: noDash('パス').describe('note フォルダ（outline.note がある dir）の絶対パス') },
    annotations: { readOnlyHint: true },
// exit 1 = 警告あり / 2 = 問題あり は検査の結果なので失敗扱いにしない
}, cli((a) => [DOCTOR, ['--note-dir', a.noteDir, '--json']], [0, 1, 2]));

server.registerTool('fractal_add', {
    description: 'Fractal に書き込む（追加系）。(1) note(.out) に text ノード、または md を page ノードとして取り込む（md は複数可・groupName でまとめる） (2) createOutliner + notesDir で新しい .out を作り outline.note に登録 (3) createMd + notesDir で独立 md を作り登録 (4) targetMd の md に subpage（md か text）を足す。',
    inputSchema: {
        note: P('書き込む .out の絶対パス'),
        text: T('追加するノードの本文（targetMd では subpage のタイトル）'),
        md: PL('page として取り込む md のパス（複数可）'),
        parent: T('親ノード（id か本文）。省略時はルート'),
        position: POSITION,
        groupName: T('md を複数取り込むとき、まとめる親ノードの名前'),
        createOutliner: T('新しい .out のタイトル（notesDir と一緒に）'),
        createMd: T('新しい独立 md のタイトル（notesDir と一緒に）'),
        notesDir: P('createOutliner / createMd の作成先 note フォルダ'),
        targetMd: P('subpage を足す md の絶対パス'),
    },
}, cli((a) => {
    const modes = ['note', 'createOutliner', 'createMd', 'targetMd'].filter((k) => a[k] !== undefined);
    if (modes.length !== 1) throw new ToolInputError('note / createOutliner / createMd / targetMd のどれか 1 つを指定してください');
    if ((a.createOutliner !== undefined || a.createMd !== undefined) && a.notesDir === undefined) throw new ToolInputError('notesDir は必須です');
    if ((a.note !== undefined || a.targetMd !== undefined) && a.text === undefined && !a.md?.length) throw new ToolInputError('text か md が必要です');
    const args = flags(a, [
        ['note', '--note'], ['targetMd', '--target-md'],
        ['createOutliner', '--create-outliner'], ['createMd', '--create-md'], ['notesDir', '--notes-dir'],
        ['text', '--text'], ['parent', '--parent'], ['position', '--position'], ['groupName', '--group-name'],
    ]);
    // --md は次の "--" までを全部集めるので最後に置く
    if (a.md?.length) args.push('--md', ...a.md);
    return [MD, args];
}));

server.registerTool('fractal_modify', {
    description: 'note(.out) の既存ノードを 1 つ変更する: 本文の書き換え / チェック / チェック外し / チェックボックスを消す / 削除（子孫ごと） / 移動。dryRun で変更内容だけ確かめられる。',
    inputSchema: {
        note: noDash('パス').describe('.out の絶対パス'),
        target: z.string().describe('対象ノード（id か本文）'),
        op: z.enum(['set-text', 'check', 'uncheck', 'clear-check', 'delete', 'move']).describe('操作'),
        text: T('set-text の新しい本文'),
        moveTo: T('move の移動先ノード（id か本文、ルートは "root"）'),
        position: POSITION,
        dryRun: B('書き込まずに結果だけ返す'),
    },
    annotations: { destructiveHint: true },
}, cli((a) => {
    const args = ['--note', a.note, '--target', a.target];
    if (a.op === 'set-text') {
        if (a.text === undefined) throw new ToolInputError('set-text には text が必要です');
        args.push('--set-text', a.text);
    } else if (a.op === 'move') {
        if (a.moveTo === undefined) throw new ToolInputError('move には moveTo が必要です');
        args.push('--move-to', a.moveTo, ...flags(a, [['position', '--position']]));
    } else args.push(`--${a.op}`);
    if (a.dryRun) args.push('--dry-run');
    return [MODIFY, args];
}));

server.registerTool('fractal_attach', {
    description: '画像・ファイルを Fractal に取り込む（コピーして相対パスで参照）。(1) note(.out) に画像ノード / ファイルノードを足す (2) target + append で既存ノードに後付け (3) targetMd の md の末尾にリンクを足す。',
    inputSchema: {
        note: P('.out の絶対パス（targetMd と排他）'),
        targetMd: P('リンクを足す md の絶対パス'),
        images: PL('画像ファイルのパス'),
        files: PL('添付ファイルのパス'),
        parent: T('親ノード（id か本文）'),
        position: POSITION,
        text: T('新しいノードの本文'),
        target: T('append の対象ノード（id か本文）'),
        append: B('target の既存ノードに後付けする'),
    },
}, cli((a) => {
    if ((a.note === undefined) === (a.targetMd === undefined)) throw new ToolInputError('note か targetMd のどちらか 1 つを指定してください');
    if (!a.images?.length && !a.files?.length) throw new ToolInputError('images か files が必要です');
    return [ATTACH, flags(a, [
        ['note', '--note'], ['targetMd', '--target-md'],
        ['images', '--image', 'list'], ['files', '--file', 'list'],
        ['parent', '--parent'], ['position', '--position'],
        ['text', '--text'], ['target', '--target'], ['append', '--append', 'bool'],
    ])];
}));

await server.connect(new StdioServerTransport());
