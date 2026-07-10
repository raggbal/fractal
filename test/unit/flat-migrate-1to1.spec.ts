/**
 * flat-migrate-1to1 TASK-01 — owner 駆動の 1:1 rename+参照書換 migration
 *
 * ADRL-0001: content-dedup 一切なし。owner（page md / 添付 node）ごとに asset を物理コピーし、
 *   各 owner の参照を自分専用コピーへ書換える。同名衝突は unique 連番名で回避（shasum 集約しない）。
 *
 * TC-M-01 load-bearing: cross-owner 同名・別実体 → 別コピー・別名で潰れない
 * TC-M-02 load-bearing: cross-owner 同名・中身同一でも別コピー（content-dedup しない）
 * TC-M-03           : node.filePath 参照の書換（別 owner 別実体 → 別名）
 * TC-M-04 load-bearing: page md 本文リンクの書換（uniquify で名前が変わった時）
 * TC-M-05           : 後方互換（衝突なし Note は本文書換せず basename 維持）
 * TC-M-06           : .md 名ディレクトリ残骸 + _notes_md 二重
 * TC-M-07 load-bearing: ロールバック（途中失敗で旧状態復元）
 * TC-M-08           : 同一 owner が同一 source を複数参照 → 1 コピー集約（1:1 OK）
 * TC-M-09 load-bearing: drawio 本文画像は files/ に保存 + 本文リンクも files/ に書換
 * TC-M-10 load-bearing: 同一 md が別 dir 同名画像 2 枚を参照 → 各々別コピー・各々別リンク書換
 * TC-M-11 load-bearing: rename と copy 混在プランの途中失敗ロールバック
 * TC-M-12 load-bearing: 1 つの .out 内の 2 node が同一 oldRef（同一物理 asset）を node.images 参照
 *                       → 各 node が別 dst に 1:1 書換わり orphan 0（per-node 化前は両者同一 dst で片方孤児化）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { planMigration, validatePlan, executePlan, summarizePlan } from '../../src/shared/flat-migrate';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flat-mig1to1-'));
}
function rm(dir: string): void {
    fs.rmSync(dir, { recursive: true, force: true });
}
function read(p: string): string {
    return fs.readFileSync(p, 'utf8');
}

/**
 * 旧 per-outliner .out を 1 つ作る。
 * <note>/<stem>.out（pageDir 未指定 = legacy）+ <note>/<stem>/<pid>.md（body 指定）
 *   + <note>/<stem>/images/* + <note>/<stem>/files/*
 * assets: [{ sub:'images'|'files', name, content }] を該当 dir に書く。
 * node は pageId のみ（body 参照で asset を持つ owner）。
 */
function makeOut(note: string, stem: string, opts: {
    pid: string; body: string;
    assets: { sub: 'images' | 'files'; name: string; content: string }[];
    node?: Record<string, unknown>;
}): void {
    const pdir = path.join(note, stem);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, `${opts.pid}.md`), opts.body);
    for (const a of opts.assets) {
        const d = path.join(pdir, a.sub);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, a.name), a.content);
    }
    const node: Record<string, unknown> = { id: 'n1', text: opts.pid, childIds: [], isPage: true, pageId: opts.pid, ...(opts.node || {}) };
    fs.writeFileSync(path.join(note, `${stem}.out`), JSON.stringify({
        title: stem, rootIds: ['n1'], nodes: { n1: node },
    }, null, 2));
}

// ────────────────────────────────────────────────────────────────────────────

test('TC-M-01 cross-owner 同名・別実体 → 別コピー・別名（load-bearing）', () => {
    const note = mkTmp();
    // outA / outB それぞれ page md 本文が images/pic.png を参照。実体は別（'A' / 'B'）。
    makeOut(note, 'outA', { pid: 'pA', body: '# A\n![](images/pic.png)', assets: [{ sub: 'images', name: 'pic.png', content: 'A' }] });
    makeOut(note, 'outB', { pid: 'pB', body: '# B\n![](images/pic.png)', assets: [{ sub: 'images', name: 'pic.png', content: 'B' }] });

    const plan = planMigration(note);
    const v = validatePlan(plan);
    expect(v.ok).toBe(true);
    const res = executePlan(plan);
    expect(res.rolledBack).toBe(false);

    // 共有 images/ に 2 物理ファイル（別名で潰れていない）
    const imgs = fs.readdirSync(path.join(note, 'images')).sort();
    expect(imgs.length).toBe(2);
    // 中身が 'A' と 'B' 両方残る（片方消失していない）
    const contents = imgs.map(f => read(path.join(note, 'images', f))).sort();
    expect(contents).toEqual(['A', 'B']);

    // 各 owner の本文リンクが自分専用ファイルを指し、path.resolve で実在
    const bodyA = read(path.join(note, 'pA.md'));
    const bodyB = read(path.join(note, 'pB.md'));
    const linkOf = (b: string) => (b.match(/!\[\]\(([^)]+)\)/) || [])[1];
    const refA = linkOf(bodyA)!;
    const refB = linkOf(bodyB)!;
    expect(fs.existsSync(path.resolve(note, refA))).toBe(true);
    expect(fs.existsSync(path.resolve(note, refB))).toBe(true);
    // A の本文リンクは 'A' を、B のは 'B' を指す
    expect(read(path.resolve(note, refA))).toBe('A');
    expect(read(path.resolve(note, refB))).toBe('B');
    // 絶対パスを本文に含めない
    expect(bodyA).not.toContain(note);
    expect(bodyB).not.toContain(note);
    // 2 owner が別ファイルを指す（畳み込まれていない）
    expect(refA).not.toBe(refB);

    // counterfactual: basename 畳み込み（旧 rewriteAssetRef `images/pic.png` 固定）なら
    //   両 owner が images/pic.png を共有 → 1 物理ファイルに畳まれ 'B' が 'A' を上書き（or 逆）で片方消失。
    //   ここでは 2 物理ファイル + contents=['A','B'] が pre-fix では成立しない（RED）。
    rm(note);
});

test('TC-M-02 cross-owner 同名・中身同一でも別コピー＝content-dedup しない（load-bearing）', () => {
    const note = mkTmp();
    // outA / outB の images/same.png が中身同一（shasum 一致）
    makeOut(note, 'outA', { pid: 'pA', body: '# A\n![](images/same.png)', assets: [{ sub: 'images', name: 'same.png', content: 'IDENTICAL' }] });
    makeOut(note, 'outB', { pid: 'pB', body: '# B\n![](images/same.png)', assets: [{ sub: 'images', name: 'same.png', content: 'IDENTICAL' }] });

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    executePlan(plan);

    // 中身同一でも 2 物理ファイル（dedup していない）
    const imgs = fs.readdirSync(path.join(note, 'images'));
    expect(imgs.length).toBe(2);
    // 各 owner の本文が別ファイルを指す
    const linkOf = (b: string) => (b.match(/!\[\]\(([^)]+)\)/) || [])[1];
    const refA = linkOf(read(path.join(note, 'pA.md')))!;
    const refB = linkOf(read(path.join(note, 'pB.md')))!;
    expect(refA).not.toBe(refB);
    expect(fs.existsSync(path.resolve(note, refA))).toBe(true);
    expect(fs.existsSync(path.resolve(note, refB))).toBe(true);

    // counterfactual: shasum 集約（dedup）実装なら 1 ファイル → imgs.length===1 で RED。
    rm(note);
});

test('TC-M-03 node.filePath 参照の書換（別 owner 別実体 → 別名）', () => {
    const note = mkTmp();
    // 添付 node（filePath）を持つ .out 2 つ。body は asset 参照なし（filePath owner）。
    makeOut(note, 'outA', {
        pid: 'pA', body: '# A', assets: [{ sub: 'files', name: 'doc.pdf', content: 'DOCA' }],
        node: { filePath: 'outA/files/doc.pdf' },
    });
    makeOut(note, 'outB', {
        pid: 'pB', body: '# B', assets: [{ sub: 'files', name: 'doc.pdf', content: 'DOCB' }],
        node: { filePath: 'outB/files/doc.pdf' },
    });

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    executePlan(plan);

    const dataA = JSON.parse(read(path.join(note, 'outA.out')));
    const dataB = JSON.parse(read(path.join(note, 'outB.out')));
    const fpA = dataA.nodes.n1.filePath as string;
    const fpB = dataB.nodes.n1.filePath as string;
    expect(fpA.startsWith('files/')).toBe(true);
    expect(fpB.startsWith('files/')).toBe(true);
    // 別名（共有していない）
    expect(fpA).not.toBe(fpB);
    // それぞれ実在 + 別実体
    expect(fs.existsSync(path.resolve(note, fpA))).toBe(true);
    expect(fs.existsSync(path.resolve(note, fpB))).toBe(true);
    expect(read(path.resolve(note, fpA))).toBe('DOCA');
    expect(read(path.resolve(note, fpB))).toBe('DOCB');
    // files/ に 2 物理ファイル
    expect(fs.readdirSync(path.join(note, 'files')).length).toBe(2);

    // counterfactual: rewriteAssetRef 畳み込みだと両者 files/doc.pdf 共有 → fpA===fpB / 1 ファイル。
    rm(note);
});

test('TC-M-04 page md 本文リンクの書換（uniquify で名前が変わった時・load-bearing）', () => {
    const note = mkTmp();
    // 衝突で 2 番目の owner が pic.png → pic-1.png にリネームされる。
    // 部分文字列誤置換を検出するため picture.png も同じ body に含める。
    makeOut(note, 'outA', { pid: 'pA', body: '# A\n![](images/pic.png)', assets: [{ sub: 'images', name: 'pic.png', content: 'A' }] });
    makeOut(note, 'outB', {
        pid: 'pB', body: '# B\n![x](images/pic.png)\n![y](images/picture.png)',
        assets: [{ sub: 'images', name: 'pic.png', content: 'B' }, { sub: 'images', name: 'picture.png', content: 'PICTURE' }],
    });

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    executePlan(plan);

    const bodyB = read(path.join(note, 'pB.md'));
    // pic.png が衝突で連番退避（pic-1.png 等）に書換わり、リンク先実在
    const links = [...bodyB.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(links.length).toBe(2);
    const [picLink, pictureLink] = links;
    // pic の方は uniquify で pic.png 以外（衝突退避）になっている
    expect(picLink).not.toBe('images/pic.png');
    expect(fs.existsSync(path.resolve(note, picLink))).toBe(true);
    expect(read(path.resolve(note, picLink))).toBe('B');
    // picture.png は衝突しないので whole-link 書換で巻き込まれず、そのまま解決
    expect(pictureLink).toBe('images/picture.png');
    expect(read(path.resolve(note, pictureLink))).toBe('PICTURE');
    // outA の本文は衝突しないので basename 維持（後方互換）
    expect(read(path.join(note, 'pA.md'))).toContain('![](images/pic.png)');

    // counterfactual: uniquify 新名を本文へ反映しない（旧 basename 畳み込み or 本文書換なし）と
    //   pB 本文が images/pic.png のまま → 'A' 側 or 存在しない位置を指し read が 'B' にならず RED。
    //   部分文字列誤置換だと picture.png が pic-1cture.png 等に壊れる → pictureLink 検証で RED。
    rm(note);
});

test('TC-M-05 後方互換: 衝突なし Note は本文書換せず basename 維持', () => {
    const note = mkTmp();
    makeOut(note, 'work', {
        pid: 'wp', body: '# wp\n![](./images/img.png)\n[📎](./files/doc.pdf)',
        assets: [{ sub: 'images', name: 'img.png', content: 'IMG' }, { sub: 'files', name: 'doc.pdf', content: 'DOC' }],
        node: { images: ['work/images/img.png'], filePath: 'work/files/doc.pdf' },
    });

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    const res = executePlan(plan);
    expect(res.rolledBack).toBe(false);

    // asset は basename のまま共有 dir へ（連番付かない）
    expect(fs.existsSync(path.join(note, 'images', 'img.png'))).toBe(true);
    expect(fs.existsSync(path.join(note, 'files', 'doc.pdf'))).toBe(true);
    expect(fs.readdirSync(path.join(note, 'images'))).toEqual(['img.png']);
    expect(fs.readdirSync(path.join(note, 'files'))).toEqual(['doc.pdf']);
    // 本文リンク不変（./images/ のまま = 書換なし）
    const body = read(path.join(note, 'wp.md'));
    expect(body).toContain('![](./images/img.png)');
    expect(body).toContain('[📎](./files/doc.pdf)');
    // .out ヘッダ pageDir='.' 等、node 参照は共有 dir 相対
    const data = JSON.parse(read(path.join(note, 'work.out')));
    expect(data.pageDir).toBe('.');
    expect(data.imageDir).toBe('./images');
    expect(data.fileDir).toBe('./files');
    expect(data.nodes.n1.images).toEqual(['images/img.png']);
    expect(data.nodes.n1.filePath).toBe('files/doc.pdf');
    // load-bearing: 直下 md → ./images/ が共有解決
    expect(fs.existsSync(path.resolve(note, './images/img.png'))).toBe(true);
    // 同一 src（body ./images/img.png と node.images work/images/img.png）は 1 コピー（重複していない）
    expect(fs.readdirSync(path.join(note, 'images')).length).toBe(1);
    rm(note);
});

test('TC-M-06 .md 名ディレクトリ残骸 + _notes_md 二重', () => {
    const note = mkTmp();
    const pid = 'pdiag';
    // stray .md dir: <note>/<pid>.md/ （中に files/diagram.drawio.svg）
    const strayDir = path.join(note, `${pid}.md`);
    fs.mkdirSync(path.join(strayDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(strayDir, 'files', 'diagram.drawio.svg'), 'DRAWIO');
    // _notes_md/<pid>.md （ファイル実体、本文は asset 参照なし）
    fs.mkdirSync(path.join(note, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(note, '_notes_md', `${pid}.md`), '# notes body');

    const plan = planMigration(note);
    const v = validatePlan(plan);
    // pre-existing target（stray dir）で abort しない
    expect(v.ok).toBe(true);
    const res = executePlan(plan);
    expect(res.rolledBack).toBe(false);

    // stray dir 内の drawio が files/ へ 1:1 救出される
    expect(fs.existsSync(path.join(note, 'files', 'diagram.drawio.svg'))).toBe(true);
    expect(read(path.join(note, 'files', 'diagram.drawio.svg'))).toBe('DRAWIO');
    // 空になった stray dir が削除される
    expect(fs.existsSync(strayDir)).toBe(false);
    // _notes_md の実体からフラット md が作られる（stray dir と同名 pid なので uniqMd 採番で <pid>-1.md）
    const flatMds = fs.readdirSync(note).filter(f => f.endsWith('.md') && fs.statSync(path.join(note, f)).isFile());
    expect(flatMds.length).toBe(1);
    expect(read(path.join(note, flatMds[0]))).toBe('# notes body');
    rm(note);
});

test('TC-M-07 ロールバック — 途中失敗で旧状態復元（load-bearing）', () => {
    const note = mkTmp();
    // cross-owner 衝突 → 少なくとも 1 つは copy or rename が走る + 本文書換のある Note
    makeOut(note, 'outA', { pid: 'pA', body: '# A\n![](images/pic.png)', assets: [{ sub: 'images', name: 'pic.png', content: 'A' }] });
    makeOut(note, 'outB', { pid: 'pB', body: '# B\n![](images/pic.png)', assets: [{ sub: 'images', name: 'pic.png', content: 'B' }] });

    // 旧レイアウト snapshot
    const snap = {
        aOut: read(path.join(note, 'outA.out')),
        bOut: read(path.join(note, 'outB.out')),
        aMd: read(path.join(note, 'outA', 'pA.md')),
        bMd: read(path.join(note, 'outB', 'pB.md')),
        aImg: read(path.join(note, 'outA', 'images', 'pic.png')),
        bImg: read(path.join(note, 'outB', 'images', 'pic.png')),
    };

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    // 全 move 完了後、.out 書換ループの途中で失敗させる（asset/md は移動済み、rewrite で throw）
    const res = executePlan(plan, { injectFailOnRewrite: 0 });
    expect(res.rolledBack).toBe(true);

    // 旧レイアウトが byte 一致で復元（move 戻し + .out/md snapshot 復元）
    expect(fs.existsSync(path.join(note, 'outA', 'pA.md'))).toBe(true);
    expect(read(path.join(note, 'outA', 'pA.md'))).toBe(snap.aMd);
    expect(read(path.join(note, 'outB', 'pB.md'))).toBe(snap.bMd);
    expect(read(path.join(note, 'outA', 'images', 'pic.png'))).toBe(snap.aImg);
    expect(read(path.join(note, 'outB', 'images', 'pic.png'))).toBe(snap.bImg);
    // .out ヘッダは legacy のまま（flat に書き換わって取り残されていない）
    expect(read(path.join(note, 'outA.out'))).toBe(snap.aOut);
    expect(read(path.join(note, 'outB.out'))).toBe(snap.bOut);
    // dst 共有 dir に残骸なし（copy した dst が削除されている）
    const flatImgDir = path.join(note, 'images');
    const leftover = fs.existsSync(flatImgDir) ? fs.readdirSync(flatImgDir) : [];
    expect(leftover.length).toBe(0);

    // counterfactual: rollback が copy を消し忘れると flatImgDir に残骸 → leftover.length>0 で RED。
    //   .out snapshot を戻さないと pageDir='.' が残り aOut 不一致で RED。
    rm(note);
});

test('TC-M-08 同一 owner が同一 source を複数参照 → 1 コピー集約（1:1 OK）', () => {
    const note = mkTmp();
    // 1 page md 本文が同じ images/logo.png を 2 回参照
    makeOut(note, 'work', {
        pid: 'wp', body: '# wp\n![a](images/logo.png)\n![b](images/logo.png)',
        assets: [{ sub: 'images', name: 'logo.png', content: 'LOGO' }],
    });

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    executePlan(plan);

    // dst に 1 コピーだけ（owner 内 dedup）
    expect(fs.readdirSync(path.join(note, 'images')).length).toBe(1);
    // 両参照が同じ dst を指す
    const body = read(path.join(note, 'wp.md'));
    const links = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(links.length).toBe(2);
    expect(links[0]).toBe(links[1]);
    expect(fs.existsSync(path.resolve(note, links[0]))).toBe(true);
    rm(note);
});

test('TC-M-09 drawio 本文画像は files/ に保存 + 本文リンクも files/ に書換（load-bearing）', () => {
    const note = mkTmp();
    // outA / outB の本文が ![](images/diagram.drawio.svg) を持ち衝突。実 asset は images/ に置かれている。
    makeOut(note, 'outA', {
        pid: 'pA', body: '# A\n![](images/diagram.drawio.svg)',
        assets: [{ sub: 'images', name: 'diagram.drawio.svg', content: 'DA' }],
    });
    makeOut(note, 'outB', {
        pid: 'pB', body: '# B\n![](images/diagram.drawio.svg)',
        assets: [{ sub: 'images', name: 'diagram.drawio.svg', content: 'DB' }],
    });

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    executePlan(plan);

    // drawio は files/ に保存（images/ には無い）
    expect(fs.existsSync(path.join(note, 'images'))).toBe(false); // drawio 以外の画像は無いので images/ 自体作られない
    const files = fs.readdirSync(path.join(note, 'files')).sort();
    expect(files.length).toBe(2);
    // 各 owner の本文リンクが files/ を指し実在
    const linkOf = (b: string) => (b.match(/!\[\]\(([^)]+)\)/) || [])[1];
    const refA = linkOf(read(path.join(note, 'pA.md')))!;
    const refB = linkOf(read(path.join(note, 'pB.md')))!;
    expect(refA.startsWith('files/')).toBe(true);
    expect(refB.startsWith('files/')).toBe(true);
    expect(refA).not.toBe(refB);
    expect(fs.existsSync(path.resolve(note, refA))).toBe(true);
    expect(fs.existsSync(path.resolve(note, refB))).toBe(true);
    expect(read(path.resolve(note, refA))).toBe('DA');
    expect(read(path.resolve(note, refB))).toBe('DB');

    // counterfactual: images/ に blunt マッピングすると files/ 解決が壊れる（refA/refB が images/ を指す）→ RED。
    rm(note);
});

test('TC-M-10 同一 md が別 dir 同名画像 2 枚を参照 → 各々別コピー・各々別リンク書換（load-bearing）', () => {
    const note = mkTmp();
    // 1 page md 本文に sub1/pic.png と sub2/pic.png（旧 pageDir 配下の別サブ dir・中身別）
    const stem = 'work';
    const pdir = path.join(note, stem);
    fs.mkdirSync(path.join(pdir, 'sub1'), { recursive: true });
    fs.mkdirSync(path.join(pdir, 'sub2'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'sub1', 'pic.png'), 'X');
    fs.writeFileSync(path.join(pdir, 'sub2', 'pic.png'), 'Y');
    fs.writeFileSync(path.join(pdir, 'wp.md'), '# wp\n![x](sub1/pic.png)\n![y](sub2/pic.png)');
    fs.writeFileSync(path.join(note, `${stem}.out`), JSON.stringify({
        title: stem, rootIds: ['n1'], nodes: { n1: { id: 'n1', text: 'wp', childIds: [], isPage: true, pageId: 'wp' } },
    }, null, 2));

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    executePlan(plan);

    // dst に 2 物理ファイル（pic.png / pic-1.png）
    const imgs = fs.readdirSync(path.join(note, 'images')).sort();
    expect(imgs.length).toBe(2);
    // 本文の 2 リンクがそれぞれ別 dst に whole-link 書換
    const body = read(path.join(note, 'wp.md'));
    const links = [...body.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map(m => m[1]);
    expect(links.length).toBe(2);
    const [lx, ly] = links;
    expect(lx).not.toBe(ly); // 別 dst（同一に潰れていない）
    expect(fs.existsSync(path.resolve(note, lx))).toBe(true);
    expect(fs.existsSync(path.resolve(note, ly))).toBe(true);
    // 中身が別（x=X 側・y=Y 側で保存）
    expect(read(path.resolve(note, lx))).toBe('X');
    expect(read(path.resolve(note, ly))).toBe('Y');

    // counterfactual: basename キー畳み込み / 部分文字列置換だと 2 リンクが同一 dst を指す / 片方壊れる → RED。
    rm(note);
});

test('TC-M-11 rename と copy 混在プランの途中失敗ロールバック（load-bearing）', () => {
    const note = mkTmp();
    // source X = 1 owner のみ参照（rename 対象）: outA 単独 asset only.png
    // source Y = 2 owner 参照（copy 対象）: 同一物理 shared.png を outB の body と node.images が参照
    //   → src 出現 2 回 = copy 判定。
    makeOut(note, 'outA', {
        pid: 'pA', body: '# A\n![](images/only.png)',
        assets: [{ sub: 'images', name: 'only.png', content: 'ONLY' }],
    });
    // outB: body と node.images が同じ shared.png（別 owner ではないが同一 owner 内 2 参照 → dedup で copy にならない）。
    // copy を確実に作るには「別 node（別 owner）が同じ物理 src を参照」させる。
    // node1(pB1) と node2(pB2) が両方 outB/images/shared.png を参照。
    const pdir = path.join(note, 'outB');
    fs.mkdirSync(path.join(pdir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(pdir, 'images', 'shared.png'), 'SHARED');
    fs.writeFileSync(path.join(pdir, 'pB1.md'), '# B1\n![](images/shared.png)');
    fs.writeFileSync(path.join(pdir, 'pB2.md'), '# B2\n![](images/shared.png)');
    fs.writeFileSync(path.join(note, 'outB.out'), JSON.stringify({
        title: 'outB', rootIds: ['n1', 'n2'], nodes: {
            n1: { id: 'n1', text: 'B1', childIds: [], isPage: true, pageId: 'pB1' },
            n2: { id: 'n2', text: 'B2', childIds: [], isPage: true, pageId: 'pB2' },
        },
    }, null, 2));

    const snap = {
        aImg: read(path.join(note, 'outA', 'images', 'only.png')),
        bImg: read(path.join(note, 'outB', 'images', 'shared.png')),
        aMd: read(path.join(note, 'outA', 'pA.md')),
        b1Md: read(path.join(pdir, 'pB1.md')),
        b2Md: read(path.join(pdir, 'pB2.md')),
        aOut: read(path.join(note, 'outA.out')),
        bOut: read(path.join(note, 'outB.out')),
    };

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);

    // shared.png は 2 node（別 owner）が参照 → src 出現 2 回 = copy。only.png は 1 回 = rename。
    // src 出現回数を確認（copy 混在の前提）
    const srcCount = new Map<string, number>();
    for (const m of plan.moves) srcCount.set(m.from, (srcCount.get(m.from) || 0) + 1);
    const sharedSrc = path.join(note, 'outB', 'images', 'shared.png');
    const onlySrc = path.join(note, 'outA', 'images', 'only.png');
    expect(srcCount.get(sharedSrc)).toBe(2); // copy 対象
    expect(srcCount.get(onlySrc)).toBe(1);   // rename 対象

    // 全 move 後の .out 書換で失敗させる（rename 済み only.png + copy 済み shared × 2 を巻き戻す）
    const res = executePlan(plan, { injectFailOnRewrite: 0 });
    expect(res.rolledBack).toBe(true);

    // rename 対象（only.png）は元位置に戻る
    expect(fs.existsSync(onlySrc)).toBe(true);
    expect(read(onlySrc)).toBe(snap.aImg);
    // copy 対象（shared.png）の元 source は残り、作った dst は削除される
    expect(fs.existsSync(sharedSrc)).toBe(true);
    expect(read(sharedSrc)).toBe(snap.bImg);
    // md も戻る
    expect(read(path.join(note, 'outA', 'pA.md'))).toBe(snap.aMd);
    expect(read(path.join(pdir, 'pB1.md'))).toBe(snap.b1Md);
    expect(read(path.join(pdir, 'pB2.md'))).toBe(snap.b2Md);
    // .out snapshot 復元（legacy のまま）
    expect(read(path.join(note, 'outA.out'))).toBe(snap.aOut);
    expect(read(path.join(note, 'outB.out'))).toBe(snap.bOut);
    // dst 共有 dir に残骸なし
    const flatImg = path.join(note, 'images');
    const leftover = fs.existsSync(flatImg) ? fs.readdirSync(flatImg) : [];
    expect(leftover.length).toBe(0);

    // counterfactual: copy 分を「rename 戻し」で処理すると元ファイル shared.png を消す（sharedSrc 消失）→ RED。
    //   dst 残骸を消し忘れると leftover.length>0 → RED。
    rm(note);
});

test('TC-M-12 1 .out 内の 2 node が同一 oldRef を参照 → 各 node が別 dst に 1:1 書換わり orphan 0（load-bearing）', () => {
    const note = mkTmp();
    // 旧レイアウト: pageDir='./work'。node.images は note 相対 'work/images/s.png'（同一物理ファイルを 2 node が参照）。
    const workImg = path.join(note, 'work', 'images');
    fs.mkdirSync(workImg, { recursive: true });
    fs.writeFileSync(path.join(workImg, 's.png'), 'S');
    // 2 node a/b が同じ物理パス文字列 'work/images/s.png' を node.images で参照（本文 md 参照なし = filePath/images owner）。
    fs.writeFileSync(path.join(note, 'work.out'), JSON.stringify({
        title: 'work', pageDir: './work', rootIds: ['a', 'b'], nodes: {
            a: { id: 'a', text: 'A', childIds: [], images: ['work/images/s.png'] },
            b: { id: 'b', text: 'B', childIds: [], images: ['work/images/s.png'] },
        },
    }, null, 2));

    const plan = planMigration(note);
    expect(validatePlan(plan).ok).toBe(true);
    const res = executePlan(plan);
    expect(res.rolledBack).toBe(false);

    // 共有 images/ に 2 物理ファイル（cross-owner なので content-dedup せず別コピー: s.png / s-1.png）
    const imgs = fs.readdirSync(path.join(note, 'images')).sort();
    expect(imgs.length).toBe(2);

    const data = JSON.parse(read(path.join(note, 'work.out')));
    const aRef = data.nodes.a.images[0] as string;
    const bRef = data.nodes.b.images[0] as string;
    // 各 node が **別々の dst** を指す（oldRef キー last-wins による同一 dst 畳み込みが起きていない）
    expect(aRef).not.toBe(bRef);
    // 両 dst が実在
    expect(fs.existsSync(path.resolve(note, aRef))).toBe(true);
    expect(fs.existsSync(path.resolve(note, bRef))).toBe(true);
    // 孤児（どの node も指さない物理コピー）が 0 = 全 dst が exactly 1 node に参照される（1:1）
    const referenced = new Set<string>([
        path.resolve(note, aRef),
        path.resolve(note, bRef),
    ]);
    const physical = new Set(imgs.map(f => path.resolve(note, 'images', f)));
    expect(referenced.size).toBe(2);          // 2 node が別 dst（重複なし）
    expect(physical.size).toBe(2);            // 物理コピー 2 個
    // 参照集合 == 物理集合（orphan コピー 0・dangling 参照 0）
    expect([...referenced].sort()).toEqual([...physical].sort());

    // counterfactual: 現行（per-`.out` の `renameOf: Map<oldRef,newRef>` が同一 oldRef 'work/images/s.png' を
    //   後勝ちで畳む）だと両 node が同じ dst（'images/s-1.png'）を指し 'images/s.png' が孤児化 →
    //   aRef===bRef で RED（1:1 破れ検出）。per-node 化した現在は別 dst に解決される。
    rm(note);
});
