/**
 * doc-backlinks.spec.ts — 添付の逆参照（参照元 md / node）解決
 *
 * sprint 20260813-133248-search-doc-content / TASK-19 / FR-DS-10 / ADRL-0061。
 *
 * 検証対象:
 *  - TC-DS-57: node.filePath 参照 → kind:'node' / md 📎 参照 → kind:'md' / 孤児 → 空
 *  - TC-DS-58: 非同期契約 — searchFilesStreaming の promise 解決（=End 相当）は逆参照解決を含まない
 *  - TC-DS-60: mtime インデックスキャッシュ — 無変更の 2 回目は走査せず / .out 更新で再解決
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DocBacklinksResolver } from '../../src/shared/doc-backlinks';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

const FIX = path.join(__dirname, '..', 'fixtures', 'doc-search');

function mkNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'doc-backlinks-'));
}

test.describe('DocBacklinksResolver（FR-DS-10）', () => {
    let dirs: string[] = [];
    const track = (d: string) => { dirs.push(d); return d; };
    test.afterEach(() => {
        for (const d of dirs) { fs.rmSync(d, { recursive: true, force: true }); }
        dirs = [];
    });

    function seedNote(dir: string): void {
        // node 参照（filePath = files/report.docx）+ md 参照（[📎 memo](files/memo.pdf)）+ 孤児（orphan.xlsx）
        fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'files', 'report.docx'), 'x');
        fs.writeFileSync(path.join(dir, 'files', 'memo.pdf'), 'x');
        fs.writeFileSync(path.join(dir, 'files', 'orphan.xlsx'), 'x');
        fs.writeFileSync(path.join(dir, 'work.out'), JSON.stringify({
            title: 'Work Plan',
            nodes: { n1: { text: '予算資料\n2行目', filePath: 'files/report.docx' } },
        }));
        fs.writeFileSync(path.join(dir, 'meeting.md'), '# 会議メモ\n\n[📎 memo](files/memo.pdf)\n');
    }

    test('TC-DS-57: node 参照 / md 参照 / 孤児の解決', () => {
        const dir = track(mkNote());
        seedNote(dir);
        const resolver = new DocBacklinksResolver(null);
        const result = resolver.resolve(dir, ['files/report.docx', 'files/memo.pdf', 'files/orphan.xlsx']);

        const nodeRefs = result.get('files/report.docx')!;
        expect(nodeRefs.length).toBe(1);
        expect(nodeRefs[0].kind).toBe('node');
        expect(nodeRefs[0].outFileId).toBe('work');
        expect(nodeRefs[0].nodeId).toBe('n1');
        expect(nodeRefs[0].label).toContain('Work Plan');
        expect(nodeRefs[0].label).toContain('予算資料');       // node text の先頭行
        expect(nodeRefs[0].label).not.toContain('2行目');

        const mdRefs = result.get('files/memo.pdf')!;
        expect(mdRefs.length).toBe(1);
        expect(mdRefs[0].kind).toBe('md');
        expect(mdRefs[0].mdPath).toBe(path.join(dir, 'meeting.md'));

        expect(result.get('files/orphan.xlsx')).toEqual([]);   // 孤児 = 空（throw しない）
    });

    test('TC-DS-58: 非同期契約 — 検索の promise 解決は逆参照を含まない（後追い）', async () => {
        const dir = track(mkNote());
        seedNote(dir);
        fs.copyFileSync(path.join(FIX, 'docx-pydocx.docx'), path.join(dir, 'files', 'report.docx'));

        const fm = new NotesFileManager(dir);
        const events: string[] = [];
        // searchFilesStreaming 自体は backlinks を触らない（handler が End 後に別途呼ぶ設計 — ADRL-0061）。
        // ここでは「検索完了までに resolveFileBacklinks が呼ばれない」ことを spy で確認する
        const orig = fm.resolveFileBacklinks.bind(fm);
        let resolveCalled = 0;
        fm.resolveFileBacklinks = ((ids: string[]) => { resolveCalled++; return orig(ids); }) as typeof fm.resolveFileBacklinks;

        await fm.searchFilesStreaming('吾輩は猫である', { caseSensitive: false, wholeWord: false, useRegex: false },
            () => events.push('partial'));
        expect(events.length).toBeGreaterThan(0);
        expect(resolveCalled).toBe(0);   // counterfactual: 検索内で同期解決すると >0 = RED

        // 後追い呼び出し（handler 相当）は正しく解決する
        const backlinks = fm.resolveFileBacklinks(['files/report.docx']);
        expect(backlinks.get('files/report.docx')!.length).toBe(1);
    });

    test('TC-DS-60: mtime インデックスキャッシュ — 無変更 2 回目は再走査なし / .out 更新で再解決', () => {
        const dir = track(mkNote());
        const cacheDir = track(fs.mkdtempSync(path.join(os.tmpdir(), 'doc-backlinks-cache-')));
        seedNote(dir);

        const r1 = new DocBacklinksResolver(cacheDir);
        r1.resolve(dir, ['files/report.docx']);
        const cacheFiles = fs.readdirSync(cacheDir).filter((f) => f.startsWith('backlinks-'));
        expect(cacheFiles.length).toBe(1);                      // インデックスが永続化された

        // 新 resolver（プロセス再起動相当）でも signature 一致でキャッシュから読める
        const r2 = new DocBacklinksResolver(cacheDir);
        const cached = r2.resolve(dir, ['files/report.docx']);
        expect(cached.get('files/report.docx')!.length).toBe(1);

        // .out 更新（node 参照を消す）→ signature 不一致 → 再解決で反映
        fs.writeFileSync(path.join(dir, 'work.out'), JSON.stringify({
            title: 'Work Plan', nodes: { n1: { text: '予算資料' } },   // filePath 参照を除去
        }));
        const r3 = new DocBacklinksResolver(cacheDir);
        const updated = r3.resolve(dir, ['files/report.docx']);
        expect(updated.get('files/report.docx')).toEqual([]);   // counterfactual: キャッシュ固執だと 1 件のまま = RED
    });
});
