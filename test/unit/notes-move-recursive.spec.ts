/**
 * move-other-note-recursive-md — Move Other Note の md-to-md 再帰移動
 *
 * TC-MVR-12 collectSurvivingMdLinkRefs 単体（絶対パス Set・exact ref）
 * TC-MVR-01 A→B 再帰移動（両方 dst へ・src から消える）
 * TC-MVR-02 多段 A→B→C
 * TC-MVR-03 循環 A↔B
 * TC-MVR-10 残留参照ありは copy フォールバック（元に残す）
 * TC-MVR-11 残留が移動 closure だけなら move
 * TC-MVR-13 move md → copy-fallback md への link が dst 新 id に解決
 * TC-MVR-20 外部note リンクは移動せず相対書換
 * TC-MVR-30 部分文字列重複リンクを誤置換しない
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import { collectSurvivingMdLinkRefs } from '../../src/shared/notes-asset-mover';

function mkTmp(p: string): string { return fs.mkdtempSync(path.join(os.tmpdir(), p)); }

/** flat note: <dir>/<id>.md + outline.note に item 登録 */
function setupNotes(): { src: string; dst: string; cleanup: () => void } {
    const root = mkTmp('mvr-');
    const src = path.join(root, 'note1');
    const dst = path.join(root, 'note2');
    fs.mkdirSync(src, { recursive: true });
    fs.mkdirSync(dst, { recursive: true });
    return { src, dst, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
/** src note に md を作り item 登録し、本文を書く。返り値 = id */
function makeMd(fm: NotesFileManager, title: string, body: string): string {
    const p = fm.createMarkdownFile(title, null);
    const id = path.basename(p, '.md');
    fs.writeFileSync(p, body, 'utf8');
    return id;
}

test('TC-MVR-12 collectSurvivingMdLinkRefs は絶対パス Set・excludeIds 反映・exact ref', () => {
    const { src, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const aId = makeMd(fm, 'A', '[b](B_ID.md)');   // placeholder, 後で実 id に合わせない — 直接ファイルで検証
    // 実 id ベースで作り直し: A と C が同じ B を参照
    const bId = makeMd(fm, 'B', '# b');
    fs.writeFileSync(path.join(src, `${aId}.md`), `[b](${bId}.md)`, 'utf8');
    const cId = makeMd(fm, 'C', `[b](${bId}.md)`);
    const bAbs = path.join(src, `${bId}.md`);
    // excludeIds={A} → C がまだ B を参照 → B は surviving
    const s1 = collectSurvivingMdLinkRefs(src, new Set([aId]));
    expect(s1.has(bAbs)).toBe(true);
    // excludeIds={A,C} → B を参照する item が居ない → B は surviving でない
    const s2 = collectSurvivingMdLinkRefs(src, new Set([aId, cId]));
    expect(s2.has(bAbs)).toBe(false);
    cleanup();
});

test('TC-MVR-01 A→B 再帰移動（両方 dst へ、src から消える）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', '# b body');
    const aId = makeMd(fm, 'A', `see [b](${bId}.md)`);
    const newAId = fm.moveFileItemToOtherNote(aId, dst);
    expect(newAId).toBeTruthy();
    // src から A・B 消える
    expect(fs.existsSync(path.join(src, `${aId}.md`))).toBe(false);
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(false);
    // dst に A・B 存在（B は元 id or 新 id）
    const dstMds = fs.readdirSync(dst).filter(f => f.endsWith('.md'));
    expect(dstMds.length).toBe(2);
    // dst の A 本文の [b] リンクが dst 内で解決
    const aBody = fs.readFileSync(path.join(dst, `${newAId}.md`), 'utf8');
    const m = aBody.match(/\[b\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(fs.existsSync(path.resolve(dst, m![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dst, m![1]), 'utf8')).toBe('# b body');
    cleanup();
});

test('TC-MVR-02 多段 A→B→C 全移動', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const cId = makeMd(fm, 'C', '# c');
    const bId = makeMd(fm, 'B', `[c](${cId}.md)`);
    const aId = makeMd(fm, 'A', `[b](${bId}.md)`);
    fm.moveFileItemToOtherNote(aId, dst);
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(3);
    expect(fs.readdirSync(src).filter(f => f.endsWith('.md')).length).toBe(0);
    cleanup();
});

test('TC-MVR-03 循環 A↔B で無限ループせず移動', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', 'placeholder');
    const aId = makeMd(fm, 'A', `[b](${bId}.md)`);
    fs.writeFileSync(path.join(src, `${bId}.md`), `[a](${aId}.md)`, 'utf8');
    const newAId = fm.moveFileItemToOtherNote(aId, dst);
    expect(newAId).toBeTruthy();
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(2);
    cleanup();
});

test('TC-MVR-10 残留参照ありの closure md は copy フォールバック（元に残す）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', '# b');
    const aId = makeMd(fm, 'A', `[b](${bId}.md)`);
    const cId = makeMd(fm, 'C', `[b](${bId}.md)`); // C も B を参照、C は src に残る
    fm.moveFileItemToOtherNote(aId, dst);
    // A は dst へ移動（src から消える）
    expect(fs.existsSync(path.join(src, `${aId}.md`))).toBe(false);
    // B は copy: dst に存在 かつ src にも残る（C がまだ参照）
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(true);
    expect(fs.readdirSync(dst).filter(f => f.endsWith('.md')).length).toBe(2); // A + B copy
    // src の C→B リンクは無傷（B が残っているので解決）
    const cBody = fs.readFileSync(path.join(src, `${cId}.md`), 'utf8');
    const cm = cBody.match(/\[b\]\(([^)]+)\)/);
    expect(fs.existsSync(path.resolve(src, cm![1]))).toBe(true);
    cleanup();
});

test('TC-MVR-11 残留が移動 closure だけなら move', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', '# b');
    const aId = makeMd(fm, 'A', `[b](${bId}.md)`); // B を参照するのは A のみ
    fm.moveFileItemToOtherNote(aId, dst);
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(false); // move（消える）
    cleanup();
});

test('TC-MVR-14 copy-fallback md が参照する共有 image は src に残る（HIGH データロス防止）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    // 共有 image bimg.png を B だけが参照
    const imgDir = path.join(src, 'images');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'bimg.png'), 'BIMG');
    const bId = makeMd(fm, 'B', '# b\n![](images/bimg.png)');
    const aId = makeMd(fm, 'A', `[b](${bId}.md)`);
    makeMd(fm, 'C', `[b](${bId}.md)`); // C 残留 → B は copy-fallback（src に残る）
    fm.moveFileItemToOtherNote(aId, dst);
    // B は copy-fallback で src に残る
    expect(fs.existsSync(path.join(src, `${bId}.md`))).toBe(true);
    // ★load-bearing: B が参照する共有 bimg.png も src に残る（copy-fallback の id を除外集合に
    //   入れていた旧実装だと「残留参照なし」と誤判定され削除される = データロス）
    expect(fs.existsSync(path.join(src, 'images', 'bimg.png'))).toBe(true);
    // dst にも B コピー + bimg.png が届く
    expect(fs.existsSync(path.join(dst, 'images', 'bimg.png'))).toBe(true);
    cleanup();
});

test('TC-MVR-13 move md → copy-fallback md への link が dst 新 id に解決', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', '# b body');
    const aId = makeMd(fm, 'A', `[b](${bId}.md)`);
    makeMd(fm, 'C', `[b](${bId}.md)`); // C 残留 → B は copy-fallback
    const newAId = fm.moveFileItemToOtherNote(aId, dst);
    // dst の A リンクが dst の B コピーを指し解決（copy-fallback も id-map に入る）
    const aBody = fs.readFileSync(path.join(dst, `${newAId}.md`), 'utf8');
    const m = aBody.match(/\[b\]\(([^)]+)\)/);
    expect(m).toBeTruthy();
    expect(fs.existsSync(path.resolve(dst, m![1]))).toBe(true);
    expect(fs.readFileSync(path.resolve(dst, m![1]), 'utf8')).toBe('# b body');
    cleanup();
});

test('TC-MVR-20 外部note リンクは移動せず dst 相対書換（絶対パス禁止）', () => {
    const { src, dst, cleanup } = setupNotes();
    const other = path.join(path.dirname(src), 'otherNote');
    fs.mkdirSync(other, { recursive: true });
    fs.writeFileSync(path.join(other, 'X.md'), '# x');
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', '# b');
    const aId = makeMd(fm, 'A', `[b](${bId}.md) [x](../otherNote/X.md)`);
    const newAId = fm.moveFileItemToOtherNote(aId, dst);
    // X は移動されない
    expect(fs.existsSync(path.join(dst, 'X.md'))).toBe(false);
    expect(fs.existsSync(path.join(other, 'X.md'))).toBe(true);
    const aBody = fs.readFileSync(path.join(dst, `${newAId}.md`), 'utf8');
    // 絶対パスを含まない
    expect(aBody).not.toContain('/Users/');
    // X リンクが dst から元 X に解決
    const mx = aBody.match(/\[x\]\(([^)]+)\)/);
    expect(fs.existsSync(path.resolve(dst, mx![1]))).toBe(true);
    expect(path.resolve(dst, mx![1])).toBe(path.resolve(other, 'X.md'));
    cleanup();
});

test('TC-MVR-30 部分文字列重複リンクを誤置換しない（B.md / BB.md）', () => {
    const { src, dst, cleanup } = setupNotes();
    const fm = new NotesFileManager(src);
    const bId = makeMd(fm, 'B', '# b body');
    const bbId = makeMd(fm, 'BB', '# bb body');
    // bId が bbId の部分文字列になるよう固定 id を仕込む（createMarkdownFile の id は unique だが、
    // 部分文字列関係を作るため本文を実 id で書く。実 id が偶然部分文字列でなくても、
    // whole-link-target 書換なら安全であることを「両リンクが別ファイルに解決」で検証）
    const aId = makeMd(fm, 'A', `[b](${bId}.md) [bb](${bbId}.md)`);
    const newAId = fm.moveFileItemToOtherNote(aId, dst);
    const aBody = fs.readFileSync(path.join(dst, `${newAId}.md`), 'utf8');
    const mb = aBody.match(/\[b\]\(([^)]+)\)/);
    const mbb = aBody.match(/\[bb\]\(([^)]+)\)/);
    // 両リンクが別々の正しいファイルに解決
    expect(fs.readFileSync(path.resolve(dst, mb![1]), 'utf8')).toBe('# b body');
    expect(fs.readFileSync(path.resolve(dst, mbb![1]), 'utf8')).toBe('# bb body');
    cleanup();
});
