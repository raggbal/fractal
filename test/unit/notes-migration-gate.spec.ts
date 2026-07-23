/**
 * 起動時フラット移行ゲート（sprint 20260721-215959-startup-flat-migration-gate）。
 *
 * 判定ロジック（FR-MG-01/03/04/06）= planMigration/summarizePlan の total で「ゲートを出すか」を fs で検証。
 * backup（FR-MG-07）= backupNoteFolder 相当（noteDir の外へコピー）を検証。
 * gate HTML（FR-MG-02/05）= getNotesMigrationGateContent の文字列検証。
 *
 * 実 openNotesFolder は VS Code 依存なので統合は手動 US。ここは判定/backup/HTML の純ロジックに集中。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planMigration, summarizePlan, validatePlan, executePlan, cleanupOldDirs } from '../../src/shared/flat-migrate';
import { getNotesMigrationGateContent } from '../../src/notesMigrationGate';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

function mkTmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'mg-gate-')); }

/** 旧 per-<stem>/ レイアウトの Note を作る（flat-migrate.spec の makeOldNote と同型）。 */
function makeOldNote(dir: string, stem = 'work'): void {
    const pdir = path.join(dir, stem);
    fs.mkdirSync(path.join(pdir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(pdir, 'files'), { recursive: true });
    const nodes: Record<string, unknown> = {};
    for (let i = 1; i <= 3; i++) {
        const pid = `${stem}p${i}`;
        const img = `${stem}i${i}.png`;
        const file = `${stem}f${i}.pdf`;
        nodes['n' + i] = { id: 'n' + i, text: pid, childIds: [], isPage: true, pageId: pid,
            images: [`${stem}/images/${img}`], filePath: `${stem}/files/${file}` };
        fs.writeFileSync(path.join(pdir, `${pid}.md`), `# ${pid}\n![](./images/${img})\n[📎](./files/${file})`);
        fs.writeFileSync(path.join(pdir, 'images', img), 'IMG' + i);
        fs.writeFileSync(path.join(pdir, 'files', file), 'FILE' + i);
    }
    fs.writeFileSync(path.join(dir, `${stem}.out`), JSON.stringify({
        title: stem, pageDir: `./${stem}`, rootIds: ['n1', 'n2', 'n3'], nodes }, null, 2));
}

/** flat レイアウトの Note（md 直下 + pageDir='.'）。 */
function makeFlatNote(dir: string, stem = 'flat'): void {
    fs.writeFileSync(path.join(dir, `${stem}p1.md`), `# ${stem}p1\n`);
    fs.writeFileSync(path.join(dir, `${stem}.out`), JSON.stringify({
        title: stem, pageDir: '.', imageDir: './images', fileDir: './files',
        rootIds: ['n1'], nodes: { n1: { id: 'n1', text: 'p1', childIds: [], isPage: true, pageId: `${stem}p1` } } }, null, 2));
}

// ===== 再オープン② 2026-07-22: cross-outliner 解決 + 移行漏れ削除ガード =====

// TC-MG-15（cross-outliner 解決・load-bearing）: 別 outliner フォルダの md を参照 → flat に移行、unresolved 空
test('TC-MG-15 cross-outliner md を解決して flat 移行 / unresolved 空', () => {
    const dir = mkTmp();
    // stemA フォルダに実体を置き、stemB.out がその pageId を参照（tepco2 型 cross-outliner）
    fs.mkdirSync(path.join(dir, 'stemA'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemA', 'shared-page.md'), '# shared\n本文');
    fs.writeFileSync(path.join(dir, 'stemA.out'), JSON.stringify({
        title: 'A', pageDir: './stemA', rootIds: ['a1'],
        nodes: { a1: { id: 'a1', text: 'own', childIds: [], isPage: true, pageId: 'stemA-own' } } }, null, 2));
    fs.writeFileSync(path.join(dir, 'stemA', 'stemA-own.md'), '# own');
    // stemB.out は自分のフォルダに無い 'shared-page' を参照（実体は stemA/ にある）
    fs.mkdirSync(path.join(dir, 'stemB'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB.out'), JSON.stringify({
        title: 'B', pageDir: './stemB', rootIds: ['b1'],
        nodes: { b1: { id: 'b1', text: 'cross', childIds: [], isPage: true, pageId: 'shared-page' } } }, null, 2));

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // 横断探索で解決 → 漏れなし
    // shared-page.md（stemA 由来）が move に積まれている
    expect(plan.moves.some(m => m.kind === 'page' && m.from.endsWith(path.join('stemA', 'shared-page.md')))).toBe(true);
    executePlan(plan);
    expect(fs.existsSync(path.join(dir, 'shared-page.md'))).toBe(true); // flat root に来た
    const clean = cleanupOldDirs(plan);
    expect(clean.skipped).toBe(false); // unresolved 空なので削除実行
    expect(fs.existsSync(path.join(dir, 'stemA'))).toBe(false); // 旧フォルダ削除
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-16（改訂・FR-MG-11改訂）: 元々壊れ（実体がどこにも無い）参照 → unresolved 記録するが旧フォルダは削除する
// ★ FR-MG-12 で画像/添付も横断探索するので、unresolved に残るのは「真にどこにも無い＝元々壊れ」だけ。
//   元々壊れは消しても失うもの無し → 削除してよい（旧「skipped で保持」から挙動反転）。
test('TC-MG-16 元々壊れ参照は unresolved 記録するが cleanupOldDirs は削除する', () => {
    const dir = mkTmp();
    makeOldNote(dir, 'work');
    // 実体が存在しない pageId を参照する node を .out に追加（＝元々壊れリンク）
    const outPath = path.join(dir, 'work.out');
    const d = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    d.nodes['ghost'] = { id: 'ghost', text: 'ghost', childIds: [], isPage: true, pageId: 'does-not-exist-anywhere' };
    d.rootIds.push('ghost');
    fs.writeFileSync(outPath, JSON.stringify(d, null, 2));

    const plan = planMigration(dir);
    expect(plan.unresolved.some(u => u.includes('does-not-exist-anywhere'))).toBe(true); // 元々壊れは記録される
    executePlan(plan); // 解決できた分（正常な work のページ）は flat 化
    const clean = cleanupOldDirs(plan);
    // ★ 元々壊れ（実体なし）は消しても失うもの無し → 削除する（旧挙動 skipped=true から反転）
    expect(clean.skipped).toBe(false);
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false); // 旧フォルダは削除された（掃除が進む）
    // 正常データは flat に来ている
    expect(fs.existsSync(path.join(dir, 'workp1.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-17: cross-outliner md の本文相対画像が正しい dir 基準（srcDir）で解決される
test('TC-MG-17 cross-outliner md の本文画像は実体 dir 基準で解決', () => {
    const dir = mkTmp();
    // stemA/ に md 実体 + その images/ に画像。stemB.out が参照。
    fs.mkdirSync(path.join(dir, 'stemA', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemA', 'cross.md'), '# c\n![](images/pic.png)');
    fs.writeFileSync(path.join(dir, 'stemA', 'images', 'pic.png'), 'PIC');
    fs.writeFileSync(path.join(dir, 'stemA.out'), JSON.stringify({
        title: 'A', pageDir: './stemA', rootIds: ['a1'],
        nodes: { a1: { id: 'a1', text: 'a', childIds: [], isPage: true, pageId: 'stemA-a' } } }, null, 2));
    fs.writeFileSync(path.join(dir, 'stemA', 'stemA-a.md'), '# a');
    fs.mkdirSync(path.join(dir, 'stemB'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB.out'), JSON.stringify({
        title: 'B', pageDir: './stemB', rootIds: ['b1'],
        nodes: { b1: { id: 'b1', text: 'x', childIds: [], isPage: true, pageId: 'cross' } } }, null, 2));

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]);
    // stemA/images/pic.png が move に積まれた（srcDir=stemA 基準で解決できている証拠）
    expect(plan.moves.some(m => m.kind === 'image' && m.from.endsWith(path.join('stemA', 'images', 'pic.png')))).toBe(true);
    executePlan(plan);
    expect(fs.existsSync(path.join(dir, 'images', 'pic.png'))).toBe(true); // 共有 images/ に来た
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-18（改訂）: runFlatMigration の通知分岐が plan.unresolved の有無で切り替わる
// ★ 新挙動: どちらも削除する（skipped 常に false）。通知だけが分岐（unresolved あり→壊れリスト警告 / なし→成功）。
//   runFlatMigration は `plan.unresolved.length > 0 ? 警告(壊れリスト) : 成功通知`。分岐キーを pure に検証。
test('TC-MG-18 通知分岐: unresolved の有無で通知が切り替わる（どちらも削除する）', () => {
    // (A) unresolved なし → 成功通知の分岐
    const dirOk = mkTmp();
    makeOldNote(dirOk, 'work');
    const planOk = planMigration(dirOk);
    expect(planOk.unresolved).toEqual([]);
    executePlan(planOk);
    expect(cleanupOldDirs(planOk).skipped).toBe(false); // 削除する

    // (B) 元々壊れ unresolved あり → 壊れリスト警告の分岐（でも削除はする）
    const dirMiss = mkTmp();
    makeOldNote(dirMiss, 'work');
    const outPath = path.join(dirMiss, 'work.out');
    const d = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    d.nodes['ghost'] = { id: 'ghost', text: 'g', childIds: [], isPage: true, pageId: 'nowhere-xyz' };
    d.rootIds.push('ghost');
    fs.writeFileSync(outPath, JSON.stringify(d, null, 2));
    const planMiss = planMigration(dirMiss);
    expect(planMiss.unresolved.length).toBeGreaterThan(0); // → runFlatMigration が壊れリスト警告を出す分岐
    executePlan(planMiss);
    expect(cleanupOldDirs(planMiss).skipped).toBe(false); // ★ 削除はする（保持しない）
    expect(fs.existsSync(path.join(dirMiss, 'work'))).toBe(false); // 旧フォルダ削除された
    expect(planMiss.unresolved.some(u => u.includes('nowhere-xyz'))).toBe(true); // 通知に載せる壊れリスト

    fs.rmSync(dirOk, { recursive: true, force: true });
    fs.rmSync(dirMiss, { recursive: true, force: true });
});

// TC-MG-01: old layout → ゲート対象（total>0）+ per-note 独立判定
test('TC-MG-01 old layout はゲート対象（total>0）', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    const s = summarizePlan(planMigration(dir));
    expect(s.total).toBeGreaterThan(0); // → ゲートを出す

    // per-note（FR-MG-06）: 別フォルダは独立判定
    const dir2 = mkTmp();
    makeFlatNote(dir2);
    expect(summarizePlan(planMigration(dir2)).total).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// TC-MG-02（回帰）: flat layout → ゲート非対象（total===0）
test('TC-MG-02 flat layout はゲート非対象（total===0）', () => {
    const dir = mkTmp();
    makeFlatNote(dir);
    expect(summarizePlan(planMigration(dir)).total).toBe(0); // → 本体を出す（従来経路）
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-03: 移行実行で old→flat になり、再判定で total===0（実行→本体の核）
test('TC-MG-03 移行実行後は flat になり total===0', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    const plan = planMigration(dir);
    expect(validatePlan(plan).ok).toBe(true);
    const res = executePlan(plan);
    expect(res.rolledBack).toBe(false);
    // 実行後、再判定でゲート不要（= reopen で本体が出る）
    expect(summarizePlan(planMigration(dir)).total).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-04: 移行後の再判定はゲート非対象（永続フラグ無しで layout 状態がマーカー）
test('TC-MG-04 移行後の再判定は 2 回とも total===0', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    executePlan(planMigration(dir));
    // 2 回続けて判定してもゲートは出ない（layout 状態がマーカー）
    expect(summarizePlan(planMigration(dir)).total).toBe(0);
    expect(summarizePlan(planMigration(dir)).total).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-07（改訂・FR-MG-07）: backup は noteDir の外に丸ごとコピー / 元は不変 / 名前が `.` 開始でない（mac 可視）
test('TC-MG-07 backup は noteDir 外へ再帰コピー・名前が . 開始でない', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    // notesEditorProvider.backupNoteFolder と同じロジック（改訂: `.` を付けない可視名）
    const parent = path.dirname(dir);
    const base = path.basename(dir);
    const backupPath = path.join(parent, `${base}-backup-TESTTS`);
    expect(fs.existsSync(backupPath)).toBe(false);
    fs.cpSync(dir, backupPath, { recursive: true });

    // ★ backup 先は noteDir の外（内側だと planMigration が拾う）
    expect(path.dirname(backupPath)).toBe(parent);
    expect(backupPath.startsWith(dir + path.sep)).toBe(false);
    // ★ FR-MG-07 改訂: backup フォルダ名が `.` 開始でない（mac で可視）
    expect(path.basename(backupPath).startsWith('.')).toBe(false);
    // 再帰コピーされている（.out + サブフォルダ）
    expect(fs.existsSync(path.join(backupPath, 'work.out'))).toBe(true);
    expect(fs.existsSync(path.join(backupPath, 'work', 'images', 'worki1.png'))).toBe(true);
    // 元 noteDir は backup だけでは不変（executePlan 前）
    expect(fs.existsSync(path.join(dir, 'work.out'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'work', 'images', 'worki1.png'), 'utf8')).toBe('IMG1');

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(backupPath, { recursive: true, force: true });
});

// TC-MG-10（load-bearing）: 移行後 cleanupOldDirs で旧サブフォルダ+orphan が完全削除される
test('TC-MG-10 移行後、旧サブフォルダが完全削除される', () => {
    const dir = mkTmp();
    makeOldNote(dir, 'work');
    // 旧サブフォルダに orphan（.out 未参照）を仕込む
    fs.writeFileSync(path.join(dir, 'work', 'orphan-xyz.md'), '# orphan');
    fs.writeFileSync(path.join(dir, 'work', 'files', 'orphan.bin'), 'ORPHAN');

    const plan = planMigration(dir);
    expect(plan.oldDirs).toContain(path.resolve(dir, 'work'));
    executePlan(plan);
    cleanupOldDirs(plan);

    // 旧サブフォルダ（orphan 含む）は消えた
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false);
    // 参照データ（flat md / 共有 images/files）は残る
    expect(fs.existsSync(path.join(dir, 'workp1.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'images'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-11: cleanupOldDirs は共有 images/files/flat md/.out を消さない
test('TC-MG-11 cleanupOldDirs は oldDirs 以外を消さない', () => {
    const dir = mkTmp();
    makeOldNote(dir, 'work');
    const plan = planMigration(dir);
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'images'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'files'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'work.out'))).toBe(true);
    expect(fs.existsSync(dir)).toBe(true); // noteDir 自身が残る
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-12: flat 済み note では oldDirs が空 / noteDir 自身を含まない
test('TC-MG-12 flat note は oldDirs 空・noteDir を含まない', () => {
    const dir = mkTmp();
    makeFlatNote(dir);
    const plan = planMigration(dir);
    expect(plan.oldDirs).toEqual([]);
    expect(plan.oldDirs.every(d => path.resolve(d) !== path.resolve(dir))).toBe(true);
    // cleanupOldDirs しても何も消えない（noteDir 健在）
    cleanupOldDirs(plan);
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'flatp1.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-13（安全順序の番人）: executePlan が rolledBack のとき掃除に到達せず旧フォルダが残る
// ★ runFlatMigration の順序不変条件「backup成功 + executePlan rolledBack=false のときだけ cleanupOldDirs」を
//   flat-migrate レベルでミラー検証。破壊的 rmSync 経路の退行ガード（reviewer 指摘・TASK-08）。
test('TC-MG-13 rolledBack 時は掃除に到達せず旧フォルダが残る（安全順序）', () => {
    const dir = mkTmp();
    makeOldNote(dir, 'work');
    const plan = planMigration(dir);
    expect(plan.oldDirs).toContain(path.resolve(dir, 'work'));

    // executePlan を強制失敗 → 自動 rollback（rolledBack=true。旧レイアウトに復元）
    const res = executePlan(plan, { injectFailOnRewrite: 0 });
    expect(res.rolledBack).toBe(true);

    // ★ runFlatMigration は rolledBack のとき return して cleanupOldDirs を呼ばない（順序不変条件）。
    //   ここでは「掃除を呼ばなければ旧フォルダは残る」= データが失われないことを確認。
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'work', 'images', 'worki1.png'))).toBe(true);

    // counterfactual（もし順序を破って rolledBack 後に掃除を呼ぶと旧フォルダが消える = データ損失）:
    //   これが「呼んではいけない」根拠。runFlatMigration は絶対に到達させない設計。
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false); // 呼べば消える → だから rolledBack 時は呼ばない

    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-14（★data-loss 番人・load-bearing）: mixed note で oldDirs に noteDir 自身が絶対入らない
test('TC-MG-14 mixed note: oldDirs に noteDir 自身が入らない（全消し事故防止）', () => {
    const dir = mkTmp();
    // flat .out（pageDir="."）+ old .out（pageDir="./stemA"）を混在
    makeFlatNote(dir, 'flatone');
    makeOldNote(dir, 'stemA');
    const plan = planMigration(dir);
    // 旧サブフォルダ stemA のみ含む
    expect(plan.oldDirs).toContain(path.resolve(dir, 'stemA'));
    // ★ noteDir 自身を含まない（flat .out の pageDir="." が noteDir に解決されても弾く）
    expect(plan.oldDirs.every(d => path.resolve(d) !== path.resolve(dir))).toBe(true);
    // ★ 全て noteDir の真下
    expect(plan.oldDirs.every(d => path.resolve(d).startsWith(path.resolve(dir) + path.sep))).toBe(true);

    executePlan(plan);
    cleanupOldDirs(plan);
    // noteDir・共有・flat md・.out は残り、旧サブフォルダだけ消える
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'stemA'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'flatone.out'))).toBe(true);
    // counterfactual の趣旨: もし oldDirs に dir 自身が入れば cleanupOldDirs で dir が消える。
    // ここでは dir が健在 = ガードが効いている証拠（generator が別途ガード除去で RED を確認済み）。
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-08（SAFETY・load-bearing）: gate 経路は loadStructure（フォルダ書換）を呼ばない
// ★ ユーザー指摘「開いたらフォルダが崩れる」の番人。gate 経路が使う操作（planMigration/summarizePlan）は
//   read-only で outline.note を生成しない。一方 loadStructure（本体経路 + watcher/config-refresh callback が
//   到達する破壊 API）を呼ぶと outline.note が生成される（= counterfactual: gate 経路がこれを呼ぶと RED）。
test('TC-MG-08 gate 経路の操作は outline.note を生成しない（loadStructure 非到達）', () => {
    const dir = mkTmp();
    makeOldNote(dir); // pageDir="./work" の old layout。outline.note はまだ無い
    expect(fs.existsSync(path.join(dir, 'outline.note'))).toBe(false);

    // (1) gate 経路の判定操作（openNotesFolder の needsMigration 判定 + gate 中の安全な操作）は read-only。
    const s = summarizePlan(planMigration(dir));
    expect(s.total).toBeGreaterThan(0);
    // ★ 判定しても outline.note は生成されない（フォルダ不変 = 開いただけで崩れない）
    expect(fs.existsSync(path.join(dir, 'outline.note'))).toBe(false);

    // (2) counterfactual: loadStructure を呼ぶ（= 本体経路 or ガードを外した watcher/config callback が到達する
    //     破壊 API）と outline.note が生成される = フォルダが書き換わる。gate 経路はこれを呼んではいけない。
    const fm = new NotesFileManager(dir);
    fm.loadStructure();
    expect(fs.existsSync(path.join(dir, 'outline.note'))).toBe(true); // loadStructure は書換する（危険の実証）

    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-05: gate HTML が summary + 移行ボタン(runFlatMigration) + 失敗表示/再試行を含む
test('TC-MG-05 gate HTML が必要要素を含む', () => {
    const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u: any) => u } as any;
    const fakeUri = {} as any;
    const html = getNotesMigrationGateContent(fakeWebview, fakeUri, { pages: 12, images: 8, files: 3, total: 23 }, 'myNote');
    // サマリ数値
    expect(html).toContain('>12<');
    expect(html).toContain('>8<');
    expect(html).toContain('>3<');
    // フォルダ名
    expect(html).toContain('myNote');
    // 移行ボタン + runFlatMigration postMessage
    expect(html).toContain("postMessage({ type: 'runFlatMigration' })");
    expect(html).toContain('id="mg-migrate"');
});

// TC-MG-06: gate HTML が migrationFailed を listen して理由 + 再試行を出す JS を持つ
test('TC-MG-06 gate HTML が migrationFailed を処理する', () => {
    const fakeWebview = { cspSource: 'vscode-resource:', asWebviewUri: (u: any) => u } as any;
    const html = getNotesMigrationGateContent(fakeWebview, {} as any, { pages: 1, images: 0, files: 0, total: 1 }, 'n');
    expect(html).toContain("m.type !== 'migrationFailed'");   // 受信ハンドラ
    expect(html).toContain("addEventListener('message'");      // message listen
    expect(html).toContain('再試行');                          // retry ラベル
    expect(html).toContain('id="mg-fail-reasons"');            // 理由表示領域
});

// ===== 再オープン③ 2026-07-22: 画像/添付 cross-outliner 横断 + 元々壊れ削除許可（FR-MG-12 / FR-MG-11改訂）=====

/** stemX.out（旧 pageDir="./stemX"）+ そのフォルダに page md 1 枚を作る最小の old outliner。 */
function makeOldOutliner(dir: string, stem: string, pageId: string, extra?: { images?: string[]; filePath?: string; body?: string }): void {
    fs.mkdirSync(path.join(dir, stem), { recursive: true });
    fs.writeFileSync(path.join(dir, stem, `${pageId}.md`), extra?.body ?? `# ${pageId}`);
    const node: any = { id: 'n1', text: pageId, childIds: [], isPage: true, pageId };
    if (extra?.images) node.images = extra.images;
    if (extra?.filePath) node.filePath = extra.filePath;
    fs.writeFileSync(path.join(dir, `${stem}.out`), JSON.stringify({
        title: stem, pageDir: `./${stem}`, rootIds: ['n1'], nodes: { n1: node } }, null, 2));
}

// TC-MG-19（FR-MG-12・load-bearing）: node.images が別 stem の images/ にある実体 → 横断で解決し flat 移行
test('TC-MG-19 node.images の cross-outliner 画像を横断解決して flat 移行', () => {
    const dir = mkTmp();
    // stemA.out の node が basename 'pic-x.png' を参照（noteDir 基準では見つからない）。実体は stemB/images/ にある。
    makeOldOutliner(dir, 'stemA', 'pageA', { images: ['pic-x.png'] });
    makeOldOutliner(dir, 'stemB', 'pageB');
    fs.mkdirSync(path.join(dir, 'stemB', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB', 'images', 'pic-x.png'), 'CROSS');

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // 横断で解決 → 漏れなし
    // 実体（stemB/images/pic-x.png）が move に積まれた
    expect(plan.moves.some(m => m.kind === 'image' && m.from.endsWith(path.join('stemB', 'images', 'pic-x.png')))).toBe(true);
    executePlan(plan);
    expect(fs.readFileSync(path.join(dir, 'images', 'pic-x.png'), 'utf8')).toBe('CROSS'); // 共有 images/ に来た
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'stemB'))).toBe(false); // 旧フォルダ削除、asset は flat に安全

    // ★ counterfactual（同一 setup で cross 実体を消すと unresolved 化 = 横断探索が load-bearing）
    const dir2 = mkTmp();
    makeOldOutliner(dir2, 'stemA', 'pageA', { images: ['pic-x.png'] });
    makeOldOutliner(dir2, 'stemB', 'pageB'); // stemB/images/pic-x.png を作らない
    const plan2 = planMigration(dir2);
    expect(plan2.unresolved.some(u => u.includes('pic-x.png'))).toBe(true); // 実体なし → 元々壊れ扱い

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// TC-MG-20（衝突連番・load-bearing）: 2 outliner が別実体・同 basename の画像 → x.png / x-1.png に連番（1:1 保持）
test('TC-MG-20 同 basename 別実体の画像は連番で 1:1 分離される', () => {
    const dir = mkTmp();
    // 各 node が自 stem の pic.png を明示参照（別実体・同名）。共有 uniquify で dst が分かれる。
    makeOldOutliner(dir, 'stemA', 'pageA', { images: ['stemA/images/pic.png'] });
    makeOldOutliner(dir, 'stemB', 'pageB', { images: ['stemB/images/pic.png'] });
    fs.mkdirSync(path.join(dir, 'stemA', 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'stemB', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemA', 'images', 'pic.png'), 'CONTENT_A');
    fs.writeFileSync(path.join(dir, 'stemB', 'images', 'pic.png'), 'CONTENT_B');

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]);
    executePlan(plan);
    // 2 実体が別名で共有 images/ に来た（pic.png と pic-1.png）。中身 A/B が両方保持される。
    const contents = new Set([
        fs.existsSync(path.join(dir, 'images', 'pic.png')) ? fs.readFileSync(path.join(dir, 'images', 'pic.png'), 'utf8') : '',
        fs.existsSync(path.join(dir, 'images', 'pic-1.png')) ? fs.readFileSync(path.join(dir, 'images', 'pic-1.png'), 'utf8') : '',
    ]);
    expect(contents.has('CONTENT_A')).toBe(true);
    expect(contents.has('CONTENT_B')).toBe(true);
    // 各 node 参照が別 dst に 1:1 で書換わっている（srcAbs dedup + 共有 uniquify の証拠）
    const outA = JSON.parse(fs.readFileSync(path.join(dir, 'stemA.out'), 'utf8'));
    const outB = JSON.parse(fs.readFileSync(path.join(dir, 'stemB.out'), 'utf8'));
    expect(outA.nodes.n1.images[0]).not.toBe(outB.nodes.n1.images[0]); // 別 dst（同一に潰れない）
    expect([outA.nodes.n1.images[0], outB.nodes.n1.images[0]].sort()).toEqual(['images/pic-1.png', 'images/pic.png']);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-21（★安全網 counterfactual・複数バリアント）: 実体があるのに削除される事故が起きない
//   横断探索が「実体あり→unresolved」を作らないことを、素直 + HIGH-A(decode) + HIGH-B(drawio files) で担保。

// (21a) 素直: cross-outliner の本文画像（普通の basename）→ 横断で解決・unresolved 空
test('TC-MG-21a 素直な cross-outliner 本文画像を横断解決（実体あり→unresolvedにしない）', () => {
    const dir = mkTmp();
    // stemA の page md 本文が images/plain.png を参照。実体は stemB/images/ にある（srcDir 基準では無い）。
    makeOldOutliner(dir, 'stemA', 'pageA', { body: '# A\n![](images/plain.png)' });
    makeOldOutliner(dir, 'stemB', 'pageB');
    fs.mkdirSync(path.join(dir, 'stemB', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB', 'images', 'plain.png'), 'PLAIN');

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // 実体あり → 削除対象にならない
    expect(plan.moves.some(m => m.kind === 'image' && m.from.endsWith(path.join('stemB', 'images', 'plain.png')))).toBe(true);

    // ★ counterfactual: 同一 ref で実体を置かないと unresolved 化（= 横断が load-bearing）
    const dir2 = mkTmp();
    makeOldOutliner(dir2, 'stemA', 'pageA', { body: '# A\n![](images/plain.png)' });
    makeOldOutliner(dir2, 'stemB', 'pageB'); // plain.png を置かない
    expect(planMigration(dir2).unresolved.some(u => u.includes('plain.png'))).toBe(true);

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// (21b) HIGH-A: 空白/percent-encode 名 → resolveAssetSrc の decode フォールバックで解決
test('TC-MG-21b percent-encode 本文 ref を decode フォールバックで cross 解決', () => {
    const dir = mkTmp();
    // 本文 ref は percent-encode（images/a%20b.png）。ディスク実体は decode 後（'a b.png'）で別 stem にある。
    makeOldOutliner(dir, 'stemA', 'pageA', { body: '# A\n![](images/a%20b.png)' });
    makeOldOutliner(dir, 'stemB', 'pageB');
    fs.mkdirSync(path.join(dir, 'stemB', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB', 'images', 'a b.png'), 'SPACE'); // 空白名（decode 後）

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // decode で解決 → 削除されない
    // ★ 見つかった実体は 'a b.png'（decode 名）。raw 'a%20b.png' はディスクに存在しない
    //   → resolution が decode フォールバックを使った証拠（decode を外すと unresolved 化する load-bearing）。
    const moved = plan.moves.find(m => m.kind === 'image' && m.from.endsWith(path.join('stemB', 'images', 'a b.png')));
    expect(moved).toBeTruthy();
    expect(fs.existsSync(path.join(dir, 'stemB', 'images', 'a%20b.png'))).toBe(false); // raw 名は実在しない
    fs.rmSync(dir, { recursive: true, force: true });
});

// (21c) HIGH-B: drawio（images 構文・files 保存）→ candidateAssetDirs が files 群も走査して解決
test('TC-MG-21c drawio（images 構文だが files 保存）を files 群走査で cross 解決', () => {
    const dir = mkTmp();
    // 本文は ![](images/diagram.drawio.svg)（images 構文）だが drawio 実体は別 stem の files/ に保存されている。
    makeOldOutliner(dir, 'stemA', 'pageA', { body: '# A\n![](images/diagram.drawio.svg)' });
    makeOldOutliner(dir, 'stemB', 'pageB');
    fs.mkdirSync(path.join(dir, 'stemB', 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB', 'files', 'diagram.drawio.svg'), '<svg/>');

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // files 群走査で解決 → 削除されない
    // ★ 実体は files/ 配下（images/ には無い）→ files 群を走査した証拠（走査を images だけに絞ると unresolved 化）。
    const moved = plan.moves.find(m => m.from.endsWith(path.join('stemB', 'files', 'diagram.drawio.svg')));
    expect(moved).toBeTruthy();
    expect(moved!.kind).toBe('file'); // drawio は files/ 保存
    executePlan(plan);
    expect(fs.existsSync(path.join(dir, 'files', 'diagram.drawio.svg'))).toBe(true); // 共有 files/ に来た
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-22: 削除時の壊れリスト通知（runFlatMigration の warning 分岐の入力を pure 検証）
// ★ 新挙動: unresolved（真の元々壊れ）があっても削除する。runFlatMigration は plan.unresolved.length>0 のとき
//   「参照先が見つからなかった（旧フォルダ削除済み）+ 壊れリスト + backup」を showWarningMessage する。
//   その分岐入力 = (a) 削除が実行される（skipped=false・旧フォルダ消える）、(b) 壊れリストが説明的ラベルを持つ。
test('TC-MG-22 元々壊れ参照で削除しつつ説明的な壊れリストを通知に渡す', () => {
    const dir = mkTmp();
    makeOldOutliner(dir, 'work', 'workp1', { images: ['nowhere-image.png'], filePath: 'nowhere-file.pdf' });
    // 参照する画像/添付の実体はどこにも無い（真の元々壊れ）。

    const plan = planMigration(dir);
    // (b) 通知に載せる壊れリストが「何が」「どこから」を示す説明的ラベルを持つ
    expect(plan.unresolved.length).toBeGreaterThan(0);
    expect(plan.unresolved.some(u => u.startsWith('image:') && u.includes('nowhere-image.png'))).toBe(true);
    expect(plan.unresolved.some(u => u.startsWith('file:') && u.includes('nowhere-file.pdf'))).toBe(true);

    executePlan(plan);
    const cleaned = cleanupOldDirs(plan);
    // (a) 元々壊れがあっても削除する（旧「保持」から反転）→ warning 分岐だが旧フォルダは消える
    expect(cleaned.skipped).toBe(false);
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false);
    // 正常な page md（実体あり）は flat に来ている
    expect(fs.existsSync(path.join(dir, 'workp1.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ===== 再オープン③ Iteration 8（reviewer data-loss 是正）: standalone _notes_md sweep の cross-outliner 対称化 =====

// TC-MG-23（★安全網・load-bearing）: standalone _notes_md md の cross-outliner 本文画像を横断解決（削除で失わない）
test('TC-MG-23 _notes_md md の cross-outliner 本文画像を横断解決し flat に残す', () => {
    const dir = mkTmp();
    // old .out（stemB）でフォルダを old layout にし、cleanupOldDirs が stemB を削除する状況を作る。
    makeOldOutliner(dir, 'stemB', 'pageB');
    // 実体は stemB/images/ にある（_notes_md/images/ には無い = cross-outliner from _notes_md's perspective）。
    fs.mkdirSync(path.join(dir, 'stemB', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB', 'images', 'pic.png'), 'NOTESMD_CROSS');
    // どの .out node からも参照されない standalone notes-md ページ。body が images/pic.png を参照。
    fs.mkdirSync(path.join(dir, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'note1.md'), '# note1\n![](images/pic.png)');

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // 横断で解決 → 削除対象にならない（元々壊れ扱いされない）
    // 実体（stemB/images/pic.png）が move に積まれた（section 4 が resolveAssetSrc を通した証拠）
    expect(plan.moves.some(m => m.kind === 'image' && m.from.endsWith(path.join('stemB', 'images', 'pic.png')))).toBe(true);
    executePlan(plan);
    expect(fs.readFileSync(path.join(dir, 'images', 'pic.png'), 'utf8')).toBe('NOTESMD_CROSS'); // 共有 images/ に来た
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'stemB'))).toBe(false);      // 旧フォルダ削除
    expect(fs.existsSync(path.join(dir, 'note1.md'))).toBe(true);    // notes-md は flat に
    expect(fs.readFileSync(path.join(dir, 'images', 'pic.png'), 'utf8')).toBe('NOTESMD_CROSS'); // 実体は生存（損失なし）

    // ★ counterfactual: 実体を置かなければ unresolved 化（= section 4 の resolve が load-bearing。
    //   横断なしの旧 reserve に戻すと実体ありでも unresolved にすら載らず silent skip → LOSS。別途 mirror で実証）
    const dir2 = mkTmp();
    makeOldOutliner(dir2, 'stemB', 'pageB');
    fs.mkdirSync(path.join(dir2, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir2, '_notes_md', 'note1.md'), '# note1\n![](images/pic.png)');
    expect(planMigration(dir2).unresolved.some(u => u.includes('pic.png'))).toBe(true); // 実体なし → 元々壊れ

    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// TC-MG-24: _notes_md md の decode 名 + drawio(images 構文/files 保存) を横断解決
test('TC-MG-24 _notes_md md の decode 名・drawio を横断解決（実体あり→unresolvedにしない）', () => {
    const dir = mkTmp();
    makeOldOutliner(dir, 'stemB', 'pageB');
    // (a) percent-encode 名 a%20b.png（disk は 'a b.png'、別 stem）(b) drawio（images 構文だが files/ 保存）
    fs.mkdirSync(path.join(dir, 'stemB', 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'stemB', 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'stemB', 'images', 'a b.png'), 'SPACE');
    fs.writeFileSync(path.join(dir, 'stemB', 'files', 'x.drawio.svg'), '<svg/>');
    fs.mkdirSync(path.join(dir, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'note1.md'),
        '# note1\n![](images/a%20b.png)\n![](images/x.drawio.svg)');

    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]); // decode + files 群走査で両方解決 → 削除されない（安全前提の核）
    // ★ 解決の証拠: move の src は decode 後の実ディスク名（'a b.png'）を指す（decode フォールバックが効いた）。
    expect(plan.moves.some(m => m.kind === 'image' && m.from.endsWith(path.join('stemB', 'images', 'a b.png')))).toBe(true);
    // drawio は images 構文でも files/ 保存で解決（kind=file）
    expect(plan.moves.some(m => m.kind === 'file' && m.from.endsWith(path.join('stemB', 'files', 'x.drawio.svg')))).toBe(true);
    executePlan(plan);
    // ★ 損失なし: 実体は flat の共有 dir に移動された（dst 名は reserve の既存仕様 = ref basename 由来なので
    //   decode 名 'a b.png' でも encode 名 'a%20b.png' でも「移動された」ことを確認 = 削除ガード反転の安全担保）。
    const spaceSurvived = fs.existsSync(path.join(dir, 'images', 'a b.png')) || fs.existsSync(path.join(dir, 'images', 'a%20b.png'));
    expect(spaceSurvived).toBe(true);
    expect(fs.existsSync(path.join(dir, 'files', 'x.drawio.svg'))).toBe(true);
    // 元の cross-outliner 実体は消費された（flat に移った）→ stemB 掃除後も損失しない
    expect(fs.existsSync(path.join(dir, 'stemB', 'images', 'a b.png'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
});

// ===== 再オープン④ 2026-07-22: md リンク subpage 判定 + 移行対象拡張（data-loss 修正）=====

/** 同 stem に複数 md を持つ old outliner。node は指定 pageId 群のみ参照（他は body-link 依存）。 */
function makeOutlinerWithPages(dir: string, stem: string, nodePageIds: string[], mdFiles: Record<string, string>): void {
    const pdir = path.join(dir, stem);
    fs.mkdirSync(pdir, { recursive: true });
    for (const [id, body] of Object.entries(mdFiles)) fs.writeFileSync(path.join(pdir, `${id}.md`), body);
    const nodes: Record<string, unknown> = {};
    nodePageIds.forEach((pid, i) => { nodes['n' + i] = { id: 'n' + i, text: pid, childIds: [], isPage: true, pageId: pid }; });
    fs.writeFileSync(path.join(dir, `${stem}.out`), JSON.stringify({
        title: stem, pageDir: `./${stem}`, rootIds: nodePageIds.map((_, i) => 'n' + i), nodes }, null, 2));
}

// TC-MG-25（FR-MG-13・条件付き昇格）: 同 stem・node 未参照だけ昇格 / node 参照はプレーン維持
test('TC-MG-25 昇格は同 stem・node 未参照のリンクだけ（node 参照ページはプレーン）', () => {
    const dir = mkTmp();
    // stem work: node は workp1（本文リンク元）と workp2（node 参照）。worksub は node 未参照。
    makeOutlinerWithPages(dir, 'work', ['workp1', 'workp2'], {
        workp1: '# p1\n[ref](workp2.md)\n[sub](worksub.md)',
        workp2: '# p2',
        worksub: '# sub',
    });
    const plan = planMigration(dir);
    executePlan(plan);
    const body = fs.readFileSync(path.join(dir, 'workp1.md'), 'utf8');
    expect(body).toContain('[ref](workp2.md)');       // node 参照 → プレーン維持
    expect(body).not.toContain('[[ref]](workp2.md)');
    expect(body).toContain('[[sub]](worksub.md)');     // node 未参照・同 stem → 昇格
    // ★ referencedPageIds が workp2 を含む番人（H1）: もし空なら workp2 も昇格 → この assert が RED
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-26（FR-MG-14）: 同 stem subpage が flat に移行され昇格される
test('TC-MG-26 同 stem subpage が flat に移行 + 昇格 + 旧 stem 削除後も生存', () => {
    const dir = mkTmp();
    makeOutlinerWithPages(dir, 'work', ['workp1'], {
        workp1: '# p1\n[sub](worksub.md)',
        worksub: '# sub body',
    });
    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]);
    // worksub が move に積まれた（node 未参照でも body-link で移行対象）
    expect(plan.moves.some(m => m.kind === 'page' && m.from.endsWith(path.join('work', 'worksub.md')))).toBe(true);
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'worksub.md'))).toBe(true);          // flat に移行
    expect(fs.readFileSync(path.join(dir, 'worksub.md'), 'utf8')).toContain('sub body');
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false);               // 旧 stem 削除
    expect(fs.readFileSync(path.join(dir, 'workp1.md'), 'utf8')).toContain('[[sub]](worksub.md)');
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-27（★NFR-MG-11 番人・load-bearing・別 stem 孤立 = H2）: 別 stem・node/note 未参照・body-link のみ到達を移行
test('TC-MG-27 別 stem 孤立 md（body-link のみ到達）を移行・削除後も生存（H2 番人）', () => {
    const dir = mkTmp();
    // stemA の pA が別 stem stemB の orphan.md を本文リンク。orphan はどの node/note からも未参照。
    makeOutlinerWithPages(dir, 'stemA', ['pA'], { pA: '# A\n[x](../stemB/orphan.md)' });
    makeOutlinerWithPages(dir, 'stemB', ['pB'], { pB: '# B', orphan: '# orphan body' });
    const plan = planMigration(dir);
    // ★ 種別不問 move: orphan.md が moves に積まれる（別 stem = subpage でないが移行対象）。unresolved 非計上。
    expect(plan.moves.some(m => m.kind === 'page' && m.from.endsWith(path.join('stemB', 'orphan.md')))).toBe(true);
    expect(plan.unresolved.some(u => u.includes('orphan'))).toBe(false);
    // ★ 昇格しない（別 stem = subpage でない）: promoteLinks に orphan の url が載らない
    const pADst = plan.moves.find(m => m.from.endsWith(path.join('stemA', 'pA.md')))!.to;
    const pl = (plan.promoteLinks || []).find(p => p.mdPath === pADst);
    expect(pl && pl.urls.some(u => u.includes('orphan'))).toBeFalsy();
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'orphan.md'))).toBe(true);            // flat に移行・生存
    expect(fs.readFileSync(path.join(dir, 'orphan.md'), 'utf8')).toContain('orphan body');
    expect(fs.existsSync(path.join(dir, 'stemB'))).toBe(false);              // 旧 stem 削除後も損失なし

    // ★★ counterfactual（load-bearing）: body-link が無ければ orphan はどの経路にも乗らず未 move → 削除で LOSS。
    //   = closure（body-link 追跡）が orphan を救っている証拠。link を external(#) にして到達不能にすると moves から消える。
    const dir2 = mkTmp();
    makeOutlinerWithPages(dir2, 'stemA', ['pA'], { pA: '# A\n[x](#no-link)' }); // body-link なし
    makeOutlinerWithPages(dir2, 'stemB', ['pB'], { pB: '# B', orphan: '# orphan body' });
    const plan2 = planMigration(dir2);
    expect(plan2.moves.some(m => m.from.endsWith(path.join('stemB', 'orphan.md')))).toBe(false); // 未 move
    // → executePlan+cleanup すれば orphan は stemB ごと削除される（= body-link closure が無いと LOSS = RED の実証）
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// TC-MG-28（推移閉包・多段）: subpage の subpage も再帰移行・昇格 / 循環で無限ループしない
test('TC-MG-28 多段 subpage を推移閉包で移行・昇格（循環打ち切り）', () => {
    const dir = mkTmp();
    // p1 → m1 → m2（同 stem・node 未参照）。m2 → p1（循環）。
    makeOutlinerWithPages(dir, 'work', ['workp1'], {
        workp1: '# p1\n[s1](m1.md)',
        m1: '# m1\n[s2](m2.md)',
        m2: '# m2\n[back](workp1.md)',
    });
    const plan = planMigration(dir);
    expect(plan.moves.some(m => m.from.endsWith(path.join('work', 'm1.md')))).toBe(true);
    expect(plan.moves.some(m => m.from.endsWith(path.join('work', 'm2.md')))).toBe(true);
    executePlan(plan);
    expect(fs.existsSync(path.join(dir, 'm1.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'm2.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'workp1.md'), 'utf8')).toContain('[[s1]](m1.md)');
    expect(fs.readFileSync(path.join(dir, 'm1.md'), 'utf8')).toContain('[[s2]](m2.md)');
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-29（★NFR-MG-11 番人・load-bearing・_notes_md 起点 = H2 b2）: _notes_md の body-link 先孤立 md を移行
test('TC-MG-29 _notes_md md の body-link 先孤立 md を移行・削除後も生存（H2 b2 番人）', () => {
    const dir = mkTmp();
    // _notes_md/note1 が stem work の orphan2 を本文リンク。orphan2 は node/note 未参照。
    makeOutlinerWithPages(dir, 'work', ['workp1'], { workp1: '# p1', orphan2: '# orphan2 body' });
    fs.mkdirSync(path.join(dir, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'note1.md'), '# note1\n[x](../work/orphan2.md)');
    const plan = planMigration(dir);
    expect(plan.moves.some(m => m.from.endsWith(path.join('work', 'orphan2.md')))).toBe(true); // _notes_md seed から到達
    expect(plan.unresolved.some(u => u.includes('orphan2'))).toBe(false);
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'orphan2.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'work'))).toBe(false);

    // ★ counterfactual: _notes_md を closure seed にしなければ orphan2 未 move → 削除 = LOSS。
    //   note1 の body-link を到達不能にすると orphan2 が moves から消える（seed 追跡が load-bearing）。
    const dir2 = mkTmp();
    makeOutlinerWithPages(dir2, 'work', ['workp1'], { workp1: '# p1', orphan2: '# orphan2 body' });
    fs.mkdirSync(path.join(dir2, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir2, '_notes_md', 'note1.md'), '# note1\n(no link)');
    expect(planMigration(dir2).moves.some(m => m.from.endsWith(path.join('work', 'orphan2.md')))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// ===== 再オープン⑤ 2026-07-22: <note>/pages/ 旧レイアウトの探索・掃除（pace2 data-loss 修正）=====

/** pace2 型: pageDir 未指定の .out + <note>/pages/ 実体。opts で pages 配下の md/画像/添付を仕込む。 */
function makePagesLayoutNote(dir: string, opts: {
    outStem: string;
    nodes: { pageId?: string; images?: string[]; filePath?: string }[];
    stemMd?: Record<string, string>;      // <note>/<stem>/<id>.md
    pagesMd?: Record<string, string>;     // <note>/pages/<id>.md
    pagesImages?: Record<string, string>; // <note>/pages/images/<name>
    pagesFiles?: Record<string, string>;  // <note>/pages/files/<name>
}): void {
    const nodesObj: Record<string, unknown> = {};
    opts.nodes.forEach((n, i) => {
        const node: any = { id: 'n' + i, text: 'p' + i, childIds: [], isPage: true };
        if (n.pageId) node.pageId = n.pageId;
        if (n.images) node.images = n.images;
        if (n.filePath) node.filePath = n.filePath;
        nodesObj['n' + i] = node;
    });
    // ★ pageDir 未指定（旧 dailynotes.out 型）
    fs.writeFileSync(path.join(dir, `${opts.outStem}.out`), JSON.stringify({
        title: opts.outStem, rootIds: opts.nodes.map((_, i) => 'n' + i), nodes: nodesObj }, null, 2));
    if (opts.stemMd) { fs.mkdirSync(path.join(dir, opts.outStem), { recursive: true }); for (const [id, b] of Object.entries(opts.stemMd)) fs.writeFileSync(path.join(dir, opts.outStem, `${id}.md`), b); }
    if (opts.pagesMd) { fs.mkdirSync(path.join(dir, 'pages'), { recursive: true }); for (const [id, b] of Object.entries(opts.pagesMd)) fs.writeFileSync(path.join(dir, 'pages', `${id}.md`), b); }
    if (opts.pagesImages) { fs.mkdirSync(path.join(dir, 'pages', 'images'), { recursive: true }); for (const [n, c] of Object.entries(opts.pagesImages)) fs.writeFileSync(path.join(dir, 'pages', 'images', n), c); }
    if (opts.pagesFiles) { fs.mkdirSync(path.join(dir, 'pages', 'files'), { recursive: true }); for (const [n, c] of Object.entries(opts.pagesFiles)) fs.writeFileSync(path.join(dir, 'pages', 'files', n), c); }
}

// TC-MG-30（★NFR-MG-13 番人・load-bearing・node.pageId→pages md）: pages/ のみに実体を持つ node ページを移行
test('TC-MG-30 pages/ のみに実体を持つ node ページを移行・削除後も生存', () => {
    const dir = mkTmp();
    // dailynotes 型: node P1 は stem dir に、node PP は pages/ にのみ実体（分散）
    makePagesLayoutNote(dir, {
        outStem: 'dailynotes',
        nodes: [{ pageId: 'p_stem' }, { pageId: 'p_pages' }],
        stemMd: { p_stem: '# stem page' },
        pagesMd: { p_pages: '# PACE ミーティング\n本文' },
    });
    const plan = planMigration(dir);
    // pages/ のみの p_pages が moves に積まれる（resolvePageMdSrc の pages 候補で解決）
    expect(plan.moves.some(m => m.kind === 'page' && m.from.endsWith(path.join('pages', 'p_pages.md')))).toBe(true);
    // stem dir の p_stem も従来どおり（分散の両方が拾える）
    expect(plan.moves.some(m => m.kind === 'page' && m.from.endsWith(path.join('dailynotes', 'p_stem.md')))).toBe(true);
    expect(plan.unresolved.some(u => u.includes('p_pages'))).toBe(false);
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'p_pages.md'))).toBe(true);           // flat 生存
    expect(fs.readFileSync(path.join(dir, 'p_pages.md'), 'utf8')).toContain('PACE ミーティング');
    expect(fs.existsSync(path.join(dir, 'pages'))).toBe(false);               // pages/ 削除後も損失なし

    // ★★ counterfactual（load-bearing）: pages/ に実体が無ければ p_pages は解決されず unresolved に載る（削除で LOSS）。
    const dir2 = mkTmp();
    makePagesLayoutNote(dir2, { outStem: 'dailynotes', nodes: [{ pageId: 'p_pages' }], stemMd: {} });
    expect(planMigration(dir2).moves.some(m => m.from.endsWith(path.join('pages', 'p_pages.md')))).toBe(false);
    expect(planMigration(dir2).unresolved.some(u => u.includes('p_pages'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// TC-MG-31（★NFR-MG-13 番人・load-bearing・node.images/filePath→pages/images|files）: pages/images・pages/files の実体を移行
test('TC-MG-31 node.images が pages/images・node.filePath が pages/files の実体を横断解決', () => {
    const dir = mkTmp();
    makePagesLayoutNote(dir, {
        outStem: 'dailynotes',
        nodes: [{ pageId: 'p1', images: ['pic_pages.png'], filePath: 'doc_pages.pdf' }],
        stemMd: { p1: '# p1' },
        pagesImages: { 'pic_pages.png': 'IMGDATA' },
        pagesFiles: { 'doc_pages.pdf': 'FILEDATA' },
    });
    const plan = planMigration(dir);
    expect(plan.unresolved).toEqual([]);
    // 画像は pages/images から、添付は pages/files から解決
    expect(plan.moves.some(m => m.kind === 'image' && m.from.endsWith(path.join('pages', 'images', 'pic_pages.png')))).toBe(true);
    expect(plan.moves.some(m => m.kind === 'file' && m.from.endsWith(path.join('pages', 'files', 'doc_pages.pdf')))).toBe(true);
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.readFileSync(path.join(dir, 'images', 'pic_pages.png'), 'utf8')).toBe('IMGDATA'); // 共有 images/ に生存
    expect(fs.readFileSync(path.join(dir, 'files', 'doc_pages.pdf'), 'utf8')).toBe('FILEDATA'); // 共有 files/ に生存
    expect(fs.existsSync(path.join(dir, 'pages'))).toBe(false);

    // ★ counterfactual: pages/images・pages/files に実体が無ければ unresolved（= pages 候補が load-bearing）
    const dir2 = mkTmp();
    makePagesLayoutNote(dir2, { outStem: 'dailynotes', nodes: [{ pageId: 'p1', images: ['pic_pages.png'] }], stemMd: { p1: '# p1' } });
    expect(planMigration(dir2).unresolved.some(u => u.includes('pic_pages.png'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
});

// TC-MG-32（pages md via closure）: pages md の本文リンク先 + 他 md からの ../pages/ リンクを移行
test('TC-MG-32 pages md の本文リンク先 / 他 md からの ../pages/ リンク先を closure で移行', () => {
    const dir = mkTmp();
    // (a) pages md p_pages が本文で同 pages の sub を subpage リンク（node/note 未参照）
    // (b) stem md p_stem が本文で ../pages/q.md を参照（q は node/note 未参照）
    makePagesLayoutNote(dir, {
        outStem: 'dailynotes',
        nodes: [{ pageId: 'p_pages' }, { pageId: 'p_stem' }],
        stemMd: { p_stem: '# stem\n[toq](../pages/q.md)' },
        pagesMd: { p_pages: '# pages page\n[sub](sub.md)', sub: '# sub body', q: '# q body' },
    });
    const plan = planMigration(dir);
    // (a) sub（pages md p_pages の本文リンク先・同 pages）が closure で移行
    expect(plan.moves.some(m => m.from.endsWith(path.join('pages', 'sub.md')))).toBe(true);
    // (b) q（stem md が ../pages/q.md で参照）が closure で移行
    expect(plan.moves.some(m => m.from.endsWith(path.join('pages', 'q.md')))).toBe(true);
    executePlan(plan);
    cleanupOldDirs(plan);
    expect(fs.existsSync(path.join(dir, 'sub.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'q.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'pages'))).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
});

// TC-MG-33（pages/ 掃除 + orphan + noteDir 保護）: pages/ 削除・純 orphan 消失・noteDir/共有は残る
test('TC-MG-33 移行後 pages/ 削除・純 orphan 消失・noteDir/共有 images/files は残る', () => {
    const dir = mkTmp();
    makePagesLayoutNote(dir, {
        outStem: 'dailynotes',
        nodes: [{ pageId: 'p1', images: ['pic.png'] }],
        stemMd: { p1: '# p1' },
        pagesMd: { orphan: '# pure orphan (未参照)' },  // node/note/リンクどこからも未参照
        pagesImages: { 'pic.png': 'X' },
    });
    const plan = planMigration(dir);
    executePlan(plan);
    cleanupOldDirs(plan);
    // pages/ ごと削除（純 orphan も消える = 意図どおり）
    expect(fs.existsSync(path.join(dir, 'pages'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'orphan.md'))).toBe(false); // 未参照 orphan は移行対象外 → pages/ ごと消える
    // ★ noteDir 自身・共有 images/files・flat md・.out は残る（最後の砦ガード。pages/ の兄弟であって配下でない）
    expect(fs.existsSync(dir)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'images', 'pic.png'))).toBe(true); // 共有 images に移行済み
    expect(fs.existsSync(path.join(dir, 'dailynotes.out'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'p1.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});
