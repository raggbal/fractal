/**
 * Sprint 20260827-172802 TASK-10 — Export folder の出力計画 + 資産委譲
 * （DOM-ExportTreePlan / DOM-ExportAssetDelegation・FR-EXF-02/03/04/05・NFR-EXF-01）
 *
 * TC-EXF-01（全分岐の代表）/ 02（同名兄弟）/ 03（資産委譲のリンク解決）/ 05（confirm/cancel/部分失敗）/
 * 05b（200 エントリ 10s）/ 09（残り分岐 + md&file 併存）/ 10（出力先の同名退避）/ 11（順序契約）/ 12（パス長超過）。
 *
 * 実 fs（os.tmpdir）+ deps 注入。資産コピーは既存正典（handlePageAssets / handleFileAsset）へ委譲するため
 * spy でラップして「呼ばれたこと」ではなく **出力物とリンク解決** を assert する（design §C4 の受容事項:
 * 画像 dest 名は `copy-<name>-<basename>` になるためファイル名そのものは pin しない）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runFolderExport, ExportNode, FolderExportDeps } from '../../src/shared/folder-export';
import { handlePageAssets, handleFileAsset } from '../../src/shared/paste-asset-handler';

const mk = (prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** tmp note（srcOutDir 直下 images//files/ + pages/ とその配下資産） */
function makeNote() {
    const noteDir = mk('fex-note-');
    const pagesDir = path.join(noteDir, 'pages');
    const fileDir = path.join(noteDir, 'files');
    const imageDir = path.join(noteDir, 'images');
    fs.mkdirSync(path.join(pagesDir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(pagesDir, 'files'), { recursive: true });
    fs.mkdirSync(fileDir, { recursive: true });
    fs.mkdirSync(imageDir, { recursive: true });
    // md 添付（本文が画像・📎・subpage を参照）
    fs.writeFileSync(path.join(pagesDir, 'p-a.md'),
        '# Page A\n\n![](images/pic.png)\n\n[📎 s.pdf](files/s.pdf)\n\n[[sub]](sub.md)\n');
    fs.writeFileSync(path.join(pagesDir, 'sub.md'), '# Sub page\n');
    fs.writeFileSync(path.join(pagesDir, 'images', 'pic.png'), 'PICDATA');
    fs.writeFileSync(path.join(pagesDir, 'files', 's.pdf'), 'SPDF');
    // node 直付き画像（.out 相対）
    fs.writeFileSync(path.join(imageDir, 'nodepic1.png'), 'NP1');
    fs.writeFileSync(path.join(imageDir, 'nodepic2.png'), 'NP2');
    // file 添付
    fs.writeFileSync(path.join(fileDir, 'report.pdf'), 'REPORT');
    return { noteDir, pagesDir, fileDir, imageDir };
}

function makeDeps(note: ReturnType<typeof makeNote>, dest: string | undefined, opts?: {
    confirm?: boolean; threshold?: number;
}) {
    const calls = { pick: 0, confirm: [] as number[], done: [] as Array<[number, number, number]>, md: 0, file: 0 };
    const deps: FolderExportDeps = {
        pickDestination: () => { calls.pick++; return dest; },
        confirmLarge: (n: number) => { calls.confirm.push(n); return opts?.confirm ?? true; },
        notifyDone: (folders: number, files: number, skipped: number) => { calls.done.push([folders, files, skipped]); },
        srcOutDir: note.noteDir,
        srcPagesDir: note.pagesDir,
        srcFileDir: note.fileDir,
        srcImageDir: note.imageDir,
        exportMd: (args: any) => { calls.md++; return handlePageAssets(args); },
        exportFile: (args: any) => { calls.file++; return handleFileAsset(args); },
        limits: opts?.threshold !== undefined ? { confirmThreshold: opts.threshold } : undefined,
    };
    return { deps, calls };
}

/** md 内の全リンク参照が実ファイルへ解決するか（design §C4: 名前ではなく解決を見る） */
function allLinksResolve(mdPath: string): { ok: boolean; refs: string[]; missing: string[] } {
    const body = fs.readFileSync(mdPath, 'utf8');
    const refs = Array.from(body.matchAll(/\]\(([^)]+)\)/g)).map((m) => m[1]).filter((r) => !/^[a-z]+:/i.test(r));
    const dir = path.dirname(mdPath);
    const missing = refs.filter((r) => !fs.existsSync(path.resolve(dir, decodeURI(r))));
    return { ok: missing.length === 0, refs, missing };
}

const snapshot = (dir: string): string[] => {
    const out: string[] = [];
    const walk = (d: string, rel: string) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const r = rel ? `${rel}/${e.name}` : e.name;
            if (e.isDirectory()) { out.push(`d ${r}`); walk(path.join(d, e.name), r); }
            else { out.push(`f ${r} ${fs.statSync(path.join(d, e.name)).size}`); }
        }
    };
    walk(dir, '');
    return out;
};

const isDir = (p: string) => fs.existsSync(p) && fs.statSync(p).isDirectory();
const countAll = (dir: string): number => (fs.existsSync(dir) ? snapshot(dir).length : 0);

test.describe('DOM-ExportTreePlan / DOM-ExportAssetDelegation（FR-EXF-02/03/04/05）', () => {

    test('TC-EXF-01: 子あり=フォルダ / 子なし=md or 添付実体・note 側は不変', async () => {
        const note = makeNote();
        const dest = mk('fex-dest-');
        // 注: collapsed 配下も出力される性質は payload 生成側（buildExportTree）の責務で TC-EXF-06 が検証する。
        // ここは host 側の計画・書き込みのみを対象にする。
        const tree: ExportNode[] = [{
            text: 'A', pageId: 'p-a', children: [
                { text: 'B', children: [{ text: '仕様書', filePath: 'files/report.pdf' }] },
                { text: 'D', subtext: 'note line1\nline2' },
                { text: 'E', images: ['images/nodepic1.png', 'images/nodepic2.png'] },
            ],
        }];
        const before = snapshot(note.noteDir);
        const { deps, calls } = makeDeps(note, dest);

        const res = await runFolderExport(tree, deps);

        expect(res.status).toBe('exported');
        expect(isDir(path.join(dest, 'A')), '子ありはフォルダ').toBe(true);
        // 子あり + md 添付 → フォルダ直下に <name>.md
        const aMd = path.join(dest, 'A', 'A.md');
        expect(fs.existsSync(aMd), 'A/A.md').toBe(true);
        expect(fs.readFileSync(aMd, 'utf8')).toContain('Page A');
        const links = allLinksResolve(aMd);
        expect(links.missing, `A.md の全リンクが解決（refs=${links.refs.join(',')}）`).toEqual([]);
        // 子あり（添付なし）→ フォルダのみ
        expect(isDir(path.join(dest, 'A', 'B'))).toBe(true);
        // 子なし + file 添付 → node text 名 + 元拡張子
        expect(fs.readFileSync(path.join(dest, 'A', 'B', '仕様書.pdf'), 'utf8')).toBe('REPORT');
        // 子なし + 添付なし → <name>.md（# text + subtext）
        const dMd = fs.readFileSync(path.join(dest, 'A', 'D.md'), 'utf8');
        expect(dMd).toContain('# D');
        expect(dMd).toContain('note line1');
        expect(dMd).toContain('line2');
        // 子なし + 直付き画像のみ → <name>.md（画像リンク）+ images/
        const eMd = path.join(dest, 'A', 'E.md');
        expect(fs.existsSync(eMd)).toBe(true);
        const eLinks = allLinksResolve(eMd);
        expect(eLinks.refs.length, 'E.md に画像リンク 2 本').toBe(2);
        expect(eLinks.missing, 'E.md の画像リンクが解決').toEqual([]);
        // 件数と note 側の不変
        expect(res.folders, 'フォルダ数 = A, B').toBe(2);
        expect(res.skipped).toBe(0);
        expect(calls.done, '完了通知 1 回').toHaveLength(1);
        expect(snapshot(note.noteDir), 'note 側は read-only（1 バイトも変わらない）').toEqual(before);
    });

    test('TC-EXF-02: 同名兄弟は連番で分かれ subtree が混ざらない', async () => {
        const note = makeNote();
        const dest = mk('fex-dest2-');
        const tree: ExportNode[] = [
            { text: 'A', children: [{ text: 'x' }] },
            { text: 'A', children: [{ text: 'y' }] },
            { text: 'A' },   // 子なし添付なし → A.md（拡張子違いで衝突しない）
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);

        expect(res.status).toBe('exported');
        expect(isDir(path.join(dest, 'A'))).toBe(true);
        expect(isDir(path.join(dest, 'A-1')), '2 つ目の同名は連番').toBe(true);
        expect(fs.existsSync(path.join(dest, 'A', 'x.md')), 'x は A/ 配下').toBe(true);
        expect(fs.existsSync(path.join(dest, 'A-1', 'y.md')), 'y は A-1/ 配下（混ざらない）').toBe(true);
        expect(fs.existsSync(path.join(dest, 'A', 'y.md')), 'A/ に y が混入しない').toBe(false);
        expect(fs.existsSync(path.join(dest, 'A.md')), '子なし A は A.md').toBe(true);
    });

    test('TC-EXF-03: md 添付の画像/📎/subpage + 直付き画像がすべて解決する', async () => {
        const note = makeNote();
        const dest = mk('fex-dest3-');
        const tree: ExportNode[] = [{ text: 'Doc', pageId: 'p-a', images: ['images/nodepic1.png'] }];
        const { deps } = makeDeps(note, dest);

        const res = await runFolderExport(tree, deps);
        expect(res.status).toBe('exported');

        const md = path.join(dest, 'Doc.md');
        expect(fs.existsSync(md)).toBe(true);
        const body = fs.readFileSync(md, 'utf8');
        const links = allLinksResolve(md);
        expect(links.missing, `全リンク解決（refs=${links.refs.join(',')}）`).toEqual([]);
        expect(body, 'subpage リンクが残る').toContain('sub');
        expect(fs.existsSync(path.join(dest, 'sub.md')), 'subpage md が同フォルダへ').toBe(true);
        expect(fs.readdirSync(path.join(dest, 'images')).length, 'images/ に本文画像 + 直付き画像').toBeGreaterThanOrEqual(2);
        expect(fs.readdirSync(path.join(dest, 'files'))).toContain('s.pdf');
        expect(links.refs.some((r) => r.includes('nodepic1')), '直付き画像のリンクが md に追記される').toBe(true);
    });

    test('TC-EXF-05: 200 超確認 / キャンセル / 部分失敗の件数', async () => {
        // (a) 201 エントリ + confirm=false → declined・fs 書き込み 0
        const noteA = makeNote();
        const destA = mk('fex-dest5a-');
        const many: ExportNode[] = Array.from({ length: 201 }, (_, i) => ({ text: `n${i}` }));
        const a = makeDeps(noteA, destA, { confirm: false });
        const declined = await runFolderExport(many, a.deps);
        expect(a.calls.confirm, '件数付きで確認').toEqual([201]);
        expect(declined.status).toBe('declined');
        expect(countAll(destA), '出力先に 1 バイトも書かない').toBe(0);
        expect(a.calls.done, '完了通知もしない').toHaveLength(0);

        // (b) pickDestination が undefined → cancelled（confirm も core も 0 回）
        const noteB = makeNote();
        const b = makeDeps(noteB, undefined, { confirm: true });
        const cancelled = await runFolderExport(many, b.deps);
        expect(cancelled.status).toBe('cancelled');
        expect(b.calls.confirm).toHaveLength(0);
        expect(b.calls.md + b.calls.file).toBe(0);
        expect(b.calls.done).toHaveLength(0);

        // (c) 読取不能な添付 1 件 → skip 集計 + 他は出力 + 完了通知に件数
        const noteC = makeNote();
        const destC = mk('fex-dest5c-');
        const locked = path.join(noteC.fileDir, 'locked.bin');
        fs.writeFileSync(locked, 'SECRET');
        fs.chmodSync(locked, 0o000);
        let readable = true;
        try { fs.readFileSync(locked); } catch { readable = false; }
        expect(readable, 'fixture 前提: chmod 000 が読取不能（root 実行では成立しない）').toBe(false);
        const c = makeDeps(noteC, destC);
        const partial = await runFolderExport([
            { text: 'ok', filePath: 'files/report.pdf' },
            { text: 'ng', filePath: 'files/locked.bin' },
        ], c.deps);
        expect(partial.status).toBe('exported');
        expect(partial.skipped, '読取不能 1 件が skip').toBe(1);
        expect(fs.existsSync(path.join(destC, 'ok.pdf')), '他は出力される').toBe(true);
        expect(c.calls.done[0][2], '完了通知の skipped が 1').toBe(1);
    });

    test('TC-EXF-05b: 200 エントリ相当の出力が 10s 未満（NFR-EXF-01）', async () => {
        const note = makeNote();
        const dest = mk('fex-perf-');
        const tree: ExportNode[] = Array.from({ length: 10 }, (_, d) => ({
            text: `dir${d}`,
            children: Array.from({ length: 20 }, (_, i) => (i % 2 === 0
                ? { text: `md${i}`, pageId: 'p-a' }
                : { text: `file${i}`, filePath: 'files/report.pdf' })),
        }));
        const { deps } = makeDeps(note, dest, { threshold: 100000 });

        const started = Date.now();
        const res = await runFolderExport(tree, deps);
        const elapsed = Date.now() - started;

        expect(res.status).toBe('exported');
        expect(res.folders).toBe(10);
        expect(res.files, '200 エントリ分の実体').toBeGreaterThanOrEqual(200);
        expect(elapsed, `210 エントリが 10s 未満（実測 ${elapsed}ms）`).toBeLessThan(10000);
    });

    test('TC-EXF-09: 残りの分岐（子あり file 添付 / 子あり md+画像 / md&file 併存）', async () => {
        const note = makeNote();
        const dest = mk('fex-dest9-');
        const tree: ExportNode[] = [
            { text: 'F', filePath: 'files/report.pdf', children: [{ text: 'child' }] },
            { text: 'G', pageId: 'p-a', images: ['images/nodepic1.png'], children: [{ text: 'gc' }] },
            { text: 'H', pageId: 'p-a', filePath: 'files/report.pdf', children: [{ text: 'hc' }] },
            { text: 'I', pageId: 'p-a', filePath: 'files/report.pdf' },
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);
        expect(res.status).toBe('exported');

        // 子あり + file 添付 → フォルダ直下に <name>.<ext>
        expect(isDir(path.join(dest, 'F'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'F', 'F.pdf'))).toBe(true);
        expect(isDir(path.join(dest, 'F', 'child')) || fs.existsSync(path.join(dest, 'F', 'child.md'))).toBe(true);

        // 子あり + md 添付 + 直付き画像 → md 末尾に画像リンク追記
        const gMd = path.join(dest, 'G', 'G.md');
        expect(fs.existsSync(gMd)).toBe(true);
        const gLinks = allLinksResolve(gMd);
        expect(gLinks.missing).toEqual([]);
        expect(gLinks.refs.some((r) => r.includes('nodepic1')), '直付き画像リンクが追記').toBe(true);

        // md + file 併存（子あり）→ 両方出す（design-review SYS2-1 の訂正）
        expect(fs.existsSync(path.join(dest, 'H', 'H.md')), '併存: md 側').toBe(true);
        expect(fs.existsSync(path.join(dest, 'H', 'H.pdf')), '併存: file 側').toBe(true);

        // md + file 併存（子なし）→ 親直下に両方
        expect(fs.existsSync(path.join(dest, 'I.md'))).toBe(true);
        expect(fs.existsSync(path.join(dest, 'I.pdf'))).toBe(true);
    });

    test('TC-EXF-13: file 添付 + 直付き画像の併存で画像が落ちない（reviewer iter4 DESIGN-1）', async () => {
        const note = makeNote();
        const dest = mk('fex-dest13-');
        // §C2-a の表に無かった組合せ: 非 md 添付（file）と node 直付き画像を同時に持つ node。
        // 子なし側で images ブランチが `!hasMd && !hasFile` に閉じ込められており、画像が無音で欠落していた。
        const tree: ExportNode[] = [
            { text: 'LeafBoth', filePath: 'files/report.pdf', images: ['images/nodepic1.png'] },
            { text: 'DirBoth', filePath: 'files/report.pdf', images: ['images/nodepic2.png'], children: [{ text: 'kid' }] },
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);
        expect(res.status).toBe('exported');

        // 子なし: 添付実体 + 画像実体 + 画像リンクを持つ md が揃う
        expect(fs.existsSync(path.join(dest, 'LeafBoth.pdf')), '添付は出る').toBe(true);
        const leafImgs = fs.existsSync(path.join(dest, 'images')) ? fs.readdirSync(path.join(dest, 'images')) : [];
        expect(leafImgs.length, '直付き画像の実体が images/ に出る（欠落しない）').toBeGreaterThanOrEqual(1);
        const leafMd = path.join(dest, 'LeafBoth.md');
        expect(fs.existsSync(leafMd), '画像を参照する md が生成される').toBe(true);
        expect(allLinksResolve(leafMd).missing, '画像リンクが解決').toEqual([]);

        // 子あり: フォルダ直下に 添付 + images/ + 画像 md
        expect(fs.existsSync(path.join(dest, 'DirBoth', 'DirBoth.pdf'))).toBe(true);
        expect(fs.readdirSync(path.join(dest, 'DirBoth', 'images')).length).toBeGreaterThanOrEqual(1);
        expect(allLinksResolve(path.join(dest, 'DirBoth', 'DirBoth.md')).missing).toEqual([]);
    });

    test("TC-EXF-14: node text が空なら 'blank' を名前にし、衝突時のみ連番（blank-1）", async () => {
        const note = makeNote();
        const dest = mk('fex-blank-');
        // 仕様（ユーザー裁定 2026-08-30 確定）: 空 text の名前は **文字列 'blank'**。
        // 旧 'export'（発明語）は廃止。1 件目は 'blank' で、被った 2 件目以降だけ 'blank-1' 等。
        const tree: ExportNode[] = [
            { text: '', children: [{ text: 'kid' }] },   // 空 text の子ありフォルダ
            { text: '   ' },                              // 空白のみ（子なし・添付なし）
            { text: '' },                                 // 空 text（子なし）
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);
        expect(res.status).toBe('exported');

        const top = fs.readdirSync(dest).sort();
        expect(top, `発明語 export を使わない（実際: ${JSON.stringify(top)}）`).not.toContain('export');
        expect(top, 'export.md も作らない').not.toContain('export.md');
        // 🔴 1 件目は 'blank' そのまま（連番を付けない — 2026-08-30 の実機バグ）
        expect(isDir(path.join(dest, 'blank')), `空 text の子ありフォルダは blank/: ${JSON.stringify(top)}`).toBe(true);
        expect(fs.existsSync(path.join(dest, 'blank', 'kid.md')), '子は blank/ 配下').toBe(true);
        expect(top, '連番だけの名前（-1）は作らない').not.toContain('-1');
        expect(top, '連番だけの名前（-1.md）は作らない').not.toContain('-1.md');
        // 空 text の子なし node は 2 つ → 1 件目 = blank.md / 2 件目 = 衝突なので blank-1.md
        const mds = top.filter((n) => n.endsWith('.md')).sort();
        expect(mds, `blank md は 1 件目が blank.md・衝突分だけ連番（実際: ${JSON.stringify(mds)}）`)
            .toEqual(['blank-1.md', 'blank.md']);
    });

    test('TC-EXF-15: node text が既に同じ拡張子で終わるなら二重付与しない（手動テストで発覚）', async () => {
        const note = makeNote();
        const dest = mk('fex-dblext-');
        // Import folder は file 添付 node の text を「拡張子込みファイル名」にするため、
        // Export で素朴に `${text}${ext}` すると `report.pdf.pdf` になる（実機の手動テストで確認）。
        const tree: ExportNode[] = [
            { text: 'report.pdf', filePath: 'files/report.pdf' },            // 同じ拡張子 → 二重付与しない
            { text: 'REPORT.PDF', filePath: 'files/report.pdf' },            // 大小違いでも二重付与しない
            { text: 'notes', filePath: 'files/report.pdf' },                 // 拡張子なし → 付与する
            { text: 'archive.tar', filePath: 'files/report.pdf' },           // 違う拡張子 → 付与する
            { text: 'guide.md', pageId: 'p-a' },                             // md 添付も同様（guide.md.md にしない）
            { text: '', filePath: 'files/report.pdf' },                       // 空 text + 添付 → blank.pdf
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);
        expect(res.status).toBe('exported');

        const names = fs.readdirSync(dest).sort();
        expect(names, `二重拡張子を作らない（実際: ${names.join(', ')}）`).not.toContain('report.pdf.pdf');
        expect(names).toContain('report.pdf');
        expect(names.some((n) => /^REPORT\.PDF$/i.test(n) || /^REPORT\.PDF-1$/i.test(n) || /^REPORT-1\.PDF$/i.test(n)),
            '大小違いも二重付与しない（連番での共存は可）').toBe(true);
        expect(names, '拡張子なし text には付与する').toContain('notes.pdf');
        expect(names, '違う拡張子なら付与する').toContain('archive.tar.pdf');
        expect(names, 'md 添付も二重にしない').toContain('guide.md');
        expect(names, 'guide.md.md を作らない').not.toContain('guide.md.md');
        expect(names, `空 text + 添付は隠しファイル '.pdf' にしない（実際: ${JSON.stringify(names)}）`).not.toContain('.pdf');
        expect(names, "空 text + 添付 → 'blank.pdf'（連番は付けない）").toContain('blank.pdf');
        expect(names, '連番だけの名前（-1.pdf）は作らない').not.toContain('-1.pdf');
    });

    test('TC-EXF-10: 出力先に同名があれば最上位のみ -N 退避（マージしない）', async () => {
        const note = makeNote();
        const dest = mk('fex-dest10-');
        const tree: ExportNode[] = [{ text: 'A', children: [{ text: 'x' }] }];

        const r1 = await runFolderExport(tree, makeDeps(note, dest).deps);
        expect(r1.status).toBe('exported');
        const firstSnapshot = snapshot(path.join(dest, 'A'));

        const r2 = await runFolderExport(tree, makeDeps(note, dest).deps);
        expect(r2.status).toBe('exported');
        expect(isDir(path.join(dest, 'A-1')), '2 回目は A-1/').toBe(true);
        expect(snapshot(path.join(dest, 'A')), '1 回目の中身は 1 バイトも変わらない').toEqual(firstSnapshot);

        await runFolderExport(tree, makeDeps(note, dest).deps);
        expect(isDir(path.join(dest, 'A-2')), '3 回目は A-2/').toBe(true);
    });

    test('TC-EXF-16: 出力先に元からある file/dir とも衝突しない（既存を 1 バイトも上書きしない）', async () => {
        const note = makeNote();
        const dest = mk('fex-dest16-');
        // 出力先に「エクスポートと無関係な既存物」を先に置く（ユーザー指摘 2026-08-30）
        fs.writeFileSync(path.join(dest, 'notes.md'), 'PRE-MD');
        fs.writeFileSync(path.join(dest, 'report.pdf'), 'PRE-PDF');
        fs.mkdirSync(path.join(dest, 'blank'));                               // 'blank' dir が既にある
        fs.writeFileSync(path.join(dest, 'blank', 'keep.txt'), 'KEEP');
        fs.writeFileSync(path.join(dest, 'blank.md'), 'PRE-BLANK-MD');
        fs.writeFileSync(path.join(dest, 'A'), 'PRE-FILE-A');                // 型違い（file なのに dir を作りたい）

        const tree: ExportNode[] = [
            { text: 'notes' },                                    // → notes.md（既存と衝突）
            { text: 'report.pdf', filePath: 'files/report.pdf' }, // → report.pdf（既存と衝突）
            { text: '', children: [{ text: 'kid' }] },            // → blank/（既存 dir と衝突）
            { text: '' },                                         // → blank.md（既存と衝突）
            { text: 'A', children: [{ text: 'c' }] },             // → A（既存 file と衝突 = 型違い）
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);
        expect(res.status).toBe('exported');

        // 🔴 既存物は 1 バイトも変わらない（上書き = データロスを構造的に禁止）
        expect(fs.readFileSync(path.join(dest, 'notes.md'), 'utf8'), 'notes.md を上書きしない').toBe('PRE-MD');
        expect(fs.readFileSync(path.join(dest, 'report.pdf'), 'utf8'), 'report.pdf を上書きしない').toBe('PRE-PDF');
        expect(fs.readFileSync(path.join(dest, 'blank', 'keep.txt'), 'utf8'), '既存 blank/ にマージしない').toBe('KEEP');
        expect(fs.readFileSync(path.join(dest, 'blank.md'), 'utf8'), 'blank.md を上書きしない').toBe('PRE-BLANK-MD');
        expect(fs.readFileSync(path.join(dest, 'A'), 'utf8'), '同名 file があっても dir で潰さない').toBe('PRE-FILE-A');

        // 新規出力は連番で回避されている
        const names = fs.readdirSync(dest).sort();
        expect(names, `notes → notes-1.md（実際: ${JSON.stringify(names)}）`).toContain('notes-1.md');
        expect(names, 'report.pdf → report-1.pdf').toContain('report-1.pdf');
        expect(isDir(path.join(dest, 'blank-1')), 'blank dir → blank-1/').toBe(true);
        expect(fs.existsSync(path.join(dest, 'blank-1', 'kid.md')), '子は blank-1/ 配下').toBe(true);
        expect(names, 'blank md → blank-1.md').toContain('blank-1.md');
        expect(isDir(path.join(dest, 'A-1')), 'A（file 既存）→ A-1/').toBe(true);
        expect(fs.existsSync(path.join(dest, 'A-1', 'c.md')), '子は A-1/ 配下').toBe(true);
    });

    test('TC-EXF-17: 出力先に既存の資産/subpage 名があっても 1 バイトも上書きしない（images/ · files/ · subpage md）', async () => {
        const note = makeNote();
        const dest = mk('fex-d17-');

        // 出力先に「そのまま衝突する資産名」を先に置く。md 本体（note1.md）は**置かない** —
        // md 名が連番退避されると資産名（copy-<md名>-…）も変わって衝突しなくなり、番人が無力化するため。
        fs.mkdirSync(path.join(dest, 'images'), { recursive: true });
        fs.mkdirSync(path.join(dest, 'files'), { recursive: true });
        fs.writeFileSync(path.join(dest, 'images', 'copy-note1-pic.png'), 'PRE-IMG', 'utf8');
        fs.writeFileSync(path.join(dest, 'files', 's.pdf'), 'PRE-FILE', 'utf8');
        fs.writeFileSync(path.join(dest, 'sub.md'), 'PRE-SUBPAGE', 'utf8');   // subpage md と同名

        const tree: ExportNode[] = [{ text: 'note1', pageId: 'p-a' }];
        const res = await runFolderExport(tree, makeDeps(note, dest).deps);
        expect(res.status).toBe('exported');

        // 🔴 既存 3 件は 1 バイトも変わらない
        expect(fs.readFileSync(path.join(dest, 'images', 'copy-note1-pic.png'), 'utf8'),
            '既存 images/ の同名を上書きしない').toBe('PRE-IMG');
        expect(fs.readFileSync(path.join(dest, 'files', 's.pdf'), 'utf8'),
            '既存 files/ の同名を上書きしない').toBe('PRE-FILE');
        expect(fs.readFileSync(path.join(dest, 'sub.md'), 'utf8'),
            '既存 subpage md と同名を上書きしない').toBe('PRE-SUBPAGE');

        // 実体は連番で別名として入り、md のリンクは全部その新しい方へ解決する
        const imgs = fs.readdirSync(path.join(dest, 'images')).sort();
        expect(imgs.length, `画像は退避されて 2 件（実際: ${JSON.stringify(imgs)}）`).toBe(2);
        const files = fs.readdirSync(path.join(dest, 'files')).sort();
        expect(files.length, `📎 は退避されて 2 件（実際: ${JSON.stringify(files)}）`).toBe(2);
        const r = allLinksResolve(path.join(dest, 'note1.md'));
        expect(r.ok, `note1.md の全リンクが解決する（未解決: ${r.missing.join(', ')} / refs: ${r.refs.join(', ')}）`).toBe(true);

        // subpage は「既存 sub.md を流用」ではなく **別名で複製**される（リンク解決だけでは区別できないので実体で見る）
        const mds = fs.readdirSync(dest).filter((n) => n.endsWith('.md')).sort();
        const subCopies = mds.filter((n) => n !== 'sub.md' && n !== 'note1.md');
        expect(subCopies.length, `subpage が別名で複製される（実際: ${JSON.stringify(mds)}）`).toBe(1);
        expect(fs.readFileSync(path.join(dest, subCopies[0]), 'utf8'), '複製の中身は元 subpage').toContain('Sub page');
        expect(fs.readFileSync(path.join(dest, 'note1.md'), 'utf8'), 'note1.md のリンクは複製を指す')
            .toContain(subCopies[0]);
    });

    test('TC-EXF-11: 連番は「まだ書いていない兄弟」とも衝突しない（順序契約 §C3-a）', async () => {
        const note = makeNote();
        const dest = mk('fex-dest11-');
        const tree: ExportNode[] = [
            { text: 'A', children: [{ text: 'c1' }] },
            { text: 'A', children: [{ text: 'c2' }] },
            { text: 'A', children: [{ text: 'c3' }] },
        ];
        const { deps } = makeDeps(note, dest);
        const res = await runFolderExport(tree, deps);

        expect(res.status).toBe('exported');
        for (const [dir, child] of [['A', 'c1'], ['A-1', 'c2'], ['A-2', 'c3']] as Array<[string, string]>) {
            expect(isDir(path.join(dest, dir)), `${dir}/ が独立`).toBe(true);
            expect(fs.existsSync(path.join(dest, dir, `${child}.md`)), `${dir}/${child}.md`).toBe(true);
        }
        expect(res.folders).toBe(3);

        // 本命: **書き込みが失敗した名前も予約される**（実体が無いので existsSync では見えない）。
        // これが usedNames Set が load-bearing な唯一のケース — 予約しないと成功した側が同じ名前を
        // 取り、skip 件数と出力物の対応が追えなくなる（design §C3-a）。
        const dest2 = mk('fex-dest11b-');
        const locked = path.join(note.fileDir, 'locked2.pdf');   // 同じ拡張子にして名前を衝突させる
        fs.writeFileSync(locked, 'X');
        fs.chmodSync(locked, 0o000);
        let readable = true;
        try { fs.readFileSync(locked); } catch { readable = false; }
        expect(readable, 'fixture 前提: chmod 000 が読取不能').toBe(false);

        const { deps: deps2 } = makeDeps(note, dest2);
        const res2 = await runFolderExport([
            { text: 'Dup', filePath: 'files/locked2.pdf' },   // 失敗する（名前 Dup.pdf は予約される）
            { text: 'Dup', filePath: 'files/report.pdf' },    // 成功 → 予約済みなので Dup-1.pdf
        ], deps2);

        expect(res2.skipped, '1 件目は skip').toBe(1);
        expect(fs.existsSync(path.join(dest2, 'Dup-1.pdf')), '2 件目は予約を避けて Dup-1.pdf').toBe(true);
        expect(fs.existsSync(path.join(dest2, 'Dup.pdf')), '失敗した実体は存在しない').toBe(false);
    });

    test('TC-EXF-12: パス長超過は 1 件の skip として可視化し例外を投げない（FIT-2）', async () => {
        const note = makeNote();
        const dest = mk('fex-dest12-');
        // 200 文字 × 25 階層 ≒ 5000 バイト > PATH_MAX(4096) で必ず途中で失敗させる
        const longName = 'l'.repeat(200);
        let deep: ExportNode = { text: longName };
        for (let i = 0; i < 25; i++) { deep = { text: longName, children: [deep] }; }
        const tree: ExportNode[] = [deep, { text: 'shallow' }];
        const { deps } = makeDeps(note, dest, { threshold: 100000 });

        // 前提 assert（testcases.md TC-EXF-12 の明示要求）: この環境で本当にパス長上限に当たること。
        // 当たらない環境では「skip が 0」という不透明な失敗ではなく、前提が崩れたことを明示して fail させる
        // （「存在しなければ pass」型のフォールバックは書かない — generator_failures 2026-08-26）
        const probe = path.join(dest, ...Array.from({ length: 26 }, () => longName));
        let mkdirFails = false;
        try { fs.mkdirSync(probe, { recursive: true }); } catch { mkdirFails = true; }
        expect(mkdirFails, `fixture 前提: ${probe.length} 文字のパスが OS 上限に当たる`).toBe(true);

        const res = await runFolderExport(tree, deps);   // 例外を投げないこと自体が assert

        expect(res.status).toBe('exported');
        expect(res.skipped, 'パス長超過が skip として数えられる').toBeGreaterThanOrEqual(1);
        expect(fs.existsSync(path.join(dest, 'shallow.md')), '成功した兄弟の出力は残る').toBe(true);
    });
});
