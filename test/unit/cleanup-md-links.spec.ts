/**
 * cleanup-protect-md-links TASK-01 — md→md リンク推移閉包の liveness パス
 *
 * バグ: Clean Unused Files が `[label](x.md)` / `[[label]](x.md)` でしか参照されない md を
 * orphan-md として削除する（cleanup の live-set が md→md リンク先を集めていなかった）。
 * 修正: `buildMdLinkClosureLive` が Pass1-live な md 群から BFS で md→md リンク先を辿り live に加える。
 *
 * ランナー: Playwright unit。tmpdir に note を組み `scanSingleNoteCore` を直接呼ぶ。
 * 既存 `cleanup-flat.spec.ts` の fixture スタイルに倣う（outline.note + .out + .md）。
 *
 * TC-CM-01 (load-bearing) プレーン `[b](B.md)` リンク先が保護される
 * TC-CM-02             推移閉包 A→B→C
 * TC-CM-03             循環 A↔B で無限ループしない
 * TC-CM-04 (load-bearing) 真の孤児 md は従来どおり orphan（過剰保護しない）
 * TC-CM-05             両形式: `[[label]](B.md)` サブページリンク先も保護
 * TC-CM-06 (load-bearing) 推移 live md が参照する画像/添付も保護（順序が load-bearing）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    scanSingleNoteCore,
    listOutFiles,
    buildLiveSetPass1,
    buildPass2LiveImages,
    buildPass2LiveFiles,
    listAllMd,
    listAllImages,
    listAllFiles,
} from '../../src/shared/cleanup-core';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-mdlinks-'));
}

/**
 * 単純な note fixture: A.md を outline.note に ext:'md' で登録（= live 起点）。
 * pages は `<note>/<id>.md` に本文を書くだけ（B.md/C.md 等は未登録）。
 */
function writeNote(dir: string, mdFiles: Record<string, string>, registered: string[]): void {
    for (const [id, body] of Object.entries(mdFiles)) {
        fs.writeFileSync(path.join(dir, `${id}.md`), body);
    }
    const items: Record<string, unknown> = {};
    for (const id of registered) {
        items[id] = { type: 'file', id, title: id, ext: 'md' };
    }
    fs.writeFileSync(path.join(dir, 'outline.note'), JSON.stringify({
        rootIds: registered,
        items,
    }));
}

const abs = (dir: string, name: string) => path.join(dir, name);

/**
 * ★counterfactual ヘルパ: 「fix（md-link closure パス）を無効化した pre-fix パイプライン」を
 * 実際に実行して orphan 候補の絶対パスを返す。
 *
 * scanSingleNoteCore の修正前の順序を、まだ export されている building blocks で忠実に再現する:
 *   liveMd = buildLiveSetPass1(...)        ← closure 拡張なし（これが pre-fix）
 *   Pass2 images/files → orphan 判定
 * これにより load-bearing TC で「fix を戻すと RED」を機械的に実証する
 * （generator_failures 2026-07-09: counterfactual が実際に pre-fix で FAIL することを確認してからラベル付与）。
 */
async function preFixOrphanAbsPaths(dir: string): Promise<Set<string>> {
    const outFiles = await listOutFiles(dir);
    const { liveMd, liveImages: li0, liveFiles: lf0 } = await buildLiveSetPass1(outFiles, dir);
    // ↓ ここに buildMdLinkClosureLive が「無い」のが pre-fix。liveMd は Pass1 のまま。
    const liveImages = await buildPass2LiveImages(liveMd, li0, dir);
    const liveFiles = await buildPass2LiveFiles(liveMd, lf0, dir);
    const orphans = new Set<string>();
    for (const p of await listAllMd(dir)) { if (!liveMd.has(p)) orphans.add(p); }
    for (const p of await listAllImages(dir)) { if (!liveImages.has(p)) orphans.add(p); }
    for (const p of await listAllFiles(dir)) { if (!liveFiles.has(p)) orphans.add(p); }
    return orphans;
}

test('TC-CM-01 (load-bearing) プレーン md リンク先 B.md が保護される', async () => {
    const dir = mkTmp();
    // A.md（live 起点）→ B.md をプレーンリンク。B.md は未登録・未参照（リンクのみ）。
    writeNote(dir, { A: 'see [b](B.md)', B: '# b page' }, ['A']);

    // counterfactual: pre-fix パイプラインでは B.md が orphan-md 候補に入る（= fix を戻すと RED）
    const preFix = await preFixOrphanAbsPaths(dir);
    expect(preFix.has(abs(dir, 'B.md'))).toBe(true); // ← pre-fix で B.md は orphan（削除対象）

    const orphans = await scanSingleNoteCore(dir);
    const orphanAbs = orphans.map(o => o.absPath);
    expect(orphanAbs).not.toContain(abs(dir, 'B.md')); // fix 後: B.md は守られる
    expect(orphanAbs).not.toContain(abs(dir, 'A.md')); // 起点 A.md も orphan でない
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CM-02 推移閉包 A→B→C が保護される', async () => {
    const dir = mkTmp();
    writeNote(dir, { A: '[b](B.md)', B: '[c](C.md)', C: '# c' }, ['A']);

    const orphans = await scanSingleNoteCore(dir);
    const orphanAbs = orphans.map(o => o.absPath);
    // 1 段だけ辿る実装だと C.md が orphan になる（推移閉包が効いていれば守られる）
    expect(orphanAbs).not.toContain(abs(dir, 'B.md'));
    expect(orphanAbs).not.toContain(abs(dir, 'C.md'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CM-03 循環 A↔B で無限ループせず両方保護される', async () => {
    const dir = mkTmp();
    writeNote(dir, { A: '[b](B.md)', B: '[a](A.md)' }, ['A']);

    // 正常終了する（visited add-before-enqueue で無限ループしない）
    const orphans = await scanSingleNoteCore(dir);
    const orphanAbs = orphans.map(o => o.absPath);
    expect(orphanAbs).not.toContain(abs(dir, 'A.md'));
    expect(orphanAbs).not.toContain(abs(dir, 'B.md'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CM-04 (load-bearing) 真の孤児 md は従来どおり orphan（過剰保護しない）', async () => {
    const dir = mkTmp();
    // A.md（live・リンクなし）、orphan.md（存在・未登録・誰からもリンクされない）
    writeNote(dir, { A: '# a, no links', orphan: '# nobody links me' }, ['A']);

    // counterfactual: 全 md を無条件 live 化する誤実装なら orphan.md が守られてしまう。
    // 正しい実装は BFS で到達しない orphan.md を従来どおり orphan にする。
    const orphans = await scanSingleNoteCore(dir);
    const orphanAbs = orphans.map(o => o.absPath);
    expect(orphanAbs).toContain(abs(dir, 'orphan.md')); // ← 過剰保護しない（削除挙動維持）
    expect(orphanAbs).not.toContain(abs(dir, 'A.md'));

    // pre-fix でも orphan.md は orphan（挙動が退行していないことも確認）
    const preFix = await preFixOrphanAbsPaths(dir);
    expect(preFix.has(abs(dir, 'orphan.md'))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CM-05 二重括弧 [[label]](B.md) サブページリンク先も保護される', async () => {
    const dir = mkTmp();
    // 二重括弧形式（parseMarkdownLinks は落とす → cleanup ローカル抽出が拾う）
    writeNote(dir, { A: '[[sub]](B.md)', B: '# sub page' }, ['A']);

    // counterfactual: プレーンのみ拾う抽出（extractAllAssetRefs.mdLinks）だと B.md が orphan → RED。
    const preFix = await preFixOrphanAbsPaths(dir);
    expect(preFix.has(abs(dir, 'B.md'))).toBe(true);

    const orphans = await scanSingleNoteCore(dir);
    const orphanAbs = orphans.map(o => o.absPath);
    expect(orphanAbs).not.toContain(abs(dir, 'B.md'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-CM-06 (load-bearing) 推移 live md が参照する画像/添付も保護される（順序が load-bearing）', async () => {
    const dir = mkTmp();
    fs.mkdirSync(path.join(dir, 'images'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'files'), { recursive: true });
    // A.md（live）→ B.md。B.md は md-link で live 化され、画像 b.png と添付 b.pdf を参照。
    writeNote(dir, {
        A: '[b](B.md)',
        B: '# b\n![](images/b.png)\n[📎 f](files/b.pdf)',
    }, ['A']);
    fs.writeFileSync(path.join(dir, 'images', 'b.png'), 'IMG');
    fs.writeFileSync(path.join(dir, 'files', 'b.pdf'), 'FILE');

    // counterfactual: md-liveness を画像/添付 Pass の後（または未実行）だと B が Pass1-live でないため
    // b.png/b.pdf が orphan になる（= fix の「順序」が load-bearing）。pre-fix パイプラインで実証。
    const preFix = await preFixOrphanAbsPaths(dir);
    expect(preFix.has(abs(dir, path.join('images', 'b.png')))).toBe(true);
    expect(preFix.has(abs(dir, path.join('files', 'b.pdf')))).toBe(true);

    const orphans = await scanSingleNoteCore(dir);
    const orphanNames = orphans.map(o => path.basename(o.absPath));
    expect(orphanNames).not.toContain('b.png');
    expect(orphanNames).not.toContain('b.pdf');
    // B.md 自体も保護される
    expect(orphans.map(o => o.absPath)).not.toContain(abs(dir, 'B.md'));
    fs.rmSync(dir, { recursive: true, force: true });
});
