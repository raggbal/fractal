/**
 * TC-ACD-01/02 — エンジン複製結果報告 + 残留参照スキャナ（sprint 20260822-051129 FR-ACD）
 *
 * TC-ACD-01: MdPasteAssetReport（opt-in out-param — 既定挙動 byte 不変が契約）
 * TC-ACD-02: collectFvSurvivingAssetRefs（サブフォルダ走査 = 旧機構の盲点 counterfactual・上限・除外）
 * 削除フェーズ（TC-ACD-03..07）は folderView 経路側で本 spec に追記する。
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
function requirePah(): any {
    purgeSrcCache();
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require('../../src/shared/paste-asset-handler');
    } finally { purgeSrcCache(); }
}

/** 資産持ち md 一式（正資産 + missing 参照 + 境界外参照） */
function mkFixture(): { base: string; src: string; srcMd: string; outside: string } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-'));
    const src = path.join(base, 'note');
    fs.mkdirSync(path.join(src, 'images'), { recursive: true });
    fs.mkdirSync(path.join(src, 'files'), { recursive: true });
    fs.writeFileSync(path.join(src, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(src, 'images', 'deep.png'), 'DEEP', 'utf8');
    fs.writeFileSync(path.join(src, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(src, 'sub.md'), '# Sub\n![d](images/deep.png)\n', 'utf8');
    fs.writeFileSync(path.join(src, 'refdoc.md'), '# Ref\n', 'utf8');
    const outside = path.join(base, 'outside.png');
    fs.writeFileSync(outside, 'OUT', 'utf8');
    const srcMd = path.join(src, 'main.md');
    fs.writeFileSync(srcMd, [
        '# Main',
        '![i](images/pic.png)',
        '![m](images/nope.png)',      // missing
        '![o](../outside.png)',       // containment-skip（境界外）
        '[📎 a.pdf](files/a.pdf)',
        '[[Sub]](sub.md)',
        '[ref](refdoc.md)',
        '',
    ].join('\n'), 'utf8');
    return { base, src, srcMd, outside };
}
function coords(src: string, dest: string) {
    return {
        sourceMdDir: src, sourceImageDir: path.join(src, 'images'), sourceFileDir: path.join(src, 'files'),
        destMdDir: dest, destImageDir: path.join(dest, 'images'), destFileDir: path.join(dest, 'files'),
    };
}

test('TC-ACD-01 report out-param: copied 全列挙 / missing・containment は skipped / copy 失敗は copyFailed / 未指定は従来 shape', () => {
    const pah = requirePah();
    // (a) 全成功: copied に pic/deep/a.pdf/sub.md の source 絶対パス・skipped に missing + 境界外
    {
        const { src, srcMd } = mkFixture();
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-dst-'));
        const report = { copied: [], copyFailed: [], skipped: [] };
        const r = pah.transferMdWithAssets(srcMd, coords(src, dest), undefined, { report });
        expect(Object.keys(r).sort()).toEqual(['destMdPath', 'newName']); // 返り値 shape 不変
        const copied = report.copied as string[];
        expect(copied).toContain(path.join(src, 'images', 'pic.png'));
        expect(copied).toContain(path.join(src, 'images', 'deep.png'));  // closure（sub.md）の資産
        expect(copied).toContain(path.join(src, 'files', 'a.pdf'));
        expect(copied).toContain(path.join(src, 'sub.md'));               // closure md 自身
        expect(copied).not.toContain(path.join(src, 'refdoc.md'));        // 参照リンクは対象外
        expect(report.copyFailed).toEqual([]);
        const skipped = report.skipped as string[];
        expect(skipped.some((p) => p.includes('nope.png')), 'missing が skipped に無い').toBe(true);
        expect(skipped.some((p) => p.includes('outside.png')), '境界外が skipped に無い').toBe(true);
    }
    // (b) copy 失敗（source 読取不能）→ copyFailed に記録・throw しない（best-effort 継続）
    {
        const { src, srcMd } = mkFixture();
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-dst2-'));
        fs.chmodSync(path.join(src, 'files', 'a.pdf'), 0o000);
        const report = { copied: [], copyFailed: [], skipped: [] };
        try {
            pah.transferMdWithAssets(srcMd, coords(src, dest), undefined, { report });
        } finally { fs.chmodSync(path.join(src, 'files', 'a.pdf'), 0o644); }
        expect((report.copyFailed as string[]).some((p) => p.endsWith('a.pdf')), 'copy 失敗が copyFailed に無い').toBe(true);
        expect((report.copied as string[]).length).toBeGreaterThanOrEqual(2); // 他の資産は複製継続
    }
    // (c) report 未指定 = 従来どおり動く（既定不変 — TC-ACC-01 系が byte pin を併走）
    {
        const { src, srcMd } = mkFixture();
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-dst3-'));
        const r = pah.transferMdWithAssets(srcMd, coords(src, dest));
        expect(fs.existsSync(r.destMdPath)).toBe(true);
        expect(fs.existsSync(path.join(dest, 'sub.md'))).toBe(true);
    }
});

test('TC-ACD-02 collectFvSurvivingAssetRefs: サブフォルダ走査 / 除外 / dotfile・symlink 非走査 / 上限 aborted', () => {
    purgeSrcCache();
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/shared/fv-residual-refs');
    purgeSrcCache();
    expect(typeof mod.collectFvSurvivingAssetRefs, 'export 不在').toBe('function');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-scan-'));
    fs.mkdirSync(path.join(root, 'docs', 'deep'), { recursive: true });
    fs.mkdirSync(path.join(root, 'shared'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'shared', 'pic.png'), 'P', 'utf8');
    fs.writeFileSync(path.join(root, 'shared', 'only-moved.png'), 'Q', 'utf8');
    // サブフォルダの md が shared/pic.png を参照（旧機構は一段のみ = ここを拾えないのが盲点）
    fs.writeFileSync(path.join(root, 'docs', 'deep', 'other.md'), '![p](../../shared/pic.png)\n[[S]](../../moved-sub.md)\n', 'utf8');
    // 移動対象（除外指定）
    fs.writeFileSync(path.join(root, 'moved.md'), '![q](shared/only-moved.png)\n', 'utf8');
    fs.writeFileSync(path.join(root, 'moved-sub.md'), '# S\n', 'utf8');
    // dotfile dir 内の md は走査されない
    fs.writeFileSync(path.join(root, '.git', 'ignore.md'), '![x](shared/only-moved.png)\n', 'utf8');

    const excl = new Set([path.join(root, 'moved.md'), path.join(root, 'moved-sub.md')]);
    const { refs, aborted } = mod.collectFvSurvivingAssetRefs(root, excl);
    expect(aborted).toBe(false);
    expect(refs.has(path.join(root, 'shared', 'pic.png')), 'サブフォルダ md の参照を拾えていない').toBe(true);
    expect(refs.has(path.join(root, 'moved-sub.md')), '他 md からの subpage 参照を拾えていない').toBe(true);
    expect(refs.has(path.join(root, 'shared', 'only-moved.png')), '除外 md / dotfile dir の参照が混入').toBe(false);

    // 上限: maxFiles=1 で aborted
    const r2 = mod.collectFvSurvivingAssetRefs(root, new Set(), { maxFiles: 1 });
    expect(r2.aborted).toBe(true);
});

// ── TC-ACD-03..07: fv 起点 3 サイトの削除フェーズ（host 経路 — requireWithVscodeStub ハーネス） ──

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

function hostSetup(): any {
    const { NotesFileManager } = requireWithVscodeStub('../../src/shared/notes-file-manager');
    const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
    const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-note-'));
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-root-'));
    const m = new NotesFileManager(noteDir);
    m.loadStructure();
    const id = m.registerFolderLink(root);
    const trash: string[] = [];
    const errors: string[] = [];
    const deps = {
        showErrorMessage: (msg: string) => { errors.push(msg); },
        t: () => undefined,
        trashDelete: async (absPath: string) => { trash.push(absPath); fs.rmSync(absPath, { force: true }); },
        toDisplayUri: (p: string) => p,
    };
    const messages: any[] = [];
    const sender = { postMessage: (x: any) => messages.push(x) };
    // ⚠️ 経路付け替え（sprint 20260901-075849 / TASK-19）用の drop 先 md。
    // fv→note ツリーが複製化（ADRL-0106）して trash 経路が消えたため、FR-ACD-01（随伴資産の
    // source 削除）の番人は移動のまま残る `folderViewMoveIntoMd` で張る。
    const targetMd = path.join(noteDir, 'acd-target.md');
    fs.writeFileSync(targetMd, '# ACD Target\n', 'utf8');
    m.openFile(targetMd);
    return { mod, m, id, root, noteDir, deps, trash, errors, sender, targetMd };
}
/** root に資産持ち md 一式（隣接 images//files/ + subpage） */
function mkFvAssetSet(root: string): void {
    fs.mkdirSync(path.join(root, 'images'), { recursive: true });
    fs.mkdirSync(path.join(root, 'files'), { recursive: true });
    fs.writeFileSync(path.join(root, 'images', 'pic.png'), 'PNG-1', 'utf8');
    fs.writeFileSync(path.join(root, 'images', 'deep.png'), 'DEEP', 'utf8');
    fs.writeFileSync(path.join(root, 'files', 'a.pdf'), 'PDF-1', 'utf8');
    fs.writeFileSync(path.join(root, 'sub.md'), '# Sub\n![d](images/deep.png)\n', 'utf8');
    fs.writeFileSync(path.join(root, 'main.md'), '# Main\n![i](images/pic.png)\n[📎 a.pdf](files/a.pdf)\n[[Sub]](sub.md)\n', 'utf8');
}

/**
 * ⚠️ **経路付け替え（sprint 20260901-075849 / TASK-19 / 許可: test_update）**:
 * TC-ACD-03/04/05/07/08 は元は `folderViewMoveToTree` で FR-ACD-01（随伴資産の source 削除）を
 * 検証していた。ADRL-0106 / FR-DCP-01 でこの方向が**複製**になり削除フェーズが消えたため、
 * **移動のまま残る `folderViewMoveIntoMd`（FR-DCP-03）へ移設**した。
 *
 * 🔴 **単純な期待値反転（「資産が残る」に書き換え）にしなかった理由**: それでは
 * FR-ACD-01 の中核（共有資産は温存 / 非共有だけ削除・部分失敗で完全不触・trash fallback）が
 * **丸ごと無検証**になる。fv→tree が複製であることの番人は TC-DCP-01/03（新規）が持つ。
 */
test('TC-ACD-03 MoveIntoMd 全成功（旧 MoveToTree 経路から移設）: md + 全随伴資産が source から消える・dir 自体は残る', async () => {
    const { mod, m, id, root, noteDir, deps, trash, errors, sender, targetMd } = hostSetup();
    mkFvAssetSet(root);
    expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(noteDir, 'main.md'))).toBe(true); // 複製成立
    // source 側: md + pic + deep + a.pdf + sub.md 全部消える
    for (const rel of ['main.md', 'sub.md', 'images/pic.png', 'images/deep.png', 'files/a.pdf']) {
        expect(fs.existsSync(path.join(root, rel)), `${rel} が source に残留`).toBe(false);
    }
    expect(fs.existsSync(path.join(root, 'images')), 'images dir は残す').toBe(true);
    expect(errors.length).toBe(0);
    expect(trash.length).toBeGreaterThanOrEqual(5);
});

test('TC-ACD-04 残留参照（MoveIntoMd 経路へ移設）: 共有資産・共有 subpage は温存・非共有だけ削除', async () => {
    const { mod, m, id, root, deps, sender, targetMd } = hostSetup();
    mkFvAssetSet(root);
    // 別 md（サブフォルダ）が pic.png と sub.md を参照 → 温存対象
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs', 'other.md'), '![p](../images/pic.png)\n[[S]](../sub.md)\n', 'utf8');
    expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(root, 'images', 'pic.png')), '共有画像が消された').toBe(true);
    expect(fs.existsSync(path.join(root, 'sub.md')), '共有 subpage が消された').toBe(true);
    expect(fs.existsSync(path.join(root, 'files', 'a.pdf')), '非共有 📎 は削除されるべき').toBe(false);
    expect(fs.existsSync(path.join(root, 'main.md'))).toBe(false);
});

test('TC-ACD-05 全成功条件（MoveIntoMd 経路へ移設）: 複製失敗 → 完全不触 + トースト / missing 混在は掃除継続 / スキャナ上限 → 資産温存 md のみ削除', async () => {
    // (a) 資産 1 件 copy 失敗（source 読取不能）→ md 含め source 完全不触
    {
        const { mod, m, id, root, deps, trash, errors, sender, targetMd } = hostSetup();
        mkFvAssetSet(root);
        fs.chmodSync(path.join(root, 'files', 'a.pdf'), 0o000);
        try {
            expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any)).toBe(true);
        } finally { fs.chmodSync(path.join(root, 'files', 'a.pdf'), 0o644); }
        expect(fs.existsSync(path.join(root, 'main.md')), '部分失敗で md が消された').toBe(true);
        expect(fs.existsSync(path.join(root, 'images', 'pic.png'))).toBe(true);
        expect(trash.length).toBe(0);
        expect(errors.length).toBeGreaterThanOrEqual(1);
    }
    // (b) missing 参照の混在はブロックしない（他は掃除される）
    {
        const { mod, m, id, root, deps, errors, sender, targetMd } = hostSetup();
        mkFvAssetSet(root);
        fs.appendFileSync(path.join(root, 'main.md'), '![gone](images/nope.png)\n');
        expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'main.md'))).toBe(false);
        expect(fs.existsSync(path.join(root, 'images', 'pic.png'))).toBe(false);
        expect(errors.length).toBe(0);
    }
    // (c) スキャナ上限超過（大量 md fixture）→ 資産温存・md のみ削除・移動は成立
    {
        const { mod, m, id, root, noteDir, deps, sender, targetMd } = hostSetup();
        mkFvAssetSet(root);
        fs.mkdirSync(path.join(root, 'many'), { recursive: true });
        for (let i = 0; i < 2005; i++) { fs.writeFileSync(path.join(root, 'many', `f${i}.md`), '# x\n', 'utf8'); }
        expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(noteDir, 'main.md'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'main.md')), 'md は従来どおり削除').toBe(false);
        expect(fs.existsSync(path.join(root, 'images', 'pic.png')), '上限超過時は資産温存（安全側）').toBe(true);
    }
});

test('TC-ACD-06 経路網羅: MoveIntoMd（note md 宛て / fv→fv）は削除フェーズ発火・note 起点（MoveIn）は温存のまま', async () => {
    // (a) fv → note md（sidepanel 相当）
    {
        const { mod, m, id, root, noteDir, deps, sender, targetMd } = hostSetup();
        mkFvAssetSet(root);
        const target = path.join(noteDir, 'target.md');
        fs.writeFileSync(target, '# T\n', 'utf8');
        expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', target, deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(root, 'images', 'pic.png')), 'MoveIntoMd で資産が残留').toBe(false);
        expect(fs.existsSync(path.join(root, 'sub.md'))).toBe(false);
    }
    // (b) fv → fv（同一 root 内別 dir）: dest 側複製は残り source 側だけ消える
    {
        const { mod, m, id, root, deps, sender, targetMd } = hostSetup();
        mkFvAssetSet(root);
        fs.mkdirSync(path.join(root, 'tdir'), { recursive: true });
        const fvTarget = path.join(root, 'tdir', 'target.md');
        fs.writeFileSync(fvTarget, '# FT\n', 'utf8');
        expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', fvTarget, deps as any, sender as any)).toBe(true);
        const destImgs = fs.readdirSync(path.join(root, 'tdir', 'images'));
        expect(destImgs.find((n) => n.includes('pic.png')), 'dest 複製が無い').toBeTruthy();
        expect(fs.existsSync(path.join(root, 'images', 'pic.png')), 'fv→fv でも source 資産は削除').toBe(false);
        expect(fs.existsSync(path.join(root, 'tdir', 'sub.md'))).toBe(true);
        expect(fs.existsSync(path.join(root, 'sub.md'))).toBe(false);
    }
    // (c) note 起点（MoveIn）は従来どおり note 側資産温存（削除フェーズ不発火 — TC-ACC-21 併走 pin）
    {
        const { mod, m, id, root, noteDir, deps, sender, trash, targetMd } = hostSetup();
        fs.mkdirSync(path.join(noteDir, 'images'), { recursive: true });
        fs.writeFileSync(path.join(noteDir, 'images', 'npic.png'), 'N', 'utf8');
        fs.writeFileSync(path.join(noteDir, 'main.md'), '# M\n![i](images/npic.png)\n', 'utf8');
        m.registerExistingMdFile('main', 'M', null, 0);
        expect(await mod.folderViewMoveIn(m, id, '', 'md', 'main', deps as any, sender as any)).toBe(true);
        expect(fs.existsSync(path.join(noteDir, 'images', 'npic.png')), 'note 起点で note 資産が消された').toBe(true);
        // FR-DCP-02（sprint 20260901-075849）: 複製化後は **md 本体と台帳 item も残る**。
        // 「資産温存」だけの assert は複製化で自明真になるため、削除フェーズ不発火の証拠を
        // md 本体 + 台帳 + trash 呼び出しゼロの 3 点で張り直す（tautology 化の回避）。
        expect(fs.existsSync(path.join(noteDir, 'main.md')), 'note 起点で md 本体が消された').toBe(true);
        expect(m.getStructure().items['main'], 'note 起点で台帳 item が除去された').toBeTruthy();
        expect(trash.length, 'note 起点で削除フェーズが発火した').toBe(0);
    }
});

test('TC-ACD-07 trash fallback 合成（MoveIntoMd 経路へ移設）: trash throw + deleteFile で資産も削除される', async () => {
    const { mod, m, id, root, noteDir, sender, targetMd } = hostSetup();
    mkFvAssetSet(root);
    const errors: string[] = [];
    const deleted: string[] = [];
    const deps = {
        showErrorMessage: (msg: string) => { errors.push(msg); },
        t: () => undefined,
        trashDelete: async () => { throw new Error('EPERM: trash unavailable'); },
        deleteFile: async (absPath: string) => { deleted.push(absPath); fs.rmSync(absPath, { force: true }); },
        toDisplayUri: (p: string) => p,
    };
    expect(await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any)).toBe(true);
    expect(fs.existsSync(path.join(noteDir, 'main.md'))).toBe(true);
    for (const rel of ['main.md', 'sub.md', 'images/pic.png', 'files/a.pdf']) {
        expect(fs.existsSync(path.join(root, rel)), `${rel} が fallback で消えていない`).toBe(false);
    }
    expect(deleted.length).toBeGreaterThanOrEqual(4);
    expect(errors.length).toBe(0);
});

test('TC-ACD-08 画像 copy 失敗の検知（QUAL-1 — データロス経路の封鎖）: dest images 書込不能 → copyFailed 記録 + source 完全不触', async () => {
    // (a) エンジン単体: report が画像失敗を copyFailed に記録する（makeUniqueImageCopier の swallow を検知）
    {
        const pah = requirePah();
        const { src, srcMd } = mkFixture();
        const dest = fs.mkdtempSync(path.join(os.tmpdir(), 'acd-imgf-'));
        fs.mkdirSync(path.join(dest, 'images'), { recursive: true });
        fs.chmodSync(path.join(dest, 'images'), 0o555); // dest 側書込不能（EACCES — QUAL-1 の再現条件）
        const report = { copied: [], copyFailed: [], skipped: [] };
        try {
            pah.transferMdWithAssets(srcMd, coords(src, dest), undefined, { report });
        } finally { fs.chmodSync(path.join(dest, 'images'), 0o755); }
        expect((report.copyFailed as string[]).some((p) => p.endsWith('pic.png')), '画像 copy 失敗が copyFailed に無い（swallow 迂回）').toBe(true);
        expect((report.copied as string[]).some((p) => p.endsWith('pic.png')), '失敗した画像が copied に混入').toBe(false);
    }
    // (b) 経路: fv 移動で dest images 書込不能 → 全成功ゲートが閉じ source 完全不触 + トースト
    {
        const { mod, m, id, root, noteDir, deps, trash, errors, sender, targetMd } = hostSetup();
        mkFvAssetSet(root);
        fs.mkdirSync(path.join(noteDir, 'images'), { recursive: true });
        fs.chmodSync(path.join(noteDir, 'images'), 0o555);
        try {
            await mod.folderViewMoveIntoMd(m, id, 'main.md', targetMd, deps as any, sender as any);
        } finally { fs.chmodSync(path.join(noteDir, 'images'), 0o755); }
        expect(fs.existsSync(path.join(root, 'main.md')), '部分失敗で md が消された').toBe(true);
        expect(fs.existsSync(path.join(root, 'images', 'pic.png')), '部分失敗で画像が消された（データロス）').toBe(true);
        expect(trash.length).toBe(0);
        expect(errors.length).toBeGreaterThanOrEqual(1);
    }
});
