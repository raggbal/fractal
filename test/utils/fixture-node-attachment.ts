/**
 * TASK-03 — 併持 node fixture ビルダー
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-NDA-01 の検証前提）
 *
 * TC-NDA-01..08 は「md page 添付 / file 添付 / 直付き画像」の 2³ = 8 セル全部を張る必要がある
 * （design/system.md §2-2）。各 spec で 8 パターンの note を手で組むと重複するため、
 * ここに 1 本化する。
 *
 * **静的 fixture ディレクトリではなく実行時 mkdtemp 生成**にした理由:
 * 本リポジトリの unit spec の慣習（copy-engine-canon / cleanup-flat 等）が
 * `fs.mkdtempSync` + 直後の fs assert で、転送系のテストは note を書き換えるため
 * 毎回まっさらな書き込み可能ディレクトリが必要（静的 fixture では 2 回目以降が汚れる）。
 * tasks.md の宣言パス `test/fixtures/node-attachment/` から変更した旨は
 * design/system.md §0 と generator-log.md に記録済み。
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 併持セル（design/system.md §2-2 の分岐表の行に 1:1 対応）。 */
export interface AttachmentCell {
    /** 分岐表の行番号（1..8） */
    cell: number;
    /** md page 添付を持つか */
    page: boolean;
    /** file 添付を持つか */
    file: boolean;
    /** 直付き画像の枚数（0 なら持たない） */
    images: number;
}

/** 2³ = 8 セルを機械列挙したもの（「よくある形」から書き始めず全組合せを持つ）。 */
export const ATTACHMENT_CELLS: AttachmentCell[] = [
    { cell: 1, page: false, file: false, images: 0 },
    { cell: 2, page: false, file: false, images: 2 },
    { cell: 3, page: false, file: true, images: 0 },
    { cell: 4, page: false, file: true, images: 2 },
    { cell: 5, page: true, file: false, images: 0 },
    { cell: 6, page: true, file: false, images: 2 },
    { cell: 7, page: true, file: true, images: 0 },
    { cell: 8, page: true, file: true, images: 2 },
];

export interface NodeAttachmentFixture {
    /** note のルート（mainFolder。outline.note / work.out / images/ / files/ / pages/ を含む） */
    dir: string;
    /** `.out` の絶対パス */
    outPath: string;
    /** セル番号 → その node の id */
    nodeIdByCell: Record<number, string>;
    /** セル番号 → その node が持つ添付の実体パス（存在検証用） */
    entitiesByCell: Record<number, { pageMd?: string; file?: string; images: string[] }>;
    /** 後始末 */
    cleanup: () => void;
}

/** 1 セル分の node オブジェクト（.out の nodes 要素）を組む。 */
function makeNode(id: string, c: AttachmentCell) {
    const node: any = { id, text: `cell-${c.cell}`, children: [] };
    if (c.page) { node.isPage = true; node.pageId = `page-${c.cell}`; }
    if (c.file) { node.filePath = `files/spec-${c.cell}.pdf`; }
    if (c.images > 0) {
        node.images = [];
        for (let i = 1; i <= c.images; i++) { node.images.push(`images/pic-${c.cell}-${i}.png`); }
    }
    return node;
}

/**
 * 8 セルすべての node を持つ note を作る。
 *
 * @param opts.withChild セル 8 の node に「添付を持つ子 node」を付ける
 *   （TC-NDA-09「子孫の添付は運ばれない」用）
 */
export function makeNodeAttachmentFixture(opts?: { withChild?: boolean }): NodeAttachmentFixture {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-nda-'));
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'pages'), { recursive: true });

    const nodeIdByCell: Record<number, string> = {};
    const entitiesByCell: NodeAttachmentFixture['entitiesByCell'] = {};
    const nodes: any[] = [];

    for (const c of ATTACHMENT_CELLS) {
        const id = `n${c.cell}`;
        nodeIdByCell[c.cell] = id;
        const ent: { pageMd?: string; file?: string; images: string[] } = { images: [] };

        if (c.page) {
            const mdAbs = path.join(dir, 'pages', `page-${c.cell}.md`);
            fs.writeFileSync(mdAbs, `# cell ${c.cell} page\n\n本文\n`, 'utf8');
            ent.pageMd = mdAbs;
        }
        if (c.file) {
            const fAbs = path.join(dir, 'files', `spec-${c.cell}.pdf`);
            fs.writeFileSync(fAbs, `PDF-${c.cell}`, 'utf8');
            ent.file = fAbs;
        }
        for (let i = 1; i <= c.images; i++) {
            const iAbs = path.join(dir, 'images', `pic-${c.cell}-${i}.png`);
            fs.writeFileSync(iAbs, `PNG-${c.cell}-${i}`, 'utf8');
            ent.images.push(iAbs);
        }

        const node = makeNode(id, c);
        if (opts?.withChild && c.cell === 8) {
            // 子も添付を持つ（親のバレット drag では運ばれてはいけない）
            const childFile = path.join(dir, 'files', 'child-only.pdf');
            fs.writeFileSync(childFile, 'CHILD', 'utf8');
            node.children = [{ id: 'n8c', text: 'cell-8-child', children: [], filePath: 'files/child-only.pdf' }];
        }
        nodes.push(node);
        entitiesByCell[c.cell] = ent;
    }

    const outPath = path.join(dir, 'work.out');
    fs.writeFileSync(outPath, JSON.stringify({
        version: 1,
        title: 'work',
        rootIds: nodes.map((n) => n.id),
        nodes,
    }, null, 2), 'utf8');

    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        rootIds: ['work'],
        items: { work: { type: 'file', id: 'work', title: 'work' } },
    }), 'utf8');

    return {
        dir,
        outPath,
        nodeIdByCell,
        entitiesByCell,
        cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } },
    };
}

/** そのセルが持つ添付の総数（= 期待される tree item 数。枚数対応の番人が使う）。 */
export function expectedItemCount(c: AttachmentCell): number {
    return (c.page ? 1 : 0) + (c.file ? 1 : 0) + c.images;
}
