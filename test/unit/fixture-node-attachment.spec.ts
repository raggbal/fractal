/**
 * TASK-03 の完了条件 smoke — 併持 node fixture が 8 セルすべてを張れることを確認する。
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-NDA-01 の検証前提）
 *
 * fixture 自身が壊れていると TC-NDA-01..08 が vacuous pass になるため、
 * 「入力側が意図どおり組めている」ことを独立に固定する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import {
    makeNodeAttachmentFixture, ATTACHMENT_CELLS, expectedItemCount,
} from '../utils/fixture-node-attachment';

test('TASK-03 smoke: 8 セルの node が .out に実在し、添付実体もすべて存在する', () => {
    const fx = makeNodeAttachmentFixture();
    try {
        // 2³ = 8 セルを機械列挙している（「よくある形」だけになっていない）
        expect(ATTACHMENT_CELLS.length).toBe(8);

        const out = JSON.parse(fs.readFileSync(fx.outPath, 'utf8'));
        expect(out.nodes.length).toBe(8);
        expect(out.rootIds.length).toBe(8);

        for (const c of ATTACHMENT_CELLS) {
            const id = fx.nodeIdByCell[c.cell];
            const node = out.nodes.find((n: any) => n.id === id);
            expect(node, `cell ${c.cell} の node が .out に無い`).toBeTruthy();

            // 属性の有無が宣言どおり（他属性の有無に依存しない独立判定）
            expect(!!(node.isPage && node.pageId), `cell ${c.cell} の page 属性`).toBe(c.page);
            expect(!!node.filePath, `cell ${c.cell} の file 属性`).toBe(c.file);
            expect((node.images || []).length, `cell ${c.cell} の画像枚数`).toBe(c.images);

            // 添付実体が実在する（fs 上で確認 — 参照だけあって実体が無いと転送テストが無意味）
            const ent = fx.entitiesByCell[c.cell];
            if (c.page) { expect(fs.existsSync(ent.pageMd!), `cell ${c.cell} の page md 実体`).toBe(true); }
            if (c.file) { expect(fs.existsSync(ent.file!), `cell ${c.cell} の file 実体`).toBe(true); }
            expect(ent.images.length).toBe(c.images);
            for (const img of ent.images) {
                expect(fs.existsSync(img), `cell ${c.cell} の画像実体 ${path.basename(img)}`).toBe(true);
            }

            // 枚数対応の番人が使う期待値（入力 N → 出力 N の N）
            expect(expectedItemCount(c)).toBe((c.page ? 1 : 0) + (c.file ? 1 : 0) + c.images);
        }

        // note 台帳も組めている（tree への drop 先として使える）
        const structure = JSON.parse(fs.readFileSync(path.join(fx.dir, 'outline.note'), 'utf8'));
        expect(structure.rootIds).toEqual(['work']);
    } finally {
        fx.cleanup();
    }
});

test('TASK-03 smoke: withChild で子 node に添付が付く（TC-NDA-09 の前提）', () => {
    const fx = makeNodeAttachmentFixture({ withChild: true });
    try {
        const out = JSON.parse(fs.readFileSync(fx.outPath, 'utf8'));
        const cell8 = out.nodes.find((n: any) => n.id === fx.nodeIdByCell[8]);
        expect(cell8.children.length, 'cell 8 に子 node が無い').toBe(1);
        expect(cell8.children[0].filePath, '子 node が添付を持っていない').toBe('files/child-only.pdf');
        expect(fs.existsSync(path.join(fx.dir, 'files', 'child-only.pdf'))).toBe(true);
        // 親自身の添付とは別実体（混同すると「子は運ばれない」の検証が空回りする）
        expect(cell8.children[0].filePath).not.toBe(cell8.filePath);
    } finally {
        fx.cleanup();
    }
});

test('TASK-03 smoke: cleanup で一時ディレクトリが残らない', () => {
    const fx = makeNodeAttachmentFixture();
    const dir = fx.dir;
    expect(fs.existsSync(dir)).toBe(true);
    fx.cleanup();
    expect(fs.existsSync(dir), '一時ディレクトリが残っている（tmpfs を圧迫する）').toBe(false);
});
