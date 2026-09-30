/**
 * TASK-06 — フォルダ payload 系 TC の共有 fixture 生成ヘルパ
 * sprint 20260910-053026-folder-payload-canon-multifolder-move
 *
 * design/tdd.md の E2E-testability 後方追跡表が要求する前提を **生成関数**として提供する。
 *
 * 🔴 **symlink と大量ファイルは git に入れない**（リポジトリを汚さない / 環境差でチェックアウトが壊れる）。
 * 実行時に一時ディレクトリへ生成し、呼び出し側が `cleanup()` で消す。
 *
 * 消費側: TASK-08（TC-GATE-1 / TC-GATE-3）/ TASK-10（TC-R2-2 / TC-R2-4 / TC-R2-5）/
 *         TASK-12（衝突 3 択）/ test-usecase.md の手動検収手順
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export interface Fixture { root: string; cleanup: () => void }

function mkRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function rmAll(...dirs: string[]): void {
    for (const d of dirs) {
        try { fs.chmodSync(d, 0o755); } catch { /* ignore */ }
        try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
}

/**
 * 件数パラメータ化した大量ファイルのフォルダ。
 * - TC-PERF-1: 2000 / TC-GATE-1: 2500 / TC-GATE-3: 2500 / TC-PERF-2: 5000
 * 既存の 2000 件 fixture では 2000 件ゲートの**超過**判定ができないため、件数は必ず引数で受ける。
 */
export function makeLargeFolder(fileCount: number, depth = 10, dirName = 'big'): Fixture {
    const root = mkRoot('fx-large-');
    const base = path.join(root, dirName);
    const per = Math.ceil(fileCount / depth);
    let cur = base; let made = 0;
    for (let d = 0; d < depth && made < fileCount; d++) {
        cur = d === 0 ? base : path.join(cur, `L${d}`);
        fs.mkdirSync(cur, { recursive: true });
        for (let i = 0; i < per && made < fileCount; i++) {
            fs.writeFileSync(path.join(cur, `f${i}.txt`), 'x'); made++;
        }
    }
    return { root, cleanup: () => rmAll(root) };
}

/**
 * linkedfd root の**外**を指す symlink を含むフォルダ（containment = NFR-FDP-02 / INV-4 の検証用）。
 * `outside/secret.txt` が複製されないことを消費側が assert する。
 */
export function makeSymlinkEscape(): Fixture & { outside: string; secretRel: string } {
    const root = mkRoot('fx-symesc-');
    const outside = mkRoot('fx-outside-');
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET');
    const src = path.join(root, 'withlink');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'ok.txt'), 'OK');
    fs.symlinkSync(outside, path.join(src, 'link-out'), 'dir');
    return { root, outside, secretRel: 'secret.txt', cleanup: () => rmAll(root, outside) };
}

/**
 * フォルダ内 md が**同フォルダ内**の画像を相対参照する fixture（TC-R2-2 = 随伴とリンク解決）。
 * `outsideRef.md` は**フォルダ外**を参照する（TC-R2-3 = 複製せず原文温存）。
 */
export function makeMdWithAssets(): Fixture & { folderName: string } {
    const root = mkRoot('fx-mdasset-');
    const f = path.join(root, 'deep', 'a', 'b');
    fs.mkdirSync(f, { recursive: true });
    fs.mkdirSync(path.join(root, 'shared-out'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared-out', 'far.png'), 'FARPNG');
    fs.writeFileSync(path.join(f, 'img.png'), 'PNG');
    fs.writeFileSync(path.join(f, 'note.md'), '# Note\n![i](img.png)\n');
    fs.writeFileSync(path.join(f, 'outsideRef.md'), '# Outside\n![o](../../../shared-out/far.png)\n');
    return { root, folderName: 'deep', cleanup: () => rmAll(root) };
}

/** 移動先に同名フォルダが既にある状態（衝突 3 択 = FR-CFL-01 / INV-7）。 */
export function makeNameConflict(): Fixture & { srcName: string; dstName: string } {
    const root = mkRoot('fx-conflict-');
    for (const n of ['docs', 'src', 'assets']) {
        fs.mkdirSync(path.join(root, n), { recursive: true });
        fs.writeFileSync(path.join(root, n, `${n}.txt`), n);
    }
    // archive/ の中に src と同名のフォルダを置く（2 件目で衝突する並び）
    fs.mkdirSync(path.join(root, 'archive', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'archive', 'src', 'existing.txt'), 'EXISTING');
    // ドットを含むフォルダ名（`assets.bak` → `assets.bak-1` の検証用）
    fs.mkdirSync(path.join(root, 'assets.bak'), { recursive: true });
    fs.writeFileSync(path.join(root, 'assets.bak', 'b.txt'), 'B');
    return { root, srcName: 'src', dstName: 'archive', cleanup: () => rmAll(root) };
}

/** dotfile を含むフォルダ（showHidden 追従の検証用 = TC-R2-5 / FR-FDP-02）。 */
export function makeDotfiles(): Fixture & { folderName: string } {
    const root = mkRoot('fx-dot-');
    const f = path.join(root, 'dotted');
    fs.mkdirSync(f, { recursive: true });
    fs.writeFileSync(path.join(f, 'visible.txt'), 'V');
    fs.writeFileSync(path.join(f, '.hidden.txt'), 'H');
    fs.mkdirSync(path.join(f, '.hiddendir'), { recursive: true });
    fs.writeFileSync(path.join(f, '.hiddendir', 'inner.txt'), 'I');
    return { root, folderName: 'dotted', cleanup: () => rmAll(root) };
}

/** 深い階層のフォルダ（手動検収 MT-001〜003 の前提）。 */
export function makeDeepFolder(depth = 6): Fixture & { folderName: string } {
    const root = mkRoot('fx-deep-');
    let cur = path.join(root, 'deep');
    fs.mkdirSync(cur, { recursive: true });
    for (let d = 0; d < depth; d++) {
        cur = path.join(cur, `lv${d}`);
        fs.mkdirSync(cur, { recursive: true });
        fs.writeFileSync(path.join(cur, `f${d}.txt`), String(d));
    }
    return { root, folderName: 'deep', cleanup: () => rmAll(root) };
}

/**
 * テスト用 linkedfd（folder link 登録済み note）を組み立てる。
 * `NotesFileManager` を注入で受けるのは、spec 側が `requireWithVscodeStub` で読んだ実体を渡すため
 * （この fixture 自体が vscode に依存しないようにする）。
 */
export function makeLinkedNote(
    NotesFileManagerCtor: new (dir: string) => any,
    folderRoot: string
): { noteDir: string; fm: any; folderLinkId: string; cleanup: () => void } {
    const noteDir = mkRoot('fx-note-');
    const fm = new NotesFileManagerCtor(noteDir);
    fm.loadStructure();
    const folderLinkId = fm.registerFolderLink(folderRoot);
    return { noteDir, fm, folderLinkId, cleanup: () => rmAll(noteDir) };
}

/**
 * linkedfd の showHidden sidecar を切り替える。
 * ファイル名と意味論は正典（`src/shared/folderview-state.ts` の `FOLDER_VIEW_STATE_SIDECAR`）に合わせる:
 * **true は upsert / false は「キー削除」**（残骸ゼロが既存 4 性質の 1 つ）。
 */
export function setShowHidden(folderRoot: string, on: boolean): void {
    const p = path.join(folderRoot, '.fractal-folderview.json');
    let cur: Record<string, unknown> = {};
    try { cur = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { /* 初回 */ }
    if (on) { cur.showHidden = true; } else { delete cur.showHidden; }
    fs.writeFileSync(p, JSON.stringify(cur, null, 2), 'utf8');
}
