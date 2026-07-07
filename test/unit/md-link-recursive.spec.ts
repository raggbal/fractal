/**
 * md-link-recursive-copy TASK-02 — copyMdPasteAssets 再帰複製
 *
 * TC-ML-12 解決不能リンクは複製もパス書換もしない
 * TC-ML-20 再帰複製: リンク先 md とその画像も dest に複製
 * TC-ML-21 起点 md 本文の md リンクが dest 相対に書換
 * TC-ML-22 外部 md リンクは dest 相対に書換（複製されない・絶対パス禁止）
 * TC-ML-23 複製名は元名維持 + 衝突時 suffix
 * TC-ML-24 循環参照込みでも有限完了
 * TC-ML-30 既存 1 階層 md-link 複製が従来どおり
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'md-rec-'));
}
/** note1(src) と note2(dest) を用意。両方 flat（md/images/files が note フォルダ直下）。 */
function setup(): { root: string; src: string; dest: string } {
    const root = mkTmp();
    const src = path.join(root, 'note1');
    const dest = path.join(root, 'note2');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dest, { recursive: true });
    return { root, src, dest };
}
function callPaste(markdown: string, src: string, dest: string) {
    return copyMdPasteAssets({
        markdown,
        sourceMdDir: src,
        sourceImageDir: path.join(src, 'images'),
        sourceFileDir: path.join(src, 'files'),
        destImageDir: path.join(dest, 'images'),
        destFileDir: path.join(dest, 'files'),
        destMdDir: dest,
    });
}

test('TC-ML-12 解決不能リンクは複製もパス書換もしない', () => {
    const { root, src, dest } = setup();
    const md = 'see [dead](nonexistent.md)';
    const { rewrittenMarkdown } = callPaste(md, src, dest);
    expect(rewrittenMarkdown).toContain('nonexistent.md'); // 触らない
    expect(fs.existsSync(path.join(dest, 'nonexistent.md'))).toBe(false);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-20 再帰複製: リンク先 md とその画像も dest に複製', () => {
    const { root, src, dest } = setup();
    fs.mkdirSync(path.join(src, 'images'), { recursive: true });
    fs.writeFileSync(path.join(src, 'images', 'ai.png'), 'AI');
    fs.writeFileSync(path.join(src, 'images', 'bi.png'), 'BI');
    // a → b, a に ai.png, b に bi.png
    fs.writeFileSync(path.join(src, 'b.md'), '# b\n![](images/bi.png)');
    const aMd = '# a\n[b](b.md)\n![](images/ai.png)';
    const { rewrittenMarkdown } = callPaste(aMd, src, dest);
    // b.md が dest に複製される
    expect(fs.existsSync(path.join(dest, 'b.md'))).toBe(true);
    // a の画像 ai.png、b の画像 bi.png 両方 dest/images に複製
    const destImgs = fs.readdirSync(path.join(dest, 'images'));
    expect(destImgs.some(f => f.endsWith('ai.png'))).toBe(true);
    expect(destImgs.some(f => f.endsWith('bi.png'))).toBe(true);
    // ★load-bearing: b.md 複製本文の bi.png リンクが dest の複製先に書換わり解決する
    const bBody = fs.readFileSync(path.join(dest, 'b.md'), 'utf8');
    const bImgMatch = bBody.match(/!\[\]\(([^)]+)\)/);
    expect(bImgMatch).toBeTruthy();
    expect(fs.existsSync(path.resolve(dest, bImgMatch![1]))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-21 起点 md 本文の md リンクが dest 複製先相対に書換', () => {
    const { root, src, dest } = setup();
    fs.writeFileSync(path.join(src, 'b.md'), '# b');
    const { rewrittenMarkdown } = callPaste('[b](b.md)', src, dest);
    // リンクが dest 内の複製先を指し、解決できる
    const m = rewrittenMarkdown.match(/\[b\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-22 外部 md リンクは dest 相対に書換（複製なし・絶対パス禁止）', () => {
    const { root, src, dest } = setup();
    const other = path.join(root, 'otherNote');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'x.md'), '# x');
    const { rewrittenMarkdown } = callPaste('[out](../otherNote/x.md)', src, dest);
    // dest に x.md は複製されない
    expect(fs.existsSync(path.join(dest, 'x.md'))).toBe(false);
    // 絶対パスを含まない（既存 assertNoAbsolutePaths 不変条件）
    expect(rewrittenMarkdown).not.toContain('/Users/');
    expect(rewrittenMarkdown).not.toContain(root);
    // dest から書換後リンクを解決すると元 x.md に届く（load-bearing: 書換なしだと解決先が違う）
    const m = rewrittenMarkdown.match(/\[out\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    expect(path.resolve(dest, m![1])).toBe(path.resolve(other, 'x.md'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-23 複製名は元名維持 + 衝突時 suffix', () => {
    const { root, src, dest } = setup();
    fs.writeFileSync(path.join(src, 'b.md'), '# src b');
    fs.writeFileSync(path.join(dest, 'b.md'), '# preexisting dest b'); // 衝突
    const { rewrittenMarkdown } = callPaste('[b](b.md)', src, dest);
    // 既存 dest/b.md は上書きされない
    expect(fs.readFileSync(path.join(dest, 'b.md'), 'utf8')).toBe('# preexisting dest b');
    // 複製は別名（b-1.md 等）
    const m = rewrittenMarkdown.match(/\[b\]\(([^)]+)\)/);
    expect(m![1]).not.toBe('b.md');
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dest, m![1]), 'utf8')).toBe('# src b');
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-24 循環参照込みでも有限完了（A↔B）', () => {
    const { root, src, dest } = setup();
    fs.writeFileSync(path.join(src, 'a.md'), '# a\n[b](b.md)');
    fs.writeFileSync(path.join(src, 'b.md'), '# b\n[a](a.md)');
    // 起点 = a 相当の markdown（a.md 本文と同じ）
    const { rewrittenMarkdown } = callPaste('# a\n[b](b.md)', src, dest);
    // b が 1 回だけ複製される（無限ループしない）
    const destMds = fs.readdirSync(dest).filter(f => f.endsWith('.md'));
    // b.md の複製が 1 つ（a は起点なので複製されない）
    expect(destMds.filter(f => f === 'b.md' || /^b-\d+\.md$/.test(f)).length).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-30 既存 1 階層 md-link 複製が従来どおり（リンク先 md 複製 + 書換）', () => {
    const { root, src, dest } = setup();
    fs.writeFileSync(path.join(src, 'leaf.md'), '# leaf (no further links)');
    const { rewrittenMarkdown } = callPaste('[leaf](leaf.md)', src, dest);
    expect(fs.existsSync(path.join(dest, 'leaf.md'))).toBe(true);
    const m = rewrittenMarkdown.match(/\[leaf\]\(([^)]+)\)/);
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});
