/**
 * Sprint: 20260802-212934-aws-sdk-migration / TASK-07 (review iteration 1, code_fix)
 * TC-SDK-41: out/shared emit 完全性 副番人（NFR-SDK-02 = 既存テスト非破壊）
 *
 * 背景: esbuild 移行で compile が `tsc -p ./`（全 src emit）→ `tsc --noEmit && esbuild`
 *   に変わり、TS 由来の out/shared/*.js（paste-asset-handler / drop-import /
 *   outliner-clipboard-store / md-h1-utils とその TS 由来 transitive dep）が生成されなく
 *   なった。これらをモジュールスコープで require する 3 spec が collection 段階で throw し、
 *   Playwright 全収集を中断 → false-green（Total: 0 tests in 0 files）になっていた。
 *   TASK-07 で tsconfig.shared-emit.json による scoped emit を追加して回復した。
 *
 * この spec は emit 完全性の副番人:
 *   - require は **test 本体内**で行う（モジュールスコープではない = 自身が collection abort 源に
 *     ならない）。emit が落ちても本 spec は「通常の RED」として個別 fail し、他 spec の収集は
 *     止めない（主番人 = check-known-red.sh の collection gate が systemic に守る）。
 *   - 「存在チェック」だけでなく **実 require 成功**まで assert する（transitive dep 破壊の検出。
 *     4 ファイルは markdown-image-utils / drawioTemplate / file-import / markdown-import /
 *     data-url-image-extractor 等の TS 由来 dep を持ち、部分 emit だと require 時に解決失敗する）。
 *
 * counterfactual: compile が out/shared の TS emit を落とすと本 spec が通常 RED になる
 *   （scoped emit を消すと require throw = FAIL）。
 *
 * beforeAll で scoped emit（tsc -p tsconfig.shared-emit.json）を実行し、compile 未実施の
 * 環境でも本 spec 単独で成立させる（npm run compile 相当のビルド後状態を前提にしつつ、
 * ビルド漏れに依存しない）。
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SHARED_OUT = path.join(REPO_ROOT, 'out', 'shared');

// tsc scoped emit は数秒かかりうる（child_process spawn）。余裕を持たせる。
test.setTimeout(120000);

test.beforeAll(() => {
    // scoped emit を実行して out/shared/*.js を確実に生成する。失敗すれば例外で全 TC が落ちる。
    execFileSync('npx', ['tsc', '-p', 'tsconfig.shared-emit.json'], { cwd: REPO_ROOT, stdio: 'pipe' });
});

/**
 * 各対象モジュールと、その代表 export（function であること）を検証する。
 * export が function = 実 require が transitive dep まで解決成功した証拠。
 */
const TARGETS: { file: string; exportName: string }[] = [
    { file: 'paste-asset-handler.js', exportName: 'handlePageAssets' },
    { file: 'drop-import.js', exportName: 'classifyDroppedFile' },
    { file: 'outliner-clipboard-store.js', exportName: 'OutlinerClipboardStore' },
    { file: 'md-h1-utils.js', exportName: 'extractFirstH1' },
];

test.describe('TC-SDK-41: out/shared emit 完全性（副番人）', () => {
    for (const { file, exportName } of TARGETS) {
        test(`TC-SDK-41: out/shared/${file} が emit され require で ${exportName} が取れる`, () => {
            const abs = path.join(SHARED_OUT, file);
            // 存在チェック（emit されているか）。
            expect(fs.existsSync(abs), `out/shared/${file} が emit されていない（npm run compile / scoped emit 漏れ）`).toBe(
                true
            );

            // 実 require 成功まで（transitive dep 破壊の検出。存在だけでは足りない）。
            let mod: any;
            let threw: Error | null = null;
            try {
                delete require.cache[require.resolve(abs)];
            } catch {
                /* not cached */
            }
            try {
                // eslint-disable-next-line @typescript-eslint/no-var-requires
                mod = require(abs);
            } catch (e) {
                threw = e as Error;
            }
            expect(threw, threw ? `require が throw（transitive dep 解決失敗）: ${threw.message}` : undefined).toBeNull();

            // 代表 export が function（= 中身が正しく解決された）。
            expect(typeof mod[exportName], `${file} の ${exportName} が function でない（export 欠落 or 部分 emit）`).toBe(
                'function'
            );
        });
    }
});
