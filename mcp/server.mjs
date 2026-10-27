#!/usr/bin/env node
/**
 * fractal-mcp — Fractal（Notes / Outliner .out / outline.note / page md）を読み書きする MCP サーバー（stdio）。
 *
 * spec 20261027-1700-mcp-full-ops / ADR-0012:
 * - このファイルは「ソースの入口」。実行するのは esbuild で 1 ファイルにした mcp/dist/server.mjs
 *   （`npm run compile` か `node mcp/build.mjs` で作る。SDK・zod・src/shared の正典を全部含む）。
 *   ここは TypeScript（mcp/src）を import するので、node で直接は起動できない。
 * - 中身の処理は src/shared の正典（拡張機能と同じ関数）と webview と同じ OutlinerModel を呼ぶ（mcp/src/*.ts）。
 *   書き込みは 1 本ずつ・tmp + rename・Notes フォルダの中だけ・expectedHash（contentHash）で楽観ロック。
 * - 検索（fractal_search / list_folders）と summary は従来の CLI（scripts/*.mjs）を同じ bundle の
 *   `--fractal-cli <name>` で子プロセスとして走らせる（timeout と出力上限を保つ）。
 * - 公式 SDK（@modelcontextprotocol/sdk）の McpServer + stdio transport。引数の型・必須・enum は zod で検査する
 * - stdout には JSON-RPC 以外を書かない（ログは stderr）
 */
import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { main as searchMain } from './scripts/fractal-search.mjs';
import { main as summaryMain } from './scripts/fractal-summary.mjs';
import { ToolError } from './src/guard.ts';
import { toolGet, toolResolve, toolListNotes, toolDoctor, resolveSummaryNode } from './src/tools-read.ts';
import { toolAdd, toolModify, toolAttach, toolTree } from './src/tools-write.ts';
import STRUCTURE_MD from './structure.md';

const SELF = fileURLToPath(import.meta.url);
const TIMEOUT_MS = 120_000;
const MAX_BUFFER = 10 * 1024 * 1024;


// ─── 引数の型 ───────────────────────────────────────

function noDash(what) { return z.string().min(1).refine((v) => !v.startsWith('-'), { message: `${what} は "-" で始められません` }); }
const P = (description) => noDash('パス').describe(description).optional();
const PL = (description) => z.array(noDash('パス')).describe(description).optional();
const T = (description) => z.string().describe(description).optional();
const TL = (description) => z.array(noDash('値')).describe(description).optional();
const B = (description) => z.boolean().describe(description).optional();
const N = (description) => z.number().int().min(1).describe(description).optional();
const MATCH = z.enum(['exact', 'prefix', 'contains']).describe('本文 / タイトルで指定したときの一致のしかた。exact（既定・完全一致）/ prefix（前方一致）/ contains（部分一致）。2 件以上に一致したら書き込まずに AMBIGUOUS（candidates に id・本文・パンくず）を返す').optional();
const HASH = (what) => z.string().describe(`${what} の contentHash（fractal_get / fractal_resolve の返り値）。今の内容と違えば書かずに CONFLICT を返す。省略すると「ロック無し」で書く（返り値の lock: "none"）`).optional();
const NODE_POS = z.enum(['child', 'first', 'after', 'before']).describe('位置（Fractal の画面と同じ）。child（既定）= 基準ノードの子の末尾（基準が無ければルートの末尾）/ first = 子の先頭 / after = 基準ノードの直後の兄弟 / before = 直前の兄弟').optional();
const MD_POS = z.enum(['end', 'start']).describe('md の中の位置。end（既定）= heading の節の末尾（heading 無しなら本文の末尾）/ start = heading の直後（heading 無しなら先頭 H1 の直後）').optional();
const DRY = B('true なら書き込まず、Notes フォルダの写しで同じ処理を走らせて「何が変わるか」（changed / created / trashed）だけを返す');

// ─── 実行 ──────────────────────────────────────────

function runScript(cli, args, okExitCodes = [0]) {
    return new Promise((resolve) => {
        execFile(process.execPath, [SELF, '--fractal-cli', cli, ...args], { timeout: TIMEOUT_MS, maxBuffer: MAX_BUFFER, encoding: 'utf-8' }, (err, stdout, stderr) => {
            const code = err ? (typeof err.code === 'number' ? err.code : null) : 0;
            if (code !== null && okExitCodes.includes(code)) {
                resolve({ ok: true, stdout: stdout || '', stderr: stderr || '' });
                return;
            }
            const why = err?.killed ? `timeout（${TIMEOUT_MS / 1000} 秒）` : err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? '出力が大きすぎます' : `exit ${code ?? err?.code}`;
            resolve({ ok: false, message: `fractal-${cli} が失敗しました（${why}）\n${(stderr || stdout || '').trim()}` });
        });
    });
}

const text = (s) => ({ content: [{ type: 'text', text: s }] });
const json = (o) => text(JSON.stringify(o, null, 2));
const fail = (code, message, details = {}) => ({ isError: true, content: [{ type: 'text', text: JSON.stringify({ ok: false, error: { code, message, ...details } }, null, 2) }] });

/** handler の例外を isError の JSON にそろえる（ToolError は code 付き） */
const wrap = (fn) => async (a) => {
    try {
        return await fn(a ?? {});
    } catch (e) {
        if (e instanceof ToolError) { return fail(e.code, e.message, e.details); }
        console.error('[fractal-mcp]', e);
        return fail('FAILED', String(e?.message || e));
    }
};

async function cliText(cli, args, okExitCodes) {
    const r = await runScript(cli, args, okExitCodes);
    if (!r.ok) { throw new ToolError('FAILED', r.message); }
    return r.stdout || r.stderr || '(出力なし)';
}

/** 登録済み Notes フォルダ（VS Code 系 / Electron の設定から） */
async function discoverFolders() {
    const out = await cliText('search', ['--list-folders', '--json']);
    try { return JSON.parse(out).folders || []; } catch { return []; }
}

const folderArgs = (a) => (a.folders?.length ? a.folders.flatMap((f) => ['--folder', f]) : ['--auto']);

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

// ─── tools ─────────────────────────────────────────

async function startServer() {
    const server = new McpServer(
        { name: 'fractal', version: '2.0.0' },
        {
            instructions: [
                'Fractal（アウトライナー .out / outline.note / page md）を読み書きする tools。初めて触るときは fractal_structure を読む。',
                '手順: (1) 対象を fractal_resolve（タイトル → 絶対パス / id）か fractal_get（中身と contentHash）で特定する。Notes フォルダが分からなければ fractal_list_folders / fractal_list_notes。候補が複数ならユーザーに選んでもらう',
                '(2) 書き込み（fractal_add / fractal_modify / fractal_attach / fractal_tree）は expectedHash に読んだときの contentHash を付ける。CONFLICT なら読み直してやり直す。md の本文は自分で直接編集してよい（H1 を変えるときは fractal_tree rename（md item）/ fractal_modify set-text（page）。画像・添付・subpage は fractal_attach / fractal_add。.out / outline.note は直接書かない）',
                '(3) 返り値の JSON（nodeId / pageId / absPath / contentHash）で次の操作を続ける。本文で指定して AMBIGUOUS になったら candidates の id を使う',
                '削除・移動・ページ解除の前は dryRun で確かめられる。削除は OS のゴミ箱へ移す。',
            ].join('\n'),
        },
    );
    const reg = (name, def, handler) => server.registerTool(name, def, wrap(handler));

    // ── 読む ──

    reg('fractal_structure', {
        description: 'Fractal の Notes / Outliner(.out) / outline.note / Page(md) / 画像・ファイルのデータモデルと、Notes フォルダの見つけ方の説明を返す（Markdown の文書）。Fractal のファイルを読む・書く前に一度読む。',
        annotations: { readOnlyHint: true },
    }, async () => text(STRUCTURE_MD));

    reg('fractal_list_folders', {
        description: '登録済みの Fractal Notes フォルダ（VSCode / Cursor / Kiro / VSCodium / Antigravity の globalState と Notes 一覧ファイル、Electron の設定から自動検出）を JSON で返す: { folders: [{ path, name（note の表示名）, dirName, sources }] }。',
        annotations: { readOnlyHint: true },
    }, async () => text(await cliText('search', ['--list-folders', '--json'])));

    reg('fractal_list_notes', {
        description: 'note（Notes フォルダ = outline.note のあるフォルダ）の一覧と、各 note のツリーの項目（.out / md / 添付 file / 仮想 folder / folderLink）を JSON で返す。folders を渡したらそのフォルダだけを見る（自動検出しない）。返り値: { notes: [{ noteDir, noteTitle, dirName, outlineNotePath, contentHash, counts, items?: [{ id, type: out|md|file|folder|folderLink, title, folderPath, absPath, exists }] }] }。items は folders / noteName を指定したとき（または includeItems: true）だけ出る。',
        inputSchema: {
            folders: PL('Notes フォルダの絶対パス（省略時は登録済みを自動検出）'),
            noteName: TL('note 名（noteTitle かフォルダ名）の部分一致で絞る'),
            includeItems: B('各 note のツリーの項目を出す（既定: folders / noteName 指定時だけ）'),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => json(await toolListNotes(a, discoverFolders)));

    reg('fractal_resolve', {
        description: 'タイトルや本文から対象（note / ツリーの項目 / ノード / page / md の見出し）を特定して、絶対パス・id・contentHash を返す。完全一致が既定（match で prefix / contains）。1 件ならその 1 件を { ok, result } で返し、2 件以上なら isError の AMBIGUOUS で候補（kind / title / id / absPath / パンくず）を返す（ユーザーに選んでもらう）。0 件は NOT_FOUND。kind: note（note の表示名）/ item（outline.note の .out・md・添付・フォルダ）/ page（page ノード。node の本文か page md の H1）/ node（.out のノード。within で .out を指定すると速い）/ heading（within の md の見出し）/ any（既定 = note + item + page）。result の例: { kind: "item", type: "md", title, itemId, noteDir, absPath, contentHash } / { kind: "page", nodeId, outPath, pageMdPath, contentHash }。',
        inputSchema: {
            query: z.string().min(1).describe('探すタイトル / 本文 / 見出し（または id）'),
            kind: z.enum(['any', 'note', 'item', 'node', 'page', 'heading']).describe('探す対象の種類（既定 any = note・ツリーの項目・page）').optional(),
            match: MATCH,
            folders: PL('探す Notes フォルダ（省略時は登録済みを全部）'),
            within: P('この .out のノード / この md の見出しの中だけを探す（絶対パス）'),
            limit: N('候補の最大件数（既定 50）'),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => json(await toolResolve(a, discoverFolders)));

    reg('fractal_get', {
        description: '1 つの対象の中身を JSON で返す（読むだけ）。path に (a) Notes フォルダ → note のツリー（items: id / type / title / absPath / 入れ子）(b) .out → ノード木（各ノード: id / text / children / checked / isPage・pageId・pageMdPath / images / filePath・fileAbsPath / tags。node で部分木、depth で深さを絞れる）(c) md → 本文 body・h1・headings（level / text / line / path）・subpages・images・files（📎 添付）・owner（tree の md item / page node のどちらの持ち物か）。どれも contentHash を返すので、書き込み系の expectedHash に渡す。',
        inputSchema: {
            path: noDash('パス').describe('Notes フォルダ / outline.note / .out / .md の絶対パス'),
            node: T('.out のとき: このノード（id か本文）の部分木だけ'),
            match: MATCH,
            depth: z.number().int().min(0).describe('.out のとき: 返す深さ（0 = 指定したノード / ルートだけ。省略 = 全部）').optional(),
            maxBodyChars: N('md の本文の最大文字数（既定 400000。超えたら truncated: true）'),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => json(toolGet(a)));

    reg('fractal_search', {
        description: 'Fractal の outline ノード / page md / ルート md / 添付ファイル（PDF / Office / テキストの中身も）を横断検索し、JSON で返す。全フィルタは AND（note → outliner → md(H1) → 行）。tags / checked / outlineName / h1 を指定すれば query は省略できる。',
        inputSchema: {
            query: T('検索語（"ext:pdf" のように拡張子でも絞れる）'),
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
    }, async (a) => {
        if (a.query === undefined && !a.tags?.length && !a.checked && !a.outlineName && !a.h1) {
            throw new ToolError('INVALID', 'query か tags / checked / outlineName / h1 のどれかが必要です');
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
        return text(await cliText('search', [...args, ...folderArgs(a), '--json']));
    });

    reg('fractal_summary', {
        description: 'Outliner(.out) か md（subpage を再帰で含む）の全内容を 1 本の Markdown にして返す（読むだけ）。要約・質問に答えるための入力に使う。node（id か本文の完全一致。曖昧なら AMBIGUOUS で候補）でその部分木だけにできる。',
        inputSchema: {
            note: P('.out の絶対パス（md と排他）'),
            node: T('note のうち、このノード（id か本文）以下だけ'),
            match: MATCH,
            md: P('md の絶対パス（note と排他）'),
        },
        annotations: { readOnlyHint: true },
    }, async (a) => {
        if ((a.note === undefined) === (a.md === undefined)) throw new ToolError('INVALID', 'note か md のどちらか 1 つを指定してください');
        const args = a.md !== undefined ? ['--md', a.md] : ['--note', a.note];
        if (a.node !== undefined) {
            if (a.note === undefined) throw new ToolError('INVALID', 'node は note と一緒に使います');
            args.push('--node', resolveSummaryNode(a.note, a.node, a.match));
        }
        return text(await cliText('summary', args));
    });

    reg('fractal_doctor', {
        description: 'note フォルダの整合性を検査する（読むだけ）。JSON: { status: clean|info|warnings|errors, counts, findings: [{ level: ERROR|WARN|INFO, check: structure|tree|refs|ownership|layout|orphans, message, file? }], cleanup: { orphanCount, orphans } }。検査: outline.note の項目と実体（.out / md / 添付 / folderLink）・rootIds・childIds の宙ぶらりん、.out の親子の整合と到達性、壊れた参照（画像 / 添付 / page md / md 内のリンクを subpage まで再帰）、pageId の重複（.out をまたいで）、未移行レイアウト。孤児（どこからも参照されない md / 画像 / 添付）は Fractal の Cleanup（Clean Unused Files）と同じ判定。',
        inputSchema: { noteDir: noDash('パス').describe('note フォルダ（outline.note がある dir）の絶対パス') },
        annotations: { readOnlyHint: true },
    }, async (a) => json(await toolDoctor(a)));

    // ── 書く ──

    reg('fractal_add', {
        description: [
            'Fractal に足す（追加系）。モードは 4 つで、どれか 1 つを指定する:',
            '(1) note（.out の絶対パス）+ text → ノードを 1 つ足す（tags は本文の #tag から、taskMode の .out ならルートのノードに checkbox が付く。画面と同じ）。note + md（取り込む md の絶対パス。複数なら groupName の親ノードの下にまとめる。dir/*.md も可）→ md を page ノードとして取り込む（md の画像・📎 添付・ローカルファイルへのリンク・subpage は Notes フォルダへ複製して書き換える）。位置は parent（基準ノードの id か本文。省略 = ルート）と position（child = 子の末尾が既定）。',
            '(2) createOutliner（タイトル）+ notesDir → 新しい .out を作り outline.note に登録（parentFolder / after でツリーの置き場。既定 = ルートの先頭）。',
            '(3) createMd（タイトル）+ notesDir → 新しい独立 md（# タイトル）を作り登録。',
            '(4) targetMd（md の絶対パス）+ md（取り込む md）か text（新しい subpage のタイトル）→ subpage を作って [[タイトル]](xxx.md) のリンクを targetMd に入れる（heading の節の末尾 / mdPosition）。',
            '返り値 JSON: add-node → { nodeId, parentId, absPath, changed: [{ absPath, contentHash }] } / add-pages → { pages: [{ nodeId, pageId, pageMdPath, title }], groupNodeId? } / create-outliner・create-md → { absPath, itemId } / add-subpage → { subpages: [{ absPath, title, link }] }。',
        ].join('\n'),
        inputSchema: {
            note: P('書き込む .out の絶対パス'),
            text: T('追加するノードの本文（targetMd では新しい subpage のタイトル。md と一緒なら page ノードの本文）'),
            md: PL('page / subpage として取り込む md の絶対パス（複数可・dir/*.md 可）'),
            parent: T('基準ノード（id か本文）。省略時はルート'),
            position: NODE_POS,
            groupName: T('md を複数取り込むとき、まとめる親ノードの名前'),
            createOutliner: T('新しい .out のタイトル（notesDir と一緒に）'),
            createMd: T('新しい独立 md のタイトル（notesDir と一緒に）'),
            notesDir: P('createOutliner / createMd の作成先 Notes フォルダ（outline.note のあるフォルダ）'),
            parentFolder: T('createOutliner / createMd: ツリーの仮想フォルダ（id かタイトル。省略 = ルート）'),
            after: T('createOutliner / createMd: この項目（id かタイトル）の直後に置く'),
            targetMd: P('subpage を足す md の絶対パス'),
            heading: T('targetMd: リンクを入れる見出し（テキストか "親 > 子" のパス）'),
            mdPosition: MD_POS,
            match: MATCH,
            expectedHash: HASH('書き込む .out / targetMd / outline.note（create のとき）'),
        },
    }, async (a) => json(await toolAdd(a)));

    reg('fractal_modify', {
        description: [
            'note（.out）の既存ノードを 1 つ変更する。target はノードの id か本文（既定は完全一致。曖昧なら書かずに AMBIGUOUS で候補）。op:',
            'set-text（text に書き換え。page ノードなら page md の H1 も同期）/ check / uncheck / clear-check（checkbox を消す）/',
            'delete（子孫ごと消す。そのノードたちだけが使っていた page md・画像・添付はゴミ箱へ）/',
            'move（moveTo = 基準ノードか "root" と position。toOut に別の .out を渡すとそちらへ移す: 同じ note なら参照を引き継ぎ、別の note なら page md・画像・添付を移動先へ複製してから移し元の実体をゴミ箱へ。移動先での位置の既定はルートの先頭）/',
            'make-page（ノードをページにして # 本文の先頭行 の page md を作る）/ unpage（ページを解除。page md はゴミ箱へ）/',
            'page-to-md（page ノードをツリーの独立 md item にする。parentFolder / after で置き場。元のノードは空のノードとして残る＝画面と同じ）/',
            'md-to-page（mdItem = 同じ note のツリーの md item を、この .out の page ノードにする。target / position で位置。md item はツリーから外れる）。',
            'dryRun で変更内容だけ確かめられる。返り値 JSON: { op, nodeId, absPath, changed: [{ absPath, contentHash }], created, trashed, ... }（make-page → pageId / pageMdPath、page-to-md → mdItemId / absPath、md-to-page → nodeId / pageId、move toOut → 移動先での nodeId と previousNodeId、delete → removedNodeIds）。',
        ].join('\n'),
        inputSchema: {
            note: noDash('パス').describe('.out の絶対パス'),
            target: T('対象ノード（id か本文）。md-to-page では位置の基準ノード（省略 = ルート）'),
            op: z.enum(['set-text', 'check', 'uncheck', 'clear-check', 'delete', 'move', 'make-page', 'unpage', 'page-to-md', 'md-to-page']).describe('操作'),
            text: T('set-text の新しい本文'),
            moveTo: T('move の基準ノード（id か本文、ルートは "root"）。toOut があるときは移動先の .out の中のノード'),
            position: NODE_POS,
            toOut: P('move: 別の .out（同じ note でも別の note でも可）の絶対パス'),
            mdItem: T('md-to-page: ページにする md item（id / タイトル / 絶対パス）'),
            parentFolder: T('page-to-md: ツリーの仮想フォルダ（id かタイトル。省略 = ルート）'),
            after: T('page-to-md: この項目の直後に置く'),
            dryRun: DRY,
            match: MATCH,
            expectedHash: HASH('note（.out）'),
            targetExpectedHash: HASH('toOut（移動先の .out）'),
        },
        annotations: { destructiveHint: true },
    }, async (a) => json(await toolModify(a)));

    reg('fractal_attach', {
        description: [
            '画像・ファイルを Fractal に取り込む（Notes フォルダの images/ files/ へコピーして相対パスで参照）。',
            '(1) note（.out）→ 画像ノード（images を 1 ノードに）/ 添付ノード（files を 1 ファイル 1 ノード）を parent・position の位置に足す。',
            '(2) note + target + append → 既存ノードに後付け（画像は追加、添付は 1 つだけ。page ノードには添付を付けられない＝page と file は排他。既に添付があれば replace: true で置き換え、古い添付はゴミ箱へ）。',
            '(3) targetMd（md）→ 画像は ![](images/...)、添付は [📎 名前](files/...) のリンクを heading の節の末尾（mdPosition）に入れる（Fractal の画面と同じ書式。Cleanup が添付として数える）。',
            'ファイル名の [ ] ? # と対応しない括弧は _ に置き換える（リンクが壊れないように）。返り値 JSON: { op, absPath, nodeId / nodeIds, images / files / assets: [{ absPath, rel }], links?, changed, created }。',
        ].join('\n'),
        inputSchema: {
            note: P('.out の絶対パス（targetMd と排他）'),
            targetMd: P('リンクを足す md の絶対パス'),
            images: PL('画像ファイルの絶対パス'),
            files: PL('添付ファイルの絶対パス'),
            parent: T('新しいノードの基準ノード（id か本文）'),
            position: NODE_POS,
            text: T('新しいノードの本文'),
            target: T('append の対象ノード（id か本文）'),
            append: B('target の既存ノードに後付けする'),
            replace: B('append で既にある添付を置き換える（古い添付はゴミ箱へ）'),
            heading: T('targetMd: リンクを入れる見出し'),
            mdPosition: MD_POS,
            match: MATCH,
            expectedHash: HASH('note（.out）か targetMd'),
        },
    }, async (a) => json(await toolAttach(a)));

    reg('fractal_tree', {
        description: [
            'note のツリー（outline.note: .out / md / 添付 file / 仮想フォルダ / folderLink）を操作する。item は項目の id / タイトル（既定は完全一致・曖昧なら AMBIGUOUS で候補）/ 絶対パス。op:',
            'rename（title に変える。.out は title、md は先頭 H1 も一緒に変わる）/ delete（.out は持っている page md ごと、md / 添付はその実体を OS のゴミ箱へ。仮想フォルダは中身を親へ移して消す。folderLink はリンクだけ外す）/',
            'move（parentFolder（"root" か仮想フォルダ）と after（この項目の直後）/ position（first / last・既定 last）でツリーの中を移動）/ create-folder（title の仮想フォルダを作る。既定 = 先頭）/',
            'duplicate（.out / md / 添付を資産ごと複製して直後に置く）/ move-to-note（toNoteDir の別の note へ、page md・subpage・資産ごと移す）。',
            '削除・移動は dryRun で確かめられる。返り値 JSON: { op, itemId, type, title, absPath, noteDir, changed: [{ absPath, contentHash }], created, trashed }（duplicate / move-to-note は新しい itemId / absPath）。',
        ].join('\n'),
        inputSchema: {
            noteDir: noDash('パス').describe('Notes フォルダ（outline.note のあるフォルダ）の絶対パス'),
            op: z.enum(['rename', 'delete', 'move', 'create-folder', 'duplicate', 'move-to-note']).describe('操作'),
            item: T('対象の項目（id / タイトル / 絶対パス）'),
            title: T('rename / create-folder の名前'),
            parentFolder: T('move / create-folder の移動先の仮想フォルダ（id かタイトル、ルートは "root"）'),
            after: T('move / create-folder: この項目（id かタイトル）の直後に置く'),
            position: z.enum(['first', 'last']).describe('after が無いときの置き場（move の既定 last / create-folder の既定 first）').optional(),
            toNoteDir: P('move-to-note の移動先 Notes フォルダの絶対パス'),
            dryRun: DRY,
            match: MATCH,
            expectedHash: HASH('noteDir の outline.note'),
            targetExpectedHash: HASH('toNoteDir の outline.note'),
        },
        annotations: { destructiveHint: true },
    }, async (a) => json(await toolTree(a)));

    await server.connect(new StdioServerTransport());
}

// ─── 入口: bundle を CLI として使う口（検索・summary を子プロセスで走らせる） ───────────
if (process.argv[2] === '--fractal-cli') {
    const name = process.argv[3];
    const rest = process.argv.slice(4);
    const mains = { search: searchMain, summary: summaryMain };
    if (!mains[name]) { console.error(`unknown cli: ${name}`); process.exit(2); }
    process.argv = [process.argv[0], `fractal-${name}.mjs`, ...rest];
    await mains[name]();
} else {
    await startServer();
}
