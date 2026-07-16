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
    // ★subpage marker `[[]]` = 複製ゲートを通る（参照リンク `[]` は複製されない = ゲート反転・ADR-0009）
    const aMd = '# a\n[[b]](b.md)\n![](images/ai.png)';
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
    // ★subpage marker `[[]]` で複製ゲートを通す
    const { rewrittenMarkdown } = callPaste('[[b]](b.md)', src, dest);
    // b.md が dest に複製される
    expect(fs.existsSync(path.join(dest, 'b.md'))).toBe(true);
    // subpage リンクが dest 内の複製先を指し、解決できる（subpage 記法を維持したまま url が書換わる）
    const m = rewrittenMarkdown.match(/\[\[b\]\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-22 外部 md リンクは dest 相対に書換（複製なし・絶対パス禁止）', () => {
    const { root, src, dest } = setup();
    const other = path.join(root, 'otherNote');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'x.md'), '# x');
    // ★subpage marker でも自note外（../otherNote）を指す限り複製されない（ADRL-0002）。相対パス書換のみ。
    const { rewrittenMarkdown } = callPaste('[[out]](../otherNote/x.md)', src, dest);
    // dest に x.md は複製されない
    expect(fs.existsSync(path.join(dest, 'x.md'))).toBe(false);
    // 絶対パスを含まない（既存 assertNoAbsolutePaths 不変条件）
    expect(rewrittenMarkdown).not.toContain('/Users/');
    expect(rewrittenMarkdown).not.toContain(root);
    // dest から書換後リンクを解決すると元 x.md に届く（load-bearing: 書換なしだと解決先が違う）
    const m = rewrittenMarkdown.match(/\[\[out\]\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    expect(path.resolve(dest, m![1])).toBe(path.resolve(other, 'x.md'));
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-23 複製名は元名維持 + 衝突時 suffix', () => {
    const { root, src, dest } = setup();
    fs.writeFileSync(path.join(src, 'b.md'), '# src b');
    fs.writeFileSync(path.join(dest, 'b.md'), '# preexisting dest b'); // 衝突
    // ★subpage marker `[[]]` で複製ゲートを通す
    const { rewrittenMarkdown } = callPaste('[[b]](b.md)', src, dest);
    // 既存 dest/b.md は上書きされない
    expect(fs.readFileSync(path.join(dest, 'b.md'), 'utf8')).toBe('# preexisting dest b');
    // 複製は別名（b-1.md 等）
    const m = rewrittenMarkdown.match(/\[\[b\]\]\(([^)]+)\)/);
    expect(m![1]).not.toBe('b.md');
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dest, m![1]), 'utf8')).toBe('# src b');
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-24 循環参照込みでも有限完了（A↔B）', () => {
    const { root, src, dest } = setup();
    // ★subpage marker `[[]]` で複製ゲートを通す（A↔B の相互 subpage リンクで循環を作る）
    fs.writeFileSync(path.join(src, 'a.md'), '# a\n[[b]](b.md)');
    fs.writeFileSync(path.join(src, 'b.md'), '# b\n[[a]](a.md)');
    // 起点 = a 相当の markdown（a.md 本文と同じ）
    const { rewrittenMarkdown } = callPaste('# a\n[[b]](b.md)', src, dest);
    // b が 1 回だけ複製される（無限ループしない）
    const destMds = fs.readdirSync(dest).filter(f => f.endsWith('.md'));
    // b.md の複製が 1 つ（a は起点なので複製されない）
    expect(destMds.filter(f => f === 'b.md' || /^b-\d+\.md$/.test(f)).length).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-25 部分文字列重複リンクを誤置換しない（note.md 改名で mynote.md 無傷）★HIGH 修正', () => {
    const { root, src, dest } = setup();
    // dest に note.md が既存 → src の note.md は改名（suffix）される。mynote.md はそれに巻き込まれてはいけない。
    fs.writeFileSync(path.join(src, 'note.md'), '# src note');
    fs.writeFileSync(path.join(src, 'mynote.md'), '# src mynote');
    fs.writeFileSync(path.join(dest, 'note.md'), '# preexisting'); // note.md 衝突 → 改名を誘発
    // ★subpage marker `[[]]` で両リンクを複製ゲートに通す（note.md は衝突改名・mynote.md は無傷維持）
    const { rewrittenMarkdown } = callPaste('[[a]](note.md) [[b]](mynote.md)', src, dest);
    // note.md リンクは別名（note-1.md 等）に、mynote.md リンクは mynote.md のまま（無傷）で dest に解決
    const mA = rewrittenMarkdown.match(/\[\[a\]\]\(([^)]+)\)/);
    const mB = rewrittenMarkdown.match(/\[\[b\]\]\(([^)]+)\)/);
    expect(mA![1]).not.toBe('note.md'); // 衝突で改名された
    // ★load-bearing: mynote 側が mynote-1.md 等に化けていない（部分文字列誤置換なし）
    expect(mB![1]).toBe('mynote.md');
    // 両方 dest で解決する
    expect(fs.existsSync(path.resolve(dest, mA![1]))).toBe(true);
    expect(fs.existsSync(path.resolve(dest, mB![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dest, mB![1]), 'utf8')).toBe('# src mynote');
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-26 root-level 画像の部分文字列重複を誤置換しない（bare basename: pic.png 改名で mypic.png 無傷）★HIGH load-bearing', () => {
    const { root, src, dest } = setup();
    // ★spec (tasks.md:80) どおり bare basename を使う。pic.png は mypic.png の部分文字列なので
    //   旧 substring .replace だと mypic.png→mycopy-<ts>-pic.png に巻き込まれて壊れる（load-bearing）。
    //   root-level 画像は sourceMdDir 基準で resolve されるので src 直下に置く。
    fs.writeFileSync(path.join(src, 'pic.png'), 'PIC');
    fs.writeFileSync(path.join(src, 'mypic.png'), 'MYPIC');
    const md = '![a](pic.png) ![b](mypic.png)';
    const { rewrittenMarkdown } = callPaste(md, src, dest);
    const mA = rewrittenMarkdown.match(/!\[a\]\(([^)]+)\)/);
    const mB = rewrittenMarkdown.match(/!\[b\]\(([^)]+)\)/);
    // ★load-bearing: 両リンクが dest で正しく解決し、mypic 側が pic 改名に巻き込まれていない
    expect(fs.existsSync(path.resolve(dest, mA![1]))).toBe(true);
    expect(fs.existsSync(path.resolve(dest, mB![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dest, mA![1]), 'utf8')).toBe('PIC');
    expect(fs.readFileSync(path.resolve(dest, mB![1]), 'utf8')).toBe('MYPIC');
    // mB のリンクが 'my' + (pic の複製名) に化けていない（部分文字列巻き込みの直接検出）
    expect(mB![1]).not.toContain('mycopy-');
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-30 既存 1 階層 md-link 複製が従来どおり（リンク先 md 複製 + 書換）', () => {
    const { root, src, dest } = setup();
    fs.writeFileSync(path.join(src, 'leaf.md'), '# leaf (no further links)');
    // ★subpage marker `[[]]` で複製ゲートを通す
    const { rewrittenMarkdown } = callPaste('[[leaf]](leaf.md)', src, dest);
    expect(fs.existsSync(path.join(dest, 'leaf.md'))).toBe(true);
    const m = rewrittenMarkdown.match(/\[\[leaf\]\]\(([^)]+)\)/);
    expect(fs.existsSync(path.resolve(dest, m![1]))).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
});

test('TC-ML-31 参照リンク [ref](x.md) は複製されない（ゲート反転の正の番人）★load-bearing', () => {
    const { root, src, dest } = setup();
    // 自note内に実在する refd.md。**プレーン参照リンク** `[ref](refd.md)` は複製ゲートを通らない。
    // （subpage `[[ref]](refd.md)` なら複製される = TC-ML-30 で検証済み。ここはその反転側の番人。）
    fs.writeFileSync(path.join(src, 'refd.md'), '# referenced (should NOT be copied)');
    const { rewrittenMarkdown } = callPaste('[ref](refd.md)', src, dest);
    // ★load-bearing: 参照リンクなので refd.md は dest に複製されない
    //   （subpage 化すると複製される = ゲートが実際に link 種別で分岐していることの正の証明）
    expect(fs.existsSync(path.join(dest, 'refd.md'))).toBe(false);
    const destMds = fs.readdirSync(dest).filter(f => f.endsWith('.md'));
    expect(destMds.filter(f => f === 'refd.md' || /^refd-\d+\.md$/.test(f)).length).toBe(0);
    // 参照リンク記法（プレーン `[]`）は維持され、subpage `[[]]` に化けない
    expect(rewrittenMarkdown).toContain('[ref](');
    expect(rewrittenMarkdown).not.toContain('[[ref]]');
    fs.rmSync(root, { recursive: true, force: true });
});
