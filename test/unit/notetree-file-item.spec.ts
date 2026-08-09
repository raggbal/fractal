/**
 * notetree-file-item.spec.ts — NotesFileManager の「tree file item（ext:'file'）」台帳・データモデル
 *
 * sprint 20260809-031217-notetree-file-dnd / TASK-01。
 * design/system.md §0-§3/§5 / §4y / §4z / ADRL-0005。
 *
 * 検証対象（behavioral + counterfactual。source-contract 文字列 assert は使わない）:
 *  - TC-TF-01: registerTreeFile が {type:'file',ext:'file',filename,title} を items に登録 + rootIds 挿入 + id は uuid（`.` なし）
 *  - TC-TF-02: 同名 2 回登録 → 実体名が report-1.pdf に uniquify され disk に一致（generateUniqueFileNamePreserving §4z）
 *  - TC-TF-03: getTreeFilePath は traversal filename（../escape.txt / ..%2F...）を safeResolveUnderDir で null に clamp
 *  - TC-TF-04: syncStructureWithDisk の第 3 分岐 — 実体が files/ にある file item は生存・実体欠損 item は除去（disk→items 自動追加なし）
 *  - TC-TF-05: 未登録 stray.bin（files/ 実体のみ）は items に自動追加されない
 *  - TC-TF-06: file item を持たない outline.note の load→save 往復が byte-identical（file item ロジックが非 file 構造を壊さない）
 *  - TC-TF-07: renameTitle の file 分岐 — title のみ変更・実体名/disk 不変（binary を JSON.parse/H1 しない）
 *  - TC-TF-08: deleteTreeFile — 構造エントリ + files/ 実体を両方除去（useTrash stub 可）。既存 deleteFile(filePath) は file item に波及しない
 *  - TC-TF-09: getFilePathById — ext:'file' は getTreeFilePath 値を返す（fake `${id}.file` を返さない）
 *  - TC-TF-10: listFiles — 登録 file item を kind:'file' で列挙・実体欠損 item は非列挙・既存 .out/.md にも kind
 *  - TC-TF-16: moveFileItemToOtherNote の file 分岐 — dst files/ copy + dst structure 登録 + src エントリ除去。
 *              src の他 md が同実体を参照 → src 実体温存 / 参照なし → 削除
 *  - TC-TF-17: file item を渡しても md/out 分岐に流れない（明示 3 値化）→ dst に実体ありで登録（counterfactual: else-out で実体なし item）
 *  - TC-SF-01: sanitizeTreeFileName — ?#[] + 制御文字→_ / balanced () 保持 / unbalanced ()→_ / archive..tar.gz 不変
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

function mkNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'notetree-file-test-'));
}
function cleanup(dir: string): void {
    if (dir && fs.existsSync(dir)) {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

test.describe('NotesFileManager tree file item（ext:file）台帳', () => {
    let dirs: string[] = [];
    const track = (d: string) => { dirs.push(d); return d; };

    test.afterEach(() => {
        for (const d of dirs) { cleanup(d); }
        dirs = [];
    });

    test('TC-TF-01: registerTreeFile は {type,ext:file,filename,title} を登録 + rootIds 挿入 + id は `.` なし', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const id = fm.registerTreeFile('report.pdf', 'report.pdf', null, 0);

        expect(typeof id).toBe('string');
        expect(id.length).toBeGreaterThan(0);
        // id は uuid 系（generateOutlineId = base36）で `.` を含まない（filename stem と区別）
        expect(id.includes('.')).toBe(false);

        const structure = fm.getStructure();
        const item = structure.items[id] as any;
        expect(item).toBeDefined();
        expect(item.type).toBe('file');
        expect(item.ext).toBe('file');
        expect(item.filename).toBe('report.pdf');
        expect(item.title).toBe('report.pdf');
        // rootIds に挿入されている
        expect(structure.rootIds.includes(id)).toBe(true);
        // 物理実体が files/ 配下に作られている
        const p = fm.getTreeFilePath(id);
        expect(p).not.toBeNull();
        expect(fs.existsSync(p as string)).toBe(true);
        expect(path.basename(p as string)).toBe('report.pdf');
    });

    test('TC-TF-02: 同名 2 回登録 → 2 個目の実体名が report-1.pdf に uniquify され disk に一致', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const id1 = fm.registerTreeFile('report.pdf', 'report.pdf', null, 0);
        const id2 = fm.registerTreeFile('report.pdf', 'report.pdf', null, 0);

        const structure = fm.getStructure();
        const f1 = (structure.items[id1] as any).filename;
        const f2 = (structure.items[id2] as any).filename;
        expect(f1).toBe('report.pdf');
        expect(f2).toBe('report-1.pdf'); // §4z generateUniqueFileNamePreserving
        expect(f2).not.toBe(f1);

        // items[id].filename が disk 実体名と一致する（台帳と実体の 1:1）
        const p2 = fm.getTreeFilePath(id2) as string;
        expect(path.basename(p2)).toBe('report-1.pdf');
        expect(fs.existsSync(p2)).toBe(true);
        expect(fs.existsSync(fm.getTreeFilePath(id1) as string)).toBe(true);
    });

    test('TC-TF-03: getTreeFilePath は traversal filename を safeResolveUnderDir で null に clamp（counterfactual: clamp 除去で files/ 外を返す）', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        // 悪意ある/破損した outline.note を直接書き（register を経由しない）
        const structure = fm.getStructure();
        (structure.items as any)['evil1'] = { type: 'file', id: 'evil1', title: 'e', ext: 'file', filename: '../escape.txt' };
        (structure.items as any)['evil2'] = { type: 'file', id: 'evil2', title: 'e', ext: 'file', filename: '..%2F..%2Fescape.txt' };
        structure.rootIds.push('evil1', 'evil2');
        fm.saveStructure();

        // clamp が効けば null（files/ 外へ escape させない）
        expect(fm.getTreeFilePath('evil1')).toBeNull();
        expect(fm.getTreeFilePath('evil2')).toBeNull();
        // counterfactual: もし path.join(filesDir, filename) を直返しすれば
        //   filesDir の親（= mainFolder 直下）を指す files/ 外パスが返り、この assert は RED になる。
    });

    test('TC-TF-04: syncStructureWithDisk 第 3 分岐 — 実体ありの file item は生存・実体欠損 item は除去（counterfactual: 第 3 分岐なしで実体ありも削除）', () => {
        const dir = track(mkNote());
        // files/ に a.pdf のみ実在させ、outline.note に a(実体あり)・b(実体なし)の file item を登録
        const filesDir = path.join(dir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'a.pdf'), 'A');
        const structure = {
            version: 1,
            rootIds: ['A', 'B'],
            items: {
                A: { type: 'file', id: 'A', title: 'a', ext: 'file', filename: 'a.pdf' },
                B: { type: 'file', id: 'B', title: 'b', ext: 'file', filename: 'b.pdf' }, // 実体なし
            },
        };
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify(structure, null, 2), 'utf8');

        // 新インスタンスで load → syncStructureWithDisk が走る
        const fm = new NotesFileManager(dir);
        const s = fm.getStructure();
        expect(s.items['A']).toBeDefined();     // 実体あり → 生存
        expect(s.items['B']).toBeUndefined();   // 実体欠損 → 除去
        expect(s.rootIds.includes('A')).toBe(true);
        expect(s.rootIds.includes('B')).toBe(false);
        // counterfactual: ext==='file' 分岐が無いと A も diskOutFiles 非該当で削除され RED。
    });

    test('TC-TF-05: 未登録 stray.bin（files/ 実体のみ）は items に自動追加されない', () => {
        const dir = track(mkNote());
        const filesDir = path.join(dir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'stray.bin'), 'X');
        // outline.note は空（登録なし）
        fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ version: 1, rootIds: [], items: {} }, null, 2), 'utf8');

        const fm = new NotesFileManager(dir);
        const s = fm.getStructure();
        // stray.bin の item は自動生成されない（disk→items 自動追加なし）
        const hasStray = Object.values(s.items).some((it: any) => it.type === 'file' && it.ext === 'file' && it.filename === 'stray.bin');
        expect(hasStray).toBe(false);
        expect(s.rootIds.length).toBe(0);
    });

    test('TC-TF-06: file item を持たない outline.note の load→save 往復が byte-identical', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        fm.createFile('Alpha', null);
        fm.createFile('Beta', null);
        const noteFile = path.join(dir, 'outline.note');
        const bytes1 = fs.readFileSync(noteFile);

        // 別インスタンスで再読込 → sync → save（file item ロジックが非 file 構造を壊さないこと）
        const fm2 = new NotesFileManager(dir);
        fm2.getStructure();
        fm2.saveStructure();
        const bytes2 = fs.readFileSync(noteFile);

        expect(bytes2.equals(bytes1)).toBe(true);
    });

    test('TC-TF-07: renameTitle の file 分岐 — title のみ変更・実体名/disk 不変', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const id = fm.registerTreeFile('report.pdf', 'Old Title', null, 0);
        const entityPath = fm.getTreeFilePath(id) as string;
        fs.writeFileSync(entityPath, '%PDF-1.4 binary'); // JSON でない binary 内容

        fm.renameTitle(entityPath, 'New Title');

        const s = fm.getStructure();
        const item = s.items[id] as any;
        expect(item.title).toBe('New Title');           // title は更新
        expect(item.filename).toBe('report.pdf');        // 実体名は不変
        expect(item.ext).toBe('file');
        // disk 実体は不変（H1/JSON 書換で破壊されない）
        expect(fs.readFileSync(entityPath, 'utf8')).toBe('%PDF-1.4 binary');
        expect(path.basename(entityPath)).toBe('report.pdf');
    });

    test('TC-TF-08: deleteTreeFile は構造 + 実体を除去 / 既存 deleteFile(filePath) は file item に波及しない', async () => {
        const dir = track(mkNote());
        // deleteTreeFile / deleteFile は require('vscode') する → Module._load で stub。
        // stub の workspace.fs.delete は物理削除を実行し「実体除去」を behavioral に検証する。
        const Module = require('module');
        const origLoad = Module._load;
        Module._load = function (request: string) {
            if (request === 'vscode') {
                return {
                    workspace: {
                        fs: {
                            delete: async (uri: any) => { fs.rmSync(uri.fsPath, { force: true, recursive: true }); },
                        },
                        getConfiguration: () => ({ get: () => undefined }),
                    },
                    Uri: { file: (p: string) => ({ fsPath: p }) },
                };
            }
            // eslint-disable-next-line prefer-rest-params
            return origLoad.apply(this, arguments as any);
        };
        try {
            const fm = new NotesFileManager(dir);
            const idA = fm.registerTreeFile('a.pdf', 'A', null, 0);
            const entityA = fm.getTreeFilePath(idA) as string;
            expect(fs.existsSync(entityA)).toBe(true);

            await fm.deleteTreeFile(idA);
            // 構造エントリ + 実体の両方が消える
            expect(fm.getStructure().items[idA]).toBeUndefined();
            expect(fs.existsSync(entityA)).toBe(false);

            // 既存 deleteFile(filePath) に実体パスを渡しても file item は除去されない
            // （deleteFile は basename(fp,'.out') を id とみなす id ベースで、file item の uuid id と一致しないため）。
            const idB = fm.registerTreeFile('b.pdf', 'B', null, 0);
            const entityB = fm.getTreeFilePath(idB) as string;
            await fm.deleteFile(entityB);
            expect(fm.getStructure().items[idB]).toBeDefined(); // file item は生存（波及しない）
        } finally {
            Module._load = origLoad;
        }
    });

    test('TC-TF-09: getFilePathById は ext:file で getTreeFilePath 値を返す（fake `${id}.file` を返さない）', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        const id = fm.registerTreeFile('report.pdf', 'r', null, 0);

        const viaGetFilePath = fm.getFilePathById(id);
        const viaTreeFilePath = fm.getTreeFilePath(id) as string;
        expect(viaGetFilePath).toBe(viaTreeFilePath);
        // fake path（`<main>/<id>.file`）を返さない
        expect(viaGetFilePath).not.toBe(path.join(dir, `${id}.file`));
        expect(viaGetFilePath.endsWith('.file')).toBe(false);
    });

    test('TC-TF-10: listFiles — file item を kind:file で列挙・実体欠損は非列挙・.out/.md にも kind', () => {
        const dir = track(mkNote());
        const fm = new NotesFileManager(dir);
        // .out
        fm.createFile('OutDoc', null);
        // .md
        fm.registerMarkdownFile('# MdDoc\n', 'MdDoc', null, 0);
        // file（実体あり）
        const idFile = fm.registerTreeFile('report.pdf', 'report.pdf', null, 0);
        // file（実体欠損）: 登録だけして実体を消す
        const idMissing = fm.registerTreeFile('gone.pdf', 'gone.pdf', null, 0);
        fs.rmSync(fm.getTreeFilePath(idMissing) as string, { force: true });

        const entries = fm.listFiles();
        const byId = new Map(entries.map(e => [e.id, e]));

        // file item（実体あり）は kind:'file' で列挙
        const fileEntry = byId.get(idFile) as any;
        expect(fileEntry).toBeDefined();
        expect(fileEntry.kind).toBe('file');
        // 実体欠損 file item は列挙されない
        expect(byId.has(idMissing)).toBe(false);
        // .out / .md にも kind が付く
        const outEntry = entries.find(e => (e as any).kind === 'out');
        const mdEntry = entries.find(e => (e as any).kind === 'md');
        expect(outEntry).toBeDefined();
        expect(mdEntry).toBeDefined();
    });

    test('TC-TF-16: moveFileItemToOtherNote の file 分岐 — dst copy + src エントリ除去 / 参照有無で src 実体温存・削除', () => {
        // ── case A: 他参照なし → src 実体削除 ──
        {
            const src = track(mkNote());
            const dst = track(mkNote());
            const srcFm = new NotesFileManager(src);
            const id = srcFm.registerTreeFile('report.pdf', 'report.pdf', null, 0);
            const srcEntity = srcFm.getTreeFilePath(id) as string;
            fs.writeFileSync(srcEntity, 'PDFDATA');

            const newId = srcFm.moveFileItemToOtherNote(id, dst);
            expect(newId).not.toBeNull();

            // dst に実体 + 構造 file item
            const dstFm = new NotesFileManager(dst);
            const dstItem = dstFm.getStructure().items[newId as string] as any;
            expect(dstItem).toBeDefined();
            expect(dstItem.type).toBe('file');
            expect(dstItem.ext).toBe('file');
            expect(dstItem.filename).toBeTruthy();
            const dstEntity = dstFm.getTreeFilePath(newId as string) as string;
            expect(fs.existsSync(dstEntity)).toBe(true);
            expect(fs.readFileSync(dstEntity, 'utf8')).toBe('PDFDATA');

            // src エントリ除去 + 実体削除（参照なし）
            expect(srcFm.getStructure().items[id]).toBeUndefined();
            expect(fs.existsSync(srcEntity)).toBe(false);
        }

        // ── case B: src の他 md が同実体を参照 → src 実体温存 ──
        {
            const src = track(mkNote());
            const dst = track(mkNote());
            const srcFm = new NotesFileManager(src);
            const id = srcFm.registerTreeFile('report.pdf', 'report.pdf', null, 0);
            const srcEntity = srcFm.getTreeFilePath(id) as string;
            fs.writeFileSync(srcEntity, 'PDFDATA');
            // src note 内の別 md が files/report.pdf を参照（📎 リンク）
            fs.writeFileSync(path.join(src, 'other.md'), '# other\n\n[report](files/report.pdf)\n', 'utf8');

            const newId = srcFm.moveFileItemToOtherNote(id, dst);
            expect(newId).not.toBeNull();

            // src 構造エントリは除去されるが、実体は残留参照ありで温存
            expect(srcFm.getStructure().items[id]).toBeUndefined();
            expect(fs.existsSync(srcEntity)).toBe(true); // 温存

            // dst にはコピーが存在
            const dstFm = new NotesFileManager(dst);
            const dstEntity = dstFm.getTreeFilePath(newId as string) as string;
            expect(fs.existsSync(dstEntity)).toBe(true);
        }
    });

    test('TC-TF-17: file item を渡しても md/out 分岐に流れない（明示 3 値化）→ dst に実体ありで登録', () => {
        const src = track(mkNote());
        const dst = track(mkNote());
        const srcFm = new NotesFileManager(src);
        const id = srcFm.registerTreeFile('doc.bin', 'doc.bin', null, 0);
        fs.writeFileSync(srcFm.getTreeFilePath(id) as string, 'BINDATA');

        const newId = srcFm.moveFileItemToOtherNote(id, dst) as string;
        expect(newId).not.toBeNull();

        const dstFm = new NotesFileManager(dst);
        const dstItem = dstFm.getStructure().items[newId] as any;
        // 明示 3 値化: file 分岐で dst item は ext:'file' + filename 付き + 実体あり。
        expect(dstItem.ext).toBe('file');
        expect(dstItem.filename).toBeTruthy();
        const dstEntity = dstFm.getTreeFilePath(newId);
        expect(dstEntity).not.toBeNull();
        expect(fs.existsSync(dstEntity as string)).toBe(true);
        // counterfactual: else-out に落とすと srcOutPath(<src>/<uuid>.out) が無く copy されず、
        //   dst item は ext:'file'/filename 無しで登録され実体もない → getTreeFilePath は null で RED。
    });

    test('TC-SF-01: sanitizeTreeFileName — ?#[] + 制御文字→_ / balanced () 保持 / unbalanced ()→_ / archive..tar.gz 不変', () => {
        const S = (NotesFileManager as any).sanitizeTreeFileName as (n: string) => string;
        expect(S('a?b.pdf')).toBe('a_b.pdf');
        expect(S('a#b.pdf')).toBe('a_b.pdf');
        expect(S('a[1].pdf')).toBe('a_1_.pdf');
        // balanced parens は保持（parseMarkdownLinks は balanced-paren aware）
        expect(S('report (1).pdf')).toBe('report (1).pdf');
        // unbalanced parens は _ に置換
        expect(S('a(b.pdf')).toBe('a_b.pdf');
        expect(S('a)b.pdf')).toBe('a_b.pdf');
        // 制御文字（\x00, \x1f, \x7f）は _ に置換
        expect(S('a\x00b\x1fc\x7f.pdf')).toBe('a_b_c_.pdf');
        // 連続ドット名は破壊しない（§4z の趣旨: global `..` replace を使わない）
        expect(S('archive..tar.gz')).toBe('archive..tar.gz');
    });
});
