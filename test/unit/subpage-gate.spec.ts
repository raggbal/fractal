/**
 * subpage-marker TASK-02 — 層4 複製ゲート（subpage-only follow）
 *
 * collectMdLinkClosure は subpage `[[]]` リンク先だけを follow（複製）する。
 * 参照リンク `[]` は follow しない（ゲート反転・ADR-0009）。自 note 外 subpage も複製しない（ADRL-0002）。
 *
 * TC-SP-20 subpage リンク先は closure に入る
 * TC-SP-21 (load-bearing) 参照リンク先は closure に入らない（pre-fix helper で機械実証）
 * TC-SP-23 自 note 外 subpage は複製されない（external）
 * TC-SP-24 循環で無限ループしない
 * TC-SP-25 推移閉包 subpage
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { collectMdLinkClosure, extractAllAssetRefs, copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'subpage-gate-'));
}
const base = (p: string) => path.basename(p);

test('TC-SP-20: subpage リンク先は closure に入る（複製される）', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'A.md'), '[[child]](child.md)');
    fs.writeFileSync(path.join(dir, 'child.md'), '# child');
    const { closure } = collectMdLinkClosure(path.join(dir, 'A.md'), dir);
    expect(closure.map(base)).toContain('child.md');
});

test('TC-SP-21: 参照リンク先は closure に入らない（ゲート反転・load-bearing）', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'A.md'), '[ref](refd.md)'); // 単一ブラケット=参照
    fs.writeFileSync(path.join(dir, 'refd.md'), '# ref');
    const { closure } = collectMdLinkClosure(path.join(dir, 'A.md'), dir);
    expect(closure.map(base)).not.toContain('refd.md');

    // ★counterfactual（機械実証）: pre-fix（種別無視で mdLinks 全 follow）を再現すると refd.md が対象に入る。
    //   = fix（subpage-only filter）を戻すと refd.md が複製される = 真の load-bearing。
    const body = fs.readFileSync(path.join(dir, 'A.md'), 'utf8');
    const preFixFollow = extractAllAssetRefs(body).mdLinks // 両種別（反転前が follow していた集合）
        .map((u) => path.resolve(dir, u))
        .filter((p) => fs.existsSync(p));
    expect(preFixFollow.map(base)).toContain('refd.md');
});

test('TC-SP-22: 参照リンクの URL も書換される（見落としリスク2 の番人・regression guard）', () => {
    // rewriteMdLinksInBody は module-private → copyMdPasteAssets（export 済み）経由で検証。
    // 参照リンク: 複製されないが URL は書き換わる（リンク切れしない）。subpage: 複製される。
    const src = mkTmp();
    const dest = mkTmp();
    fs.writeFileSync(path.join(src, 'ref.md'), '# ref'); // 参照先（複製しない）
    fs.writeFileSync(path.join(src, 'child.md'), '# child'); // subpage 先（複製する）
    const result = copyMdPasteAssets({
        markdown: '[ref](ref.md) と [[child]](child.md)',
        sourceMdDir: src, sourceImageDir: src, sourceFileDir: src,
        destImageDir: dest, destFileDir: dest, destMdDir: dest,
    });
    // 参照リンク ref.md: 複製されないが URL は書き換わる（リンク切れしない）
    expect(fs.existsSync(path.join(dest, 'ref.md'))).toBe(false); // 複製されていない
    expect(result.rewrittenMarkdown).not.toContain('/Users/'); // 絶対パス化しない
    expect(result.rewrittenMarkdown).toMatch(/\[ref\]\([^)]*ref\.md\)/); // 参照リンクの url が残る＝書換漏れでない
    // subpage child.md: 複製される + 構文保持
    expect(fs.existsSync(path.join(dest, 'child.md'))).toBe(true);
    expect(result.rewrittenMarkdown).toMatch(/\[\[child\]\]\([^)]*child\.md\)/);
});

test('TC-SP-23: 自 note 外 subpage は複製されない（external）', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'A.md'), '[[ext]](../ext/x.md)'); // 自 note 外を指す subpage
    const { closure, external } = collectMdLinkClosure(path.join(dir, 'A.md'), dir);
    expect(closure).toHaveLength(0); // 複製されない
    expect(external.size).toBeGreaterThan(0); // external に入る
});

test('TC-SP-24: 循環 [[a]](b.md) ↔ [[b]](a.md) で無限ループしない', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'a.md'), '[[b]](b.md)');
    fs.writeFileSync(path.join(dir, 'b.md'), '[[a]](a.md)');
    const { closure, visitedCount } = collectMdLinkClosure(path.join(dir, 'a.md'), dir);
    // 起点 a.md + b.md = visited 2、closure に b.md（a.md は起点で visited 済み）
    expect(closure.map(base)).toEqual(['b.md']);
    expect(visitedCount).toBe(2);
});

test('TC-SP-25: 推移閉包 subpage A→b→c で c も複製', () => {
    const dir = mkTmp();
    fs.writeFileSync(path.join(dir, 'A.md'), '[[b]](b.md)');
    fs.writeFileSync(path.join(dir, 'b.md'), '[[c]](c.md)');
    fs.writeFileSync(path.join(dir, 'c.md'), '# c');
    const { closure } = collectMdLinkClosure(path.join(dir, 'A.md'), dir);
    expect(closure.map(base).sort()).toEqual(['b.md', 'c.md']);
});
