/**
 * TASK-04 (sprint 20260809-031217-notetree-file-dnd) — Notes 左ツリー panel の
 * 添付ファイル (kind:'file') 対応 番人。対象: src/shared/notes-file-panel.js。
 *
 * ハーネス方針:
 *   標準の standalone-notes.html + __testApi は「git commit 済みの build 成果物」で、
 *   `npx playwright test <SPEC>` は build を再生成しない（pretest は compile+lint のみ）。
 *   さらにその test bridge は本 sprint 新設の bridge メソッド (openTreeFileExternal /
 *   notesRegisterFileFromOutNode 等) を持たず、build-standalone-notes.js は本 TASK の
 *   変更ファイル外。よって現在ソースを常に反映する形として、
 *     about:blank + setContent(notes-body-html の panel HTML)
 *       + addScriptTag(現ソースの notes-file-panel.js)
 *       + 自前 spy bridge（全 bridge 呼び出しを window.__calls に記録）
 *   を用いる（editor-caret-scroll-follow.spec.ts の addScriptTag 前例と同型）。
 *
 * 対象 TC:
 *   TC-WV-01  createFileElement の 3 値描画 (out/md/file) — file は is-attach + paperclip icon + fileExt='file'
 *   TC-WV-04  外部 .md/.pdf 混在 drop → notesRegisterExternalMd が md(content) と file(bytes) を両方載せる（silent skip 無し）
 *   TC-WV-05  file 右クリックメニュー = 専用 8 項目集合（Copy In-App Link / Open in new tab は非表示）。out は両者を表示（対比）
 *   TC-WV-06  Explore 名前検索が「タイトル≠ファイル名」でも basename 部分一致でヒットし badge [file]
 *   TC-WV-07  dragend が one-shot drag state を clear（file→out drop は正制御で発火・dragend 後の空 drop は不発）
 *   TC-WV-11  dragstart(file) は x-fractal-tree-file {id} のみ積む（tree-md は積まない）／ md は逆
 *   TC-WV-12  drop x-fractal-out-node-file → notesRegisterFileFromOutNode（subpage 経路へ誤流入しない）
 *   TC-WV-13  drop x-fractal-md-filelink → notesRegisterFileFromMdLink（MIME 判別・notesRegisterSubpageFromMd 不発）
 */
import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const PANEL_JS = fs.readFileSync(
    path.join(__dirname, '../../src/shared/notes-file-panel.js'), 'utf8');
// panel の DOM（必要 id を全て含む）を Node 側で生成して setContent に流す。
// notes-body-html.js は vscode 非依存で require 可能。
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { generateNotesFilePanelHtml } = require('../../src/shared/notes-body-html.js');
const PANEL = generateNotesFilePanelHtml({ collapsed: false, messages: {} });

interface LoadOpts {
    fileList: any[];
    currentFile?: string | null;
    structure: any;
    noteFolderName?: string;
}

async function loadPanel(page: Page, opts: LoadOpts): Promise<void> {
    await page.goto('about:blank');
    await page.setContent(
        '<!DOCTYPE html><html><head><meta charset="utf-8">' +
        '<style>' + PANEL.css + '</style>' +
        // ratio 計算 (drop 位置判定) が成立するよう item に確定高さを与える（test 専用・挙動非干渉）
        '<style>.file-panel-item{min-height:22px;} .file-panel-folder-header{min-height:22px;}</style>' +
        '</head><body>' + PANEL.html + '</body></html>');

    // IIFE が load 時に読む global を addScriptTag より前に設定する。
    await page.evaluate(() => {
        const w = window as any;
        w.__outlinerMessages = {};              // i18n = window.__outlinerMessages || {}
        // InAppLinkUtils を用意 → out/md メニューは「Copy In-App Link」を出す。
        // これで file メニューでの非表示が load-bearing な negative になる（vacuous でない）。
        w.InAppLinkUtils = {
            buildMdLink: () => 'fractal://note/MyNote/md/x',
            buildOutLink: () => 'fractal://note/MyNote/out/x',
        };
        w.__calls = [];
        w.__makeBridge = function () {
            const rec = (type: string) => function () {
                const args = Array.prototype.slice.call(arguments);
                w.__calls.push({ type, args });
                if (type === 'onSearchStart') w.__onSearchStart = args[0];
            };
            // 任意メソッドを recorder として返す Proxy（全 if(bridge.x) ガードを通過し記録）。
            return new Proxy({}, {
                get(_t, prop) {
                    if (typeof prop !== 'string') return undefined;
                    return rec(prop);
                },
            });
        };
    });

    await page.addScriptTag({ content: PANEL_JS });

    await page.evaluate((o) => {
        const w = window as any;
        w.notesFilePanel.init(
            w.__makeBridge(), o.fileList, o.currentFile || null, o.structure,
            null, o.noteFolderName || 'MyNote');
        w.__calls = []; // init 中の登録呼び出しを捨て、action だけ観測する
    }, opts as any);
}

// ── TC-WV-01: createFileElement 3 値描画 ──
test.describe('TASK-04 — Notes tree file panel (notes-file-panel.js)', () => {
    test('TC-WV-01 kind 別描画: file→is-attach+paperclip+fileExt=file / md→is-md / out→plain（拡張子推測は kind に劣後）', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' },
                { id: 'm1', filePath: '/n/doc.md', title: 'Doc', kind: 'md' },
                { id: 'a1', filePath: '/n/files/photo.png', title: 'photo.png', kind: 'file' },
                // counterfactual: kind='file' だが名前が .md。拡張子推測なら md になるが kind 優先で file。
                { id: 'a2', filePath: '/n/files/weird.md', title: 'weird.md', kind: 'file' },
                // 後方互換: kind 未付与の旧 entry は拡張子推測（file 扱いにはしない）。
                { id: 'bc', filePath: '/n/legacy.md', title: 'Legacy' },
            ],
            structure: {
                version: 1, rootIds: ['o1', 'm1', 'a1', 'a2', 'bc'],
                items: {
                    o1: { type: 'file', id: 'o1', title: 'Plan' },
                    m1: { type: 'file', id: 'm1', title: 'Doc' },
                    a1: { type: 'file', id: 'a1', title: 'photo.png' },
                    a2: { type: 'file', id: 'a2', title: 'weird.md' },
                    bc: { type: 'file', id: 'bc', title: 'Legacy' },
                },
            },
        });

        const r = await page.evaluate(() => {
            const q = (id: string) => document.querySelector('[data-item-id="' + id + '"]') as HTMLElement;
            const info = (id: string) => {
                const el = q(id);
                return {
                    exists: !!el,
                    fileExt: el ? el.dataset.fileExt : null,
                    isAttach: el ? el.classList.contains('is-attach') : false,
                    isMd: el ? el.classList.contains('is-md') : false,
                    hasAttachIcon: el ? !!el.querySelector('svg.file-panel-attach-icon') : false,
                };
            };
            return { o1: info('o1'), m1: info('m1'), a1: info('a1'), a2: info('a2'), bc: info('bc') };
        });

        // 添付 file: is-attach + paperclip icon + fileExt='file'（md でない）
        expect(r.a1.exists).toBe(true);
        expect(r.a1.fileExt).toBe('file');
        expect(r.a1.isAttach).toBe(true);
        expect(r.a1.isMd).toBe(false);
        expect(r.a1.hasAttachIcon).toBe(true);
        // 名前が .md でも kind='file' → file 扱い（拡張子推測に劣後する = counterfactual）
        expect(r.a2.fileExt).toBe('file');
        expect(r.a2.isAttach).toBe(true);
        expect(r.a2.isMd).toBe(false);
        expect(r.a2.hasAttachIcon).toBe(true);
        // md item: fileExt='md' / is-md / paperclip 無し
        expect(r.m1.fileExt).toBe('md');
        expect(r.m1.isMd).toBe(true);
        expect(r.m1.isAttach).toBe(false);
        expect(r.m1.hasAttachIcon).toBe(false);
        // out item: fileExt='out' / どちらのクラスも無し / paperclip 無し
        expect(r.o1.fileExt).toBe('out');
        expect(r.o1.isMd).toBe(false);
        expect(r.o1.isAttach).toBe(false);
        expect(r.o1.hasAttachIcon).toBe(false);
        // 後方互換: kind 無し + .md → md 推測（file 扱いにはならない）
        expect(r.bc.fileExt).toBe('md');
        expect(r.bc.isMd).toBe(true);
        expect(r.bc.isAttach).toBe(false);
    });

    // ── TC-WV-04: 外部 .md/.pdf 混在 drop → md(content)+file(bytes) 両方（silent skip 無し）──
    test('TC-WV-04 外部 .md/.pdf 混在 drop → notesRegisterExternalMd が md(content) と file(bytes) を両方載せる', async ({ page }) => {
        await loadPanel(page, {
            fileList: [{ id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' }],
            structure: { version: 1, rootIds: ['o1'], items: { o1: { type: 'file', id: 'o1', title: 'Plan' } } },
        });

        await page.evaluate(() => {
            const dst = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.items.add(new File(['# hello'], 'note.md', { type: 'text/markdown' }));
            dt.items.add(new File([new Uint8Array([1, 2, 3, 4])], 'report.pdf', { type: 'application/pdf' }));
            const rr = dst.getBoundingClientRect();
            dst.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));
        });

        // FileReader 非同期 → notesRegisterExternalMd 到着を待つ
        await page.waitForFunction(() => (window as any).__calls.some((c: any) => c.type === 'notesRegisterExternalMd'));

        const payload = await page.evaluate(() => {
            const c = (window as any).__calls.find((x: any) => x.type === 'notesRegisterExternalMd');
            return c ? c.args[0] : null;
        });

        expect(Array.isArray(payload)).toBe(true);
        expect(payload.length).toBe(2); // 非 md を silent skip しない（旧挙動なら 1 = RED）
        const md = payload.find((p: any) => p.kind === 'md');
        const file = payload.find((p: any) => p.kind === 'file');
        expect(md).toBeTruthy();
        expect(md.name).toBe('note.md');
        expect(md.content).toBe('# hello');
        expect(file).toBeTruthy();
        expect(file.name).toBe('report.pdf');
        expect(typeof file.bytes).toBe('string');
        expect(file.bytes.length).toBeGreaterThan(0);
        expect(file.bytes).toBe('AQIDBA=='); // base64([1,2,3,4])
    });

    // ── TC-WV-05: file 右クリックメニュー集合 ──
    // rev (design_gap SYS-1 / ユーザー裁定 2026-08-10): FR-TF-10「共通項目（New Outline here /
    // New Markdown here / New Subfolder）は従来どおり表示」が正。旧版は not.toContain で逆方向 pin していた。
    test('TC-WV-05 file メニュー = 専用 8 項目 + 共通 3 項目（Copy In-App Link / Open in new tab は非表示）。out は両者を表示', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'a1', filePath: '/n/files/photo.png', title: 'photo.png', kind: 'file' },
                { id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' },
            ],
            structure: {
                version: 1, rootIds: ['a1', 'o1'],
                items: {
                    a1: { type: 'file', id: 'a1', title: 'photo.png' },
                    o1: { type: 'file', id: 'o1', title: 'Plan' },
                },
            },
        });

        const labels = await page.evaluate(() => {
            const read = (id: string) => {
                const el = document.querySelector('[data-item-id="' + id + '"]') as HTMLElement;
                el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }));
                const items = Array.from(document.querySelectorAll('.file-panel-context-menu .file-panel-context-item'));
                return items.map((n) => (n.textContent || '').trim());
            };
            const fileLabels = read('a1');   // 先に読み取る（次の contextmenu が closeContextMenu で消す）
            const outLabels = read('o1');
            return { fileLabels, outLabels };
        });

        // file メニュー: 専用 8 項目 + 共通 3 項目（FR-TF-10「共通項目は従来どおり表示」）・順序込み
        expect(labels.fileLabels).toEqual([
            'Open',
            'Reveal in Finder',
            'Rename',
            '☆ Add to Favorites',
            'Copy Path',
            'Set Color',
            'Move Other Note',
            'New Outline here',
            'New Markdown here',
            'New Subfolder',
            'Delete',
        ]);
        // file では出さない
        expect(labels.fileLabels).not.toContain('Copy In-App Link');
        expect(labels.fileLabels).not.toContain('Open in new tab');
        // out（対比）: Copy In-App Link と Open in new tab を出す
        // → file 側の非表示は「InAppLinkUtils 不在」ではなく file branch 固有と確定できる
        expect(labels.outLabels).toContain('Copy In-App Link');
        expect(labels.outLabels).toContain('Open in new tab');
    });

    // ── TC-WV-06: Explore 名前検索の filename 部分一致 + [file] badge ──
    test('TC-WV-06 タイトル≠ファイル名でも basename 部分一致で Explore ヒット・badge [file]', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'a1', filePath: '/n/files/quarterly-report.pdf', title: 'My Doc', kind: 'file' },
                { id: 'o1', filePath: '/n/zzz.out', title: 'Zzz', kind: 'out' },
            ],
            structure: {
                version: 1, rootIds: ['a1', 'o1'],
                items: {
                    a1: { type: 'file', id: 'a1', title: 'My Doc' },
                    o1: { type: 'file', id: 'o1', title: 'Zzz' },
                },
            },
        });

        const r = await page.evaluate(() => {
            const input = document.getElementById('notesSearchInput') as HTMLInputElement;
            input.value = 'quarter'; // タイトル 'My Doc' には無い・ファイル名 basename にのみ在る
            (window as any).__onSearchStart(1); // panel が bridge.onSearchStart(cb) で登録した cb
            const matches = Array.from(document.querySelectorAll('#notesSearchResults .file-panel-search-match'));
            return matches.map((m) => (m.textContent || '').trim());
        });

        // filename 部分一致節が無ければ 0 件（title のみ照合 = RED）。1 件ヒットする。
        const attachHit = r.filter((t) => t.indexOf('My Doc') !== -1);
        expect(attachHit.length).toBe(1);
        expect(attachHit[0]).toContain('[file]'); // out なら [out]
        // out は 'quarter' に一致しない
        expect(r.some((t) => t.indexOf('[out]') !== -1)).toBe(false);
    });

    // ── TC-WV-07: dragend が one-shot drag state を clear ──
    test('TC-WV-07 dragend が one-shot drag state を clear（file→out は正制御で発火・dragend 後の空 drop は不発）', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'a1', filePath: '/n/files/photo.png', title: 'photo.png', kind: 'file' },
                { id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' },
            ],
            structure: {
                version: 1, rootIds: ['a1', 'o1'],
                items: {
                    a1: { type: 'file', id: 'a1', title: 'photo.png' },
                    o1: { type: 'file', id: 'o1', title: 'Plan' },
                },
            },
        });

        // 正制御: dragstart(file a1) → o1 中央 drop → notesImportFileIntoOut(a1,o1)
        const positive = await page.evaluate(() => {
            const w = window as any;
            w.__calls = [];
            const src = document.querySelector('[data-item-id="a1"]') as HTMLElement;
            const dst = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            const rr = dst.getBoundingClientRect();
            dst.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            return w.__calls.filter((c: any) => c.type === 'notesImportFileIntoOut');
        });
        expect(positive.length).toBe(1);
        expect(positive[0].args).toEqual(['a1', 'o1']);

        // ガード: dragstart(file a1) → dragend（state clear）→ 空 DataTransfer で o1 中央に drop
        //   dragend が dragItemId / dragSourceFileExt を null 化 → 空 drop は早期 return して不発。
        //   （dragend reset を外すと stale state で notesImportFileIntoOut が発火 = RED）
        const guard = await page.evaluate(() => {
            const w = window as any;
            w.__calls = [];
            const src = document.querySelector('[data-item-id="a1"]') as HTMLElement;
            const dst = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const dt = new DataTransfer();
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: dt }));
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: dt }));
            const rr = dst.getBoundingClientRect();
            dst.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: new DataTransfer(),
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));
            return {
                importFile: w.__calls.filter((c: any) => c.type === 'notesImportFileIntoOut').length,
                move: w.__calls.filter((c: any) => c.type === 'moveItem').length,
            };
        });
        expect(guard.importFile).toBe(0); // stale state で発火しない
        expect(guard.move).toBe(0);
    });

    // ── TC-WV-11: dragstart payload の MIME 相互排他 ──
    test('TC-WV-11 dragstart(file) は x-fractal-tree-file {id} のみ・tree-md は積まない／md は逆', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'a1', filePath: '/n/files/photo.png', title: 'photo.png', kind: 'file' },
                { id: 'm1', filePath: '/n/doc.md', title: 'Doc', kind: 'md' },
            ],
            structure: {
                version: 1, rootIds: ['a1', 'm1'],
                items: {
                    a1: { type: 'file', id: 'a1', title: 'photo.png' },
                    m1: { type: 'file', id: 'm1', title: 'Doc' },
                },
            },
        });

        const r = await page.evaluate(() => {
            // setData を spy（dispatch 後の getData は protected-mode で不安定なため setData 側で捕捉）
            const orig = DataTransfer.prototype.setData;
            const dragstartSetData = (id: string) => {
                const calls: Array<{ type: string; data: string }> = [];
                (DataTransfer.prototype as any).setData = function (type: string, data: string) {
                    calls.push({ type, data });
                    return orig.call(this, type, data);
                };
                try {
                    const el = document.querySelector('[data-item-id="' + id + '"]') as HTMLElement;
                    el.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
                    el.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
                } finally {
                    (DataTransfer.prototype as any).setData = orig;
                }
                return calls;
            };
            return { file: dragstartSetData('a1'), md: dragstartSetData('m1') };
        });

        const TREE_FILE = 'application/x-fractal-tree-file';
        const TREE_MD = 'application/x-fractal-tree-md';
        // file item: tree-file を積み、tree-md は積まない
        const fileMimes = r.file.map((c: any) => c.type);
        expect(fileMimes).toContain(TREE_FILE);
        expect(fileMimes).not.toContain(TREE_MD);
        const treeFilePayload = JSON.parse(r.file.find((c: any) => c.type === TREE_FILE).data);
        expect(treeFilePayload).toEqual({ id: 'a1' }); // {id} のみ（絶対パス・filename を積まない = NFR-TF-02）
        expect(Object.keys(treeFilePayload)).toEqual(['id']);
        // md item: tree-md を積み、tree-file は積まない
        const mdMimes = r.md.map((c: any) => c.type);
        expect(mdMimes).toContain(TREE_MD);
        expect(mdMimes).not.toContain(TREE_FILE);
    });

    // ── TC-WV-12: drop x-fractal-out-node-file → notesRegisterFileFromOutNode ──
    test('TC-WV-12 drop x-fractal-out-node-file → notesRegisterFileFromOutNode（subpage 経路へ誤流入しない）', async ({ page }) => {
        await loadPanel(page, {
            fileList: [{ id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' }],
            structure: { version: 1, rootIds: ['o1'], items: { o1: { type: 'file', id: 'o1', title: 'Plan' } } },
        });

        const r = await page.evaluate(() => {
            const w = window as any;
            w.__calls = [];
            const dst = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const dt = new DataTransfer();
            dt.setData('application/x-fractal-out-node-file', JSON.stringify({ outFileKey: '/n/src.out', nodeId: 'node-1' }));
            const rr = dst.getBoundingClientRect();
            dst.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));
            return {
                fromOutNode: w.__calls.filter((c: any) => c.type === 'notesRegisterFileFromOutNode'),
                subpage: w.__calls.filter((c: any) => c.type === 'notesRegisterSubpageFromMd').length,
                fromMdLink: w.__calls.filter((c: any) => c.type === 'notesRegisterFileFromMdLink').length,
            };
        });

        expect(r.fromOutNode.length).toBe(1);
        expect(r.fromOutNode[0].args[0]).toEqual({ outFileKey: '/n/src.out', nodeId: 'node-1' }); // payload
        expect(r.subpage).toBe(0);   // subpage 経路へ誤流入しない
        expect(r.fromMdLink).toBe(0);
    });

    // ── TC-WV-13: drop x-fractal-md-filelink → notesRegisterFileFromMdLink（MIME 判別）──
    test('TC-WV-13 drop x-fractal-md-filelink → notesRegisterFileFromMdLink（同一 shape の subpage へ誤流入しない）', async ({ page }) => {
        await loadPanel(page, {
            fileList: [{ id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' }],
            structure: { version: 1, rootIds: ['o1'], items: { o1: { type: 'file', id: 'o1', title: 'Plan' } } },
        });

        const r = await page.evaluate(() => {
            const w = window as any;
            w.__calls = [];
            const dst = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const dt = new DataTransfer();
            // md-filelink と md-subpage は payload shape が同一 {href, sourceMdPath}。
            // filelink の MIME のみ積む → MIME 判別なら filelink 経路、shape 判別なら誤って subpage 経路。
            dt.setData('application/x-fractal-md-filelink', JSON.stringify({ href: 'files/a.pdf', sourceMdPath: '/n/doc.md' }));
            const rr = dst.getBoundingClientRect();
            dst.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));
            return {
                fromMdLink: w.__calls.filter((c: any) => c.type === 'notesRegisterFileFromMdLink'),
                subpage: w.__calls.filter((c: any) => c.type === 'notesRegisterSubpageFromMd').length,
            };
        });

        expect(r.fromMdLink.length).toBe(1);
        expect(r.fromMdLink[0].args[0]).toEqual({ href: 'files/a.pdf', sourceMdPath: '/n/doc.md' });
        expect(r.subpage).toBe(0); // MIME 判別（shape 判別で subpage に取り違えると RED）
    });

    // ── TC-MX-03 (FR-TF-05b 信頼性 2026-08-10): listEl fallback（谷間/余白）drop の file MIME 配線 ──
    // item 直上でなく listEl 自体（余白）に drop した場合も notesRegisterFileFromOutNode /
    // notesRegisterFileFromMdLink がルート末尾 index で呼ばれる（counterfactual: fallback 配線を
    // 外すと dragover 非 preventDefault で drop 不発 = 呼ばれず RED —「補助線だけ出て移動しない」の番人）。
    test('TC-MX-03 listEl 余白への out-node-file / md-filelink drop → ルート末尾に登録', async ({ page }) => {
        await loadPanel(page, {
            fileList: [{ id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' }],
            structure: { version: 1, rootIds: ['o1'], items: { o1: { type: 'file', id: 'o1', title: 'Plan' } } },
        });

        const r = await page.evaluate(() => {
            const w = window as any;
            w.__calls = [];
            const list = document.getElementById('notesFileList') as HTMLElement;
            const rr = list.getBoundingClientRect();
            const fire = (mime: string, payload: any) => {
                const dt = new DataTransfer();
                dt.setData(mime, JSON.stringify(payload));
                // 余白 = listEl 自身を target にする（item 要素外の座標）
                const over = new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rr.left + 10, clientY: rr.bottom - 4 });
                Object.defineProperty(over, 'target', { value: list });
                list.dispatchEvent(over);
                const preventedOver = over.defaultPrevented;
                const drop = new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt, clientX: rr.left + 10, clientY: rr.bottom - 4 });
                Object.defineProperty(drop, 'target', { value: list });
                list.dispatchEvent(drop);
                return preventedOver;
            };
            const overOF = fire('application/x-fractal-out-node-file', { outFileKey: '/n/src.out', nodeId: 'node-9' });
            const overFL = fire('application/x-fractal-md-filelink', { href: 'files/z.pdf', sourceMdPath: '/n/doc.md' });
            return {
                overOF, overFL,
                fromOutNode: w.__calls.filter((c: any) => c.type === 'notesRegisterFileFromOutNode'),
                fromMdLink: w.__calls.filter((c: any) => c.type === 'notesRegisterFileFromMdLink'),
            };
        });

        expect(r.overOF).toBe(true); // dragover が preventDefault（drop 発火の前提）
        expect(r.overFL).toBe(true);
        expect(r.fromOutNode.length).toBe(1);
        expect(r.fromOutNode[0].args[1]).toBe(null); // parentId = root
        expect(r.fromOutNode[0].args[2]).toBe(1);    // index = rootIds.length（末尾）
        expect(r.fromMdLink.length).toBe(1);
        expect(r.fromMdLink[0].args[1]).toBe(null);
        expect(r.fromMdLink[0].args[2]).toBe(1);
    });

    // ── TC-WV-14: openAttachExternal の click/pointerup 二重発火デデュープ（400ms + id）──
    // file item は click と pointerup 保険の両経路から openAttachExternal を呼ぶため、
    // 短時間の同一 id 連打は 1 回に潰す（counterfactual: dedup を外すと 2 回 = RED）。
    test('TC-WV-14 file click の連続 2 回は openTreeFileExternal 1 回・別 id は即時可・400ms 経過後は再発火', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'a1', filePath: '/n/files/one.pdf', title: 'one.pdf', kind: 'file' },
                { id: 'a2', filePath: '/n/files/two.pdf', title: 'two.pdf', kind: 'file' },
            ],
            structure: {
                version: 1, rootIds: ['a1', 'a2'],
                items: {
                    a1: { type: 'file', id: 'a1', title: 'one.pdf' },
                    a2: { type: 'file', id: 'a2', title: 'two.pdf' },
                },
            },
        });

        // Date.now を制御して 400ms 窓を決定論でテストする（実時間 sleep を使わない）
        const r = await page.evaluate(() => {
            const w = window as any;
            const realNow = Date.now;
            let t = realNow();
            Date.now = () => t;
            try {
                const click = (id: string) => {
                    (document.querySelector('[data-item-id="' + id + '"]') as HTMLElement).click();
                };
                const count = (id: string) =>
                    w.__calls.filter((c: any) => c.type === 'openTreeFileExternal' && c.args[0] === id).length;

                // (1) 同一 id 連続 2 回（同時刻）→ 1 回だけ
                w.__calls = [];
                click('a1'); click('a1');
                const dup = count('a1');

                // (2) 直後の別 id は即時可
                click('a2');
                const other = count('a2');

                // (3) 400ms 経過後は同一 id でも再発火（a2 の直後に a1 へ戻るケースも id が違うので即時、
                //     ここでは a2 → a2 を時間経過で検証）
                t += 401;
                click('a2');
                const after = count('a2');

                return { dup, other, after };
            } finally {
                Date.now = realNow;
            }
        });

        expect(r.dup).toBe(1);    // counterfactual: dedup を外すと 2
        expect(r.other).toBe(1);  // 別 id は dedup に阻まれない
        expect(r.after).toBe(2);  // 400ms 経過後は同一 id でも再発火
    });

    // ═══════════════════════════════════════════════════════════════════
    // 再オープン③ (2026-08-10): FR-TF-16 drag 中 hover 色抑止（TC-HV-01/02/03）
    // ═══════════════════════════════════════════════════════════════════

    const HV_FIXTURE = {
        fileList: [
            { id: 'a1', filePath: '/n/files/photo.png', title: 'photo.png', kind: 'file' },
            { id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' },
        ],
        structure: {
            version: 1, rootIds: ['a1', 'o1'],
            items: {
                a1: { type: 'file', id: 'a1', title: 'photo.png' },
                o1: { type: 'file', id: 'o1', title: 'Plan' },
            },
        },
    };

    // ── TC-HV-01: dragover / dragenter / 内部 dragstart で body.fr-drag-active が付く（冪等）──
    test('TC-HV-01 panel 内 dragover で body.fr-drag-active が付与される（外部/内部・冪等）', async ({ page }) => {
        await loadPanel(page, HV_FIXTURE);

        const r = await page.evaluate(() => {
            const item = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const rr = item.getBoundingClientRect();
            const has = () => document.body.classList.contains('fr-drag-active');

            // 外部 Files drag: dragover のみ届く（dragstart/dragend は届かない）
            const dtExt = new DataTransfer();
            dtExt.items.add(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
            const mk = (type: string) => new DragEvent(type, {
                bubbles: true, cancelable: true, dataTransfer: dtExt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            });
            const before = has();
            item.dispatchEvent(mk('dragenter'));
            const afterEnter = has();
            item.dispatchEvent(mk('dragover'));
            item.dispatchEvent(mk('dragover')); // 冪等（連続 dragover で例外なし）
            const afterOver = has();
            // 掃除して内部 drag を検証
            document.body.classList.remove('fr-drag-active');
            const src = document.querySelector('[data-item-id="a1"]') as HTMLElement;
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
            const afterInternalStart = has();
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
            return { before, afterEnter, afterOver, afterInternalStart };
        });

        expect(r.before).toBe(false);
        expect(r.afterEnter).toBe(true);   // dragenter で set
        expect(r.afterOver).toBe(true);    // dragover でも set（冪等）
        expect(r.afterInternalStart).toBe(true); // 内部 dragstart でも set
    });

    // ── TC-HV-02: clear 全系統（drop / relaxed dragleave / dragend / window 安全網）──
    test('TC-HV-02 fr-drag-active の clear 4 系統（drop / dragleave外 / dragend / window 安全網）', async ({ page }) => {
        await loadPanel(page, HV_FIXTURE);

        const r = await page.evaluate(() => {
            const w = window as any;
            const item = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const rr = item.getBoundingClientRect();
            const has = () => document.body.classList.contains('fr-drag-active');
            const extDt = () => {
                const dt = new DataTransfer();
                dt.items.add(new File(['x'], 'a.pdf', { type: 'application/pdf' }));
                return dt;
            };
            const over = (dt: DataTransfer) => item.dispatchEvent(new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));

            // ① drop で clear（外部 drop）
            w.__calls = [];
            let dt = extDt();
            over(dt);
            const set1 = has();
            item.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.5,
            }));
            const afterDrop = has();

            // ② relaxed dragleave（relatedTarget=null = panel 外へ）で clear
            dt = extDt();
            over(dt);
            const set2 = has();
            item.dispatchEvent(new DragEvent('dragleave', {
                bubbles: true, cancelable: true, dataTransfer: dt, relatedTarget: null,
            }));
            const afterLeaveOut = has();

            // ②b panel 内要素への dragleave（relatedTarget = panel 内）では clear しない
            dt = extDt();
            over(dt);
            const inner = document.querySelector('[data-item-id="a1"]') as HTMLElement;
            const ev: any = new DragEvent('dragleave', { bubbles: true, cancelable: true, dataTransfer: dt });
            Object.defineProperty(ev, 'relatedTarget', { value: inner });
            item.dispatchEvent(ev);
            const afterLeaveInner = has();
            document.body.classList.remove('fr-drag-active');

            // ③ 内部 drag の dragend で clear
            const src = document.querySelector('[data-item-id="a1"]') as HTMLElement;
            src.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: new DataTransfer() }));
            const set3 = has();
            src.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
            const afterDragend = has();

            // ④ window 安全網（dragend capture — item ハンドラ経由でない終了）
            document.body.classList.add('fr-drag-active');
            window.dispatchEvent(new DragEvent('dragend', { bubbles: true }));
            const afterWindowSafety = has();

            return { set1, afterDrop, set2, afterLeaveOut, afterLeaveInner, set3, afterDragend, afterWindowSafety };
        });

        expect(r.set1).toBe(true);
        expect(r.afterDrop).toBe(false);        // ① drop で clear
        expect(r.set2).toBe(true);
        expect(r.afterLeaveOut).toBe(false);    // ② panel 外への dragleave で clear
        expect(r.afterLeaveInner).toBe(true);   // ②b panel 内移動では clear しない（hover 抑止が途切れない）
        expect(r.set3).toBe(true);
        expect(r.afterDragend).toBe(false);     // ③ dragend で clear
        expect(r.afterWindowSafety).toBe(false); // ④ window 安全網で clear
    });

    // ── TC-HV-03: CSS — fr-drag-active 下で hover 打ち消し・drop 専用表示は生存 ──
    test('TC-HV-03 body.fr-drag-active 下で item/folder hover が transparent・drag-over 表示は生きる', async ({ page }) => {
        await loadPanel(page, HV_FIXTURE);

        const r = await page.evaluate(() => {
            const item = document.querySelector('[data-item-id="a1"]') as HTMLElement;
            document.body.classList.add('fr-drag-active');
            // :hover は pointer 依存で合成不能 → CSSOM から規則の存在 + 適用値を代理検証。
            // fr-drag-active 下の hover 打ち消し規則が style sheet に存在するか
            let guardRule = false;
            for (const sheet of Array.from(document.styleSheets)) {
                let rules: CSSRuleList;
                try { rules = (sheet as CSSStyleSheet).cssRules; } catch { continue; }
                for (const rule of Array.from(rules)) {
                    const sel = (rule as CSSStyleRule).selectorText || '';
                    if (sel.includes('fr-drag-active') && sel.includes('.file-panel-item:hover')) {
                        const bg = (rule as CSSStyleRule).style.background ||
                                   (rule as CSSStyleRule).style.backgroundColor;
                        if (bg === 'transparent' || bg === 'rgba(0, 0, 0, 0)') {
                            // folder header も同規則に含まれるか
                            guardRule = sel.includes('.file-panel-folder-header:hover') &&
                                        sel.includes('.file-panel-item.active:hover');
                        }
                    }
                }
            }
            // drop 専用表示は fr-drag-active 下でも点灯する（counterfactual: * !important 方式だと死ぬ）
            item.classList.add('file-panel-drag-over');
            const dragOverBg = getComputedStyle(item).backgroundColor;
            item.classList.remove('file-panel-drag-over');
            document.body.classList.remove('fr-drag-active');
            return { guardRule, dragOverBg };
        });

        expect(r.guardRule).toBe(true); // 3 セレクタ揃いの打ち消し規則が存在
        // drag-over の highlight 色（transparent でない）が生きている
        expect(r.dragOverBg).not.toBe('rgba(0, 0, 0, 0)');
        expect(r.dragOverBg).not.toBe('transparent');
    });


    // ═══════════════════════════════════════════════════════════════════
    // 再オープン③ (2026-08-10): FR-TF-17 uri-list webview 側（TC-UL-01/02）
    // ═══════════════════════════════════════════════════════════════════

    // ── TC-UL-01: isVscodeUriListDrag 判定（dragover 受理で代理検証）──
    // ── TC-UL-02: 6 配線点（dragover 3 + drop 3）の対称配線 ──
    test('TC-UL-01/02 uri-list drag が全配線点で受理され notesRegisterExternalUris が呼ばれる', async ({ page }) => {
        await loadPanel(page, {
            fileList: [
                { id: 'o1', filePath: '/n/plan.out', title: 'Plan', kind: 'out' },
                { id: 'f1', filePath: null, title: 'Folder', kind: undefined },
            ],
            structure: {
                version: 1, rootIds: ['o1', 'fold1'],
                items: {
                    o1: { type: 'file', id: 'o1', title: 'Plan' },
                    fold1: { type: 'folder', id: 'fold1', title: 'Folder', childIds: [], collapsed: false },
                },
            },
        });

        const r = await page.evaluate(() => {
            const w = window as any;
            const URI_MIME = 'application/vnd.code.uri-list';
            const uris = 'file:///tmp/a.md\r\nfile:///tmp/b.pdf';
            const mkDt = () => {
                const dt = new DataTransfer();
                dt.setData(URI_MIME, uris);
                return dt;
            };
            const calls = () => w.__calls.filter((c: any) => c.type === 'notesRegisterExternalUris');

            const out: any = {};

            // (1) item 上（setupDropTarget）: dragover が preventDefault + drop で bridge 呼び出し
            w.__calls = [];
            const item = document.querySelector('[data-item-id="o1"]') as HTMLElement;
            const rr = item.getBoundingClientRect();
            let dt = mkDt();
            const ov1 = new DragEvent('dragover', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.3, // 上半分 = before
            });
            item.dispatchEvent(ov1);
            out.itemOverAccepted = ov1.defaultPrevented; // counterfactual: 配線なしだと false
            item.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dt,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.3,
            }));
            out.itemDrop = calls().map((c: any) => c.args)[0] || null; // [uris[], parentId, index]

            // (2) listEl 余白: root 末尾へ
            w.__calls = [];
            const listEl = document.getElementById('notesFileList') as HTMLElement;
            dt = mkDt();
            const ov2 = new DragEvent('dragover', { bubbles: false, cancelable: true, dataTransfer: dt });
            Object.defineProperty(ov2, 'target', { value: listEl });
            listEl.dispatchEvent(ov2);
            out.listOverAccepted = ov2.defaultPrevented;
            const dp2 = new DragEvent('drop', { bubbles: false, cancelable: true, dataTransfer: dt });
            Object.defineProperty(dp2, 'target', { value: listEl });
            listEl.dispatchEvent(dp2);
            out.listDrop = calls().map((c: any) => c.args)[0] || null;

            // (3) Files 優先の dispatch 順: Files + uri-list 両方 → uri-list 経路は使わない
            w.__calls = [];
            const dtBoth = new DataTransfer();
            dtBoth.items.add(new File(['x'], 'c.pdf', { type: 'application/pdf' }));
            dtBoth.setData(URI_MIME, uris);
            item.dispatchEvent(new DragEvent('drop', {
                bubbles: true, cancelable: true, dataTransfer: dtBoth,
                clientX: rr.left + rr.width / 2, clientY: rr.top + rr.height * 0.3,
            }));
            out.bothUriCalls = calls().length; // Files 優先 → 0

            return out;
        });

        // (1) item 上: dragover 受理 + drop で uris が届く（before = index 0）
        expect(r.itemOverAccepted).toBe(true);
        expect(r.itemDrop).toBeTruthy();
        expect(r.itemDrop[0]).toEqual(['file:///tmp/a.md', 'file:///tmp/b.pdf']); // \r\n split + trim
        expect(r.itemDrop[1]).toBe(null); // root 直下 item の前 = parentId null
        expect(r.itemDrop[2]).toBe(0);
        // (2) listEl 余白: root 末尾
        expect(r.listOverAccepted).toBe(true);
        expect(r.listDrop).toBeTruthy();
        expect(r.listDrop[1]).toBe(null);
        expect(r.listDrop[2]).toBe(2); // rootIds.length = 2（o1, fold1 の末尾）
        // (3) Files 同時積みは Files 経路優先（uri-list 経路は発火しない）
        expect(r.bothUriCalls).toBe(0);
    });

});
