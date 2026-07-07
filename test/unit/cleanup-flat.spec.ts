/**
 * notes-flat-storage TASK-05 — cleanup フラット対応
 *
 * decision 2026-07-07: md=basedir 直下、画像/添付=共有 images/・files/。
 * Pass-2 guard は既存 safeResolveUnderDir のまま（md 直下で ./images が basedir 配下に収まる）。
 *
 * TC-FS-20 フラット live-set が生存ファイルを 0 件 orphan 判定 (+ MEDIUM-1: 新旧 mdRoot 両方 live)
 * TC-FS-21 真の孤児だけを検出
 * TC-FS-22 Single Outliner 複数 .out 共存で誤爆しない (BH-01)
 * TC-FS-23 md 直下の本文リンク (./images/) が既存 guard で live 判定される
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { scanSingleNoteCore } from '../../src/shared/cleanup-core';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-flat-'));
}

/** flat .out を作る: md=basedir 直下, images/files=共有。node は pageId + images + filePath を持つ。 */
function writeFlatOut(dir: string, name: string, pages: { pageId: string; body: string; img?: string; file?: string }[]): void {
    const nodes: Record<string, unknown> = {};
    for (const p of pages) {
        const nid = 'n_' + p.pageId;
        nodes[nid] = {
            id: nid, text: p.pageId, childIds: [], isPage: true, pageId: p.pageId,
            images: p.img ? [`images/${p.img}`] : [],
            ...(p.file ? { filePath: `files/${p.file}` } : {}),
        };
        // page md 実体（basedir 直下）
        fs.writeFileSync(path.join(dir, `${p.pageId}.md`), p.body);
    }
    fs.writeFileSync(path.join(dir, name), JSON.stringify({
        title: name, pageDir: '.', imageDir: './images', fileDir: './files',
        rootIds: Object.keys(nodes), nodes,
    }, null, 2));
}

test('TC-FS-20 フラット live-set が生存ファイルを 0 件 orphan 判定 (+MEDIUM-1 新旧 mdRoot 両方)', async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    // .out with 3 pages, each with img+file, body references its image via ./images
    const pages = [1, 2, 3].map(i => ({ pageId: `p${i}`, body: `# p${i}\n![](./images/i${i}.png)`, img: `i${i}.png`, file: `f${i}.pdf` }));
    for (const p of pages) {
        fs.writeFileSync(path.join(dir, 'images', p.img!), 'IMG');
        fs.writeFileSync(path.join(dir, 'files', p.file!), 'FILE');
    }
    writeFlatOut(dir, 'work.out', pages);
    // notes-md (registered in outline.note) with an image, md at basedir 直下
    fs.writeFileSync(path.join(dir, 'md1.md'), '# note\n![](./images/note.png)');
    fs.writeFileSync(path.join(dir, 'images', 'note.png'), 'IMG');
    // MEDIUM-1: also a legacy _notes_md copy of a registered md still live
    fs.mkdirSync(path.join(dir, '_notes_md'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_notes_md', 'md2.md'), '# legacy live');
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        rootIds: ['work', 'md1', 'md2'],
        items: {
            work: { type: 'file', id: 'work', title: 'work' },
            md1: { type: 'file', id: 'md1', title: 'md1', ext: 'md' },
            md2: { type: 'file', id: 'md2', title: 'md2', ext: 'md' },
        },
    }));

    const orphans = await scanSingleNoteCore(dir);
    expect(orphans.length).toBe(0); // 生存ファイルは 1 件も orphan にしない
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-21 真の孤児だけを検出', async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    const pages = [{ pageId: 'p1', body: '# p1\n![](./images/i1.png)', img: 'i1.png', file: 'f1.pdf' }];
    fs.writeFileSync(path.join(dir, 'images', 'i1.png'), 'IMG');
    fs.writeFileSync(path.join(dir, 'files', 'f1.pdf'), 'FILE');
    writeFlatOut(dir, 'work.out', pages);
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        rootIds: ['work'], items: { work: { type: 'file', id: 'work', title: 'work' } },
    }));
    // 未参照の孤児 3 件
    fs.writeFileSync(path.join(dir, 'orphan.md'), '# not referenced');
    fs.writeFileSync(path.join(dir, 'images', 'orphan.png'), 'IMG');
    fs.writeFileSync(path.join(dir, 'files', 'orphan.pdf'), 'FILE');

    const orphans = await scanSingleNoteCore(dir);
    const orphanNames = orphans.map(o => path.basename(o.absPath)).sort();
    expect(orphanNames).toEqual(['orphan.md', 'orphan.pdf', 'orphan.png']);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-22 Single Outliner 複数 .out 共存で誤爆しない (BH-01)', async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    writeFlatOut(dir, 'alpha.out', [
        { pageId: 'a1', body: '# a1' }, { pageId: 'a2', body: '# a2' },
    ]);
    writeFlatOut(dir, 'beta.out', [
        { pageId: 'b1', body: '# b1' }, { pageId: 'b2', body: '# b2' },
    ]);
    // no outline.note (Single Outliner mode). All 4 page md live.
    const orphans = await scanSingleNoteCore(dir);
    expect(orphans.length).toBe(0);

    // alpha から 1 ノード削除（a2 の md を .out から外す） → その 1 ページだけ orphan
    const alpha = JSON.parse(fs.readFileSync(path.join(dir, 'alpha.out'), 'utf8'));
    delete alpha.nodes['n_a2'];
    alpha.rootIds = alpha.rootIds.filter((r: string) => r !== 'n_a2');
    fs.writeFileSync(path.join(dir, 'alpha.out'), JSON.stringify(alpha));
    const orphans2 = await scanSingleNoteCore(dir);
    const names = orphans2.map(o => path.basename(o.absPath));
    expect(names).toEqual(['a2.md']); // beta のページは live のまま
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-23 md 直下の本文リンク (./images/) が既存 guard で live 判定される', async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    // notes-md at basedir 直下 referencing ./images/x.png
    fs.writeFileSync(path.join(dir, 'n1.md'), '# n1\n![](./images/x.png)');
    fs.writeFileSync(path.join(dir, 'images', 'x.png'), 'IMG');
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        rootIds: ['n1'], items: { n1: { type: 'file', id: 'n1', title: 'n1', ext: 'md' } },
    }));
    const orphans = await scanSingleNoteCore(dir);
    // x.png は本文 ./images/x.png から参照される → orphan にしない（既存 guard で basedir 配下解決）
    expect(orphans.map(o => path.basename(o.absPath))).not.toContain('x.png');
    expect(orphans.length).toBe(0);
    fs.rmSync(dir, { recursive: true, force: true });
});
