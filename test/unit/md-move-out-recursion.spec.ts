/**
 * md-move-link-recursion-unify (scope1): Move Other Note の `.out` flat 分岐で、
 * page md の md-to-md リンク先を `.md` 分岐と同じ closure 機構で再帰移動する。
 *
 * TC-OUT-01 (load-bearing) .out page md の md-link 先が再帰移動 + dst 解決
 * TC-OUT-02 多段 page md → B → C
 * TC-OUT-03 循環 page md ↔ B（無限ループせず）
 * TC-OUT-10 残留参照ありは copy-fallback（.out 版）
 * TC-OUT-11 残留が .out 内 page md のみなら move
 * TC-OUT-14 (load-bearing データロス) copy-fallback md の共有 image が src に残る
 * TC-OUT-15 (multi-root) 同一 .out の 2 page md（P1→P2 md-link）で P2 が closure 二重コピーされない
 * TC-OUT-20 外部note リンクは移動せず相対書換・絶対禁止
 * TC-OUT-30 (load-bearing) 部分文字列リンク誤置換しない（.out 版）
 * TC-OUT-40 後方互換: md-link 無しの .out は従来どおり（TC-MV-01 と同結果）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

function mkTmp(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

/** src / dst の 2 note を同一 root 配下に用意（外部note のため兄弟配置可能） */
function setupNotes(): { root: string; src: string; dst: string; cleanup: () => void } {
    const root = mkTmp('mvo-');
    const src = path.join(root, 'note1');
    const dst = path.join(root, 'note2');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    return { root, src, dst, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/**
 * src note に flat .out を作り、page ノード（isPage/pageId）を注入する。
 * page md（`<src>/<pageId>.md`）は呼び出し側で書く。
 * @returns .out の item id
 */
function makeOutWithPage(fm: NotesFileManager, srcDir: string, pageId: string): string {
    const outPath = fm.createFile('Doc A', null);
    const id = path.basename(outPath, '.out');
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const pid = 'n_' + pageId;
    data.nodes[pid] = { id: pid, isPage: true, pageId, text: '', childIds: [], collapsed: false };
    (data.rootIds as string[]).push(pid);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
    return id;
}

/** src の生 .md を作り item 登録する（.md item として structure に載せる）。返り値 = id */
function makeMdItem(fm: NotesFileManager, title: string, body: string): string {
    const p = fm.createMarkdownFile(title, null);
    const id = path.basename(p, '.md');
    fs.writeFileSync(p, body, 'utf8');
    return id;
}

/**
 * 既存 flat .out（makeOutWithPage で作成済み）に 2 つ目の page ノード（isPage/pageId）を追加する。
 * makeOutWithPage と同じノード注入スタイルを踏襲。page md（`<src>/<pageId>.md`）は呼び出し側で書く。
 */
function addPageToOut(fm: NotesFileManager, srcDir: string, outId: string, pageId: string): void {
    const outPath = path.join(srcDir, `${outId}.out`);
    const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    const pid = 'n_' + pageId;
    data.nodes[pid] = { id: pid, isPage: true, pageId, text: '', childIds: [], collapsed: false };
    (data.rootIds as string[]).push(pid);
    fs.writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf8');
}

test('TC-OUT-01 (load-bearing) .out page md の md-link 先 B が再帰移動 + dst 内で解決', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    // 別 md item B を先に作る（実 id を得る）
    const bId = makeMdItem(fm, 'B', '# b body');
    // .out + page node（pageId=p1）。page md p1.md が B を参照
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md)`, 'utf8');

    const newId = fm.moveFileItemToOtherNote(outId, dst);
    expect(newId).toBeTruthy();

    // dst に .out + p1.md + B の md が存在（.md 2 枚 = p1 + B）
    expect(fs.existsSync(path.join(dst, `${newId}.out`))).toBe(true);
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(2);
    // src から .out・p1.md・B が消える（B は残留参照なしなので move）
    expect(fs.existsSync(path.join(src, `${outId}.out`))).toBe(false);
    expect(fs.existsSync(path.join(src, 'p1.md'))).toBe(false);
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(false);

    // ★load-bearing: dst の p1.md 本文の [b] リンクが dst 内で解決し中身が '# b body'
    const p1Body = fs.readFileSync(path.join(dst, 'p1.md'), 'utf8');
    const m = p1Body.match(/\[b\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    // counterfactual: 再帰しない旧実装だと B は dst に来ず（.md 1 枚のみ）このリンクが切れる
    expect(fs.existsSync(path.resolve(dst, m![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dst, m![1]), 'utf8')).toBe('# b body');
    cleanup();
});

test('TC-OUT-02 多段 .out page md → B → C 全移動', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const cId = makeMdItem(fm, 'C', '# c');
    const bId = makeMdItem(fm, 'B', `[c](${cId}.md)`);
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md)`, 'utf8');

    fm.moveFileItemToOtherNote(outId, dst);
    // dst の .md が 3 枚（p1 + B + C）、src の .md が 0 枚
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(3);
    expect(fs.readdirSync(src).filter(f => f.endsWith('.md')).length).toBe(0);
    cleanup();
});

test('TC-OUT-03 循環 page md ↔ B で無限ループせず移動', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMdItem(fm, 'B', 'placeholder');
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md)`, 'utf8');
    fs.writeFileSync(path.join(src, `${bId}.md`), '[p](p1.md)', 'utf8');

    const newId = fm.moveFileItemToOtherNote(outId, dst);
    expect(newId).toBeTruthy();
    // 無限ループせず終了、dst .md 2 枚
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(2);
    cleanup();
});

test('TC-OUT-10 残留参照ありは copy-fallback（.out 版）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMdItem(fm, 'B', '# b');
    // 別 .md item C も B を参照（C は移動対象外で src に残る）
    const cId = makeMdItem(fm, 'C', `[b](${bId}.md)`);
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md)`, 'utf8');

    fm.moveFileItemToOtherNote(outId, dst);
    // B は dst に複製される
    expect(fs.existsSync(path.join(dst, `${bId}.md`))).toBe(true);
    // ★B は src にも残る（C がまだ参照 → copy-fallback）
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(true);
    // C の [b] リンクは src で解決
    const cBody = fs.readFileSync(path.join(src, `${cId}.md`), 'utf8');
    const cm = cBody.match(/\[b\]\(([^)]+)\)/);
    expect(fs.existsSync(path.resolve(src, cm![1]))).toBe(true);
    cleanup();
});

test('TC-OUT-11 残留参照が .out 内 page md のみなら move', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMdItem(fm, 'B', '# b');
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md)`, 'utf8');

    fm.moveFileItemToOtherNote(outId, dst);
    // B を参照するのは p1（移動対象）のみ → B は src から消える（move）
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(false);
    expect(fs.existsSync(path.join(dst, `${bId}.md`))).toBe(true);
    cleanup();
});

test('TC-OUT-14 (load-bearing データロス) copy-fallback md の共有 image が src に残る', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    // 共有 image bimg.png を B だけが参照
    const imgDir = path.join(src, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'bimg.png'), 'BIMG');
    const bId = makeMdItem(fm, 'B', '# b\n![](images/bimg.png)');
    // 別 .md item C も B を参照 → B は copy-fallback（src 温存）
    makeMdItem(fm, 'C', `[b](${bId}.md)`);
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md)`, 'utf8');

    fm.moveFileItemToOtherNote(outId, dst);
    // B は copy-fallback で src に残る
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(true);
    // ★load-bearing: B が参照する共有 bimg.png も src に残る。
    // counterfactual: copy-fallback id を surviving 除外集合（movedIds）に入れる旧型実装だと
    //   「残留参照なし」と誤判定され bimg.png が削除される（データロス）→ このアサーションが fail。
    expect(fs.existsSync(path.join(src, 'images', 'bimg.png'))).toBe(true);
    // dst にも bimg.png が届く
    expect(fs.existsSync(path.join(dst, 'images', 'bimg.png'))).toBe(true);
    cleanup();
});

test('TC-OUT-15 (multi-root) 2 page md（P1→P2 md-link）で P2 が closure 二重コピーされない', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    // 同一 .out に 2 つの page node P1(pageId=p1) / P2(pageId=p2)。両方が root（page md）。
    const outId = makeOutWithPage(fm, src, 'p1');
    addPageToOut(fm, src, outId, 'p2');
    // P1 の page md が P2 の page md を md-link 参照（同一 .out 内の root 間リンク）。
    fs.writeFileSync(path.join(src, 'p1.md'), '[p2](p2.md)', 'utf8');
    fs.writeFileSync(path.join(src, 'p2.md'), '# p2', 'utf8');

    const newId = fm.moveFileItemToOtherNote(outId, dst);
    expect(newId).toBeTruthy();
    expect(fs.existsSync(path.join(dst, `${newId}.out`))).toBe(true);

    // (a) P2 は closure として二重コピーされない: dst の .md 枚数 == page node 数（2）= p1 + p2 各 1 枚。
    // counterfactual: `_planMdRecursiveMove` の `rootSet.has(abs) continue`（他起点を closure から除外）が
    //   無いと、P1 の [p2] リンクが P2 を closure として拾い、renumber された 2 枚目の p2 が増えて枚数 3 になる。
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(2);
    // p2 は元 pageId 維持でちょうど 1 枚（closure 複製 = 別 id の 2 枚目が生えていない）。
    expect(fs.existsSync(path.join(dst, 'p2.md'))).toBe(true);

    // (b) P1 の [p2] リンクが dst の root P2（元 pageId 'p2' 維持）に解決し中身が '# p2'。
    // counterfactual: root 除外が無いと [p2] は closure 複製（renumber された別 id）を指し、root p2 ではなくなる。
    const p1Body = fs.readFileSync(path.join(dst, 'p1.md'), 'utf8');
    const m = p1Body.match(/\[p2\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(path.resolve(dst, m![1])).toBe(path.resolve(dst, 'p2.md'));
    expect(fs.existsSync(path.resolve(dst, m![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dst, m![1]), 'utf8')).toBe('# p2');

    // (c) src から両 page md が消える（move）。
    expect(fs.existsSync(path.join(src, 'p1.md'))).toBe(false);
    expect(fs.existsSync(path.join(src, 'p2.md'))).toBe(false);
    cleanup();
});

test('TC-OUT-20 外部note リンクは移動せず相対書換・絶対禁止', () => {
    const { root, src, dst, cleanup } = setupNotes();
    // 兄弟 otherNote/X.md（自note外）
    const other = path.join(root, 'otherNote');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'X.md'), '# x');
    const fm = new NotesFileManager(src);
    const bId = makeMdItem(fm, 'B', '# b');
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md) [x](../otherNote/X.md)`, 'utf8');

    const newId = fm.moveFileItemToOtherNote(outId, dst);
    expect(newId).toBeTruthy();
    // X は移動されず src(other) に残る
    expect(fs.existsSync(path.join(other, 'X.md'))).toBe(true);
    expect(fs.existsSync(path.join(dst, 'X.md'))).toBe(false);
    const p1Body = fs.readFileSync(path.join(dst, 'p1.md'), 'utf8');
    // 絶対パスを含まない
    expect(p1Body).not.toContain('/Users/');
    expect(p1Body).not.toContain(root);
    // [x] リンクが dst から元 X に相対解決
    const mx = p1Body.match(/\[x\]\(([^)]+)\)/);
    expect(mx).toBeTruthy();
    expect(path.resolve(dst, mx![1])).toBe(path.resolve(other, 'X.md'));
    cleanup();
});

test('TC-OUT-30 (load-bearing) 部分文字列リンク誤置換しない（.out 版）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMdItem(fm, 'B', '# b body');
    const bbId = makeMdItem(fm, 'BB', '# bb body');
    const outId = makeOutWithPage(fm, src, 'p1');
    // 2 リンク（[b] と [bb]）。whole-link-target 書換なら別々に解決する
    fs.writeFileSync(path.join(src, 'p1.md'), `[b](${bId}.md) [bb](${bbId}.md)`, 'utf8');

    const newId = fm.moveFileItemToOtherNote(outId, dst);
    expect(newId).toBeTruthy();
    const p1Body = fs.readFileSync(path.join(dst, 'p1.md'), 'utf8');
    const mb = p1Body.match(/\[b\]\(([^)]+)\)/);
    const mbb = p1Body.match(/\[bb\]\(([^)]+)\)/);
    expect(mb).toBeTruthy();
    expect(mbb).toBeTruthy();
    // ★両リンクが別々の正しいファイルに解決（substring 誤置換なら片方が壊れる）
    expect(fs.readFileSync(path.resolve(dst, mb![1]), 'utf8')).toBe('# b body');
    expect(fs.readFileSync(path.resolve(dst, mbb![1]), 'utf8')).toBe('# bb body');
    cleanup();
});

test('TC-OUT-40 後方互換: md-link 無しの .out は従来どおり（TC-MV-01 と同結果）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const outId = makeOutWithPage(fm, src, 'p1');
    fs.writeFileSync(path.join(src, 'p1.md'), '# just text', 'utf8');

    const dst2 = new NotesFileManager(dst);
    dst2.createFile('Existing', null); // dst に既存 item

    const newId = fm.moveFileItemToOtherNote(outId, dst);
    expect(newId).toBeTruthy();
    // dst に .out + p1.md のみ（.md 1 枚）
    expect(fs.existsSync(path.join(dst, `${newId}.out`))).toBe(true);
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(1);
    // src から .out・p1.md が消える
    expect(fs.existsSync(path.join(src, `${outId}.out`))).toBe(false);
    expect(fs.existsSync(path.join(src, 'p1.md'))).toBe(false);
    // dst 構造の先頭に移動分が入る
    const dst3 = new NotesFileManager(dst);
    expect(dst3.getStructure().rootIds[0]).toBe(newId);
    cleanup();
});
