/**
 * TC-ACC-20..24 — linkedfd（folder view）4 経路の随伴 + 双方向レイアウト変換（sprint 20260820-063902 FR-ACC-02）
 *
 * fv→note = md 隣接 images//files/ + 同 dir subpage → note 共有 dir + フラットへ変換。
 * note→fv = note 共有 dir → 移動先 dir に images//files/ を作成して配置。
 * source 側 = md 本体のみ既存契約（trash）・資産/closure md は v1 温存（ADRL-ACC-2）。
 * bridge 契約・厳密 pin（同一 dir no-op / 失敗時 source 不変 + trash 0 / file 分岐不変）は維持。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) delete require.cache[key];
    }
}
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {} },
                env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Module._load = origLoad; purgeSrcCache(); }
}

function makeMoveDeps() {
    const calls: { errors: string[]; trash: any[] } = { errors: [], trash: [] };
    const deps = {
        showErrorMessage: (msg: string) => { calls.errors.push(msg); },
        t: (_key: string) => undefined as any,
        trashDelete: async (absPath: string, recursive: boolean) => { calls.trash.push({ absPath, recursive }); },
        toDisplayUri: (absPath: string) => 'vscode-resource://' + absPath,
    };
    return { deps, calls };
}
function makeSender() {
    const messages: any[] = [];
    return { sender: { postMessage: (m: any) => messages.push(m) }, messages };
}
/** dir に資産持ち md 一式（main.md + images/ + files/ + sub.md + refdoc.md）を作る */
function mkAssetSet(dir: string): void {
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(dir, 'images', 'deep.png'), 'DEEP', 'utf8');
    fs.writeFileSync(path.join(dir, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(dir, 'sub.md'), '# Sub\n![d](images/deep.png)\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'refdoc.md'), '# Ref\n', 'utf8');
    fs.writeFileSync(path.join(dir, 'main.md'), '# Main Title\n![i](images/pic.png)\n[📎 a.pdf](files/a.pdf)\n[[Sub]](sub.md)\n[ref](refdoc.md)\n', 'utf8');
}
function assertAccompanied(destDir: string, mainName: string): void {
    const body = fs.readFileSync(path.join(destDir, mainName), 'utf8');
    const imgs = fs.readdirSync(path.join(destDir, 'images'));
    const pic = imgs.find((n) => n.includes('pic.png'));
    expect(pic, '画像が随伴していない').toBeTruthy();
    expect(body).toContain(`images/${pic}`);
    expect(fs.existsSync(path.join(destDir, 'files', 'a.pdf')), '📎 が随伴していない').toBe(true);
    expect(fs.existsSync(path.join(destDir, 'sub.md')), 'subpage が随伴していない').toBe(true);
    expect(fs.existsSync(path.join(destDir, 'refdoc.md')), '参照リンクが複製された').toBe(false);
}
function setup(): any {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flvacc-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flvacc-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    return { mod, m, id, root, noteDir };
}

/**
 * ⚠️ **期待値反転（sprint 20260901-075849 / TASK-19 / 許可: test_update）**:
 * ADRL-0106 / FR-DCP-01 で fv→note ツリーが**複製**になったため source 側 trash の期待を反転。
 * この TC の主眼は**座標変換**（fv 隣接 → note フラット）なのでそこは不変。
 * FR-ACD-01 の削除ロジック（共有温存 / 非共有削除 / fallback）の番人は
 * `fv-accompanied-cleanup.spec.ts` の TC-ACD-03..08 が `MoveIntoMd` 経路で保持している。
 */
test('TC-ACC-20 folderViewMoveToTree: fv 隣接 → note フラット変換・台帳 +1 のみ・md + 随伴資産は source に残る（複製）', async () => {
    const { mod, m, id, root, noteDir } = setup();
    const { deps, calls } = makeMoveDeps();
    const { sender } = makeSender();
    mkAssetSet(root);

    expect(await mod.folderViewMoveToTree(m, id, 'main.md', null, 0, deps as any, sender as any)).toBe(true);
    assertAccompanied(noteDir, 'main.md'); // note フラット（共有 dir + 直下 closure）
    const mdItems: any[] = (Object.values(m.getStructure().items) as any[]).filter((it) => it.ext === 'md');
    expect(mdItems.length, '台帳は新 md 1 件のみ（closure は台帳外）').toBe(1);
    expect(mdItems[0].title).toBe('Main Title');
    // source 側: FR-DCP-01（ADRL-0106）: md + 随伴資産（画像/📎/closure md）は**すべて残る**
    expect(calls.trash.length, `fv→tree で trash が走った: ${calls.trash.map((t: any) => t.absPath).join(', ')}`).toBe(0);
    for (const rel of ['main.md', 'sub.md', 'images/pic.png', 'files/a.pdf', 'refdoc.md']) {
        expect(fs.existsSync(path.join(root, rel)), `linkedfd の ${rel} が消えた`).toBe(true);
    }
});

/**
 * ⚠️ **期待値反転（sprint 20260901-075849 / TASK-19 / 許可: test_update）**:
 * ADRL-0106 / FR-DCP-02 で note ツリー→fv が**複製**になったため「unregister + trash」を反転。
 * 主眼の**座標変換**（note フラット → fv 隣接 `images/` `files/` 作成）は不変。
 */
test('TC-ACC-21 folderViewMoveIn: note フラット → fv 隣接変換（images//files/ 作成）・note 側は台帳 item と実体が残る', async () => {
    const { mod, m, id, root, noteDir } = setup();
    const { deps, calls } = makeMoveDeps();
    const { sender } = makeSender();
    mkAssetSet(noteDir); // note フラット側に資産持ち md
    m.registerExistingMdFile('main', 'Main Title', null, 0);

    expect(await mod.folderViewMoveIn(m, id, '', 'md', 'main', deps as any, sender as any)).toBe(true);
    const destMd = fs.readdirSync(root).find((n) => n.endsWith('.md') && n.includes('Main'));
    expect(destMd, 'md が fv へ移動していない').toBeTruthy();
    // 隣接座標に変換（fv 側に images//files/ が作成される）
    const body = fs.readFileSync(path.join(root, destMd!), 'utf8');
    const imgs = fs.readdirSync(path.join(root, 'images'));
    const pic = imgs.find((n) => n.includes('pic.png'));
    expect(pic).toBeTruthy();
    expect(body).toContain(`images/${pic}`);
    expect(fs.existsSync(path.join(root, 'files', 'a.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'sub.md'))).toBe(true);
    // FR-DCP-02: 台帳 item も md 本体も note 側資産もすべて残る
    expect((Object.values(m.getStructure().items) as any[]).filter((it) => it.ext === 'md').length,
        'note 台帳の md item が除去された（複製化していない）').toBe(1);
    expect(calls.trash.length, `note→fv で trash が走った: ${calls.trash.map((t: any) => t.absPath).join(', ')}`).toBe(0);
    expect(fs.existsSync(path.join(noteDir, 'main.md')), 'note 側の md 本体が消えた').toBe(true);
    expect(fs.existsSync(path.join(noteDir, 'images', 'pic.png'))).toBe(true);
});

test('TC-ACC-22 folderViewMoveIntoMd（md 分岐）: note md 宛て随伴 + fv 配下 md 宛て（fv→fv 変種）も隣接座標で随伴', async () => {
    const { mod, m, id, root, noteDir } = setup();
    const { deps } = makeMoveDeps();
    const { sender, messages } = makeSender();
    mkAssetSet(root);
    const target = path.join(noteDir, 'target.md');
    fs.writeFileSync(target, '# Target\n', 'utf8');

    // note md 宛て
    expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', target, deps as any, sender as any)).toBe(true);
    assertAccompanied(noteDir, 'main.md');
    const link = messages.find((x) => x.type === 'insertSubpageLink');
    expect(link?.markdownPath).toBe('main.md');

    // fv→fv 変種（TDD-4）: target md が fv 配下の別 dir
    const { mod: mod2, m: m2, id: id2, root: root2 } = setup();
    const { deps: deps2 } = makeMoveDeps();
    const { sender: sender2 } = makeSender();
    mkAssetSet(root2);
    fs.mkdirSync(path.join(root2, 'tdir'), { recursive: true });
    const fvTarget = path.join(root2, 'tdir', 'target.md');
    fs.writeFileSync(fvTarget, '# FvTarget\n', 'utf8');
    expect(await mod2.folderViewMoveIntoMd(m2, id2, 'main.md', fvTarget, deps2 as any, sender2 as any)).toBe(true);
    assertAccompanied(path.join(root2, 'tdir'), 'main.md');
});

test('TC-ACC-23 folderViewMoveFromMd（subpage）: note 共有 → fv 隣接変換 + アンカー除去 + md 本体 trash', async () => {
    const { mod, m, id, root, noteDir } = setup();
    const { deps, calls } = makeMoveDeps();
    const { sender, messages } = makeSender();
    mkAssetSet(noteDir);
    const sourceMd = path.join(noteDir, 'source.md');
    fs.writeFileSync(sourceMd, 'x\n[[Main]](main.md)\ny\n', 'utf8');

    expect(await mod.folderViewMoveFromMd(m, id, '', { href: 'main.md', sourceMdPath: sourceMd, isSubpage: true }, deps as any, sender as any)).toBe(true);
    assertAccompanied(root, 'main.md'); // fv 隣接座標（root/images 等が作成される）
    // 既存契約: アンカー除去 2 段 + md 本体のみ trash
    expect(fs.readFileSync(sourceMd, 'utf8')).not.toContain('(main.md)');
    expect(messages.some((x) => x.type === 'removeSubpageLink')).toBe(true);
    expect(calls.trash.length).toBe(1);
    expect(fs.existsSync(path.join(noteDir, 'images', 'pic.png'))).toBe(true); // note 側資産温存
});

test('TC-ACC-43 fv 起点移動の root 境界緩和（NFR-ACC-02b rev2）: linkedfd 内共有フォルダ参照は随伴・linkedfd 外は非随伴のまま', async () => {
    // (a) folderViewMoveToTree: root/docs/main.md が ../shared/pic2.png（linkedfd 内・md 隣接の外）を参照
    {
        const { mod, m, id, root, noteDir } = setup();
        const { deps } = makeMoveDeps();
        const { sender } = makeSender();
        fs.mkdirSync(path.join(root, 'docs', 'images'), { recursive: true });
        fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
        fs.writeFileSync(path.join(root, 'docs', 'images', 'pic.png'), 'PNG-1', 'utf8');
        fs.writeFileSync(path.join(root, 'shared', 'pic2.png'), 'PNG-2', 'utf8');
        const outsideAbs = path.join(path.dirname(root), 'acc43-outside.png');
        fs.writeFileSync(outsideAbs, 'OUT', 'utf8');
        fs.writeFileSync(path.join(root, 'docs', 'main.md'),
            `# Main\n![i](images/pic.png)\n![s](../shared/pic2.png)\n![o](${outsideAbs})\n`, 'utf8');

        expect(await mod.folderViewMoveToTree(m, id, 'docs/main.md', null, 0, deps as any, sender as any)).toBe(true);
        const imgs = fs.readdirSync(path.join(noteDir, 'images'));
        expect(imgs.find((n) => n.includes('pic.png')), '隣接資産が随伴していない').toBeTruthy();
        expect(imgs.find((n) => n.includes('pic2.png')), 'linkedfd 内共有フォルダ資産が随伴していない（root 境界緩和）').toBeTruthy();
        expect(imgs.find((n) => n.includes('acc43-outside')), 'linkedfd 外の絶対パス参照が随伴された（containment 破り）').toBeFalsy();
        const body = fs.readFileSync(path.join(noteDir, 'main.md'), 'utf8');
        expect(body).toContain(`![o](${outsideAbs})`); // 非随伴リンクは書換なし温存
        expect(fs.existsSync(path.join(root, 'shared', 'pic2.png'))).toBe(true); // source 温存
    }
    // (b) folderViewMoveIntoMd（note md 宛て）: 同じ共有参照が随伴される
    {
        const { mod, m, id, root, noteDir } = setup();
        const { deps } = makeMoveDeps();
        const { sender } = makeSender();
        fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
        fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
        fs.writeFileSync(path.join(root, 'shared', 'pic2.png'), 'PNG-2', 'utf8');
        fs.writeFileSync(path.join(root, 'docs', 'main.md'), '# Main\n![s](../shared/pic2.png)\n', 'utf8');
        const target = path.join(noteDir, 'target.md');
        fs.writeFileSync(target, '# Target\n', 'utf8');

        expect(await mod.folderViewMoveIntoMd(m, id, 'docs/main.md', target, deps as any, sender as any)).toBe(true);
        const imgs = fs.readdirSync(path.join(noteDir, 'images'));
        expect(imgs.find((n) => n.includes('pic2.png')), 'MoveIntoMd で共有フォルダ資産が随伴していない').toBeTruthy();
    }
});

test('TC-ACC-42 transfer 失敗 swallow 3 箇所の診断ログ（QUAL-2）: console.error 発火 + 従来どおり失敗通知・source 不変・trash 0', async () => {
    const errs: any[][] = [];
    const origErr = console.error;
    console.error = (...a: any[]) => { errs.push(a); };
    try {
        // (a) folderViewMoveIn: fv 側（dest）書込不能 → console.error + 通知 + false
        {
            const { mod, m, id, root, noteDir } = setup();
            const { deps, calls } = makeMoveDeps();
            const { sender } = makeSender();
            mkAssetSet(noteDir);
            m.registerExistingMdFile('main', 'Main Title', null, 0);
            fs.chmodSync(root, 0o555);
            try {
                expect(await mod.folderViewMoveIn(m, id, '', 'md', 'main', deps as any, sender as any)).toBe(false);
            } finally { fs.chmodSync(root, 0o755); }
            expect(calls.errors.length).toBeGreaterThanOrEqual(1);
            expect(calls.trash.length).toBe(0);
            expect(fs.existsSync(path.join(noteDir, 'main.md'))).toBe(true);
        }
        // (b) folderViewMoveIntoMd（fv→fv 変種）: target dir 書込不能 → console.error + 通知 + false
        {
            const { mod, m, id, root } = setup();
            const { deps, calls } = makeMoveDeps();
            const { sender } = makeSender();
            mkAssetSet(root);
            fs.mkdirSync(path.join(root, 'tdir'), { recursive: true });
            const fvTarget = path.join(root, 'tdir', 'target.md');
            fs.writeFileSync(fvTarget, '# T\n', 'utf8');
            fs.chmodSync(path.join(root, 'tdir'), 0o555);
            try {
                expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', fvTarget, deps as any, sender as any)).toBe(false);
            } finally { fs.chmodSync(path.join(root, 'tdir'), 0o755); }
            expect(calls.errors.length).toBeGreaterThanOrEqual(1);
            expect(calls.trash.length).toBe(0);
            expect(fs.existsSync(path.join(root, 'main.md'))).toBe(true);
        }
        // (c) folderViewMoveFromMd: fv 側（dest）書込不能 → console.error + 通知 + false
        {
            const { mod, m, id, root, noteDir } = setup();
            const { deps, calls } = makeMoveDeps();
            const { sender } = makeSender();
            mkAssetSet(noteDir);
            const sourceMd = path.join(noteDir, 'source.md');
            fs.writeFileSync(sourceMd, '[[Main]](main.md)\n', 'utf8');
            fs.chmodSync(root, 0o555);
            try {
                expect(await mod.folderViewMoveFromMd(m, id, '', { href: 'main.md', sourceMdPath: sourceMd, isSubpage: true }, deps as any, sender as any)).toBe(false);
            } finally { fs.chmodSync(root, 0o755); }
            expect(calls.errors.length).toBeGreaterThanOrEqual(1);
            expect(calls.trash.length).toBe(0);
            expect(fs.existsSync(path.join(noteDir, 'main.md'))).toBe(true);
        }
        // 3 経路とも診断ログ（W2 規範「silent 握り禁止」— counterfactual: catch が e を捨てると 0 件で RED）
        const transferErrs = errs.filter((a) => String(a[0]).includes('transferMdWithAssets failed'));
        expect(transferErrs.length, 'console.error 診断が 3 経路分出ていない').toBeGreaterThanOrEqual(3);
    } finally {
        console.error = origErr;
    }
});

test('TC-ACC-24 厳密 pin 維持: 同一 dir no-op / 失敗時 source 不変 + trash 0 / file（非 md）分岐 byte 不変', async () => {
    const { mod, m, id, root, noteDir } = setup();
    const { deps, calls } = makeMoveDeps();
    const { sender } = makeSender();
    // (a) MoveFromMd 同一 dir 宛て = no-op（唯一の silent）
    mkAssetSet(root);
    const fvSource = path.join(root, 'fvsrc.md');
    fs.writeFileSync(fvSource, '[[Main]](main.md)\n', 'utf8');
    expect(await mod.folderViewMoveFromMd(m, id, '', { href: 'main.md', sourceMdPath: fvSource, isSubpage: true }, deps as any, sender as any)).toBe(false);
    expect(calls.trash.length).toBe(0);
    expect(calls.errors.length).toBe(0);
    // (b) MoveToTree 失敗時（note 書込不能）source 不変 + trash 0 + 通知
    fs.chmodSync(noteDir, 0o555);
    try {
        expect(await mod.folderViewMoveToTree(m, id, 'main.md', null, 0, deps as any, sender as any)).toBe(false);
    } finally { fs.chmodSync(noteDir, 0o755); }
    expect(fs.existsSync(path.join(root, 'main.md'))).toBe(true);
    // ⚠️ この行は複製化（ADRL-0106）で**成功時も 0** になったため失敗経路の弁別力を失った。
    // 弁別力を持つのは下の「通知が出る」（登録失敗の検知）。fv→tree が常に trash 0 であることの
    // 番人は TC-DCP-03（実行の実測）が持つ。
    expect(calls.trash.length).toBe(0);
    expect(calls.errors.length, '登録失敗が通知されない').toBeGreaterThanOrEqual(1);
    // (c) file（非 md）は従来どおり単体移動（随伴対象なし・images//files/ を作らない）
    fs.mkdirSync(path.join(noteDir, 'files'), { recursive: true });
    fs.writeFileSync(path.join(noteDir, 'files', 'solo.bin'), 'BIN', 'utf8');
    const srcSource = path.join(noteDir, 'src2.md');
    fs.writeFileSync(srcSource, '[📎 solo.bin](files/solo.bin)\n', 'utf8');
    fs.mkdirSync(path.join(root, 'fdir'), { recursive: true });
    expect(await mod.folderViewMoveFromMd(m, id, 'fdir', { href: 'files/solo.bin', sourceMdPath: srcSource, isSubpage: false }, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(root, 'fdir', 'solo.bin'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'fdir', 'images'))).toBe(false);
});
