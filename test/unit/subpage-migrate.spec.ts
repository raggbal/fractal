/**
 * subpage-marker TASK-03 — 層5 migrate（promoteMdLinksToSubpage + flat-migrate 組込）
 *
 * migrate（旧フォルダ→flat）を通る note の md 本文プレーン md リンクを `[[]]` に昇格（FR-027・決定2）。
 * flat 済み note は昇格しない（isAlreadyFlat skip）。★asset を持たず md リンクだけの md も昇格（HIGH-2）。
 *
 * TC-SP-30 promoteMdLinksToSubpage プレーンだけ昇格・既存 [[]] 冪等
 * TC-SP-31 promoteMdLinksToSubpage が Wikipedia/画像/📎/外部/anchor を昇格しない
 * TC-SP-32 flat-migrate で page md 本文リンクが昇格（★asset なし md も）
 * TC-SP-33 _notes_md も昇格 / flat 済み note は昇格しない
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { promoteMdLinksToSubpage } from '../../src/shared/paste-asset-handler';
import { planMigration as planMig, executePlan as execMig } from '../../src/shared/flat-migrate';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'subpage-mig-'));
}

test('TC-SP-30: promoteMdLinksToSubpage プレーンだけ昇格・既存 [[]] 冪等', () => {
    const out = promoteMdLinksToSubpage('[a](x.md) と [[b]](y.md)');
    expect(out).toBe('[[a]](x.md) と [[b]](y.md)');
    expect(promoteMdLinksToSubpage(out)).toBe(out); // 冪等
});

test('TC-SP-31: promoteMdLinksToSubpage が Wikipedia/画像/📎/外部/anchor を昇格しない', () => {
    expect(promoteMdLinksToSubpage('[[cite](url)]')).toBe('[[cite](url)]');
    expect(promoteMdLinksToSubpage('![img](p.png)')).toBe('![img](p.png)');
    expect(promoteMdLinksToSubpage('[📎 f](c.pdf)')).toBe('[📎 f](c.pdf)');
    expect(promoteMdLinksToSubpage('[ext](https://a.md)')).toBe('[ext](https://a.md)');
    expect(promoteMdLinksToSubpage('[anchor](#x)')).toBe('[anchor](#x)');
});

/** 旧フォルダ note を作る。page md 本文に md→md リンクを含める（asset の有無を分ける）。 */
function makeOldNoteWithMdLinks(dir: string): void {
    const stem = 'work';
    const pdir = path.join(dir, stem);
    fs.mkdirSync(pdir, { recursive: true });
    const nodes: Record<string, unknown> = {};
    // p1: asset なし・md リンクだけ（★HIGH-2 の対象：renames 空でも昇格すべき）
    nodes['n1'] = { id: 'n1', text: 'p1', childIds: [], isPage: true, pageId: `${stem}p1` };
    fs.writeFileSync(path.join(pdir, `${stem}p1.md`), `# p1\n[child](${stem}p2.md)`);
    // p2: リンク先（asset なし）
    nodes['n2'] = { id: 'n2', text: 'p2', childIds: [], isPage: true, pageId: `${stem}p2` };
    fs.writeFileSync(path.join(pdir, `${stem}p2.md`), `# p2`);
    fs.writeFileSync(path.join(dir, `${stem}.out`), JSON.stringify({
        title: stem, pageDir: `./${stem}`, rootIds: ['n1', 'n2'], nodes,
    }, null, 2));
}

test('TC-SP-32: flat-migrate で page md 本文リンクが昇格（★asset なし md も）', () => {
    const dir = mkTmp();
    makeOldNoteWithMdLinks(dir);
    const plan = planMig(dir);
    execMig(plan);
    // 移行後 flat の workp1.md 本文がプレーン → [[]] 昇格（renames 空でも括弧化される = HIGH-2）
    const body = fs.readFileSync(path.join(dir, 'workp1.md'), 'utf8');
    expect(body).toContain('[[child]](workp2.md)');
    expect(body).not.toMatch(/[^[]\[child\]\(workp2\.md\)/); // プレーンが残っていない
});

test('TC-SP-33: _notes_md も昇格 / flat 済み note は昇格しない', () => {
    // (a) _notes_md 内のプレーン md リンク → 昇格
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'md1.md'), `# note\n[ref](md2.md)`);
    fs.writeFileSync(path.join(dir, '_notes_md', 'md2.md'), `# md2`);
    const plan = planMig(dir);
    execMig(plan);
    // migrate 後 md1 は flat 直下へ（本文リンク昇格）
    const migrated = fs.readdirSync(dir).filter((f) => f.endsWith('.md'));
    const md1Body = fs.readFileSync(path.join(dir, migrated.find((f) => fs.readFileSync(path.join(dir, f), 'utf8').includes('note'))!), 'utf8');
    expect(md1Body).toContain('[[ref]](md2.md)');

    // (b) 既に flat な note（.out が既に flat・移動する page md なし）→ 昇格されない
    const flatDir = mkTmp();
    fs.writeFileSync(path.join(flatDir, 'existing.md'), `# flat\n[plain](p.md)`);
    fs.writeFileSync(path.join(flatDir, 'p.md'), `# p`);
    // flat-only note（.out なし・_notes_md なし）→ migrate 対象の move なし
    const plan2 = planMig(flatDir);
    execMig(plan2);
    const flatBody = fs.readFileSync(path.join(flatDir, 'existing.md'), 'utf8');
    expect(flatBody).toContain('[plain](p.md)'); // 昇格されず参照のまま（決定2: 参照降格を許容）
});
