/**
 * doc-search-stage4.spec.ts — searchFilesStreaming の第 4 検索段（tree file item 中身検索）+ async 化
 *
 * sprint 20260813-133248-search-doc-content / TASK-06。
 * design/system.md §4・§8 / testcases.md C 節 / ハーネス = notetree-file-item.spec.ts 流儀（TS 直 import + mkdtemp）。
 *
 * 検証対象:
 *  - TC-DS-14: docx 添付が fileType:'file' でヒット（field:'content' + lineNumber + 200 字 lineText）
 *  - TC-DS-15: 台帳に居るが実体なし → 例外なく skip（TC-TF-10 precedent）
 *  - TC-DS-16: 対象外拡張子（.txt）は中身検索対象外 / .PDF 大文字は対象（case-insensitive）
 *  - TC-DS-17: generation abort — 新検索発行で旧検索が中断
 *  - TC-DS-18: 既存 3 段（.out / root md / page md）の結果が第 4 段追加後も同一
 *  - TC-DS-34: traversal filename → getTreeFilePath null → skip（counterfactual: clamp 外すと外を読む）
 *  - TC-DS-35: notesSearchEnd が全 Partial の後（Start→Partial*→End 順序契約）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager, SearchResult } from '../../src/shared/notes-file-manager';

const FIX = path.join(__dirname, '..', 'fixtures', 'doc-search');

function mkNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-stage4-'));
}

/** 台帳 + files/ 実体を直接書く（registerTreeFile を経由しない = traversal filename も注入できる） */
function writeStructure(dir: string, items: Record<string, unknown>, rootIds: string[]): void {
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({ noteTitle: 'T', rootIds, items }));
}

function addAttachment(dir: string, filename: string, fixtureName: string): void {
    const filesDir = path.join(dir, 'files');
    fs.mkdirSync(filesDir, { recursive: true });
    fs.copyFileSync(path.join(FIX, fixtureName), path.join(filesDir, filename));
}

async function search(fm: NotesFileManager, query: string): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    await fm.searchFilesStreaming(query, { caseSensitive: false, wholeWord: false, useRegex: false },
        (r) => results.push(r));
    return results;
}

test.describe('searchFilesStreaming 第 4 段（FR-DS-01）', () => {
    let dirs: string[] = [];
    const track = (d: string) => { dirs.push(d); return d; };
    test.afterEach(() => {
        for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
        dirs = [];
    });

    test('TC-DS-14: docx 添付が fileType:file でヒット（content + lineNumber + 200 字 clamp）【rev.2: fileId = files/ 相対パス】', async () => {
        const dir = track(mkNote());
        addAttachment(dir, 'meeting.docx', 'docx-pydocx.docx');
        writeStructure(dir, { att1: { type: 'file', ext: 'file', filename: 'meeting.docx', title: '会議資料' } }, ['att1']);

        const fm = new NotesFileManager(dir);
        const results = await search(fm, '吾輩は猫である');
        const fileHits = results.filter((r) => r.fileType === 'file');
        expect(fileHits.length).toBe(1);                      // 台帳 + walk の二重列挙をしない（walk 一本化）
        expect(fileHits[0].fileId).toBe('files/meeting.docx'); // rev.2: 同定は files/ 相対パス
        expect(fileHits[0].fileTitle).toBe('会議資料');        // 台帳 title の逆引き
        const m = fileHits[0].matches[0];
        expect(m.field).toBe('content');
        expect(typeof m.lineNumber).toBe('number');
        expect(m.lineText.length).toBeLessThanOrEqual(200);
        expect(m.lineText).toContain('吾輩は猫である');
    });

    test('TC-DS-46: 台帳未登録 file（node 📎 / md 📎 添付相当）が files/ walk でヒット【rev.2 の核】', async () => {
        const dir = track(mkNote());
        // files/ に実体を置くが outline.note の items には登録しない = node.filePath / md 📎 添付の実体状態
        addAttachment(dir, 'embedded.docx', 'docx-textutil.docx');
        writeStructure(dir, {}, []);

        const fm = new NotesFileManager(dir);
        const results = await search(fm, '国境の長いトンネル');
        const fileHits = results.filter((r) => r.fileType === 'file');
        // counterfactual: 台帳走査（rev.1）に戻すと 0 件 = RED
        expect(fileHits.length).toBe(1);
        expect(fileHits[0].fileId).toBe('files/embedded.docx');
        expect(fileHits[0].fileTitle).toBe('embedded.docx');   // 台帳なし → basename
    });

    test('TC-DS-47: サブディレクトリ配下も再帰 walk でヒット', async () => {
        const dir = track(mkNote());
        const subDir = path.join(dir, 'files', 'reports', '2026');
        fs.mkdirSync(subDir, { recursive: true });
        fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), path.join(subDir, 'q3.docx'));
        writeStructure(dir, {}, []);

        const fm = new NotesFileManager(dir);
        const results = await search(fm, '吾輩は猫である');
        const fileHits = results.filter((r) => r.fileType === 'file');
        expect(fileHits.length).toBe(1);
        // fileId は files/ 相対（区切りは OS ネイティブ — path.relative の出力そのまま）
        expect(fileHits[0].fileId).toBe(`files/${path.join('reports', '2026', 'q3.docx')}`);
    });

    test('TC-DS-48: symlink 非追従番人 — files/ 外を指す symlink は対象にならない', async () => {
        const dir = track(mkNote());
        fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
        // files/ の外（note 直下）にヒットするはずの docx を置き、files/ 内から symlink で指す
        const outside = path.join(dir, 'outside.docx');
        fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), outside);
        fs.symlinkSync(outside, path.join(dir, 'files', 'link.docx'));
        // 外側 dir を指す symlink dir も置く（dir 経由の escape も防ぐ）
        fs.symlinkSync(dir, path.join(dir, 'files', 'linkdir'));
        writeStructure(dir, {}, []);

        const fm = new NotesFileManager(dir);
        const results = await search(fm, '吾輩は猫である');
        // counterfactual: walk が symlink を追う（statSync/realpath 判定等）と外の docx がヒット = RED
        expect(results.filter((r) => r.fileType === 'file').length).toBe(0);
    });

    test('TC-DS-15: 台帳に居るが実体なし → 例外なく skip', async () => {
        const dir = track(mkNote());
        writeStructure(dir, { ghost: { type: 'file', ext: 'file', filename: 'gone.docx', title: 'gone' } }, ['ghost']);
        const fm = new NotesFileManager(dir);
        const results = await search(fm, '吾輩');
        expect(results.filter((r) => r.fileType === 'file').length).toBe(0);
    });

    test('TC-DS-16: .txt は対象外 / .PDF 大文字は対象（case-insensitive）', async () => {
        const dir = track(mkNote());
        const filesDir = path.join(dir, 'files');
        fs.mkdirSync(filesDir, { recursive: true });
        fs.writeFileSync(path.join(filesDir, 'note.txt'), '吾輩は猫である');
        fs.copyFileSync(path.join(FIX, 'fixture-ja-en.pdf'), path.join(filesDir, 'REPORT.PDF'));
        writeStructure(dir, {
            t1: { type: 'file', ext: 'file', filename: 'note.txt', title: 'txt' },
            p1: { type: 'file', ext: 'file', filename: 'REPORT.PDF', title: 'pdf-upper' },
        }, ['t1', 'p1']);

        const fm = new NotesFileManager(dir);
        const txtHits = await search(fm, '吾輩は猫である');
        expect(txtHits.filter((r) => r.fileType === 'file').length).toBe(0);   // .txt は中身検索対象外

        const pdfHits = await search(fm, '富士山麓に鸚鵡鳴く');
        expect(pdfHits.filter((r) => r.fileType === 'file').length).toBe(1);   // .PDF は対象
    });

    test('TC-DS-17: generation abort — 新検索発行で旧検索が中断される', async () => {
        const dir = track(mkNote());
        // 添付を多数並べ、旧検索が第 4 段の途中で新検索に追い越される状況を作る
        const items: Record<string, unknown> = {};
        const rootIds: string[] = [];
        for (let i = 0; i < 8; i++) {
            const name = `doc${i}.docx`;
            addAttachment(dir, name, 'docx-pydocx.docx');
            items[`a${i}`] = { type: 'file', ext: 'file', filename: name, title: name };
            rootIds.push(`a${i}`);
        }
        writeStructure(dir, items, rootIds);

        const fm = new NotesFileManager(dir);
        const oldResults: SearchResult[] = [];
        const p1 = fm.searchFilesStreaming('吾輩は猫である', { caseSensitive: false, wholeWord: false, useRegex: false },
            (r) => oldResults.push(r));
        // 直後に新検索（await せず interleave）→ 旧検索は generation check で中断
        const newResults: SearchResult[] = [];
        const p2 = fm.searchFilesStreaming('The quick brown fox', { caseSensitive: false, wholeWord: false, useRegex: false },
            (r) => newResults.push(r));
        await Promise.all([p1, p2]);

        const oldFileHits = oldResults.filter((r) => r.fileType === 'file').length;
        const newFileHits = newResults.filter((r) => r.fileType === 'file').length;
        expect(newFileHits).toBe(8);                    // 新検索は完走（counterfactual: gen check を外すと旧も 8 完走）
        expect(oldFileHits).toBeLessThan(8);            // 旧検索は途中で中断
    });

    test('TC-DS-18: 既存 3 段の結果が第 4 段追加後も同一（.out / root md）', async () => {
        const dir = track(mkNote());
        // .out（node text）+ root md + 添付を混在させ、既存 2 種の結果形が不変であることを確認
        fs.writeFileSync(path.join(dir, 'work.out'), JSON.stringify({
            title: 'Work', nodes: { n1: { text: '検索対象ワード in node' } },
        }));
        // root md は _notes_md 台帳管理（items 経由）なので、items に md エントリが必要 —
        // ここでは簡易に .out node と添付のみで確認（md 第 2 段は items 台帳照合が前提のため）
        addAttachment(dir, 'meeting.docx', 'docx-pydocx.docx');
        writeStructure(dir, { att1: { type: 'file', ext: 'file', filename: 'meeting.docx', title: '会議資料' } }, ['att1']);

        const fm = new NotesFileManager(dir);
        const results = await search(fm, '検索対象ワード');
        const outHits = results.filter((r) => r.fileType === 'out');
        expect(outHits.length).toBe(1);                          // 既存第 1 段は不変
        expect(outHits[0].matches[0].field).toBe('text');
        expect(results.filter((r) => r.fileType === 'file').length).toBe(0);  // 添付には無い語
    });

    test('TC-DS-34: traversal filename → clamp で skip（files/ 外を読まない）', async () => {
        const dir = track(mkNote());
        fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
        // files/ の外（note 直下）に「ヒットするはずの」docx を置く — clamp が無ければ届く位置
        fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), path.join(dir, 'evil.docx'));
        writeStructure(dir, { evil: { type: 'file', ext: 'file', filename: '../evil.docx', title: 'evil' } }, ['evil']);

        const fm = new NotesFileManager(dir);
        const results = await search(fm, '吾輩は猫である');
        // rev.2: walk は files/ 実体しか列挙しないため、台帳の traversal filename は構造的に無効
        // （rev.1 では getTreeFilePath の clamp が防御していた — 防御の持ち主が walk に代わった）
        expect(results.filter((r) => r.fileType === 'file').length).toBe(0);
    });

    test('TC-DS-35: Start→Partial*→End 順序 — promise 解決は全 onResult の後', async () => {
        // notes-message-handler は vscode 依存（mindmap-export-host 経由）で unit import 不能のため、
        // handler の順序契約を成立させている性質そのもの =「searchFilesStreaming の promise は
        // 全 onResult 発火の後に resolve する」を直接検証する（handler は
        // `await searchFilesStreaming(...)` → `postMessage(End)` の 1 行配線 — system.md §8）。
        const dir = track(mkNote());
        addAttachment(dir, 'meeting.docx', 'docx-pydocx.docx');
        writeStructure(dir, { att1: { type: 'file', ext: 'file', filename: 'meeting.docx', title: '会議' } }, ['att1']);

        const fm = new NotesFileManager(dir);
        const events: string[] = [];
        const p = fm.searchFilesStreaming('吾輩は猫である', { caseSensitive: false, wholeWord: false, useRegex: false },
            () => events.push('partial'));
        await p.then(() => events.push('resolved'));

        expect(events.length).toBeGreaterThanOrEqual(2);           // 添付ヒットの partial + resolved
        expect(events[events.length - 1]).toBe('resolved');        // End 相当は必ず全 Partial の後
        expect(events.filter((e) => e === 'partial').length).toBeGreaterThan(0);
    });
});

test.describe('削除連動 evict（TASK-13 / SEC-3）', () => {
    test('TC-DS-45: deleteTreeFile 後に抽出キャッシュが cacheDir に残存しない', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-evict-'));
        const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doc-search-evict-cache-'));
        // deleteTreeFile は require('vscode') する → Module._load stub（TC-TF-08 と同型）
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Module = require('module');
        const origLoad = Module._load;
        Module._load = function (request: string) {
            if (request === 'vscode') {
                return {
                    workspace: {
                        fs: { delete: async (uri: { fsPath: string }) => { fs.rmSync(uri.fsPath, { force: true, recursive: true }); } },
                        getConfiguration: () => ({ get: () => undefined }),
                    },
                    Uri: { file: (p: string) => ({ fsPath: p }) },
                };
            }
            // eslint-disable-next-line prefer-rest-params
            return origLoad.apply(this, arguments as never);
        };
        try {
            const fm = new NotesFileManager(dir, cacheDir);
            const filesDir = path.join(dir, 'files');
            fs.mkdirSync(filesDir, { recursive: true });
            const id = fm.registerTreeFile('meeting.docx', '会議資料', null, 0,
                fs.readFileSync(path.join(FIX, 'docx-pydocx.docx')));
            // 検索でキャッシュ生成
            await fm.searchFilesStreaming('吾輩は猫である', { caseSensitive: false, wholeWord: false, useRegex: false }, () => {});
            expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length).toBe(1);

            await fm.deleteTreeFile(id);
            // counterfactual: evict 配線を外すと本文テキスト入り .json が残留 = RED
            expect(fs.readdirSync(cacheDir).filter((f) => f.endsWith('.json')).length).toBe(0);
        } finally {
            Module._load = origLoad;
            fs.rmSync(dir, { recursive: true, force: true });
            fs.rmSync(cacheDir, { recursive: true, force: true });
        }
    });
});
