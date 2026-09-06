/**
 * TASK-20 — Import folder の closure 抑止 + 随伴の正典化
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-OIF-05/06/07 / NFR-DCP-01）
 *
 * TC-OIF-10..18。
 *
 * 現状の欠陥（本 TASK で同時に直す）:
 *   markdown-import.ts の processImages（:305-345）は `kind === 'image'` だけを処理し
 *   📎 file リンクと subpage md リンクを素通しする → md は pages/<uuid>.md に置かれるのに
 *   本文は元フォルダ基準の files/x.pdf を指す = **今すでにリンク切れ**。
 *   さらに path.resolve(sourceDir, ref) に containment 検査が無く絶対パス・../ が素通り。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { makeImportFolderFixture, makeDestNote } from '../utils/fixture-import-folder';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../../src/shared/folder-import');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pah = require('../../src/shared/paste-asset-handler');

/** fixture の walk → closure 算出までを通す。 */
function walkAndClosure(target: string) {
    const walked = fi.walkFolderForImport(target);
    expect(walked.ok, 'walk が失敗した').toBe(true);
    const closure: Set<string> = fi.computeMdClosure(walked.entries, target);
    return { walked, closure };
}

/** closure の絶対パス集合を target 起点の相対パスに落として比較しやすくする。 */
function rel(target: string, closure: Set<string>): string[] {
    return [...closure].map((a) => path.relative(target, a).split(path.sep).join('/')).sort();
}

test.describe('computeMdClosure — md 本文が参照する資産の closure（FR-OIF-05）', () => {
    test('TC-OIF-13 [[label]](sub.md) 形式の subpage が closure に入る（関数 pin の番人）', () => {
        const fx = makeImportFolderFixture('basic');
        try {
            const { closure } = walkAndClosure(fx.target);
            const got = rel(fx.target, closure);
            // 画像 / 📎 / subpage の 3 種すべてが入る
            expect(got).toContain('images/pic.png');
            expect(got).toContain('files/spec.pdf');
            // rev2（ADRL-0110・TASK-43）: closure の正典は随伴転送エンジンと同じ extractAllAssetRefs
            // （mdLinkRefs.isSubpage が [[ ]] を返す）。初版の「extractAllAssetRefs はこの形式を落とす」は事実誤認だった。
            // 本 TC の期待は rev2 でも不変。規則 pin の番人は TC-OIF-20（プレーンリンクが closure に入らない）が担う。
            expect(got, '[[label]](sub.md) 形式の subpage が closure から漏れた（extractAllAssetRefs.mdLinkRefs の isSubpage ゲート）')
                .toContain('sub.md');
            // closure 外は入らない
            expect(got, 'a.md から参照されない orphan.png が closure に入っている').not.toContain('images/orphan.png');
        } finally { fx.cleanup(); }
    });

    test('TC-OIF-14 URL エンコードされた参照が closure に入る（decodeURIComponent）', () => {
        const fx = makeImportFolderFixture('urlencoded');
        try {
            const got = rel(fx.target, walkAndClosure(fx.target).closure);
            expect(got, '%20 を decode せずに照合すると偽陰性になる').toContain('images/pic a.png');
        } finally { fx.cleanup(); }
    });

    test('TC-OIF-16 containment: 絶対パス / ../ escape は closure に入らない（NFR-DCP-01）', () => {
        const fx = makeImportFolderFixture('escape');
        try {
            const { closure } = walkAndClosure(fx.target);
            const abs = [...closure];
            // target 配下だけ
            for (const a of abs) {
                expect(path.relative(fx.target, a).startsWith('..'),
                    `closure に境界外が入っている: ${a}`).toBe(false);
                expect(path.isAbsolute(a) && a.startsWith(fx.target)).toBe(true);
            }
            // 境界内の正常参照は入る（全部落ちる実装を green にしない）
            expect(rel(fx.target, closure)).toContain('images/pic.png');
            // escape 先の実体は複製されていない（この段では closure 算出のみなので存在確認だけ）
            expect(fs.existsSync(path.join(fx.root, 'outside', 'escape.png'))).toBe(true);
        } finally { fx.cleanup(); }
    });

    test('TC-OIF-12 md が 1 つも無いフォルダは closure が空（従来どおり）', () => {
        const fx = makeImportFolderFixture('no-md');
        try {
            expect([...walkAndClosure(fx.target).closure]).toEqual([]);
        } finally { fx.cleanup(); }
    });
});

test.describe('hasNonClosureDescendant — 空 folder node の生成条件（FR-OIF-07）', () => {
    test('TC-OIF-11 closure だけの dir は false / closure 外を持つ dir は true', () => {
        const fx = makeImportFolderFixture('basic');
        try {
            const { walked, closure } = walkAndClosure(fx.target);
            const find = (name: string) => walked.entries.find((e: any) => e.kind === 'dir' && e.name === name);
            const images = find('images');
            const files = find('files');
            expect(images, 'images/ dir が walk に無い').toBeTruthy();
            expect(files, 'files/ dir が walk に無い').toBeTruthy();

            // images/ は orphan.png（closure 外）を持つので node を作る
            expect(fi.hasNonClosureDescendant(images, closure), 'images/ は closure 外を持つ').toBe(true);
            // files/ は spec.pdf（closure）だけなので node を作らない
            expect(fi.hasNonClosureDescendant(files, closure), 'files/ は closure だけ').toBe(false);
        } finally { fx.cleanup(); }
    });

    test('TC-OIF-11c 空 dir / 読めない dir は true（§5-4 行 5「従来挙動を維持」）', () => {
        // design/system.md §5-4 の行 5。closure と関係が無い dir を抑止対象にしてはいけない。
        // 実装を false にすると既存 TC-OIF-09（読めない dir の node が空で再現される）が RED になる
        // — この分岐が番人を持っていなかったため実装で踏んだ。
        const emptyDir: any = { kind: 'dir', name: 'empty', children: [] };
        expect(fi.hasNonClosureDescendant(emptyDir, new Set()),
            '空 dir の node を抑止すると読めない dir（EACCES で children 空）の node も silent に消える')
            .toBe(true);

        // 入れ子の空 dir も同様
        const nestedEmpty: any = { kind: 'dir', name: 'a', children: [{ kind: 'dir', name: 'b', children: [] }] };
        expect(fi.hasNonClosureDescendant(nestedEmpty, new Set())).toBe(true);
    });

    test('TC-OIF-18 中間 dir は「再帰的に」closure 外を持つと true（直下だけ見る実装を弾く）', () => {
        const fx = makeImportFolderFixture('deep');
        try {
            const { walked, closure } = walkAndClosure(fx.target);
            const deep = walked.entries.find((e: any) => e.kind === 'dir' && e.name === 'deep');
            expect(deep).toBeTruthy();
            // deep 直下にファイルは無いが、孫（deep/a/b/x.pdf）が closure 外
            expect(fi.hasNonClosureDescendant(deep, closure),
                '「直下だけ見る」実装だと false になり中間 dir の node が消えて孫が root へ浮く').toBe(true);
            const a = deep.children.find((e: any) => e.kind === 'dir' && e.name === 'a');
            const b = a.children.find((e: any) => e.kind === 'dir' && e.name === 'b');
            expect(fi.hasNonClosureDescendant(a, closure)).toBe(true);
            expect(fi.hasNonClosureDescendant(b, closure)).toBe(true);
        } finally { fx.cleanup(); }
    });
});

test.describe('runFolderImport — node 化の抑止と随伴（FR-OIF-05/06）', () => {
    /** deps を組んで runFolderImport を走らせる。 */
    async function runImport(target: string, destDir: string) {
        const notified: { skipped: number[]; limit: string[] } = { skipped: [], limit: [] };
        const outcome = await fi.runFolderImport({
            pickFolder: () => target,
            confirmLarge: () => true,
            notifyLimitExceeded: (e: string) => notified.limit.push(e),
            notifySkipped: (n: number) => notified.skipped.push(n),
            pageDir: path.join(destDir, 'pages'),
            imageDir: path.join(destDir, 'images'),
            fileDir: path.join(destDir, 'files'),
            outDir: destDir,
        });
        return { outcome, notified };
    }

    /** entries 木を平坦化して kind/name の一覧にする。 */
    function flatten(entries: any[], prefix = ''): string[] {
        const out: string[] = [];
        for (const e of entries) {
            const label = `${prefix}${e.kind}:${e.name}`;
            out.push(label);
            if (e.kind === 'dir') { out.push(...flatten(e.children, `${prefix}${e.name}/`)); }
        }
        return out;
    }

    test('TC-OIF-10 closure の実体は node を作らない（images / files の folder node も作らない）', async () => {
        const fx = makeImportFolderFixture('basic');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            expect(outcome.status).toBe('imported');
            const flat = flatten(outcome.entries);

            // 選んだフォルダ自身は node になる（FR-OIF-02 の既存挙動は不変）
            expect(flat).toContain('dir:docs');
            // a.md / sub.md は node になる
            expect(flat.some((s) => s.endsWith('md:a.md'))).toBe(true);
            // closure に入る資産の node が無い
            expect(flat.some((s) => s.endsWith('file:spec.pdf')),
                'closure の spec.pdf に node ができている').toBe(false);
            expect(flat.some((s) => s.endsWith('file:pic.png')),
                'closure の pic.png に node ができている').toBe(false);
            // files/ は closure だけなので folder node も作らない
            expect(flat.some((s) => s.endsWith('dir:files')),
                'closure だけの files/ に folder node ができている').toBe(false);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-11b closure 外は folder node + 実体 node が作られる', async () => {
        const fx = makeImportFolderFixture('basic');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            const flat = flatten(outcome.entries);
            expect(flat.some((s) => s.endsWith('dir:images')), 'images/ の folder node が無い').toBe(true);
            expect(flat.some((s) => s.endsWith('file:orphan.png')), 'orphan.png の node が無い').toBe(true);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-12b md が無いフォルダは従来どおり folder node + 実体 node', async () => {
        const fx = makeImportFolderFixture('no-md');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            const flat = flatten(outcome.entries);
            expect(flat.some((s) => s.endsWith('dir:files'))).toBe(true);
            expect(flat.some((s) => s.endsWith('file:x.pdf'))).toBe(true);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-18b 中間 dir 3 段の folder node が作られる', async () => {
        const fx = makeImportFolderFixture('deep');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            const flat = flatten(outcome.entries);
            for (const seg of ['dir:deep', 'dir:a', 'dir:b']) {
                expect(flat.some((s) => s.endsWith(seg)), `${seg} の folder node が無い`).toBe(true);
            }
            expect(flat.some((s) => s.endsWith('file:x.pdf'))).toBe(true);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-15 📎 と subpage が随伴されリンクが切れない', async () => {
        const fx = makeImportFolderFixture('basic');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            // a.md の pageId を拾う
            const findMd = (entries: any[], name: string): any => {
                for (const e of entries) {
                    if (e.kind === 'md' && e.name === name) { return e; }
                    if (e.kind === 'dir') { const r = findMd(e.children, name); if (r) { return r; } }
                }
                return null;
            };
            const aMd = findMd(outcome.entries, 'a.md');
            expect(aMd, 'a.md の md entry が無い').toBeTruthy();

            const pageAbs = path.join(dest.dir, 'pages', `${aMd.pageId}.md`);
            expect(fs.existsSync(pageAbs), '取り込んだ page md が無い').toBe(true);
            const body = fs.readFileSync(pageAbs, 'utf8');

            // 本文中の全参照が dest 側で解決できる（= リンクが切れていない）
            const re = /!?\[\[?[^\]]*\]?\]\(([^)\s]+)\)/g;
            const targets: string[] = [];
            let m: RegExpExecArray | null;
            while ((m = re.exec(body)) !== null) { targets.push(m[1]); }
            expect(targets.length, '参照が 1 つも残っていない（書換で消された）').toBeGreaterThan(0);

            for (const t of targets) {
                if (/^(https?:|data:)/i.test(t)) { continue; }
                let decoded = t;
                try { decoded = decodeURIComponent(t.split(/[?#]/)[0]); } catch { /* keep */ }
                const abs = path.resolve(path.dirname(pageAbs), decoded);
                expect(fs.existsSync(abs), `リンク切れ: ${t} → ${abs}`).toBe(true);
            }
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-16b containment: 絶対パス / ../ escape の実体は複製されない', async () => {
        const fx = makeImportFolderFixture('escape');
        const dest = makeDestNote();
        try {
            await runImport(fx.target, dest.dir);
            // dest 配下に escape 先の内容が現れていない
            const walkAll = (d: string): string[] => {
                const out: string[] = [];
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) { out.push(...walkAll(p)); } else { out.push(p); }
                }
                return out;
            };
            const bodies = walkAll(dest.dir)
                .filter((p) => !p.endsWith('.md') && !p.endsWith('outline.note'))
                .map((p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } });
            expect(bodies, 'escape 先（PNG-outside）が dest に複製された').not.toContain('PNG-outside');
            // 境界内の正常資産は複製されている
            expect(bodies, '境界内の pic.png が複製されていない').toContain('PNG-ok');
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-17 枚数対応: 入力にあった実体が全部出力に現れる（入力 N → 出力 N）', async () => {
        const fx = makeImportFolderFixture('basic');
        const dest = makeDestNote();
        try {
            // 入力の実体を数える（closure 4 件 + closure 外 1 件 = 5）
            const inputCount = fx.closure.length + fx.nonClosure.length;
            expect(inputCount, '前提: basic は 5 実体').toBe(5);

            await runImport(fx.target, dest.dir);

            // 出力の実体を数える（outline.note は台帳なので除く）
            const walkAll = (d: string): string[] => {
                const out: string[] = [];
                for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                    const p = path.join(d, e.name);
                    if (e.isDirectory()) { out.push(...walkAll(p)); } else if (e.name !== 'outline.note') { out.push(p); }
                }
                return out;
            };
            const produced = walkAll(dest.dir);
            expect(produced.length,
                `入力 ${inputCount} 実体に対し出力 ${produced.length} 実体 — `
                + `どれかが落ちている / 二重コピーされている: ${produced.map((p) => path.relative(dest.dir, p)).join(', ')}`)
                .toBe(inputCount);

            // 配置の内訳（実測に基づく確定値。二重コピーが起きたらここで崩れる）
            //   images/ = closure 画像 1（copy-<ts>- 接頭辞が付く = 随伴転送の命名規約）
            //   files/  = closure 📎 1（spec.pdf）+ closure 外 1（orphan.png・importFilesCore 経路）
            //   pages/  = a.md（pageId 命名）+ closure subpage sub.md（元名維持）
            const rels = produced.map((p) => path.relative(dest.dir, p).split(path.sep).join('/')).sort();
            expect(rels.filter((r) => r.startsWith('images/')).length, `images/: ${rels}`).toBe(1);
            expect(rels.filter((r) => r.startsWith('files/')).length, `files/: ${rels}`).toBe(2);
            expect(rels.filter((r) => r.startsWith('pages/')).length, `pages/: ${rels}`).toBe(2);
            // closure 外の orphan.png は元名のまま files/ に入る（node も作られる = TC-OIF-11b）
            expect(rels).toContain('files/orphan.png');
            // closure の 📎 は元名維持（随伴転送の規約: 画像は copy- 接頭辞 / 📎 は元名 + -N uniquify）
            expect(rels).toContain('files/spec.pdf');
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    // ── 再オープン 2026-09-03（TASK-43 / ADRL-0110）: closure 規則をエンジンの複製集合に揃える ──

    /** dest 配下（outline.note 以外）の実体を相対パスで列挙する。 */
    function listDest(destDir: string): string[] {
        const out: string[] = [];
        const walk = (d: string): void => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
                const p = path.join(d, e.name);
                if (e.isDirectory()) { walk(p); } else if (e.name !== 'outline.note') { out.push(path.relative(destDir, p).split(path.sep).join('/')); }
            }
        };
        walk(destDir);
        return out.sort();
    }

    test('TC-OIF-20 プレーンリンク先は closure に入らず node になる（規則 pin rev2 の番人）', async () => {
        const fx = makeImportFolderFixture('plainlinks');
        const dest = makeDestNote();
        try {
            const got = rel(fx.target, walkAndClosure(fx.target).closure);
            expect(got, 'プレーン [text](x.md) が closure に入った（エンジンは複製しないので node にも複製にもならず消える）').not.toContain('chapter1.md');
            expect(got, 'プレーン [text](x.pdf) が closure に入った').not.toContain('report.pdf');

            const { outcome } = await runImport(fx.target, dest.dir);
            expect(outcome.status).toBe('imported');
            const nodes = flatten(outcome.entries);
            expect(nodes, `node 木: ${nodes.join(', ')}`).toContain('docs/md:index.md');
            expect(nodes, 'chapter1.md が node にならなかった（消えた）').toContain('docs/md:chapter1.md');
            expect(nodes, 'report.pdf が node にならなかった（消えた）').toContain('docs/file:report.pdf');
            const produced = listDest(dest.dir);
            expect(produced.filter((r) => r.startsWith('pages/')).length, `pages/: ${produced}`).toBe(2);
            expect(produced.filter((r) => r.startsWith('files/')).length, `files/: ${produced}`).toBe(1);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-21 相互 [[ ]] 参照する走査 md は走査順先頭が node になる（循環 root ルール）', async () => {
        const fx = makeImportFolderFixture('cycle');
        const dest = makeDestNote();
        try {
            const got = rel(fx.target, walkAndClosure(fx.target).closure);
            expect(got, 'root（走査順先頭 a.md）が closure に入っている — 両方抑止で何も取り込まれない').not.toContain('a.md');
            expect(got, 'b.md は a.md の subpage として closure に入るべき').toContain('b.md');

            const { outcome } = await runImport(fx.target, dest.dir);
            const nodes = flatten(outcome.entries);
            expect(nodes, `md が 1 つも node になっていない（相互参照で全滅）: ${nodes.join(', ')}`).toContain('docs/md:a.md');
            expect(nodes).not.toContain('docs/md:b.md');
            const produced = listDest(dest.dir);
            expect(produced.filter((r) => r.startsWith('pages/')).length, `pages/: ${produced}`).toBe(2);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-22 closure ≡ 複製集合: 走査 md / 資産は必ず node か複製のどちらかに落ちる（差集合 = ∅）', async () => {
        const fx = makeImportFolderFixture('mixed');
        const dest = makeDestNote();
        try {
            const { walked, closure } = walkAndClosure(fx.target);
            // (1) closure は fixture が宣言した集合と一致（規則がエンジン側と同じ 3 形式 + 循環 root）
            expect(rel(fx.target, closure)).toEqual([...fx.closure].sort());

            // (2) 走査で見つけた全ファイルを列挙
            const sources: string[] = [];
            const collect = (list: any[]): void => {
                for (const e of list) { if (e.kind === 'dir') { collect(e.children); } else { sources.push(path.relative(fx.target, e.absPath).split(path.sep).join('/')); } }
            };
            collect(walked.entries);
            expect(sources.length).toBe(fx.closure.length + fx.nonClosure.length);

            const { outcome } = await runImport(fx.target, dest.dir);
            const nodeNames = new Set(flatten(outcome.entries).map((l) => l.replace(/^.*:/, '')));
            const produced = listDest(dest.dir).map((r) => path.basename(r));

            // (3) 各 source は「node になった」or「dest に実体が存在する」のどちらか（漏れ 0）
            const lost: string[] = [];
            for (const rel0 of sources) {
                const name = path.basename(rel0);
                const stem = name.replace(/\.[^.]+$/, ''); const ext = name.slice(stem.length);
                const isNode = nodeNames.has(name);
                const copied = produced.some((b) => b === name || b.endsWith('-' + name) || (b.startsWith(stem) && b.endsWith(ext)));
                if (!isNode && !copied) { lost.push(rel0); }
            }
            expect(lost, `node にも複製にもならず消えた実体: ${lost.join(', ')}`).toEqual([]);
            // (4) closure の実体は node になっていない（抑止が効いている）
            for (const c of fx.closure) { expect(nodeNames.has(path.basename(c)), `closure の ${c} に node ができた`).toBe(false); }
            // (5) closure 外は node になっている
            for (const n of fx.nonClosure) { expect(nodeNames.has(path.basename(n)), `closure 外の ${n} が node にならなかった`).toBe(true); }
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    // ── 再オープン 2026-09-03（TASK-44 / FR-OIF-08）: 取り込んだ実体へのプレーンリンクを取込後の位置へ張り替える ──

    /** 取込後の page 本文から `[..](url)` の url を列挙（画像は除く）。 */
    function linkUrls(body: string): string[] {
        const out: string[] = [];
        const re = /(^|[^!])\[\[?[^\]]*\]\]?\(([^)\s]+)\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) { out.push(m[2]); }
        return out;
    }
    function pageBodyOf(pageDir: string, pageId: string): string {
        return fs.readFileSync(path.join(pageDir, `${pageId}.md`), 'utf8');
    }
    function findMd(entries: any[], name: string): any {
        for (const e of entries) {
            if (e.kind === 'md' && e.name === name) { return e; }
            if (e.kind === 'dir') { const r = findMd(e.children, name); if (r) { return r; } }
        }
        return null;
    }

    test('TC-OIF-23 取込後リンクの張り替え: md → pages/<pageId>.md / file → files/<name>（note の外を指さない）', async () => {
        const fx = makeImportFolderFixture('plainlinks');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            const idx = findMd(outcome.entries, 'index.md'); const ch = findMd(outcome.entries, 'chapter1.md');
            expect(idx && ch, 'index.md / chapter1.md の node が無い').toBeTruthy();
            const pageDir = path.join(dest.dir, 'pages');
            const body = pageBodyOf(pageDir, idx.pageId);
            const urls = linkUrls(body);
            expect(urls.length, `リンクが消えた: ${body}`).toBe(2);
            // md リンク → chapter1 の取込先 page（同じ pages/ 内 = ファイル名だけ）
            expect(urls, `md リンクが取込先 page を指していない: ${urls}`).toContain(`${ch.pageId}.md`);
            // file リンク → files/<name>（uniquify 後の名前）
            const fileUrl = urls.find((u) => u !== `${ch.pageId}.md`)!;
            expect(fileUrl, `file リンクが files/ を指していない: ${fileUrl}`).toMatch(/^\.\.\/files\/report(-\d+)?\.pdf$/);
            // 両 url を pages/ 基準で解決して実在 + note 配下（`..` で note の外へ出ない = NFR-DCP-01）
            for (const u of urls) {
                const abs = path.resolve(pageDir, decodeURIComponent(u));
                expect(fs.existsSync(abs), `リンク切れ: ${u}`).toBe(true);
                expect(path.relative(dest.dir, abs).startsWith('..'), `note の外を指している: ${u}`).toBe(false);
            }
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-24 「Outliner に送る」の複数 root を跨いだ張り替え（docs/index.md → ../notes/x.md）', async () => {
        const root = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fx-oif24-'));
        const dest = makeDestNote();
        try {
            const w = (p: string, b: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
            w(path.join(root, 'docs', 'index.md'), '# Index\n\nSee [x](../notes/x.md)\n');
            w(path.join(root, 'notes', 'x.md'), '# X\n');
            const pageDir = path.join(dest.dir, 'pages');
            const outcome = await fi.runSendToOutliner({
                roots: [path.join(root, 'docs'), path.join(root, 'notes', 'x.md')],
                confirmLarge: () => true, notifyLimitExceeded: () => { /* noop */ }, notifySkipped: () => { /* noop */ },
                pageDir, imageDir: path.join(dest.dir, 'images'), fileDir: path.join(dest.dir, 'files'), outDir: dest.dir,
            });
            expect(outcome.status).toBe('imported');
            const idx = findMd(outcome.entries, 'index.md');
            const x = outcome.entries.find((e: any) => e.kind === 'md' && e.name === 'x.md');
            expect(idx && x, `entries: ${JSON.stringify(outcome.entries)}`).toBeTruthy();
            const urls = linkUrls(pageBodyOf(pageDir, idx.pageId));
            expect(urls, 'root を跨いだリンクが x.md の取込先 page を指していない').toEqual([`${x.pageId}.md`]);
        } finally { fs.rmSync(root, { recursive: true, force: true }); dest.cleanup(); }
    });

    test('TC-OIF-25 張り替えの書き込み失敗は page 単位で skip し他は続行（集計に合流・rollback なし）', async () => {
        // 後段パス単体: 2 page のうち片方を読み取り専用にして走らせる
        const dest = makeDestNote();
        const src = fs.mkdtempSync(path.join(require('os').tmpdir(), 'fx-oif25-'));
        try {
            const pageDir = path.join(dest.dir, 'pages');
            const w = (p: string, b: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, b); };
            w(path.join(src, 'a.md'), '# A\n[b](b.md)\n'); w(path.join(src, 'b.md'), '# B\n[a](a.md)\n');
            w(path.join(pageDir, 'pa.md'), '# A\n[b](b.md)\n'); w(path.join(pageDir, 'pb.md'), '# B\n[a](a.md)\n');
            const importedMap = new Map<string, any>([
                [path.join(src, 'a.md'), { kind: 'md', pageId: 'pa', srcDir: src }],
                [path.join(src, 'b.md'), { kind: 'md', pageId: 'pb', srcDir: src }],
            ]);
            fs.chmodSync(path.join(pageDir, 'pb.md'), 0o444);
            const r = fi.rewriteImportedPlainLinks(pageDir, importedMap, ['pa.md', 'pb.md']);
            expect(r.skipped, '書き込めない page が skip として数えられていない').toBe(1);
            expect(r.rewritten, '正常側の page が張り替わっていない（失敗が波及 or rollback）').toBe(1);
            expect(linkUrls(fs.readFileSync(path.join(pageDir, 'pa.md'), 'utf8'))).toEqual(['pb.md']);
            expect(linkUrls(fs.readFileSync(path.join(pageDir, 'pb.md'), 'utf8')), '失敗側はエンジン既定のまま残る').toEqual(['a.md']);
            expect(fs.existsSync(path.join(pageDir, 'pa.md')) && fs.existsSync(path.join(pageDir, 'pb.md')), '実体が消えた').toBe(true);
        } finally { try { fs.chmodSync(path.join(dest.dir, 'pages', 'pb.md'), 0o644); } catch { /* ignore */ } dest.cleanup(); fs.rmSync(src, { recursive: true, force: true }); }
    });

    test('TC-OIF-27 closure 複製 subpage 自身のプレーン file リンクも張り替わる（reviewer iteration 5 DSN-16 / TASK-48）', async () => {
        const fx = makeImportFolderFixture('mixed');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            expect(outcome.status).toBe('imported');
            const pageDir = path.join(dest.dir, 'pages');
            // sub.md は a.md の [[ ]] subpage = closure 複製（元名維持で pages/ に入る）
            const subAbs = path.join(pageDir, 'sub.md');
            expect(fs.existsSync(subAbs), 'closure 複製 sub.md が pages/ に無い').toBe(true);
            const urls = linkUrls(fs.readFileSync(subAbs, 'utf8'));
            expect(urls.length, 'sub.md のプレーンリンクが消えた').toBe(1);
            // notes.pdf は closure 外 = file node → files/ へ。sub.md の元 dir 基準で解決して張り替わる
            expect(urls[0], `原文のまま残っている（元 dir を台帳に持っていない）: ${urls[0]}`).toMatch(/^\.\.\/files\/notes(-\d+)?\.pdf$/);
            expect(fs.existsSync(path.resolve(pageDir, urls[0])), `リンク切れ: ${urls[0]}`).toBe(true);
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-26 張り替えの containment: 絶対パス / ../ escape のプレーンリンクは張り替えも複製もしない（reviewer iteration 5 SEC-5-1 / TASK-49）', async () => {
        const fx = makeImportFolderFixture('escape');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            const a = findMd(outcome.entries, 'a.md');
            expect(a, 'a.md の node が無い').toBeTruthy();
            const pageDir = path.join(dest.dir, 'pages');
            const urls = linkUrls(pageBodyOf(pageDir, a.pageId));
            expect(urls).toHaveLength(2);
            // 絶対パスは字面そのまま（rewriteImportedPlainLinks は isAbsolute で skip・エンジンも触らない）
            expect(urls[0], `絶対パスが書き換わった: ${urls[0]}`).toBe('/etc/passwd');
            // ../ escape はエンジンの既定（ADRL-0078: 参照リンクは元位置への相対に書換）どおり**元の外部ファイル**を指し続ける。
            // 張り替えパスが note 内（pages/ / files/）へ向け直していないことを、解決先の同一性で pin する
            const resolved = path.resolve(pageDir, urls[1]);
            expect(resolved, `../ escape の解決先が変わった: ${urls[1]}`).toBe(path.join(fx.root, 'outside', 'escape.md'));
            expect(resolved.startsWith(dest.dir + path.sep), 'escape リンクが note 内を指すよう張り替えられた').toBe(false);
            // note 側に escape 先の md / 実体が現れない（複製しない）
            expect(fs.readdirSync(pageDir).some((n) => /^escape(-\d+)?\.md$/.test(n)), 'escape.md が pages/ に複製された').toBe(false);
            const filesDir = path.join(dest.dir, 'files');
            const files = fs.existsSync(filesDir) ? fs.readdirSync(filesDir) : [];
            expect(files.some((n) => /passwd|escape/.test(n)), `escape 先が files/ に複製された: ${files}`).toBe(false);
        } finally { fx.cleanup(); dest.cleanup(); }
    });
    test('TC-OIF-28 title 付きプレーンリンクも取込後の位置へ張り替わり title は温存される（reviewer iteration 6 QUAL6-1 / TASK-51）', async () => {
        const fx = makeImportFolderFixture('titled');
        const dest = makeDestNote();
        try {
            const { outcome } = await runImport(fx.target, dest.dir);
            const idx = findMd(outcome.entries, 'index.md');
            const ch1 = findMd(outcome.entries, 'chapter1.md');
            const ch2 = findMd(outcome.entries, 'ch 2.md');
            expect(idx && ch1 && ch2, 'index / chapter1 / ch 2 の node が無い').toBeTruthy();
            const pageDir = path.join(dest.dir, 'pages');
            const body = pageBodyOf(pageDir, idx.pageId);
            // url 部が取込後の位置へ書き換わり、title はそのまま残る
            expect(body, `md リンク（title 付き）が張り替わっていない:\n${body}`).toContain(`](${ch1.pageId}.md "Chapter one")`);
            expect(body, `encode 付き md リンク（title 付き）が張り替わっていない:\n${body}`).toContain(`](${ch2.pageId}.md "two")`);
            expect(body, `file リンク（title 付き）が張り替わっていない:\n${body}`).toMatch(/\]\(\.\.\/files\/report(-\d+)?\.pdf 'R'\)/);
            // 原文の url は残らない
            expect(body).not.toContain('](chapter1.md');
            expect(body).not.toContain('](report.pdf');
            expect(body).not.toContain('](ch%202.md');
        } finally { fx.cleanup(); dest.cleanup(); }
    });

    test('TC-OIF-28b applyLinkUrlRewrites は raw 正規化キーで外れたとき normalizeMdLinkKeys の候補で再照合する（既存 caller の raw キー形は不変）', async () => {
        const body = '[a](x.md "t") [b](<y z.md>) [c](x.md)';
        // (a) title strip 済みキー（normalizeMdLinkKeys 系 caller）→ title 温存で url 部だけ置換
        const outA = pah.applyLinkUrlRewrites(body, new Map([['x.md', 'p.md']]));
        expect(outA).toBe('[a](p.md "t") [b](<y z.md>) [c](p.md)');
        // (b) 従来の raw キー形（title 込み）→ 従来どおり raw span 全体を置換（既存 caller 不変）
        const outB = pah.applyLinkUrlRewrites(body, new Map([['x.md "t"', 'q.md']]));
        expect(outB).toBe('[a](q.md) [b](<y z.md>) [c](x.md)');
        // (c) renames に無いリンクは不変・空 renames は同一文字列
        expect(pah.applyLinkUrlRewrites(body, new Map())).toBe(body);
    });
});
