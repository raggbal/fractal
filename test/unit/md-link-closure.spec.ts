/**
 * md-link-recursive-copy TASK-01 — closure 収集 + 自note判定（純関数）
 *
 * TC-ML-01 単純チェーン A→B→C の再帰収集
 * TC-ML-02 循環 A→B→A で無限ループしない（具体 assert）
 * TC-ML-03 自己参照 A→A で複製されない
 * TC-ML-04 ダイヤモンド A→B,C / B→D / C→D で D 1 回だけ
 * TC-ML-10 自note内のみ closure、外部は external
 * TC-ML-11 isUnderNoteDir 判定（内=true / 外=false / .. エスケープ=false / sibling-prefix=false）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectMdLinkClosure, isUnderNoteDir } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'md-closure-'));
}
function wr(dir: string, name: string, body: string): string {
    const p = path.join(dir, name);
    fs.writeFileSync(p, body, 'utf8');
    return p;
}

test('TC-ML-01 単純チェーン A→B→C を再帰収集（起点除く）', () => {
    const d = mkTmp();
    const a = wr(d, 'a.md', '[b](b.md)');
    wr(d, 'b.md', '[c](c.md)');
    wr(d, 'c.md', '# c');
    const { closure, external } = collectMdLinkClosure(a, d);
    const names = closure.map(p => path.basename(p)).sort();
    expect(names).toEqual(['b.md', 'c.md']); // 起点 a は含まない
    expect(external.size).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
});

test('TC-ML-02 循環 A→B→A で無限ループしない（closure 有限・正確）', () => {
    const d = mkTmp();
    const a = wr(d, 'a.md', '[b](b.md)');
    wr(d, 'b.md', '[a](a.md)');
    const res = collectMdLinkClosure(a, d);
    // load-bearing: visited なしなら無限ループ or 増殖。closure は b のみ、visited は a,b の 2 件で有限。
    expect(res.closure.map(p => path.basename(p))).toEqual(['b.md']);
    expect(typeof res.visitedCount).toBe('number');
    expect(res.visitedCount).toBeLessThanOrEqual(2); // a, b のみ訪問
    fs.rmSync(d, { recursive: true, force: true });
});

test('TC-ML-03 自己参照 A→A で複製されない', () => {
    const d = mkTmp();
    const a = wr(d, 'a.md', 'self [a](a.md)');
    const { closure, external } = collectMdLinkClosure(a, d);
    expect(closure).toEqual([]); // 起点は visited 済み
    expect(external.size).toBe(0);
    fs.rmSync(d, { recursive: true, force: true });
});

test('TC-ML-04 ダイヤモンド A→B,C / B→D / C→D で D は 1 回だけ', () => {
    const d = mkTmp();
    const a = wr(d, 'a.md', '[b](b.md) [c](c.md)');
    wr(d, 'b.md', '[d](d.md)');
    wr(d, 'c.md', '[d](d.md)');
    wr(d, 'd.md', '# d');
    const { closure } = collectMdLinkClosure(a, d);
    const names = closure.map(p => path.basename(p)).sort();
    expect(names).toEqual(['b.md', 'c.md', 'd.md']); // d は重複なし
    fs.rmSync(d, { recursive: true, force: true });
});

test('TC-ML-10 自note内のみ closure、外部は external', () => {
    const root = mkTmp();
    const note1 = path.join(root, 'note1');
    const other = path.join(root, 'otherNote');
    fs.mkdirSync(note1, { recursive: true });
    fs.mkdirSync(other, { recursive: true });
    const a = wr(note1, 'a.md', '[in](b.md) [out](../otherNote/x.md)');
    wr(note1, 'b.md', '# b');
    wr(other, 'x.md', '# x');
    const { closure, external } = collectMdLinkClosure(a, note1);
    expect(closure.map(p => path.basename(p))).toEqual(['b.md']); // 自note内のみ
    // external に otherNote/x.md の絶対パスが入る（複製しない）
    const ext = Array.from(external);
    expect(ext.length).toBe(1);
    expect(ext[0]).toBe(path.resolve(other, 'x.md'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-11 isUnderNoteDir 判定（内/外/.. エスケープ/sibling-prefix）', () => {
    const d = mkTmp();
    const noteDir = path.join(d, 'n', 'pages');
    fs.mkdirSync(noteDir, { recursive: true });
    expect(isUnderNoteDir(path.join(noteDir, 'b.md'), noteDir)).toBe(true);
    expect(isUnderNoteDir(path.join(d, 'other', 'x.md'), noteDir)).toBe(false);
    expect(isUnderNoteDir(path.resolve(noteDir, '../evil.md'), noteDir)).toBe(false); // .. エスケープ
    // ★sibling-prefix: /d/n/pagesX/y.md は /d/n/pages 配下でない
    expect(isUnderNoteDir(path.join(d, 'n', 'pagesX', 'y.md'), noteDir)).toBe(false);
    fs.rmSync(d, { recursive: true, force: true });
});
