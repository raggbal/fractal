/**
 * W9 / W10 / W11 / W12（multi-file-dnd-clipboard-matrix）: clipboard の貼り付けの host 側。
 *
 * どれも本物の host 関数を一時フォルダの note / linkedfd に対して呼ぶ（mock は vscode だけ）。
 * Fractal の中では cmd+x → v = 移動 / cmd+c → v = 複製。linkedfd の境界をまたぐものは常に複製（判定は host）。
 *
 * TC-CBH-01 W9 outliner の cut → 同じ note の md: page md / 添付 / 画像は複製せずそのまま指す（移動）。Store の cut は消費される
 * TC-CBH-02 W9 outliner の copy / 別 note の md への cut / Store が copy: 複製（新しい実体）
 * TC-CBH-03 W9 outlinerCutCanMoveToMd: 同じ note = 真 / 別 note・linkedfd の md = 偽
 * TC-CBH-04 W9 cut → linkedfd: clipboard の印 + Store の cut が揃ったときだけ Store の nodes から書き出す（親子も戻る）
 * TC-CBH-10 W10 ツリーの clip → ツリー: cut = 選択順に移動 / copy = Duplicate してその位置へ。folder link は理由付きで飛ばす（通知 1 回）
 * TC-CBH-11 W10 prepareTreeClipCopy: 同じ note の md 宛て = Duplicate / 別 note・linkedfd の md 宛て = 台帳を残す（keepSource）
 * TC-CBH-12 W10 copy → 同じ note の md: 元の項目は残り、複製の方へのリンクが入る / 別 note: 正典が複製し、元の項目は残る
 * TC-CBH-13 W10 normalizeTreeClipItems: seq 順・不正な種類は落とす
 * TC-CBH-20 W11 md clip → ツリー（copy）: 選択の中の 📎 / subpage を選択順に複製して登録。元 md・元実体は不変
 * TC-CBH-21 W11 md clip → ツリー（cut・同じ note）: 実体はそのまま登録（新しいファイルを作らない）
 * TC-CBH-22 W11 md clip → ツリー（cut・linkedfd の md から）: 境界をまたぐので複製
 * TC-CBH-23 W11 md clip → linkedfd: Fractal の md から = 複製 / 同じ linkedfd の md からの cut = その中で移動
 * TC-CBH-24 W11 outliner clip → ツリー: cut（同じ note）= 実体をそのまま登録 + Store 消費 / copy = 複製
 * TC-CBH-25 W11 linkedfd clip → 同じ linkedfd の md（mode 'copy'）: 元のエントリを消さない
 * TC-CBH-26 W11 ツリー clip → linkedfd: `.out` は理由付きで飛ばす（黙って落とさない）
 * TC-CBH-27 W11 201 件で確認 → キャンセルなら 0 件
 * TC-CBH-30 W12 linkedfd → 別の linkedfd: ファイル / md（随伴資産）/ フォルダを複製。元は残る。自分の中へは飛ばす
 * TC-CBH-40 handleNotesMessage が 5 種の message を platform へ渡す / provider と bridge の配線
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purge(): void { for (const k of Object.keys(require.cache)) { if (k.startsWith(SRC_PREFIX)) { delete require.cache[k]; } } }
/** 同じ module instance で handler / store / paste-asset-handler / file manager を読む（Store を共有するため） */
function load(): { mh: any; store: any; pah: any; NotesFileManager: any } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module'); const o = Module._load; purge();
    Module._load = function (r: string) {
        if (r === 'vscode') { return { workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } }, Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) }, commands: { executeCommand: () => {} }, window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined, showOpenDialog: async () => undefined }, env: {}, ViewColumn: {}, EventEmitter: class {} }; }
        // eslint-disable-next-line prefer-rest-params
        return o.apply(this, arguments as any);
    };
    try {
        return {
            mh: require('../../src/shared/notes-message-handler'),
            store: require('../../src/shared/outliner-clipboard-store').OutlinerClipboardStore,
            pah: require('../../src/shared/paste-asset-handler'),
            NotesFileManager: require('../../src/shared/notes-file-manager').NotesFileManager,
        };
    } finally { Module._load = o; }
}

function mkNote(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    return dir;
}
function setup() {
    const L = load();
    const dir = mkNote('cbh-note-');
    const fm = new L.NotesFileManager(dir); fm.loadStructure();
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    const seen: { confirm: number[]; outcome: any[]; errors: string[]; info: string[]; trash: string[] } = { confirm: [], outcome: [], errors: [], info: [], trash: [] };
    const deps: any = {
        confirmLarge: (n: number) => { seen.confirm.push(n); return false; },
        notifyLimitExceeded: () => { /* noop */ },
        notifyOutcome: (o: any) => { seen.outcome.push(o); },
        showErrorMessage: (m: string) => { seen.errors.push(m); },
        showInformationMessage: (m: string) => { seen.info.push(m); },
        t: () => undefined,
        trashDelete: async (abs: string) => { seen.trash.push(abs); fs.rmSync(abs, { recursive: true, force: true }); },
        toDisplayUri: (abs: string) => abs,
    };
    const viewDeps: any = Object.assign({}, deps, { renameFs: fs.renameSync, showInputBox: async () => undefined });
    const extra: string[] = [];
    const cleanup = () => {
        L.store.save(null as any);
        for (const d of [dir, ...extra]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
    };
    return { ...L, fm, dir, sender, messages, deps, viewDeps, seen, extra, cleanup };
}
type S = ReturnType<typeof setup>;

/** note に md item / file item を作る（実体 + 台帳） */
function addMdItem(s: S, id: string, title: string, parentId: string | null = null): string {
    const p = path.join(s.dir, `${id}.md`);
    fs.writeFileSync(p, `# ${title}\n`, 'utf8');
    s.fm.registerExistingMdFile(id, title, parentId, 999);
    return p;
}
function addFileItem(s: S, filename: string, parentId: string | null = null): string {
    fs.writeFileSync(path.join(s.dir, 'files', filename), 'BIN', 'utf8');
    const st: any = s.fm.getStructure();
    const id = 'f_' + filename.replace(/\W/g, '');
    st.items[id] = { type: 'file', id, title: filename, ext: 'file', filename };
    const sib = parentId ? st.items[parentId].childIds : st.rootIds;
    sib.push(id);
    s.fm.saveStructure();
    return id;
}
function rootTitles(s: S): string[] {
    const st: any = s.fm.getStructure();
    return st.rootIds.map((id: string) => st.items[id].title);
}

// ── W9: outliner の cut → md ──────────────────────────────────────────────

/** Store に outliner の clipboard を置く（.out は note 直下 = flat） */
function seedOutlinerClip(s: S, isCut: boolean, noteDir: string = s.dir) {
    fs.writeFileSync(path.join(noteDir, 'pg1.md'), '# Page One\n', 'utf8');
    fs.writeFileSync(path.join(noteDir, 'files', 'doc.pdf'), 'PDF', 'utf8');
    fs.writeFileSync(path.join(noteDir, 'images', 'pic.png'), 'PNG', 'utf8');
    const outPath = path.join(noteDir, 'o1.out');
    fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: [], nodes: {} }), 'utf8');
    const nodes = [
        { text: 'Page One', level: 0, isPage: true, pageId: 'pg1', images: [], filePath: null },
        { text: 'Doc', level: 0, isPage: false, pageId: null, images: [], filePath: 'files/doc.pdf' },
        { text: 'Pic', level: 1, isPage: false, pageId: null, images: ['images/pic.png'], filePath: null },
    ];
    s.store.save({
        plainText: 'Page One\nDoc\n\tPic', isCut, nodes,
        sourcePagesDirPath: noteDir, sourceImagesDirPath: path.join(noteDir, 'images'),
        sourceFileDirPath: path.join(noteDir, 'files'), sourceOutDir: noteDir, sourceOutFilePath: outPath,
    });
    return { outPath, nodes };
}
function pasteOutlinerToMd(s: S, destMd: string, isCut: boolean) {
    return s.pah.runOutlinerNodesPaste({
        plainText: 'Page One\nDoc\n\tPic', fallbackNodes: [], destMdPath: destMd,
        getClipboard: (pt: string) => s.store.get(pt),
        destFilesDir: path.join(path.dirname(destMd), 'files'), destImagesDir: path.join(path.dirname(destMd), 'images'),
        isCut,
        canMove: (st: any) => s.mh.outlinerCutCanMoveToMd(s.fm, st, destMd),
        onCutConsumed: () => s.store.markCutConsumed(),
    });
}

test('TC-CBH-01 W9 outliner の cut → 同じ note の md: 実体はそのまま指す（移動）。Store の cut は 1 回で消費', () => {
    const s = setup();
    try {
        seedOutlinerClip(s, true);
        const dest = path.join(s.dir, 'dst.md'); fs.writeFileSync(dest, '# Dst\n', 'utf8');
        const before = fs.readdirSync(s.dir).sort();
        const r = pasteOutlinerToMd(s, dest, true);
        expect(r.moved, '同じ note の cut が移動にならない').toBe(true);
        expect(r.markdown).toContain('[[Page One]](pg1.md)');
        expect(r.markdown).toContain('[📎 Doc](files/doc.pdf)');
        expect(r.markdown).toContain('![](images/pic.png)');
        expect(fs.readdirSync(s.dir).sort(), 'cut なのに note 直下に新しい md ができた（複製になっている）').toEqual(before);
        expect(fs.readdirSync(path.join(s.dir, 'files')), 'cut なのに添付が複製された').toEqual(['doc.pdf']);
        expect(fs.readdirSync(path.join(s.dir, 'images')), 'cut なのに画像が複製された').toEqual(['pic.png']);
        expect(s.store.peek().isCut, 'Store の cut が消費されていない（2 回目の貼り付けで同じ実体を 2 か所が指す）').toBe(false);
        // 2 回目は複製になる
        const r2 = pasteOutlinerToMd(s, dest, true);
        expect(r2.moved).toBe(false);
        expect(fs.readdirSync(path.join(s.dir, 'files')).length, '2 回目の貼り付けが複製になっていない').toBe(2);
    } finally { s.cleanup(); }
});

test('TC-CBH-02 W9 copy / 別 note への cut / Store が copy のときは複製', () => {
    const s = setup();
    const other = mkNote('cbh-other-');
    s.extra.push(other);
    try {
        // copy
        seedOutlinerClip(s, false);
        const dest = path.join(s.dir, 'dst.md'); fs.writeFileSync(dest, '# Dst\n', 'utf8');
        const r = pasteOutlinerToMd(s, dest, false);
        expect(r.moved).toBe(false);
        expect(r.markdown, 'copy なのに元の page md を指した').not.toContain('(pg1.md)');
        expect(fs.readdirSync(path.join(s.dir, 'files')).length, 'copy で添付が複製されない').toBe(2);
        // webview が cut と言っても Store が copy なら複製（stale cut メタ）
        seedOutlinerClip(s, false);
        expect(pasteOutlinerToMd(s, dest, true).moved, 'Store が copy なのに移動した').toBe(false);
        // 別 note の md への cut = 複製
        seedOutlinerClip(s, true);
        const destOther = path.join(other, 'dst.md'); fs.writeFileSync(destOther, '# D\n', 'utf8');
        const r3 = pasteOutlinerToMd(s, destOther, true);
        expect(r3.moved, '別 note の md への cut が移動になった').toBe(false);
        expect(fs.existsSync(path.join(other, 'files', 'doc.pdf')), '別 note へ添付が複製されない').toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'files', 'doc.pdf')), '元の実体は残る').toBe(true);
        expect(s.store.peek().isCut, '複製なのに cut を消費した').toBe(true);
    } finally { s.cleanup(); }
});

test('TC-CBH-03 W9 outlinerCutCanMoveToMd: 同じ note = 真 / 別 note・linkedfd の md = 偽', () => {
    const s = setup();
    const other = mkNote('cbh-other-');
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fd-'));
    s.extra.push(other, fd);
    try {
        const st = { sourceOutDir: s.dir, sourceOutFilePath: path.join(s.dir, 'o1.out') };
        expect(s.mh.outlinerCutCanMoveToMd(s.fm, st, path.join(s.dir, 'a.md'))).toBe(true);
        expect(s.mh.outlinerCutCanMoveToMd(s.fm, st, path.join(other, 'a.md'))).toBe(false);
        s.fm.registerFolderLink(fd);
        expect(s.mh.outlinerCutCanMoveToMd(s.fm, st, path.join(fd, 'a.md')), 'linkedfd の md へ移動にした').toBe(false);
        // linkedfd が note の中にあっても境界をまたぐ
        const nested = path.join(s.dir, 'nested'); fs.mkdirSync(nested);
        s.fm.registerFolderLink(nested);
        expect(s.mh.outlinerCutCanMoveToMd(s.fm, st, path.join(nested, 'a.md')), 'note の中の linkedfd の md へ移動にした').toBe(false);
        // 別 note の outliner からの cut
        expect(s.mh.outlinerCutCanMoveToMd(s.fm, { sourceOutDir: other, sourceOutFilePath: path.join(other, 'o.out') }, path.join(s.dir, 'a.md'))).toBe(false);
    } finally { s.cleanup(); }
});

test('TC-CBH-04 W9 cut → linkedfd: 印 + Store の cut が揃ったときだけ Store の nodes から（親子も戻る）', async () => {
    const s = setup();
    try {
        const { outPath } = seedOutlinerClip(s, true);
        const clip = { isCut: true, plainText: 'Page One\nDoc\n\tPic' };
        const nodes = s.mh.cutClipNodesForOut({ clip }, outPath);
        expect(nodes, 'cut の clipboard なのに Store の nodes を使わない（.out から消えた node を書き出せない）').not.toBeNull();
        const tree = s.mh.buildExportNodesFromClipNodes(nodes);
        expect(tree.map((n: any) => n.text)).toEqual(['Page One', 'Doc']);
        expect(tree[0].pageId).toBe('pg1');
        expect(tree[1].filePath).toBe('files/doc.pdf');
        expect(tree[1].children.map((n: any) => n.text), 'level の親子が戻らない').toEqual(['Pic']);
        // D&D（印なし）・別の操作の text・copy の Store は disk から作る（null）
        expect(s.mh.cutClipNodesForOut({}, outPath)).toBeNull();
        expect(s.mh.cutClipNodesForOut({ clip: { isCut: true, plainText: 'other' } }, outPath)).toBeNull();
        expect(s.mh.cutClipNodesForOut({ clip }, path.join(s.dir, 'zz.out'))).toBeNull();
        seedOutlinerClip(s, false);
        expect(s.mh.cutClipNodesForOut({ clip }, outPath), 'Store が copy なのに Store の nodes を使った').toBeNull();
        // 実際の書き出し（Export folder の正典）で page md・添付が linkedfd に複製される
        seedOutlinerClip(s, true);
        const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdx-'));
        s.extra.push(fd);
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Module = require('module'); const o = Module._load;
        Module._load = function (r: string) {
            if (r === 'vscode') { return { window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: async () => undefined, showOpenDialog: async () => undefined }, workspace: { getConfiguration: () => ({ get: () => undefined }) } }; }
            // eslint-disable-next-line prefer-rest-params
            return o.apply(this, arguments as any);
        };
        let host: any;
        try { host = require('../../src/shared/folder-export-host'); } finally { Module._load = o; }
        const outcome = await host.runSendNodesToFolderLink({
            tree: s.mh.buildExportNodesFromClipNodes(s.mh.cutClipNodesForOut({ clip }, outPath)),
            srcOutDir: s.dir, srcPagesDir: s.dir, srcFileDir: path.join(s.dir, 'files'), srcImageDir: path.join(s.dir, 'images'),
            destRoot: fd,
        });
        expect(outcome.status).toBe('exported');
        const all = fs.readdirSync(fd, { recursive: true } as any).map(String);
        // Export folder の正典は node の文字を名前にする（Doc/Doc.pdf・Page One.md）
        expect(all.some((n) => /Doc\.pdf$/.test(n)), 'cut した node の添付が linkedfd に書き出されない').toBe(true);
        expect(all, 'cut した page node が書き出されない').toContain('Page One.md');
        expect(fs.existsSync(path.join(s.dir, 'files', 'doc.pdf')), '元の実体を消した').toBe(true);
    } finally { s.cleanup(); }
});

// ── W10: ツリーの clipboard ──────────────────────────────────────────────

test('TC-CBH-10 W10 ツリー → ツリー: cut = 選択順に移動 / copy = Duplicate してその位置。folder link は飛ばして通知 1 回', async () => {
    const s = setup();
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdt-'));
    s.extra.push(fd);
    try {
        addMdItem(s, 'ma', 'A'); addMdItem(s, 'mb', 'B');
        const fid = addFileItem(s, 'c.pdf');
        const st: any = s.fm.createFolder('Dir', null, null);
        const dirId = Object.keys(st.items).find((k) => st.items[k].type === 'folder' && st.items[k].title === 'Dir') as string;
        // cut: [mb, c.pdf] → Dir の中へ（選択順）
        let r = await s.mh.pasteTreeClipIntoTree(s.fm, s.sender, [{ kind: 'md', id: 'mb' }, { kind: 'file', id: fid }], false, dirId, 0, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(st.items[dirId].childIds, 'cut がフォルダの中へ選択順に移動しない').toEqual(['mb', fid]);
        expect(st.rootIds).not.toContain('mb');
        // copy: [ma] → root の ma の後ろ（index 1）。元は残り、複製がその位置に入る
        const linkId = s.fm.registerFolderLink(fd);
        const idxAfterMa = st.rootIds.indexOf('ma') + 1;
        r = await s.mh.pasteTreeClipIntoTree(s.fm, s.sender, [{ kind: 'md', id: 'ma' }, { kind: 'folder', id: linkId }], true, null, idxAfterMa, s.deps);
        expect(r.outcome.succeeded).toBe(1);
        expect(r.outcome.skipped, 'folder link を飛ばしていない').toBe(1);
        expect(s.seen.outcome.length, '集計通知が 1 回でない').toBe(1);
        const maAt = st.rootIds.indexOf('ma');
        const dupId = st.rootIds[maAt + 1];
        expect(dupId, 'copy が元の直後に入らない').not.toBe('ma');
        expect(st.items[dupId].ext).toBe('md');
        expect(fs.existsSync(path.join(s.dir, `${dupId}.md`)), '複製の実体が無い').toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'ma.md')), '元の実体が消えた').toBe(true);
        expect(s.messages.filter((m) => m.type === 'notesFileListChanged').length).toBeGreaterThan(0);
    } finally { s.cleanup(); }
});

test('TC-CBH-11 W10 prepareTreeClipCopy: 同じ note = Duplicate / 別 note・linkedfd の md 宛て = 台帳を残す', () => {
    const s = setup();
    const other = mkNote('cbh-other-');
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdp-'));
    s.extra.push(other, fd);
    try {
        addMdItem(s, 'ma', 'A');
        const fid = addFileItem(s, 'c.pdf');
        const same = s.mh.prepareTreeClipCopy(s.fm, { kind: 'md', id: 'ma', filePath: path.join(s.dir, 'ma.md') }, path.join(s.dir, 'x.md'));
        expect(same.keepSource).toBe(false);
        expect(same.item.id, '同じ note の md 宛てなのに Duplicate しない（元を移動してしまう）').not.toBe('ma');
        expect(same.item.filePath).toBe(path.join(s.dir, `${same.item.id}.md`));
        const fileSame = s.mh.prepareTreeClipCopy(s.fm, { kind: 'file', id: fid }, null);
        expect(fileSame.item.id).not.toBe(fid);
        expect(fs.readdirSync(path.join(s.dir, 'files')).length, '添付の複製が無い').toBe(2);
        const cross = s.mh.prepareTreeClipCopy(s.fm, { kind: 'md', id: 'ma' }, path.join(other, 'x.md'));
        expect(cross, '別 note の md 宛てに Duplicate した（正典がもう 1 つ複製を作る）').toEqual({ item: { kind: 'md', id: 'ma' }, keepSource: true });
        s.fm.registerFolderLink(fd);
        const lfd = s.mh.prepareTreeClipCopy(s.fm, { kind: 'file', id: fid }, path.join(fd, 'x.md'));
        expect(lfd.keepSource).toBe(true);
        expect(lfd.item.id).toBe(fid);
    } finally { s.cleanup(); }
});

test('TC-CBH-12 W10 copy → md editor: 同じ note = 複製へのリンク・元の項目は残る / 別 note = 正典が複製して元の項目は残る', () => {
    const s = setup();
    const other = mkNote('cbh-other-');
    s.extra.push(other);
    try {
        addMdItem(s, 'ma', 'A');
        const fid = addFileItem(s, 'c.pdf');
        const dest = path.join(s.dir, 'dst.md'); fs.writeFileSync(dest, '# Dst\n', 'utf8');
        const st: any = s.fm.getStructure();
        // 同じ note（provider の pasteTreeClip と同じ組み合わせ: prepare → 既存の 1 件分の正典）
        const p1 = s.mh.prepareTreeClipCopy(s.fm, { kind: 'md', id: 'ma', filePath: path.join(s.dir, 'ma.md') }, dest);
        expect(s.mh.linkMdAsSubpageForSidePanelCore(s.fm, s.sender, p1.item.filePath, p1.item.id, dest, p1.keepSource)).toBe(true);
        const p2 = s.mh.prepareTreeClipCopy(s.fm, { kind: 'file', id: fid }, dest);
        expect(s.mh.treeFileAttachToMdEditor(s.fm, s.sender, p2.item.id, dest, p2.keepSource)).toBe(true);
        expect(st.items.ma, 'copy なのに元の md 項目がツリーから消えた').toBeTruthy();
        expect(st.items[fid], 'copy なのに元の添付項目がツリーから消えた').toBeTruthy();
        expect(st.items[p1.item.id], '複製の方はツリーから外れて md の subpage になる').toBeFalsy();
        const ins = s.messages.filter((m) => /^insert/.test(m.type)).map((m) => m.markdownPath);
        expect(ins[0], '元の md を指した（共有になる）').not.toBe('ma.md');
        expect(ins[1], '元の添付を指した').not.toBe('files/c.pdf');
        // 別 note の md（sidepanel）へ: 正典が実体を複製し、keepSource で元の項目を残す
        s.messages.length = 0;
        const destOther = path.join(other, 'dst.md'); fs.writeFileSync(destOther, '# D\n', 'utf8');
        const srcBefore = fs.readdirSync(s.dir).sort();
        const p3 = s.mh.prepareTreeClipCopy(s.fm, { kind: 'md', id: 'ma', filePath: path.join(s.dir, 'ma.md') }, destOther);
        expect(s.mh.linkMdAsSubpageForSidePanelCore(s.fm, s.sender, p3.item.filePath, p3.item.id, destOther, p3.keepSource)).toBe(true);
        expect(st.items.ma, '別 note への copy で元の項目が消えた').toBeTruthy();
        expect(fs.readdirSync(s.dir).sort(), '別 note への copy で元の note に複製のゴミ（台帳に無い md）が残った').toEqual(srcBefore);
        expect(fs.readdirSync(other).some((n) => /^ma.*\.md$/.test(n)), '別 note に複製されない').toBe(true);
        // cut（keepSource 無し）は従来どおり移動
        expect(s.mh.treeFileAttachToMdEditor(s.fm, s.sender, fid, dest)).toBe(true);
        expect(st.items[fid], 'cut（移動）なのに項目が残った').toBeFalsy();
    } finally { s.cleanup(); }
});

test('TC-CBH-13 W10 normalizeTreeClipItems: seq 順・不正な種類と id 無しは落とす', () => {
    const s = setup();
    try {
        expect(s.mh.normalizeTreeClipItems([
            { kind: 'file', id: 'b', seq: 2 }, { kind: 'bogus', id: 'x', seq: 0 }, { kind: 'out', id: 'o', seq: 1 },
            { kind: 'md', id: 'a', filePath: '/n/a.md', seq: 0 }, { kind: 'md', seq: 3 }, null,
        ])).toEqual([
            { kind: 'md', id: 'a', filePath: '/n/a.md' }, { kind: 'out', id: 'o', filePath: null }, { kind: 'file', id: 'b', filePath: null }]);
        expect(s.mh.normalizeTreeClipItems('x')).toEqual([]);
    } finally { s.cleanup(); }
});

// ── レビュー指摘の修正（W9 / W10）───────────────────────────────────────

test('TC-CBH-05 W9 cut → md: .out の fileDir が md の files/ と違えば、同名の別ファイルがあっても流用せず uniquify して複製', () => {
    const s = setup();
    try {
        // .out は note 直下、添付は attachments/（outData.fileDir を変えた note）。md の files/ には同名の別物がある
        fs.mkdirSync(path.join(s.dir, 'attachments'), { recursive: true });
        fs.writeFileSync(path.join(s.dir, 'attachments', 'report.pdf'), 'CUT-SOURCE', 'utf8');
        fs.writeFileSync(path.join(s.dir, 'files', 'report.pdf'), 'UNRELATED', 'utf8');
        const outPath = path.join(s.dir, 'o1.out');
        fs.writeFileSync(outPath, JSON.stringify({ version: 1, rootIds: [], nodes: {} }), 'utf8');
        s.store.save({
            plainText: 'Report', isCut: true,
            nodes: [{ text: 'Report', level: 0, isPage: false, pageId: null, images: [], filePath: 'attachments/report.pdf' }],
            sourcePagesDirPath: s.dir, sourceImagesDirPath: path.join(s.dir, 'images'),
            sourceFileDirPath: path.join(s.dir, 'attachments'), sourceOutDir: s.dir, sourceOutFilePath: outPath,
        });
        const dest = path.join(s.dir, 'dst.md'); fs.writeFileSync(dest, '# Dst\n', 'utf8');
        const r = s.pah.runOutlinerNodesPaste({
            plainText: 'Report', fallbackNodes: [], destMdPath: dest,
            getClipboard: (pt: string) => s.store.get(pt),
            destFilesDir: path.join(s.dir, 'files'), destImagesDir: path.join(s.dir, 'images'),
            isCut: true,
            canMove: (st: any) => s.mh.outlinerCutCanMoveToMd(s.fm, st, dest),
            onCutConsumed: () => s.store.markCutConsumed(),
        });
        const m = /\[📎 [^\]]*\]\(([^)]+)\)/.exec(r.markdown);
        expect(m, '📎 リンクが無い').toBeTruthy();
        const linked = path.resolve(s.dir, decodeURIComponent(m![1]));
        expect(fs.readFileSync(linked, 'utf8'), '同名の無関係なファイルを指した（cut した添付が orphan になる）').toBe('CUT-SOURCE');
        expect(fs.readFileSync(path.join(s.dir, 'files', 'report.pdf'), 'utf8'), '既存の別ファイルを上書きした').toBe('UNRELATED');
    } finally { s.cleanup(); }
});

test('TC-CBH-06 W9 Store の cut を消費したら outliner の panel へ知らせる（onCutConsumed）。copy・2 回目は知らせない', () => {
    const s = setup();
    const heard: string[] = [];
    const sub = s.store.onCutConsumed((pt: string) => { heard.push(pt); });
    try {
        seedOutlinerClip(s, true);
        const dest = path.join(s.dir, 'dst.md'); fs.writeFileSync(dest, '# Dst\n', 'utf8');
        expect(pasteOutlinerToMd(s, dest, true).moved).toBe(true);
        expect(heard, '移動で cut を消費したのに outliner へ知らせない（outliner に戻って貼ると cut のまま復元する）').toEqual(['Page One\nDoc\n\tPic']);
        pasteOutlinerToMd(s, dest, true);   // 2 回目は複製（もう cut ではない）
        seedOutlinerClip(s, false);
        pasteOutlinerToMd(s, dest, false);
        expect(heard.length, 'cut でないのに知らせた').toBe(1);
        sub.dispose();
        seedOutlinerClip(s, true);
        pasteOutlinerToMd(s, dest, true);
        expect(heard.length, 'dispose 後も呼ばれた（panel を閉じても残る）').toBe(1);
        // panel ごとに購読して webview へ送る（notes の panel・.out の custom editor の両方）
        for (const f of ['../../src/notesEditorProvider.ts', '../../src/outlinerProvider.ts']) {
            const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
            expect(src, `${f} が Store の cut の消費を outliner の webview へ送っていない`)
                .toMatch(/disposables\.push\([^\n]*OutlinerClipboardStore\.onCutConsumed\([\s\S]{0,200}?type: 'outlinerCutConsumed'/);
        }
    } finally { sub.dispose(); s.cleanup(); }
});

/** provider の pasteTreeClip（md 宛て）と同じ組み合わせ: pasteTreeClipIntoEditor + 1 件分は treeMdItemToMdEditor / treeFileAttachToMdEditor */
function pasteTreeClipToMd(s: S, items: any[], copy: boolean, dest: string) {
    const asBlock = items.length > 1;
    return s.mh.pasteTreeClipIntoEditor(s.fm, s.sender, s.mh.normalizeTreeClipItems(items), copy, dest, false,
        (it: any, keepSource: boolean) => (it.kind === 'md'
            ? s.mh.treeMdItemToMdEditor(s.fm, s.sender, it.id, dest, keepSource, asBlock)
            : s.mh.treeFileAttachToMdEditor(s.fm, s.sender, it.id, dest, keepSource)), s.deps);
}

test('TC-CBH-14 W10 ツリーの cut を md へ 2 回貼っても、2 回目は台帳に無いので飛ばす（2 つの md が同じ subpage を指さない）', async () => {
    const s = setup();
    try {
        addMdItem(s, 'ma', 'A');
        const x = path.join(s.dir, 'x.md'); fs.writeFileSync(x, '# X\n', 'utf8');
        const y = path.join(s.dir, 'y.md'); fs.writeFileSync(y, '# Y\n', 'utf8');
        const clip = [{ kind: 'md', id: 'ma', filePath: path.join(s.dir, 'ma.md') }];
        let r = await pasteTreeClipToMd(s, clip, false, x);
        expect(r.outcome.succeeded).toBe(1);
        expect(s.fm.getStructure().items.ma, 'cut なのに項目が残った').toBeFalsy();
        s.messages.length = 0;
        r = await pasteTreeClipToMd(s, clip, false, y);
        expect(r.outcome.succeeded, '同じ cut の 2 回目でまたリンクした（A.md が X と Y 両方の subpage になる）').toBe(0);
        expect(r.outcome.skipped).toBe(1);
        expect(s.messages.filter((m) => m.type === 'insertSubpageLink')).toEqual([]);
    } finally { s.cleanup(); }
});

test('TC-CBH-15 W10 clipboard の filePath は使わない: 台帳に無い id + note の外の md は複製も挿入もしない', async () => {
    const s = setup();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-outside-'));
    s.extra.push(outside);
    try {
        const secret = path.join(outside, 'secret.txt'); fs.writeFileSync(secret, 'SECRET', 'utf8');
        const dest = path.join(s.dir, 'x.md'); fs.writeFileSync(dest, '# X\n', 'utf8');
        const before = fs.readdirSync(s.dir).sort();
        const r = await pasteTreeClipToMd(s, [{ kind: 'md', id: 'forged', filePath: secret }], false, dest);
        expect(r.outcome.succeeded).toBe(0);
        expect(s.messages.filter((m) => m.type === 'insertSubpageLink'), '偽の clipboard の filePath を信じた').toEqual([]);
        expect(fs.readdirSync(s.dir).sort(), 'note の外のファイルが note に取り込まれた').toEqual(before);
    } finally { s.cleanup(); }
});

test('TC-CBH-16 W10 ツリーの複数 md を md へ: subpage の挿入指示に asBlock（1 行 1 リンク）/ 1 件は inline', async () => {
    const s = setup();
    try {
        addMdItem(s, 'ma', 'A'); addMdItem(s, 'mb', 'B');
        const fid = addFileItem(s, 'c.pdf');
        const dest = path.join(s.dir, 'x.md'); fs.writeFileSync(dest, '# X\n', 'utf8');
        await pasteTreeClipToMd(s, [{ kind: 'md', id: 'ma', seq: 0 }, { kind: 'file', id: fid, seq: 1 }, { kind: 'md', id: 'mb', seq: 2 }], false, dest);
        const ins = s.messages.filter((m) => /^insert/.test(m.type));
        expect(ins.map((m) => m.type)).toEqual(['insertSubpageLink', 'insertFileLink', 'insertSubpageLink']);
        expect(ins.filter((m) => m.type === 'insertSubpageLink').map((m) => m.asBlock), '複数の subpage が 1 行に連結される').toEqual([true, true]);
        s.messages.length = 0;
        addMdItem(s, 'mc', 'C');
        await pasteTreeClipToMd(s, [{ kind: 'md', id: 'mc' }], false, dest);
        expect(s.messages.find((m) => m.type === 'insertSubpageLink').asBlock, '1 件なのに block にした').toBeFalsy();
    } finally { s.cleanup(); }
});

test('TC-CBH-17 W10 ツリーの copy の貼り付けが失敗したら、先に作った複製をツリーと disk から片付ける', async () => {
    const s = setup();
    const prevTrash = s.NotesFileManager.trashImpl;
    s.NotesFileManager.trashImpl = async (abs: string) => { fs.rmSync(abs, { recursive: true, force: true }); };
    try {
        addMdItem(s, 'ma', 'A');
        const fid = addFileItem(s, 'c.pdf');
        const ids = () => Object.keys(s.fm.getStructure().items).sort();
        const beforeIds = ids();
        const beforeDir = fs.readdirSync(s.dir).sort();
        const beforeFiles = fs.readdirSync(path.join(s.dir, 'files')).sort();
        const dest = path.join(s.dir, 'x.md');   // outliner 宛てと同じく「同じ note」= Duplicate してから渡す
        const items = s.mh.normalizeTreeClipItems([{ kind: 'md', id: 'ma' }, { kind: 'file', id: fid }]);
        // 失敗（false）と例外の両方
        let n = 0;
        const r = await s.mh.pasteTreeClipIntoEditor(s.fm, s.sender, items, true, dest, false,
            () => { n++; if (n === 1) { return false; } throw new Error('boom'); }, s.deps);
        expect(r.outcome.succeeded).toBe(0);
        expect(ids(), '失敗した copy の複製がツリーに残った（再試行のたびに増える）').toEqual(beforeIds);
        expect(fs.readdirSync(s.dir).sort(), '失敗した copy の md の複製が disk に残った').toEqual(beforeDir);
        expect(fs.readdirSync(path.join(s.dir, 'files')).sort(), '失敗した copy の添付の複製が disk に残った').toEqual(beforeFiles);
        // 成功したものは片付けない
        const ok = await s.mh.pasteTreeClipIntoEditor(s.fm, s.sender, s.mh.normalizeTreeClipItems([{ kind: 'file', id: fid }]), true, null, false,
            () => true, s.deps);
        expect(ok.outcome.succeeded).toBe(1);
        expect(ids().length, '成功した copy の複製まで消した').toBe(beforeIds.length + 1);
    } finally { s.NotesFileManager.trashImpl = prevTrash; s.cleanup(); }
});

// ── W11: md の clipboard → ツリー / linkedfd ──────────────────────────────

const CLIP_MD = '[[Alpha]](alpha.md) and [📎 x.pdf](files/x.pdf) then [[Beta]](beta.md) ![](images/p.png) end';
function seedMdSource(dir: string): void {
    fs.writeFileSync(path.join(dir, 'alpha.md'), '# Alpha\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'beta.md'), '# Beta\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'x.pdf'), 'PDF', 'utf8');
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'p.png'), 'PNG', 'utf8');
}
const ctxOf = (dir: string) => ({ imageDir: path.join(dir, 'images'), fileDir: path.join(dir, 'files'), mdDir: dir });

test('TC-CBH-20 W11 md clip → ツリー（copy）: 📎 / subpage を選択順に複製して登録。元は不変、画像と文字は運ばない', async () => {
    const s = setup();
    try {
        seedMdSource(s.dir);
        addMdItem(s, 'mz', 'Z');
        const r = await s.mh.pasteMdClipToTree(s.fm, s.sender, CLIP_MD, ctxOf(s.dir), false, null, 0, s.deps);
        expect(r.outcome).toMatchObject({ succeeded: 3, skipped: 0 });
        expect(rootTitles(s).slice(0, 3), '選択順に登録されない').toEqual(['Alpha', 'x.pdf', 'Beta']);
        const st: any = s.fm.getStructure();
        const [a, x, b] = st.rootIds.slice(0, 3);
        expect(a, 'copy なのに元の md をそのまま登録した').not.toBe('alpha');
        expect(fs.existsSync(path.join(s.dir, `${a}.md`))).toBe(true);
        expect(st.items[x].filename, 'copy なのに元の添付をそのまま登録した').not.toBe('x.pdf');
        expect(st.items[b].ext).toBe('md');
        expect(fs.readdirSync(path.join(s.dir, 'images')), '画像まで運んだ').toEqual(['p.png']);
        expect(st.rootIds[3]).toBe('mz');
    } finally { s.cleanup(); }
});

test('TC-CBH-21 W11 md clip → ツリー（cut・同じ note）: 実体はそのまま登録（新しいファイルを作らない）', async () => {
    const s = setup();
    try {
        seedMdSource(s.dir);
        const before = fs.readdirSync(s.dir).sort();
        const r = await s.mh.pasteMdClipToTree(s.fm, s.sender, CLIP_MD, ctxOf(s.dir), true, null, 0, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        const st: any = s.fm.getStructure();
        expect(st.rootIds.slice(0, 3), 'cut なのに複製を登録した').toEqual(['alpha', st.rootIds[1], 'beta']);
        expect(st.items[st.rootIds[1]].filename).toBe('x.pdf');
        expect(fs.readdirSync(s.dir).sort(), 'cut なのにファイルが増えた').toEqual(before);
        expect(fs.readdirSync(path.join(s.dir, 'files'))).toEqual(['x.pdf']);
    } finally { s.cleanup(); }
});

test('TC-CBH-22 W11 md clip → ツリー（cut・linkedfd の md から）: 境界をまたぐので複製・元はそのまま', async () => {
    const s = setup();
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdm-'));
    s.extra.push(fd);
    try {
        fs.mkdirSync(path.join(fd, 'files'));
        seedMdSource(fd);
        s.fm.registerFolderLink(fd);
        const r = await s.mh.pasteMdClipToTree(s.fm, s.sender, CLIP_MD, ctxOf(fd), true, null, 0, s.deps);
        expect(r.outcome.succeeded).toBe(3);
        expect(fs.existsSync(path.join(fd, 'alpha.md')), 'linkedfd の実体を動かした').toBe(true);
        expect(fs.existsSync(path.join(fd, 'files', 'x.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'files', 'x.pdf')), 'note に複製されない').toBe(true);
        expect(fs.readdirSync(s.dir).filter((n) => /^alpha.*\.md$/.test(n)).length).toBe(1);
    } finally { s.cleanup(); }
});

test('TC-CBH-23 W11 md clip → linkedfd: Fractal の md から = 複製 / 同じ linkedfd の md からの cut = 移動', async () => {
    const s = setup();
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdv-'));
    s.extra.push(fd);
    try {
        seedMdSource(s.dir);
        const linkId = s.fm.registerFolderLink(fd);
        // Fractal（note）の md から → cut でも複製
        let r = await s.mh.pasteMdClipToFolderView(s.fm, CLIP_MD, ctxOf(s.dir), true, linkId, '', s.viewDeps, s.deps, s.sender);
        expect(r.outcome.succeeded).toBe(3);
        expect(fs.existsSync(path.join(fd, 'alpha.md'))).toBe(true);
        expect(fs.existsSync(path.join(fd, 'x.pdf'))).toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'alpha.md')), 'Fractal の実体を消した（境界をまたぐのに移動）').toBe(true);
        expect(fs.existsSync(path.join(s.dir, 'files', 'x.pdf'))).toBe(true);
        expect(s.seen.trash).toEqual([]);
        // 同じ linkedfd の中の md（sub/）から cut → linkedfd の中で移動（sub/ から root へ）
        const sub = path.join(fd, 'sub'); fs.mkdirSync(path.join(sub, 'files'), { recursive: true });
        fs.writeFileSync(path.join(sub, 'gamma.md'), '# Gamma\n', 'utf8');
        fs.writeFileSync(path.join(sub, 'files', 'y.pdf'), 'Y', 'utf8');
        r = await s.mh.pasteMdClipToFolderView(s.fm, '[[Gamma]](gamma.md) [📎 y.pdf](files/y.pdf)', ctxOf(sub), true, linkId, '', s.viewDeps, s.deps, s.sender);
        expect(r.outcome.succeeded).toBe(2);
        expect(fs.existsSync(path.join(fd, 'gamma.md')), '同じ linkedfd の中の cut が root へ動かない').toBe(true);
        expect(fs.existsSync(path.join(sub, 'files', 'y.pdf')), '同じ linkedfd の中の cut なのに元が残った（複製になっている）').toBe(false);
        expect(fs.existsSync(path.join(fd, 'y.pdf'))).toBe(true);
        // 同じ linkedfd の md からの copy → 元は残る
        fs.writeFileSync(path.join(sub, 'files', 'z.pdf'), 'Z', 'utf8');
        await s.mh.pasteMdClipToFolderView(s.fm, '[📎 z.pdf](files/z.pdf)', ctxOf(sub), false, linkId, '', s.viewDeps, s.deps, s.sender);
        expect(fs.existsSync(path.join(sub, 'files', 'z.pdf')), 'copy で元を消した').toBe(true);
        expect(fs.existsSync(path.join(fd, 'z.pdf'))).toBe(true);
    } finally { s.cleanup(); }
});

test('TC-CBH-24 W11 outliner clip → ツリー: cut（同じ note）= 実体のまま登録 + Store 消費 / copy = 複製', async () => {
    const s = setup();
    try {
        seedOutlinerClip(s, true);
        const before = fs.readdirSync(s.dir).sort();
        let r = await s.mh.pasteOutlinerClipToTree(s.fm, s.sender, 'Page One\nDoc\n\tPic', true, null, 0, s.deps);
        expect(r.outcome.succeeded, '画像だけの node まで運んだ / 添付を取りこぼした').toBe(2);
        const st: any = s.fm.getStructure();
        expect(st.rootIds.slice(0, 2)[0], 'cut の page md をそのまま登録しない').toBe('pg1');
        expect(st.items[st.rootIds[1]].filename).toBe('doc.pdf');
        expect(fs.readdirSync(s.dir).sort(), 'cut なのにファイルが増えた').toEqual(before);
        expect(s.store.peek().isCut, 'Store の cut を消費していない').toBe(false);
        // copy = 複製（既に登録済みの pg1 とは別の項目）
        seedOutlinerClip(s, false);
        r = await s.mh.pasteOutlinerClipToTree(s.fm, s.sender, 'Page One\nDoc\n\tPic', false, null, 0, s.deps);
        expect(r.outcome.succeeded).toBe(2);
        expect(st.rootIds[0], 'copy なのに元の page md を登録した').not.toBe('pg1');
        expect(fs.readdirSync(path.join(s.dir, 'files')).length).toBe(2);
        // webview が cut と言っても Store が copy なら複製
        seedOutlinerClip(s, false);
        await s.mh.pasteOutlinerClipToTree(s.fm, s.sender, 'Page One\nDoc\n\tPic', true, null, 0, s.deps);
        expect(fs.readdirSync(path.join(s.dir, 'files')).length, 'Store が copy なのに移動した').toBe(3);
    } finally { s.cleanup(); }
});

test('TC-CBH-25 W11 linkedfd clip → 同じ linkedfd の md（mode copy）: 元のエントリを消さない / D&D（move）は従来どおり', async () => {
    const s = setup();
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdc-'));
    s.extra.push(fd);
    try {
        const linkId = s.fm.registerFolderLink(fd);
        fs.mkdirSync(path.join(fd, 'sub'));
        fs.writeFileSync(path.join(fd, 'sub', 'target.md'), '# T\n', 'utf8');
        fs.writeFileSync(path.join(fd, 'a.pdf'), 'A', 'utf8');
        fs.writeFileSync(path.join(fd, 'b.pdf'), 'B', 'utf8');
        const target = path.join(fd, 'sub', 'target.md');
        await s.mh.folderViewMoveIntoMdBatch(s.fm, linkId, ['a.pdf'], target, s.deps, s.sender, { mode: 'copy' });
        expect(fs.existsSync(path.join(fd, 'a.pdf')), 'copy なのに元のエントリを消した').toBe(true);
        expect(s.messages.some((m) => m.type === 'insertFileLink')).toBe(true);
        await s.mh.folderViewMoveIntoMdBatch(s.fm, linkId, ['b.pdf'], target, s.deps, s.sender);
        expect(fs.existsSync(path.join(fd, 'b.pdf')), 'D&D（移動）の挙動が変わった').toBe(false);
    } finally { s.cleanup(); }
});

test('TC-CBH-26 W11 ツリー clip → linkedfd: .out は理由付きで飛ばす（黙って落とさない）', async () => {
    const s = setup();
    const fd = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdo-'));
    s.extra.push(fd);
    try {
        const linkId = s.fm.registerFolderLink(fd);
        const fid = addFileItem(s, 'c.pdf');
        const r = await s.mh.folderViewMoveInBatch(s.fm, linkId, '', [{ srcKind: 'file', srcItemId: fid }, { srcKind: 'out', srcItemId: 'o1' }], s.deps, s.sender);
        expect(r.outcome.succeeded).toBe(1);
        expect(r.outcome.skipped, '.out を黙って落とした').toBe(1);
        expect(r.outcome.reasons.kind_unsupported).toBe(1);
        expect(s.seen.outcome.length).toBe(1);
        expect(fs.existsSync(path.join(fd, 'c.pdf'))).toBe(true);
        expect(s.fm.getStructure().items[fid], 'linkedfd へ貼ったのに元の項目が消えた').toBeTruthy();
    } finally { s.cleanup(); }
});

test('TC-CBH-27 W11 201 件で確認 → キャンセルなら 0 件', async () => {
    const s = setup();
    try {
        seedMdSource(s.dir);
        const many = Array.from({ length: 201 }, () => '[📎 x.pdf](files/x.pdf)').join(' ');
        const r = await s.mh.pasteMdClipToTree(s.fm, s.sender, many, ctxOf(s.dir), false, null, 0, s.deps);
        expect(s.seen.confirm).toEqual([201]);
        expect(r.verdict).not.toBe('ok');
        expect(fs.readdirSync(path.join(s.dir, 'files')), 'キャンセルしたのに複製した').toEqual(['x.pdf']);
        expect(s.fm.getStructure().rootIds).toEqual([]);
    } finally { s.cleanup(); }
});

// ── W12: linkedfd → 別の linkedfd ─────────────────────────────────────────

test('TC-CBH-30 W12 linkedfd → 別の linkedfd: ファイル / md（随伴資産）/ フォルダを複製。元は残る。自分の中へは飛ばす', async () => {
    const s = setup();
    const a = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fda-'));
    const b = fs.mkdtempSync(path.join(os.tmpdir(), 'cbh-fdb-'));
    s.extra.push(a, b);
    try {
        const la = s.fm.registerFolderLink(a);
        const lb = s.fm.registerFolderLink(b);
        fs.writeFileSync(path.join(a, 'one.pdf'), '1', 'utf8');
        fs.mkdirSync(path.join(a, 'files'));
        fs.writeFileSync(path.join(a, 'files', 'att.pdf'), 'ATT', 'utf8');
        fs.writeFileSync(path.join(a, 'note.md'), '# N\n\n[📎 att](files/att.pdf)\n', 'utf8');
        fs.mkdirSync(path.join(a, 'dir')); fs.writeFileSync(path.join(a, 'dir', 'in.txt'), 'IN', 'utf8');
        fs.mkdirSync(path.join(b, 'dst'));
        const r = await s.mh.folderViewCopyAcrossLinks(s.fm, la, ['one.pdf', 'note.md', 'dir'], lb, 'dst', s.deps, s.sender);
        expect(r.outcome).toMatchObject({ succeeded: 3, skipped: 0, failed: 0 });
        expect(fs.readFileSync(path.join(b, 'dst', 'one.pdf'), 'utf8')).toBe('1');
        expect(fs.existsSync(path.join(b, 'dst', 'note.md'))).toBe(true);
        expect(fs.existsSync(path.join(b, 'dst', 'files', 'att.pdf')), 'md の随伴資産が複製されない').toBe(true);
        expect(fs.readFileSync(path.join(b, 'dst', 'dir', 'in.txt'), 'utf8'), 'フォルダが再帰で複製されない').toBe('IN');
        for (const p of ['one.pdf', 'note.md', 'files/att.pdf', 'dir/in.txt']) {
            expect(fs.existsSync(path.join(a, p)), `元の ${p} を消した（境界をまたぐのに移動）`).toBe(true);
        }
        expect(s.seen.trash).toEqual([]);
        expect(s.messages.filter((m) => m.type === 'folderViewListResult' && m.folderLinkId === lb).length, '行き先の一覧を再送しない').toBe(1);
        expect(s.seen.info.length, 'フォルダを含むのに内訳通知が無い').toBe(1);
        // 同名は uniquify（2 回目）
        await s.mh.folderViewCopyAcrossLinks(s.fm, la, ['one.pdf'], lb, 'dst', s.deps, s.sender);
        expect(fs.readdirSync(path.join(b, 'dst')).filter((n) => /^one.*\.pdf$/.test(n)).length).toBe(2);
        // 行き先の linkedfd が元のフォルダの中にある → その中へは複製しない
        const inner = path.join(a, 'dir', 'inner'); fs.mkdirSync(inner);
        const li = s.fm.registerFolderLink(inner);
        s.seen.outcome.length = 0;
        const r2 = await s.mh.folderViewCopyAcrossLinks(s.fm, la, ['dir', 'one.pdf'], li, '', s.deps, s.sender);
        expect(r2.outcome.succeeded).toBe(1);
        expect(r2.outcome.reasons.into_self, '自分の中への複製を止めない').toBe(1);
        expect(s.seen.outcome.length, '集計通知が 1 回でない').toBe(1);
        // 201 件で確認
        s.deps.confirmLarge = (n: number) => { s.seen.confirm.push(n); return false; };
        const r3 = await s.mh.folderViewCopyAcrossLinks(s.fm, la, Array.from({ length: 201 }, () => 'one.pdf'), lb, '', s.deps, s.sender);
        expect(r3.verdict).not.toBe('ok');
        expect(s.seen.confirm).toContain(201);
    } finally { s.cleanup(); }
});

// ── 配線 ──────────────────────────────────────────────────────────────────

test('TC-CBH-40 handleNotesMessage が clipboard の message を platform へ渡す / provider と bridge の配線', async () => {
    const s = setup();
    try {
        const got: any[] = [];
        const platform: any = {};
        for (const k of ['pasteTreeClip', 'pasteMdClip', 'pasteOutlinerClipToTree', 'folderViewCopyAcrossLinks', 'folderViewMoveIntoMdBatch', 'pasteOutlinerNodesWithAssets']) {
            platform[k] = (...a: any[]) => { got.push([k, ...a.filter((x) => !(x && typeof x.postMessage === 'function'))]); };
        }
        const send = (m: any) => s.mh.handleNotesMessage(m, s.fm, s.sender, platform);
        const clip = { items: [{ kind: 'md', id: 'a' }], isCut: true };
        await send({ type: 'pasteTreeClip', clip, target: { kind: 'tree', parentId: null, index: 1 } });
        await send({ type: 'pasteMdClip', mdText: 'M', sourceContext: { mdDir: '/n' }, isCut: true, target: { kind: 'fv' } });
        await send({ type: 'pasteOutlinerClipToTree', plainText: 'P', isCut: 1, parentId: 'd', index: 2 });
        await send({ type: 'folderViewCopyAcrossLinks', srcLinkId: 'a', relPaths: ['x'], dstLinkId: 'b', dstDirRelPath: 'd' });
        await send({ type: 'folderViewMoveIntoMdBatch', id: 'a', relPaths: ['x'], targetMdPath: '/t.md', mode: 'copy' });
        await send({ type: 'folderViewMoveIntoMdBatch', id: 'a', relPaths: ['x'], targetMdPath: '/t.md', mode: 'evil' });
        await send({ type: 'pasteOutlinerNodesWithAssets', plainText: 'P', nodes: [], sidePanelFilePath: '/s.md', destination: 'sidepanel', isCut: true });
        expect(got).toEqual([
            ['pasteTreeClip', clip, { kind: 'tree', parentId: null, index: 1 }],
            ['pasteMdClip', 'M', { mdDir: '/n' }, true, { kind: 'fv' }],
            ['pasteOutlinerClipToTree', 'P', true, 'd', 2],
            ['folderViewCopyAcrossLinks', 'a', ['x'], 'b', 'd'],
            ['folderViewMoveIntoMdBatch', 'a', ['x'], '/t.md', 'copy'],
            ['folderViewMoveIntoMdBatch', 'a', ['x'], '/t.md', 'move'],
            ['pasteOutlinerNodesWithAssets', 'P', [], '/s.md', 'sidepanel', true],
        ]);
        const prov = fs.readFileSync(path.join(__dirname, '../../src/notesEditorProvider.ts'), 'utf8');
        expect(prov, 'provider の cut → linkedfd が Store の nodes を使わない').toMatch(/cutClipNodesForOut\(payload, outPath\)/);
        expect(prov).toMatch(/pasteTreeClip: async[\s\S]*?pasteTreeClipIntoEditor\([\s\S]*?treeItemToMdEditor\(item, sidePanelFilePath, senderRef, keepSource, asBlock\)[\s\S]*?platformBatchDeps/);
        expect(prov, 'ツリーの複数を md へ貼るとき asBlock を付けていない').toMatch(/const asBlock = tg\.kind === 'md' && items\.length > 1;/);
        expect(prov, 'D&D の batch と clipboard が同じ 1 件分の関数を回していない')
            .toMatch(/attachTreeItemsToMdBatch: async[^\n]*\n[^\n]*const asBlock = [^\n]*\n\s*await runPlatformBatch\(items, \(it\) => treeItemToMdEditor\(/);
        expect(prov).toMatch(/folderViewCopyAcrossLinks: async[\s\S]*?folderViewCopyAcrossLinks\(fileManager[\s\S]*?folderMoveDeps/);
        expect(prov).toMatch(/canMove: \(store[^)]*\) =>\s*outlinerCutCanMoveToMd\(fileManager/);
        const bridge = fs.readFileSync(path.join(__dirname, '../../src/shared/notes-host-bridge.js'), 'utf8');
        for (const k of ['pasteTreeClip', 'pasteMdClip', 'pasteOutlinerClipToTree', 'folderViewCopyAcrossLinks']) {
            expect(bridge, `notes-host-bridge.js に ${k} が無い`).toContain(`${k}: function(`);
            expect(bridge).toContain(`type: '${k}'`);
        }
        // standalone の 2 provider も cut を移動 / 複製の判定に渡す（同じ形の経路）
        for (const f of ['outlinerProvider.ts', 'editorProvider.ts']) {
            const src = fs.readFileSync(path.join(__dirname, '../../src', f), 'utf8');
            expect(src, `${f} が isCut を runOutlinerNodesPaste に渡さない`).toMatch(/isCut: !!message\.isCut,\s*canMove:/);
        }
    } finally { s.cleanup(); }
});
