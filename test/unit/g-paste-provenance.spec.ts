/**
 * G-paste のコピー元 provenance（FR-CBD-04 rev1 / NFR-CBD-04 / ADRL-0121 / TASK-27）
 * sprint 20260906-095357-outliner-selmode-cmda-linkedfd-multimove
 *
 * reviewer iteration 1 SEC-1: G（outliner clip → linkedfd cmd+v）はコピー元 `.out` の絶対パスを
 * **OS clipboard の `text/html`** から正規表現で拾って host に渡し、host は
 * `endsWith('.out') && fs.existsSync(...)` だけで受理していた（containment なし）。
 * `text/html` はあらゆるアプリが populate する汎用 MIME なので、外部由来の HTML に偽の `.out` パスを
 * 仕込めば任意の `.out` を読ませられた。
 *
 * ADRL-0121: コピー元の真実は **`OutlinerClipboardStore` の `sourceOutDir`**（outliner の copy/cut ごとに
 * extension 自身が記録している）。既存の cross 経路 4 本（handlePageAssetsCross / copyImagesCross /
 * handleFileAssetCross / copyPageFileCross）と同じ型に揃える。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}

/**
 * notes-message-handler と **同一 require グラフ上の** OutlinerClipboardStore を取る。
 *
 * 🔴 2 回に分けて `requireWithVscodeStub` を呼ぶと、finally の `purgeSrcCache()` で
 * `src/` 配下がキャッシュから落ちるため **store が別インスタンス**になり、テストが書いた値を
 * 実装側が見られない（= 実装は正しいのに常に null になる）。1 回の stub 窓の中で両方 require する。
 */
function loadMod() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        const mod = require('../../src/shared/notes-message-handler');
        const store = require('../../src/shared/outliner-clipboard-store').OutlinerClipboardStore;
        return { mod, store };
    } finally { Module._load = origLoad; }   // purge しない（同一インスタンスを保つ）
}

function mkTree() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'gpp-'));
    const notes = path.join(base, 'notes');
    const other = path.join(base, 'other');
    fs.mkdirSync(notes, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const workOut = path.join(notes, 'work.out');
    const secretOut = path.join(other, 'secret.out');
    fs.writeFileSync(workOut, JSON.stringify({ version: 1, rootIds: [], nodes: {} }), 'utf8');
    fs.writeFileSync(secretOut, JSON.stringify({ version: 1, rootIds: [], nodes: {} }), 'utf8');
    return { base, notes, other, workOut, secretOut };
}

const saveStore = (store: any, sourceOutDir: string, sourceOutFilePath?: string) => store.save({
    plainText: 'n1', isCut: false, nodes: [],
    sourcePagesDirPath: path.join(sourceOutDir, 'pages'),
    sourceImagesDirPath: path.join(sourceOutDir, 'pages', 'images'),
    sourceFileDirPath: path.join(sourceOutDir, 'files'),
    sourceOutDir, sourceOutFilePath,
});

test('TC-CBD-70 偽造した .out パスは host のファイル読取に到達しない', () => {
    const { mod, store } = loadMod();
    const { notes, workOut, secretOut } = mkTree();
    saveStore(store, notes, workOut);              // 記録されたコピー元は notes/work.out

    const r = mod.resolveTrustedOutPath(secretOut, null);
    expect(r, `記録されたコピー元と別の .out が受理された（任意ファイル読取 = SEC-1）: ${r}`).toBe(null);
});

test('TC-CBD-71 記録されたコピー元そのものは受理される', () => {
    const { mod, store } = loadMod();
    const { notes, workOut } = mkTree();
    saveStore(store, notes, workOut);

    const r = mod.resolveTrustedOutPath(workOut, null);
    expect(r, '記録されたコピー元そのものが拒否された（機能が死ぬ = 過剰実装）').toBe(fs.realpathSync(workOut));
});

test('TC-CBD-72 store が空なら受理しない（再起動 / 別ウィンドウ相当）', () => {
    const { mod, store } = loadMod();
    const { workOut } = mkTree();
    store.save(null as any);                       // 空にする（extension 起動直後 / 別プロセス相当）

    const r = mod.resolveTrustedOutPath(workOut, null);
    expect(r, 'store が空なのに受理された（素通し = containment が効いていない）').toBe(null);
});

test('TC-CBD-73 id 指定の正規経路は containment に関係なく維持される', () => {
    const { mod, store } = loadMod();
    const { notes, workOut } = mkTree();
    saveStore(store, notes);
    // `.out` で終わらない値 = id 指定。resolver は fileManager の id 解決に委ねる（従来分岐）
    const resolved = mod.resolveTrustedOutPath('some-id', { getFilePathById: (id: string) => (id === 'some-id' ? workOut : '') });
    expect(resolved, 'id 指定の正規経路が壊れた').toBe(workOut);
});

test('TC-CBD-73b 同じ sink を通る既存 D&D 経路にも同じ containment が効く（trigger ごとに書き分けていない）', () => {
    const PROVIDER = path.join(ROOT, 'src', 'notesEditorProvider.ts');
    const src = fs.readFileSync(PROVIDER, 'utf8');
    const at = src.indexOf('sendOutNodesToFolderLinkFromDrop: async');
    expect(at, 'sink が provider に無い').toBeGreaterThan(-1);
    const win = src.slice(at, at + 2600);   // TASK-29 で信頼源列挙のコメントが増えたので窓を広げる
    expect(win.includes('resolveTrustedOutPath'),
        'sink で containment を通していない（G 分岐の webview 側だけに検査を書くと既存 D&D が無防備なまま）')
        .toBe(true);
    expect(/payload\.outFileKey\.endsWith\('\.out'\)\s*&&\s*fs\.existsSync/.test(win),
        '旧・無防備な受理条件（endsWith(.out) && existsSync）が残っている').toBe(false);
    // srcOutDir も store 由来にする（兄弟 4 本と同じ型 = ADRL-0121）
    expect(/srcOutDir:\s*path\.dirname\(outPath\)/.test(win),
        'srcOutDir を clipboard 由来のパスから再導出している（store の sourceOutDir を使うべき）').toBe(false);
});

/**
 * TC-CBD-75（reviewer iteration 2 DESIGN-4 の番人 / TASK-29）:
 * **clipboard を一切経由しない既存 D&D が、コピー履歴ゼロでも通ること。**
 *
 * D&D drop（`notes-folder-view.js:622-634`）は `application/x-fractal-out-node-subtree` 等を読んで
 * 同じ sink を呼ぶが、`saveOutlinerClipboard` は copy / cut / duplicate ハンドラからのみ送られ
 * **dragstart からは 1 件も送られない**（`grep -n "saveOutlinerClipboard" src/webview/outliner.js` の
 * 全ヒットが copy/cut/duplicate 内）。iteration 2 の containment は store だけを信頼源にしていたため、
 * 「拡張起動後に一度も cmd+c していない状態で node を linkedfd へ D&D」が **silent no-op** に退行していた。
 *
 * counterfactual（TASK-27 時点の実装）: store 空 → `resolveTrustedOutPath` が null → 通知もなく何も起きない
 */
test('TC-CBD-75 コピー履歴ゼロでも「開いている .out」からの D&D は通る（DESIGN-4 の回帰番人）', () => {
    const { mod, store } = loadMod();
    const { workOut, secretOut } = mkTree();
    store.save(null as any);                       // clipboard 履歴なし（起動直後 = D&D が最初の操作）

    const fmOpen = { getFilePathById: () => '', getCurrentFilePath: () => workOut };

    // ① この面が現在開いている .out（D&D の payload は currentOutFileKey）→ 受理
    const ok = mod.resolveTrustedOutPath(workOut, fmOpen);
    expect(ok, 'コピー履歴ゼロだと D&D が無反応になる（DESIGN-4 の退行）').toBe(fs.realpathSync(workOut));

    // ② 開いていない別の .out は、コピー履歴ゼロでも受理しない（SEC-1 の containment は維持）
    const ng = mod.resolveTrustedOutPath(secretOut, fmOpen);
    expect(ng, '開いていない .out が受理された（containment が緩んだ）').toBe(null);
});

test('TC-CBD-76 記録済みコピー元と同一フォルダの別 .out は受理しない（SEC-6）', () => {
    const { mod, store } = loadMod();
    const { notes, workOut } = mkTree();
    const sibling = path.join(notes, 'work-secret.out');
    fs.writeFileSync(sibling, JSON.stringify({ version: 1, rootIds: [], nodes: {} }), 'utf8');
    saveStore(store, notes, workOut);              // copy したのは work.out だけ

    const r = mod.resolveTrustedOutPath(sibling, null);
    expect(r, '同一フォルダの別 .out が受理された（containment がディレクトリ単位のまま = SEC-6）').toBe(null);
});

/**
 * TC-CBD-77（reviewer iteration 3 SEC-7 の番人 / ADRL-0121 rev2）:
 * **「別タブで開いているだけ」の `.out` は信頼源にしない。**
 *
 * rev1 は第 3 の信頼源として `openOutPaths`（workspace 中で開いている全 `.out`）を受けていたが、
 * これは偽造 clipboard trigger にとっても有効な受理条件になり SEC-1 の脅威モデルを再拡大していた
 * （victim が別タブで `secret.out` を開いているだけで偽造 paste が通る）。
 * DESIGN-4 を閉じるのに必要なのは「**この面が**開いている `.out`」だけ。
 */
test('TC-CBD-77 別タブで開いているだけの .out は信頼源にならない（SEC-7）', () => {
    const { mod, store } = loadMod();
    const { workOut, secretOut } = mkTree();
    store.save(null as any);                       // コピー履歴なし
    // この面が開いているのは workOut。secretOut は「別タブで開いているだけ」に相当
    const fm = { getFilePathById: () => '', getCurrentFilePath: () => workOut };

    expect(mod.resolveTrustedOutPath(secretOut, fm),
        '別タブで開いているだけの .out が受理された（第 3 の信頼源が復活している = SEC-7）').toBe(null);
    // 第 3 引数（openOutPaths）を渡そうとしても受理条件にならない（シグネチャから撤去済み）
    expect((mod.resolveTrustedOutPath as any)(secretOut, fm, [secretOut]),
        '第 3 引数で信頼源を注入できてしまう').toBe(null);
    // 正当な経路（この面が開いているファイル）は通る
    expect(mod.resolveTrustedOutPath(workOut, fm), '正当な D&D 経路が塞がれた').toBe(fs.realpathSync(workOut));
});
