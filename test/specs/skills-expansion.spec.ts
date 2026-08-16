/**
 * ai_skills 拡張（sprint 20260726-042303）: fractal-modify / --create-md / fractal-doctor /
 * fractal-export / fractal-search --tag/--checked。
 *
 * 全 mjs は main guard 付きなので直接 import できる。tmp fixture note を都度生成。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const modifyMjs = path.resolve(__dirname, '../../ai_skills/fractal-edit/scripts/fractal-modify.mjs');
const mdMjs = path.resolve(__dirname, '../../ai_skills/fractal-edit/scripts/fractal-md.mjs');
const attachMjs = path.resolve(__dirname, '../../ai_skills/fractal-edit/scripts/fractal-attach.mjs');
const doctorMjs = path.resolve(__dirname, '../../ai_skills/fractal-doctor/scripts/fractal-doctor.mjs');
const summaryMjs = path.resolve(__dirname, '../../ai_skills/fractal-summary/scripts/fractal-summary.mjs');
const searchMjs = path.resolve(__dirname, '../../ai_skills/fractal-search/scripts/fractal-search.mjs');

let tmpRoot: string;
test.beforeAll(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fractal-skills-exp-'));
});
test.afterAll(() => {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

function mkdir(name: string): string {
    return fs.mkdtempSync(path.join(tmpRoot, name + '-'));
}

/** 標準 fixture .out データ（root: A(checked null) > B(child), C(#work checked=false), D(page) */
function fixtureOutData() {
    return {
        version: 1,
        title: 'Fixture',
        pageDir: '.', imageDir: './images', fileDir: './files',
        rootIds: ['nA', 'nC', 'nD'],
        nodes: {
            nA: { id: 'nA', parentId: null, children: ['nB'], text: '親ノード', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null },
            nB: { id: 'nB', parentId: 'nA', children: [], text: '子ノード', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null },
            nC: { id: 'nC', parentId: null, children: [], text: 'タスク #work', tags: ['#work'], isPage: false, pageId: null, collapsed: false, checked: false, subtext: '', images: [], filePath: null },
            nD: { id: 'nD', parentId: null, children: [], text: 'ページノード', tags: [], isPage: true, pageId: 'page-uuid-1', collapsed: false, checked: null, subtext: '', images: [], filePath: null },
        },
    };
}

function mkFixtureNote(name: string): { dir: string; outPath: string } {
    const dir = mkdir(name);
    const outPath = path.join(dir, 'fix.out');
    fs.writeFileSync(outPath, JSON.stringify(fixtureOutData(), null, 2));
    fs.writeFileSync(path.join(dir, 'page-uuid-1.md'), '# ページノード\n\n本文 ![img](images/pic.png)\n');
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNG');
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        version: 1, rootIds: ['fix'], items: { fix: { type: 'file', id: 'fix', title: 'Fixture' } },
    }, null, 2));
    return { dir, outPath };
}

test.describe('A. fractal-modify', () => {
    test('TC-EX-01 set-text: text 置換 + tags 再計算・他フィールド不変', async () => {
        const { applyModify } = await import(modifyMjs);
        const data = fixtureOutData();
        const before = JSON.parse(JSON.stringify(data.nodes.nD));
        applyModify(data, { kind: 'set-text', targetId: 'nA', text: '新テキスト #tag1 @who' });
        expect(data.nodes.nA.text).toBe('新テキスト #tag1 @who');
        expect(data.nodes.nA.tags).toEqual(['#tag1', '@who']);
        // inline code 内タグは除外（parseTags ミラー）
        applyModify(data, { kind: 'set-text', targetId: 'nB', text: 'code `#not-tag` only' });
        expect(data.nodes.nB.tags).toEqual([]);
        // 他フィールド（isPage/pageId/checked 等）不変
        expect(data.nodes.nD).toEqual(before);
        expect(data.nodes.nA.isPage).toBe(false);
    });

    test('TC-EX-02 check/uncheck/clear-check の 3 値遷移', async () => {
        const { applyModify } = await import(modifyMjs);
        const data = fixtureOutData();
        applyModify(data, { kind: 'check', targetId: 'nC' });
        expect(data.nodes.nC.checked).toBe(true);
        applyModify(data, { kind: 'uncheck', targetId: 'nC' });
        expect(data.nodes.nC.checked).toBe(false);
        applyModify(data, { kind: 'clear-check', targetId: 'nC' });
        expect(data.nodes.nC.checked).toBe(null);
    });

    test('TC-EX-03 delete: 子孫ごと構造除去・物理 page md は残る（★安全番人）', async () => {
        const { dir, outPath } = mkFixtureNote('mod-del');
        const { execFileSync } = await import('child_process');
        execFileSync('node', [modifyMjs, '--note', outPath, '--target', 'nD', '--delete'], { encoding: 'utf-8' });
        const after = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        expect(after.nodes.nD).toBeUndefined();
        expect(after.rootIds).not.toContain('nD');
        // ★物理 page md は削除されない
        expect(fs.existsSync(path.join(dir, 'page-uuid-1.md'))).toBe(true);
        // 子孫ごと: nA を消すと nB も消える
        const { applyModify } = await import(modifyMjs);
        const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        const summary = applyModify(data, { kind: 'delete', targetId: 'nA' });
        expect(summary.removedCount).toBe(2);
        expect(data.nodes.nB).toBeUndefined();
    });

    test('TC-EX-04 move: child/after + 子孫への move はエラー（.out 非破壊）', async () => {
        const { applyModify } = await import(modifyMjs);
        const data = fixtureOutData();
        // nC を nA の子（先頭）へ
        applyModify(data, { kind: 'move', targetId: 'nC', moveToId: 'nA', position: 'child' });
        expect(data.nodes.nA.children[0]).toBe('nC');
        expect(data.nodes.nC.parentId).toBe('nA');
        expect(data.rootIds).not.toContain('nC');
        // nB を nD の直後（root 兄弟）へ
        applyModify(data, { kind: 'move', targetId: 'nB', moveToId: 'nD', position: 'after' });
        expect(data.rootIds[data.rootIds.indexOf('nD') + 1]).toBe('nB');
        expect(data.nodes.nB.parentId).toBe(null);
        // counterfactual: 自分の子孫（nA→nC）への移動はエラーで data 不変
        const snapshot = JSON.stringify(data);
        expect(() => applyModify(data, { kind: 'move', targetId: 'nA', moveToId: 'nC', position: 'child' })).toThrow(/descendant/);
        expect(JSON.stringify(data)).toBe(snapshot);
    });

    test('TC-EX-05 target 解決: id / 完全一致 / 部分一致・不在エラー', async () => {
        const { resolveTargetId } = await import(modifyMjs);
        const data = fixtureOutData();
        expect(resolveTargetId(data, 'nB')).toBe('nB');
        expect(resolveTargetId(data, '親ノード')).toBe('nA');
        expect(resolveTargetId(data, 'タスク')).toBe('nC'); // 部分一致
        expect(() => resolveTargetId(data, '存在しない')).toThrow(/not found/);
    });

    test('TC-EX-06 dry-run: .out バイト不変', async () => {
        const { outPath } = mkFixtureNote('mod-dry');
        const before = fs.readFileSync(outPath, 'utf-8');
        const { execFileSync } = await import('child_process');
        const out = execFileSync('node', [modifyMjs, '--note', outPath, '--target', 'nA', '--delete', '--dry-run'], { encoding: 'utf-8' });
        expect(out).toContain('dry-run');
        expect(fs.readFileSync(outPath, 'utf-8')).toBe(before);
    });
});

test.describe('B. fractal-md --create-md', () => {
    test('TC-EX-07 md item 作成 + outline.note 登録（ext:md・rootIds 先頭）', async () => {
        const { createMdItem } = await import(mdMjs);
        const dir = mkdir('create-md');
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: ['x'], items: { x: { type: 'file', id: 'x', title: 'X' } } }));
        const { id, filePath } = createMdItem(dir, '会議メモ');
        expect(fs.readFileSync(filePath, 'utf-8')).toBe('# 会議メモ\n');
        expect(path.dirname(filePath)).toBe(dir); // note 直下フラット
        const s = JSON.parse(fs.readFileSync(path.join(dir, 'outline.note'), 'utf-8'));
        expect(s.items[id]).toEqual({ type: 'file', id, title: '会議メモ', ext: 'md' });
        expect(s.rootIds[0]).toBe(id);
        expect(s.rootIds).toContain('x'); // 既存は保持
    });

    test('TC-EX-08 outline.note 不在でも新規作成して登録', async () => {
        const { createMdItem } = await import(mdMjs);
        const dir = mkdir('create-md-empty');
        const { id } = createMdItem(dir, 'First');
        const s = JSON.parse(fs.readFileSync(path.join(dir, 'outline.note'), 'utf-8'));
        expect(s.version).toBe(1);
        expect(s.rootIds).toEqual([id]);
        expect(s.items[id].ext).toBe('md');
    });

    test('TC-EX-08c --target-md: subpage md 作成 + 末尾リンク追記 + 画像コピー', async () => {
        const { addSubpageToMd, sanitizeSubpageTitle } = await import(mdMjs);
        const dir = mkdir('target-md');
        const targetMd = path.join(dir, 'parent.md');
        fs.writeFileSync(targetMd, '# 親ページ\n\n本文\n');
        // source md（画像参照付き）
        const srcDir = mkdir('target-md-src');
        fs.writeFileSync(path.join(srcDir, 'article.md'), '# 記事 [x]\n\n![p](photo.png)\n');
        fs.writeFileSync(path.join(srcDir, 'photo.png'), 'PNG');

        const r = addSubpageToMd(targetMd, { sourceMdPath: path.join(srcDir, 'article.md') });
        // 新規 md は target と同 dir（相対リンクが dirname(target) 基準で届く）
        expect(path.dirname(r.newMdPath)).toBe(dir);
        // 末尾に [[サニタイズ済みタイトル]](<uuid>.md) が追記される（] は全角化）
        const after = fs.readFileSync(targetMd, 'utf-8');
        expect(after).toContain(`[[記事 ［x］]](${path.basename(r.newMdPath)})`);
        expect(after.startsWith('# 親ページ')).toBe(true); // 既存本文保持
        // 画像は target 隣の images/ にコピーされ相対書換（image_<ts>_<rand>.<ext> にリネーム = 本体規約）
        const newBody = fs.readFileSync(r.newMdPath, 'utf-8');
        const imgMatch = newBody.match(/!\[p\]\(images\/(image_\d+_\w+\.png)\)/);
        expect(imgMatch).toBeTruthy();
        expect(fs.existsSync(path.join(dir, 'images', imgMatch![1]))).toBe(true);
        // --text モード（source なし）: 空 md
        const r2 = addSubpageToMd(targetMd, { text: 'メモ' });
        expect(fs.readFileSync(r2.newMdPath, 'utf-8')).toBe('# メモ\n');
        expect(fs.readFileSync(targetMd, 'utf-8')).toContain(`[[メモ]](${path.basename(r2.newMdPath)})`);
        // sanitize 単体（本体パーサ制約: ラベル内 ] 不可）
        expect(sanitizeSubpageTitle('A]B[C\nD')).toBe('A］B［C D');
        expect(sanitizeSubpageTitle('  ')).toBe('(untitled)');
    });

    test('TC-EX-08d attach --target-md: 画像/ファイルを md 隣にコピーして末尾リンク追記', async () => {
        const { attachToMd } = await import(attachMjs);
        const dir = mkdir('attach-md');
        const targetMd = path.join(dir, 'doc.md');
        fs.writeFileSync(targetMd, '# ドキュメント\n\n本文\n');
        const srcDir = mkdir('attach-md-src');
        fs.writeFileSync(path.join(srcDir, 'shot.png'), 'PNG');
        fs.writeFileSync(path.join(srcDir, 'report.pdf'), 'PDF');

        // 画像: images/ に image_<ts>_<rand> リネームコピー + ![](images/...) 追記
        const ri = attachToMd(targetMd, [path.join(srcDir, 'shot.png')], 'image');
        expect(ri.copied[0]).toMatch(/^images\/image_\d+_\w+\.png$/);
        expect(fs.existsSync(path.join(dir, ri.copied[0]))).toBe(true);
        let body = fs.readFileSync(targetMd, 'utf-8');
        expect(body.startsWith('# ドキュメント')).toBe(true); // 既存本文保持
        expect(body).toContain(`![](${ri.copied[0]})`);

        // ファイル: files/ に元名コピー + [name](files/name) 追記。衝突時 -1
        const rf = attachToMd(targetMd, [path.join(srcDir, 'report.pdf')], 'file');
        expect(rf.copied[0]).toBe('files/report.pdf');
        expect(fs.readFileSync(targetMd, 'utf-8')).toContain('[report.pdf](files/report.pdf)');
        const rf2 = attachToMd(targetMd, [path.join(srcDir, 'report.pdf')], 'file');
        expect(rf2.copied[0]).toBe('files/report-1.pdf'); // 衝突 suffix = 本体規約
        // 不在 target はエラー
        expect(() => attachToMd(path.join(dir, 'nope.md'), [path.join(srcDir, 'shot.png')], 'image')).toThrow(/not found/);
    });

    test('TC-EX-08b --create-outliner がフラットヒント付き .out を作る（legacy サブフォルダを作らない）', async () => {
        const dir = mkdir('create-out-flat');
        const { execFileSync } = await import('child_process');
        execFileSync('node', [mdMjs, '--create-outliner', 'Flat New', '--notes-dir', dir], { encoding: 'utf-8' });
        const outFile = fs.readdirSync(dir).find((f) => f.endsWith('.out'))!;
        expect(outFile).toBeTruthy();
        const data = JSON.parse(fs.readFileSync(path.join(dir, outFile), 'utf-8'));
        // 正典 FLAT_OUT_HINTS（flat-layout.ts:155）と一致
        expect(data.pageDir).toBe('.');
        expect(data.imageDir).toBe('./images');
        expect(data.fileDir).toBe('./files');
        // counterfactual: 旧実装は <id>/ サブフォルダを mkdir していた
        const id = outFile.replace(/\.out$/, '');
        expect(fs.existsSync(path.join(dir, id))).toBe(false);
        // outline.note 登録
        const s = JSON.parse(fs.readFileSync(path.join(dir, 'outline.note'), 'utf-8'));
        expect(s.items[id].title).toBe('Flat New');
    });
});

test.describe('C. fractal-doctor', () => {
    test('TC-EX-09 broken refs: images/filePath/pageId の実体不在 = ERROR', async () => {
        const { runDoctor } = await import(doctorMjs);
        const { dir, outPath } = mkFixtureNote('doc-refs');
        // クリーン状態では refs ERROR なし
        const clean = runDoctor(dir).filter((f: any) => f.check === 'refs' && f.level === 'ERROR');
        expect(clean).toEqual([]);
        // 壊す: 参照だけ足して実体は置かない
        const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        data.nodes.nA.images = ['images/missing.png'];
        data.nodes.nB.filePath = 'files/missing.pdf';
        data.nodes.nB.images = [];
        data.nodes.nC.pageId = 'no-such-page'; data.nodes.nC.isPage = true;
        fs.writeFileSync(outPath, JSON.stringify(data));
        const errs = runDoctor(dir).filter((f: any) => f.check === 'refs' && f.level === 'ERROR');
        expect(errs.length).toBe(3);
        expect(errs.map((e: any) => e.message).join('\n')).toMatch(/missing\.png/);
        expect(errs.map((e: any) => e.message).join('\n')).toMatch(/missing\.pdf/);
        expect(errs.map((e: any) => e.message).join('\n')).toMatch(/no-such-page\.md/);
    });

    test('TC-EX-10 orphan: 未参照 asset は INFO・参照されると消える（counterfactual）', async () => {
        const { runDoctor } = await import(doctorMjs);
        const { dir } = mkFixtureNote('doc-orphan');
        fs.writeFileSync(path.join(dir, 'images', 'unused.png'), 'PNG');
        const orphans = runDoctor(dir).filter((f: any) => f.check === 'orphans');
        expect(orphans.some((f: any) => f.message.includes('unused.png'))).toBe(true);
        // pic.png は page md 本文から参照済み → orphan でない
        expect(orphans.some((f: any) => f.message.includes('pic.png'))).toBe(false);
    });

    test('TC-EX-11 structure: 実体不在 ERROR / 未登録 WARN / childIds 宙ぶらりん ERROR', async () => {
        const { runDoctor } = await import(doctorMjs);
        const { dir } = mkFixtureNote('doc-struct');
        // outline.note に実体のない item + 宙ぶらりん childIds、未登録 .out
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
            version: 1, rootIds: ['fix', 'ghost', 'fol'],
            items: {
                fix: { type: 'file', id: 'fix', title: 'Fixture' },
                ghost: { type: 'file', id: 'ghost', title: 'Ghost' },              // ghost.out 不在 = ERROR
                gmd: { type: 'file', id: 'gmd', title: 'GhostMd', ext: 'md' },     // gmd.md 不在 = ERROR
                fol: { type: 'folder', id: 'fol', title: 'F', childIds: ['nope'], collapsed: false }, // 宙ぶらりん = ERROR
            },
        }));
        fs.writeFileSync(path.join(dir, 'stray.out'), JSON.stringify({ version: 1, rootIds: [], nodes: {} })); // 未登録 = WARN
        const fs2 = runDoctor(dir).filter((f: any) => f.check === 'structure');
        expect(fs2.filter((f: any) => f.level === 'ERROR').length).toBe(3);
        expect(fs2.some((f: any) => f.level === 'WARN' && f.message.includes('stray.out'))).toBe(true);
    });

    test('TC-EX-12 layout: ヒントなし + legacy dir = WARN / FLAT_OUT_HINTS 付きは出ない', async () => {
        const { runDoctor } = await import(doctorMjs);
        // フラットヒント付き → layout WARN なし
        const { dir } = mkFixtureNote('doc-flat');
        expect(runDoctor(dir).filter((f: any) => f.check === 'layout' && f.level === 'WARN')).toEqual([]);
        // ヒントなし + legacy stem dir → WARN（未移行）
        const legacy = mkdir('doc-legacy');
        fs.writeFileSync(path.join(legacy, 'old.out'), JSON.stringify({ version: 1, rootIds: [], nodes: {} })); // pageDir なし
        fs.mkdirSync(path.join(legacy, 'old'), { recursive: true });
        fs.writeFileSync(path.join(legacy, 'outline.note'), JSON.stringify({ version: 1, rootIds: ['old'], items: { old: { type: 'file', id: 'old', title: 'Old' } } }));
        const warns = runDoctor(legacy).filter((f: any) => f.check === 'layout' && f.level === 'WARN');
        expect(warns.length).toBe(1);
        expect(warns[0].message).toMatch(/未移行/);
    });

    test('TC-EX-13 read-only（書込 API 0 grep）+ exit code 対応', async () => {
        const src = fs.readFileSync(doctorMjs, 'utf-8');
        // FR-DOC-06: 書込/削除/mkdir API を一切含まない（静的ゲート）
        expect(src).not.toMatch(/writeFileSync|appendFileSync|createWriteStream|rmSync|unlinkSync|rmdirSync|mkdirSync|renameSync|copyFileSync/);
        const { exitCodeFor } = await import(doctorMjs);
        expect(exitCodeFor([])).toBe(0);
        expect(exitCodeFor([{ level: 'INFO' }])).toBe(0);
        expect(exitCodeFor([{ level: 'WARN' }])).toBe(1);
        expect(exitCodeFor([{ level: 'WARN' }, { level: 'ERROR' }])).toBe(2);
    });

    test('TC-EX-13b ownership: 同一 asset を複数 node が参照 = WARN', async () => {
        const { runDoctor } = await import(doctorMjs);
        const { dir, outPath } = mkFixtureNote('doc-own');
        const data = JSON.parse(fs.readFileSync(outPath, 'utf-8'));
        data.nodes.nA.images = ['images/pic.png'];
        data.nodes.nB.images = ['images/pic.png']; // 共有 = 1:1 違反
        fs.writeFileSync(outPath, JSON.stringify(data));
        const owns = runDoctor(dir).filter((f: any) => f.check === 'ownership');
        expect(owns.length).toBe(1);
        expect(owns[0].message).toContain('pic.png');
    });
});

test.describe('D. fractal-summary', () => {
    test('TC-EX-14 階層→ネスト箇条書き + checked → [x]/[ ]', async () => {
        const { summarizeOutline } = await import(summaryMjs);
        const { dir } = mkFixtureNote('sum-tree');
        const data = fixtureOutData();
        data.nodes.nB.checked = true;
        const md = summarizeOutline(dir, data, {});
        expect(md).toContain('# Fixture');
        expect(md).toContain('- 親ノード');
        expect(md).toContain('  - [x] 子ノード');     // 2sp インデント + checked
        expect(md).toContain('- [ ] タスク #work');
    });

    test('TC-EX-15 Pages セクション + --node 部分木', async () => {
        const { summarizeOutline } = await import(summaryMjs);
        const { dir } = mkFixtureNote('sum-pages');
        const data = fixtureOutData();
        const md = summarizeOutline(dir, data, {});
        expect(md).toContain('## Pages');
        expect(md).toContain('### ページノード');
        expect(md).toContain('本文'); // page md 本文 inline
        // 部分木: nA 配下のみ → nD の page は含まれない
        const sub = summarizeOutline(dir, data, { rootNodeId: 'nA' });
        expect(sub).toContain('- 親ノード');
        expect(sub).not.toContain('## Pages');
        expect(sub).not.toContain('タスク #work');
    });

    test('TC-EX-16 相対パス絶対化（URL 不変）', async () => {
        const { summarizeOutline, absolutizeLocalPaths } = await import(summaryMjs);
        const { dir } = mkFixtureNote('sum-abs');
        const md = summarizeOutline(dir, fixtureOutData(), {});
        expect(md).toContain(`![img](${path.join(dir, 'images', 'pic.png')})`); // 絶対化
        expect(md).not.toContain('![img](images/pic.png)');
        // pure 関数: URL / anchor / 絶対は不変
        const body = '![a](https://x.com/i.png) [b](#sec) [c](/abs/p.md) ![d](images/rel.png)';
        const out = absolutizeLocalPaths(body, '/base');
        expect(out).toContain('(https://x.com/i.png)');
        expect(out).toContain('(#sec)');
        expect(out).toContain('(/abs/p.md)');
        expect(out).toContain(`(${path.resolve('/base', 'images/rel.png')})`);
    });

    test('TC-EX-16b md モード: subpage 再帰 + 循環打ち切り + 欠落注記', async () => {
        const { summarizeMd, extractSubpageLinks } = await import(summaryMjs);
        const dir = mkdir('sum-md');
        // root → sub1 → sub2、sub2 → root（循環）、root → ghost（欠落）
        fs.writeFileSync(path.join(dir, 'root.md'), '# ルート\n\n[[サブ1]](sub1.md)\n[[幽霊]](ghost.md)\n');
        fs.writeFileSync(path.join(dir, 'sub1.md'), '# サブ1\n\nサブ1本文 ![i](images/s1.png)\n\n[[サブ2]](sub2.md)\n');
        fs.writeFileSync(path.join(dir, 'sub2.md'), '# サブ2\n\n[[戻る]](root.md)\n');
        fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'images', 's1.png'), 'PNG');

        const md = summarizeMd(path.join(dir, 'root.md'));
        expect(md).toContain('# ルート');
        expect(md).toContain('## Subpages');
        expect(md).toContain('### サブ1');
        expect(md).toContain('### サブ2');       // 再帰で 2 階層目も展開
        expect(md).toContain('サブ1本文');
        // 循環: root は visited 済みなので Subpages に再展開されない（### 戻る が無い）
        expect(md).not.toContain('### 戻る');
        // 欠落 subpage は注記
        expect(md).toContain('*(subpage md not found');
        // subpage 本文の相対画像も絶対化
        expect(md).toContain(`![i](${path.join(dir, 'images', 's1.png')})`);
        // extractSubpageLinks: URL / anchor / 非 md は対象外
        expect(extractSubpageLinks('[[a]](x.md) [[b]](https://x.com/y.md) [[c]](#sec) [[d]](files/doc.pdf)'))
            .toEqual([{ label: 'a', url: 'x.md' }]);
    });
});

test.describe('E. fractal-search --tag/--checked', () => {
    test('TC-EX-17 --tag: parseTags ミラー + プレフィックス省略 + 複数 OR', async () => {
        const { parseTagsFromText, matchesTagFilter } = await import(searchMjs);
        expect(parseTagsFromText('タスク #work @alice')).toEqual(['#work', '@alice']);
        expect(parseTagsFromText('code `#nope` https://x.com/@user')).toEqual([]); // inline code / URL 除外
        expect(matchesTagFilter(['#work'], ['work'])).toBe(true);       // プレフィックス省略
        expect(matchesTagFilter(['@alice'], ['alice'])).toBe(true);
        expect(matchesTagFilter(['#work'], ['#work'])).toBe(true);
        expect(matchesTagFilter(['#work'], ['home', 'work'])).toBe(true); // OR
        expect(matchesTagFilter(['#work'], ['home'])).toBe(false);
        expect(matchesTagFilter([], [])).toBe(true);                     // フィルタなし = 素通し
    });

    test('TC-EX-18 --checked: true/false/none/any', async () => {
        const { matchesCheckedFilter } = await import(searchMjs);
        expect(matchesCheckedFilter(true, 'true')).toBe(true);
        expect(matchesCheckedFilter(false, 'true')).toBe(false);
        expect(matchesCheckedFilter(false, 'false')).toBe(true);
        expect(matchesCheckedFilter(null, 'none')).toBe(true);
        expect(matchesCheckedFilter(true, 'none')).toBe(false);
        expect(matchesCheckedFilter(true, 'any')).toBe(true);
        expect(matchesCheckedFilter(false, 'any')).toBe(true);
        expect(matchesCheckedFilter(null, 'any')).toBe(false);
        expect(matchesCheckedFilter(null, null)).toBe(true); // フィルタなし
    });

    test('TC-EX-19b --note-name/--exclude-note: noteTitle/フォルダ名で対象 note を絞る', async () => {
        const { filterFoldersByNoteName, matchesNoteName, resolveNoteLabelFromDisk } = await import(searchMjs);
        // noteTitle 付き note と、outline.note 無し（フォルダ名 fallback）の note
        const workDir = mkdir('nn-work');
        fs.writeFileSync(path.join(workDir, 'outline.note'), JSON.stringify({ version: 1, rootIds: [], items: {}, noteTitle: '仕事ノート' }));
        const plainDir = mkdir('nn-plain-inbox');
        expect(resolveNoteLabelFromDisk(workDir)).toBe('仕事ノート');
        expect(resolveNoteLabelFromDisk(plainDir)).toBe(path.basename(plainDir));

        const entries = [{ path: workDir, sources: [] }, { path: plainDir, sources: [] }];
        // include: noteTitle 部分一致（大小無視）
        expect(filterFoldersByNoteName(entries, ['仕事'], []).map((e: any) => e.path)).toEqual([workDir]);
        // include: フォルダ名でも当たる
        expect(filterFoldersByNoteName(entries, ['nn-plain'], []).map((e: any) => e.path)).toEqual([plainDir]);
        // exclude が include より優先
        expect(filterFoldersByNoteName(entries, ['仕事'], ['仕事'])).toEqual([]);
        // exclude のみ
        expect(filterFoldersByNoteName(entries, [], ['仕事']).map((e: any) => e.path)).toEqual([plainDir]);
        // フィルタなし = 全通し
        expect(filterFoldersByNoteName(entries, [], []).length).toBe(2);
        expect(matchesNoteName('My Note', 'folder', ['note'])).toBe(true); // 大小無視

        // CLI 統合: --folder 2 つ + --note-name で片方だけ検索される
        const { execFileSync } = await import('child_process');
        fs.writeFileSync(path.join(workDir, 'a.out'), JSON.stringify({ version: 1, title: 'A', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: '共通語', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null } } }));
        fs.writeFileSync(path.join(plainDir, 'b.out'), JSON.stringify({ version: 1, title: 'B', rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: '共通語', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null } } }));
        const out = execFileSync('node', [searchMjs, '--query', '共通語', '--folder', workDir, '--folder', plainDir, '--note-name', '仕事', '--no-cache', '--json'], { encoding: 'utf-8' });
        const j = JSON.parse(out);
        expect(j.folders).toEqual([workDir]); // plainDir は除外
        expect(j.results.length).toBe(1);
    });

    test('TC-EX-19 CLI 統合: --tag のみで列挙 / --query と AND / CACHE_VERSION=6', async () => {
        const { dir } = mkFixtureNote('search-filter');
        const { execFileSync } = await import('child_process');
        // --tag のみ（--query なし）で列挙できる（FR-SRF-03。--no-cache で独立実行）
        const out = execFileSync('node', [searchMjs, '--tag', 'work', '--folder', dir, '--no-cache', '--json'], { encoding: 'utf-8' });
        const j = JSON.parse(out);
        const nodeHits = j.results.filter((r: any) => r.kind === 'outline-node');
        expect(nodeHits.length).toBe(1);
        expect(nodeHits[0].nodeText).toBe('タスク #work');
        expect(nodeHits[0].checked).toBe(false);
        // --query と AND: query にマッチしないので 0 件
        const out2 = execFileSync('node', [searchMjs, '--query', '存在しない語', '--tag', 'work', '--folder', dir, '--no-cache', '--json'], { encoding: 'utf-8' });
        expect(JSON.parse(out2).results.filter((r: any) => r.kind === 'outline-node')).toEqual([]);
        // --checked false のみ
        const out3 = execFileSync('node', [searchMjs, '--checked', 'false', '--folder', dir, '--no-cache', '--json'], { encoding: 'utf-8' });
        expect(JSON.parse(out3).results.filter((r: any) => r.kind === 'outline-node').length).toBe(1);
        // CACHE_VERSION bump（ソース grep）
        expect(fs.readFileSync(searchMjs, 'utf-8')).toMatch(/CACHE_VERSION = 6/);
    });
});

test.describe('F. 配線', () => {
    test('TC-EX-20 install.sh SKILLS + SKILL.md 実在', async () => {
        const installSh = fs.readFileSync(path.resolve(__dirname, '../../ai_skills/install.sh'), 'utf-8');
        const skillsLine = installSh.match(/^SKILLS="([^"]+)"/m);
        expect(skillsLine).toBeTruthy();
        expect(skillsLine![1]).toContain('fractal-doctor');
        expect(skillsLine![1]).toContain('fractal-summary');
        expect(fs.existsSync(path.resolve(__dirname, '../../ai_skills/fractal-doctor/SKILL.md'))).toBe(true);
        expect(fs.existsSync(path.resolve(__dirname, '../../ai_skills/fractal-summary/SKILL.md'))).toBe(true);
    });
});
