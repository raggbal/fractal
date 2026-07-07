/**
 * notes-flat-storage TASK-02 — Migrate to flat layout コア
 *
 * decision 2026-07-07: md=Note 直下、画像/添付=共有 images/・files/。本文リンク書換なし。
 *
 * TC-FS-10 planMigration が旧→新の移動計画を正しく列挙
 * TC-FS-11 validatePlan が移動先衝突を検出し execute を止める
 * TC-FS-12 executePlan 成功時 dry-run 件数 == 実行件数
 * TC-FS-13 executePlan 中途失敗でロールバック（部分移動なし）
 * TC-FS-14 移行後 .out の node.images/node.filePath が共有 dir を指す（load-bearing）
 * TC-FS-15 移行後 md 本文リンクはそのまま（書換なし）で解決する（load-bearing）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planMigration, validatePlan, executePlan, summarizePlan } from '../../src/shared/flat-migrate';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flat-mig-'));
}

/** 旧 per-<stem>/ レイアウトの Note を作る（3 ページ, 各 img+file, 本文は ./images/ 参照）。
 *  pageId / asset 名は stem を含めて Note 間で衝突しないようにする。 */
function makeOldNote(dir: string, stem = 'work'): void {
    const pdir = path.join(dir, stem);
    fs.mkdirSync(path.join(pdir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(pdir, 'files'), { recursive: true });
    const nodes: Record<string, unknown> = {};
    for (let i = 1; i <= 3; i++) {
        const pid = `${stem}p${i}`;   // stem を含めて一意化（複数 Note で共有 dir に集約されても衝突しない）
        const img = `${stem}i${i}.png`;
        const file = `${stem}f${i}.pdf`;
        nodes['n' + i] = {
            id: 'n' + i, text: pid, childIds: [], isPage: true, pageId: pid,
            images: [`${stem}/images/${img}`],   // outDir 基準の旧相対
            filePath: `${stem}/files/${file}`,
        };
        fs.writeFileSync(path.join(pdir, `${pid}.md`), `# ${pid}\n![](./images/${img})\n[📎](./files/${file})`);
        fs.writeFileSync(path.join(pdir, 'images', img), 'IMG' + i);
        fs.writeFileSync(path.join(pdir, 'files', file), 'FILE' + i);
    }
    fs.writeFileSync(path.join(dir, `${stem}.out`), JSON.stringify({
        title: stem, pageDir: `./${stem}`, rootIds: ['n1', 'n2', 'n3'], nodes,
    }, null, 2));
}

test('TC-FS-10 planMigration が旧→新の移動計画を正しく列挙', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    // notes-md 1 件（_notes_md）
    fs.mkdirSync(path.join(dir, '_notes_md', 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'md1.md'), '# note\n![](./images/n.png)');
    fs.writeFileSync(path.join(dir, '_notes_md', 'images', 'n.png'), 'IMG');

    const plan = planMigration(dir);
    const s = summarizePlan(plan);
    // pages: 3 (.out) + 1 (notes-md) = 4 ; images: 3 + 1 = 4 ; files: 3
    expect(s.pages).toBe(4);
    expect(s.images).toBe(4);
    expect(s.files).toBe(3);
    // md は Note 直下へ
    const pageMove = plan.moves.find(m => m.kind === 'page' && m.from.endsWith('workp1.md'));
    expect(pageMove!.to).toBe(path.join(dir, 'workp1.md'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-11 validatePlan が移動先衝突を検出し execute を止める', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    // 移動先 <dir>/p1.md に既存ファイルを置く（衝突）
    fs.writeFileSync(path.join(dir, 'workp1.md'), 'PRE-EXISTING');
    const snapshotBefore = fs.readFileSync(path.join(dir, 'work', 'workp1.md'), 'utf8');

    const plan = planMigration(dir);
    const v = validatePlan(plan);
    expect(v.ok).toBe(false);
    expect(v.reasons.some(r => r.includes('pre-existing target'))).toBe(true);
    // execute しない → 旧レイアウト維持
    expect(fs.existsSync(path.join(dir, 'work', 'workp1.md'))).toBe(true);
    expect(fs.readFileSync(path.join(dir, 'work', 'workp1.md'), 'utf8')).toBe(snapshotBefore);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-12 executePlan 成功時 dry-run 件数 == 実行件数', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    const plan = planMigration(dir);
    const dryCount = summarizePlan(plan).total; // 3 md + 3 img + 3 file = 9
    expect(dryCount).toBe(9);
    const v = validatePlan(plan);
    expect(v.ok).toBe(true);
    const res = executePlan(plan);
    expect(res.rolledBack).toBe(false);
    expect(res.executedMoves).toBe(dryCount);
    // 移行後レイアウト: md=Note 直下、images/files=共有
    expect(fs.existsSync(path.join(dir, 'workp1.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'images', 'worki1.png'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'files', 'workf1.pdf'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-13 executePlan 中途失敗でロールバック（部分移動なし）', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    // 旧レイアウトのスナップショット
    const snap = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
    const before = {
        p1: snap('work/workp1.md'), i1: snap('work/images/worki1.png'), f1: snap('work/files/workf1.pdf'),
        out: snap('work.out'),
    };
    const plan = planMigration(dir);
    const res = executePlan(plan, { injectFailAfter: 4 }); // 4 件移動後に throw
    expect(res.rolledBack).toBe(true);
    // 旧レイアウトが byte 一致で復元
    expect(fs.existsSync(path.join(dir, 'work', 'workp1.md'))).toBe(true);
    expect(snap('work/workp1.md')).toBe(before.p1);
    expect(snap('work/images/worki1.png')).toBe(before.i1);
    expect(snap('work/files/workf1.pdf')).toBe(before.f1);
    // .out の pageDir は未書換（rename 段で失敗 → JSON 書換に到達しない）
    expect(snap('work.out')).toBe(before.out);
    expect(JSON.parse(snap('work.out')).pageDir).toBe('./work');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-14 移行後 .out の node.images/node.filePath が共有 dir を指す（load-bearing）', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    const plan = planMigration(dir);
    executePlan(plan);
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'work.out'), 'utf8'));
    expect(data.pageDir).toBe('.');
    expect(data.imageDir).toBe('./images');
    expect(data.fileDir).toBe('./files');
    expect(data.nodes['n1'].images).toEqual(['images/worki1.png']);
    expect(data.nodes['n1'].filePath).toBe('files/workf1.pdf');
    // load-bearing: outDir 基準で node.images が共有 images に解決する
    const outDir = dir;
    expect(fs.existsSync(path.resolve(outDir, data.nodes['n1'].images[0]))).toBe(true);
    expect(fs.existsSync(path.resolve(outDir, data.nodes['n1'].filePath))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-41 .out JSON 書換ループ失敗で rename も書換も対称ロールバック（header/disk が legacy で一致）', () => {
    const dir = mkTmp();
    makeOldNote(dir, 'aaa');
    makeOldNote(dir, 'bbb'); // 2 つの .out → outRewrites が 2 件
    const snap = (rel: string) => fs.readFileSync(path.join(dir, rel), 'utf8');
    const beforeAaaOut = snap('aaa.out');
    const beforeBbbOut = snap('bbb.out');
    const beforeAaaP1 = snap('aaa/aaap1.md');

    const plan = planMigration(dir);
    // 全 rename 成功後、outRewrite #1 の後（#2 の書換直前）で失敗注入
    const res = executePlan(plan, { injectFailOnRewrite: 1 });
    expect(res.rolledBack).toBe(true);

    // 対称ロールバック: 書換済み .out も元に戻り、rename も戻る → 旧レイアウトが byte 一致
    expect(fs.existsSync(path.join(dir, 'aaa', 'aaap1.md'))).toBe(true);
    expect(snap('aaa/aaap1.md')).toBe(beforeAaaP1);
    expect(snap('aaa.out')).toBe(beforeAaaOut); // #1 は一度書換→復元されて元に一致
    expect(snap('bbb.out')).toBe(beforeBbbOut);
    // header/disk 整合: .out の pageDir は legacy のまま（flat に書き換わって取り残されていない）
    expect(JSON.parse(snap('aaa.out')).pageDir).toBe('./aaa');
    expect(JSON.parse(snap('bbb.out')).pageDir).toBe('./bbb');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-15 移行後 md 本文リンクはそのまま（書換なし）で解決する（load-bearing）', () => {
    const dir = mkTmp();
    makeOldNote(dir);
    const plan = planMigration(dir);
    executePlan(plan);
    // md は Note 直下 <dir>/workp1.md。本文は書き換わらず ./images/ のまま。
    const body = fs.readFileSync(path.join(dir, 'workp1.md'), 'utf8');
    expect(body).toContain('![](./images/worki1.png)');
    expect(body).toContain('[📎](./files/workf1.pdf)');
    expect(body).not.toContain('../images/'); // 過剰書換していない
    // load-bearing: 直下 md → ./images/i1.png が共有 <dir>/images/i1.png に解決
    const mdDir = dir;
    expect(fs.existsSync(path.resolve(mdDir, './images/worki1.png'))).toBe(true);
    expect(fs.existsSync(path.resolve(mdDir, './files/workf1.pdf'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});
