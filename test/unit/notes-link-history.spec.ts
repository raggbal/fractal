/**
 * FR-HP-08/09: リンク/subpage 遷移で開いた md（他 note / note 外含む）を Recent に記録する。
 *
 * sidePanelManager.openFile が sidepanel open の単一 choke point で、成功後 onFileOpened(filePath) を呼ぶ。
 * ★reopen 2026-07-23: page-md kind 廃止。notesEditorProvider は onFileOpened で呼び分けせず、常に
 * recordFileHistory(note-md 絶対パス) で記録する（page md も他 note md も 1 種に統一）。Recent クリックは
 * kind によらず bridge.openFile(絶対パス) でメインペインに開く。
 *
 * SidePanelManager 本体は vscode 依存なので、ここでは記録ロジック（recordFileHistory の title フォールバック /
 * 重複先頭移動 / 絶対パス解決）を NotesFileManager（fs ベース・vscode 非依存）で検証する。
 * 実 UI（リンククリック → sidepanel → onFileOpened 発火 → Recent 表示）は手動 US。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

// provider の onFileOpened ルールを純粋にミラー（notesEditorProvider の callback と同一ロジック）。
// ★reopen 2026-07-23: page-md kind 廃止 → 呼び分けなし・常に recordFileHistory（note-md・絶対パス）。
// 実 callback は SidePanelManager が openFile 成功時に fp を渡して呼ぶ。
function dispatchOnFileOpened(fm: NotesFileManager, fp: string): void {
    if (!fp) return;
    fm.recordFileHistory(fp);
}

// Recent クリックの解決ルールをミラー（全 kind が絶対パス openFile。id 自体が絶対パス）。
// legacy page-md（絶対パス absPath 持ち or 無し）は絶対パス優先で開く。
function resolveOpenTarget(entry: { id: string; absPath?: string }): string | null {
    const target = entry.absPath || entry.id;
    return (target && fs.existsSync(target)) ? target : null;
}

// §2b saveSidePanelFile の Recent title 再送判定をミラー（notes-message-handler.ts:643-648 と同一ロジック）。
// syncTitleFromH1 が false（items 外 md）のとき、絶対パス一致の note-md 履歴があれば再送する。
// ★reopen 2026-07-23: 旧 `e.kind==='page-md' && e.id===basename` を絶対パス一致 note-md 判定に置換。
function shouldResendHistoryOnSidePanelSave(fm: NotesFileManager, filePath: string): boolean {
    const fp = path.resolve(filePath);
    return (fm.getHistory() || []).some((e) => e.kind === 'note-md' && path.resolve(e.id) === fp);
}

test.describe('FR-HP-08/09 — link/subpage 遷移の Recent 記録', () => {
    let tempDir: string;   // 現 note フォルダ（getPagesDirPath はここに解決される = flat レイアウト）
    let otherDir: string;  // 他 note / note 外に相当する別フォルダ（現 note pages dir 配下でない）
    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-link-hist-'));
        otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notes-link-other-'));
    });
    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
        if (otherDir && fs.existsSync(otherDir)) fs.rmSync(otherDir, { recursive: true, force: true });
    });

    // TC-LH-01（★load-bearing・記録点一本化）: onFileOpened で開いた md が Recent に記録される
    // ★ counterfactual: onFileOpened（dispatch）を呼ばないと記録が一切増えない（＝リンク/subpage 遷移が Recent に載らない現行バグ）
    test('TC-LH-01 dispatchOnFileOpened で md が記録される / 呼ばないと記録ゼロ', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('Host'); // structure 初期化
        const externalMd = path.join(otherDir, 'linked.md');
        fs.mkdirSync(path.dirname(externalMd), { recursive: true });
        fs.writeFileSync(externalMd, '# Linked', 'utf8');

        // counterfactual: 呼ばない → history に載らない
        expect(fm.getHistory().some((e) => e.id === externalMd)).toBe(false);
        // 呼ぶ → 記録される
        dispatchOnFileOpened(fm, externalMd);
        expect(fm.getHistory().some((e) => e.id === externalMd)).toBe(true);
    });

    // TC-LH-02（改訂・page md も note-md 統一・二重記録なし）: 現 note の page md
    test('TC-LH-02 現 note の page md は note-md（絶対パス）で記録・二重にならない', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('Host');
        fm.openFile(outPath);
        const pagePath = fm.getPageFilePath('p1');
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# Page1\n\nbody', 'utf8');

        dispatchOnFileOpened(fm, pagePath);
        const hist = fm.getHistory();
        // ★reopen 2026-07-23: page md も note-md（絶対パス）で 1 件記録（page-md kind は存在しない）
        const entries = hist.filter((e) => e.kind === 'note-md' && e.id === pagePath);
        expect(entries.length, 'note-md（絶対パス）で 1 件').toBe(1);
        expect(entries[0].title, 'H1 で title 解決').toBe('Page1');

        // 2 回目の open も 1 件のまま（先頭移動・dedup）
        dispatchOnFileOpened(fm, pagePath);
        expect(fm.getHistory().filter((e) => e.kind === 'note-md' && e.id === pagePath).length).toBe(1);
    });

    // TC-LH-03（他 note / note 外 md）: pages dir 外の絶対パス md → note-md（絶対パス）
    test('TC-LH-03 pages dir 外の md は note-md（絶対パス）で記録', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('Host');
        // 他 note / note 外に相当する絶対パス md（現 note pages dir 配下でない）
        const foreignMd = path.join(otherDir, 'foreign.md');
        fs.mkdirSync(path.dirname(foreignMd), { recursive: true });
        fs.writeFileSync(foreignMd, '# Foreign Note', 'utf8');

        dispatchOnFileOpened(fm, foreignMd);
        const entry = fm.getHistory().find((e) => e.id === foreignMd);
        expect(entry, 'note-md エントリが在る').toBeTruthy();
        expect(entry!.kind).toBe('note-md');
        expect(entry!.id, 'id は絶対パス').toBe(foreignMd);
        // title は items に無いので H1 で解決
        expect(entry!.title).toBe('Foreign Note');
    });

    // TC-LH-04（★H1 抽出・C#/F# 番人・load-bearing）: items に無い md の title が末尾記号を壊さない
    test('TC-LH-04 title の H1 抽出が C#/F# を切り捨てない（extractFirstH1 使用の証拠）', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('Host');
        const csharp = path.join(otherDir, 'a.md');
        const fsharp = path.join(otherDir, 'b.md');
        fs.mkdirSync(path.dirname(csharp), { recursive: true });
        fs.writeFileSync(csharp, '# C#\n\nbody', 'utf8');
        fs.writeFileSync(fsharp, '# F# and C#\n\nbody', 'utf8');

        fm.recordFileHistory(csharp);
        fm.recordFileHistory(fsharp);
        // ★ buggy inline 正規表現なら 'C' / 'F# and C' に化ける。extractFirstH1 なら末尾記号保持。
        expect(fm.getHistory().find((e) => e.id === csharp)!.title).toBe('C#');
        expect(fm.getHistory().find((e) => e.id === fsharp)!.title).toBe('F# and C#');
    });

    // TC-LH-04b: H1 が無ければ basename にフォールバック（Untitled 濫用しない）
    test('TC-LH-04b H1 無しは basename フォールバック', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('Host');
        const noH1 = path.join(otherDir, 'my-note.md');
        fs.mkdirSync(path.dirname(noH1), { recursive: true });
        fs.writeFileSync(noH1, 'no heading here\n\njust body', 'utf8');
        fm.recordFileHistory(noH1);
        expect(fm.getHistory().find((e) => e.id === noH1)!.title).toBe('my-note'); // basename（拡張子なし）
    });

    // TC-LH-05（重複先頭移動・回帰）: 同じ md を 2 回開くと 1 エントリで先頭に移動
    test('TC-LH-05 同一 md 2 回で 1 エントリ・先頭移動', () => {
        const fm = new NotesFileManager(tempDir);
        fm.createFile('Host');
        const a = path.join(otherDir, 'a.md');
        const b = path.join(otherDir, 'b.md');
        fs.mkdirSync(path.dirname(a), { recursive: true });
        fs.writeFileSync(a, '# A', 'utf8');
        fs.writeFileSync(b, '# B', 'utf8');

        dispatchOnFileOpened(fm, a);
        dispatchOnFileOpened(fm, b);
        dispatchOnFileOpened(fm, a); // a を再度 → 先頭へ移動、重複しない
        const hist = fm.getHistory();
        expect(hist.filter((e) => e.id === a).length, 'a は 1 件').toBe(1);
        expect(hist[0].id, '最新 open の a が先頭').toBe(a);
    });

    // ===== 再オープン・バグ修正 2026-07-23: page-md Recent の cross-note 解決 =====

    // TC-LH-06（改訂・★load-bearing・cross-note 解決）: page md を note-md（絶対パス）で記録 → 別 note を開いても開ける
    test('TC-LH-06 currentFilePath 汚染後も note-md（絶対パス）で解決できる', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('Host');       // newtest4 相当
        fm.openFile(outPath);                          // currentFilePath = newtest4 の .out
        const pagePath = fm.getPageFilePath('pA');
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# PageA', 'utf8');
        // newtest4 の page md を開く（note-md・絶対パスで記録される）
        dispatchOnFileOpened(fm, pagePath);
        const entry = fm.getHistory().find((e) => e.kind === 'note-md' && e.id === pagePath)!;
        expect(entry, 'page md も note-md・id=絶対パスで記録').toBeTruthy();

        // 別 note（otherDir）の note-md を開く → currentFilePath が汚染される
        const foreignMd = path.join(otherDir, 'foreign.md');
        fs.mkdirSync(path.dirname(foreignMd), { recursive: true });
        fs.writeFileSync(foreignMd, '# Foreign', 'utf8');
        fm.openFile(foreignMd);
        expect(fm.getCurrentFilePath(), 'currentFilePath が別 note に汚染').toBe(foreignMd);

        // ★ id 自体が絶対パス → 汚染後も pA を解決できる（currentFilePath 非依存）。番人。
        expect(resolveOpenTarget(entry), '絶対パス id 解決で開ける').toBe(pagePath);
        // ★ 統一で pageId 相対解決（getPageFilePath）は Recent 経路から消える。もし pageId 相対に戻すと
        //    現 currentFilePath=foreignMd 基準で別 note に pA が無く解決不能（RED の再現）。
        expect(fs.existsSync(fm.getPageFilePath('pA')), 'pageId 相対解決は汚染後 no-op（旧バグ）').toBe(false);
    });

    // TC-LH-07（改訂・title 解決も cross-note 堅牢）: note-md（絶対パス）の fresh title が汚染後も正しい
    test('TC-LH-07 currentFilePath 汚染後も note-md（絶対パス）の fresh title が正しい', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('Host');
        fm.openFile(outPath);
        const pagePath = fm.getPageFilePath('pA');
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# PageA Title', 'utf8');
        dispatchOnFileOpened(fm, pagePath);

        // currentFilePath を別 note に汚染
        const foreignMd = path.join(otherDir, 'foreign.md');
        fs.mkdirSync(path.dirname(foreignMd), { recursive: true });
        fs.writeFileSync(foreignMd, '# Foreign', 'utf8');
        fm.openFile(foreignMd);

        // items に無い絶対パス md → §5 の H1 フォールバックで解決（絶対パスなので currentFilePath 非依存）
        const fresh = fm.getHistoryWithFreshTitles().find((e) => e.kind === 'note-md' && e.id === pagePath)!;
        expect(fresh.title, '絶対パスで H1 抽出 → 汚染後も正しい title').toBe('PageA Title');
    });

    // TC-LH-08（改訂・後方互換）: legacy page-md entry が描画/クリックでクラッシュしない
    test('TC-LH-08 legacy page-md entry は絶対パス優先で開く / 無しは silent no-op', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('Host');
        fm.openFile(outPath);
        const pagePath = fm.getPageFilePath('pLegacy');
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# Legacy', 'utf8');

        // (a) absPath 持ちの legacy page-md（型から page-md は消えたので cast で旧データを再現）
        const legacyWithAbs = { kind: 'page-md', id: 'pLegacy', title: 'Legacy', ts: 1, absPath: pagePath } as any;
        expect(resolveOpenTarget(legacyWithAbs), 'absPath 優先で開ける').toBe(pagePath);

        // (b) absPath 無しの legacy page-md（id=pageId）→ 絶対パスでないので解決不能 = silent no-op（クラッシュしない）
        const legacyNoAbs = { kind: 'page-md', id: 'pLegacy', title: 'Legacy', ts: 1 } as any;
        expect(resolveOpenTarget(legacyNoAbs), 'absPath 無し legacy は解決不能で no-op（無害）').toBeNull();
    });

    // TC-U-01（★load-bearing・§2b saveSidePanelFile 再送 note-md 化・counterfactual）:
    // items 外の絶対パス md（page md 相当）を note-md で Recent 記録済みのとき、その md を sidepanel 保存すると
    // 「絶対パス一致の note-md 履歴あり」で history 再送要（H1 変更を Recent に反映するトリガ）。
    test('TC-U-01 sidepanel 保存で絶対パス一致 note-md 履歴があれば再送要（旧 page-md 判定では届かない）', () => {
        const fm = new NotesFileManager(tempDir);
        const outPath = fm.createFile('Host');
        fm.openFile(outPath);
        const pagePath = fm.getPageFilePath('pA');   // items に無い絶対パス md（page md 相当）
        fs.mkdirSync(path.dirname(pagePath), { recursive: true });
        fs.writeFileSync(pagePath, '# PageA', 'utf8');
        dispatchOnFileOpened(fm, pagePath);           // note-md（絶対パス）で記録

        // その md を sidepanel 保存 → 絶対パス一致の note-md 履歴があるので再送要
        expect(shouldResendHistoryOnSidePanelSave(fm, pagePath), '絶対パス一致 note-md 履歴 → 再送要').toBe(true);
        // ★ counterfactual: 履歴に無い別の md を保存しても再送不要（判定が絶対パス一致に load-bearing）
        const otherMd = path.join(otherDir, 'never-recorded.md');
        fs.mkdirSync(path.dirname(otherMd), { recursive: true });
        fs.writeFileSync(otherMd, '# Other', 'utf8');
        expect(shouldResendHistoryOnSidePanelSave(fm, otherMd), '履歴に無い md は再送不要').toBe(false);
    });
});
