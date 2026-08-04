/**
 * Sprint: 20260802-212934-aws-sdk-migration / TASK-03 (DOM-BundleBuild, FR-SDK-04, NFR-SDK-03)
 *
 * esbuild バンドル後の out/extension.js を検証する番人 spec。beforeAll で
 * `node esbuild.js` を child_process 実行して実バンドルを生成し、その成果物を検証する。
 *
 * TC-SDK-30: バンドルを vscode stub つきで require → activate/deactivate が export され throw しない
 * TC-SDK-31: R2 番人 — バンドル環境で initLocale('ja') → messages と webviewMessages の両方が ja 実値
 *            （英語 fallback でない。variable require のままだとバンドルで locale 解決失敗 = RED）
 * TC-SDK-32: バンドルサイズ ≤ 3MB（NFR-SDK-03）
 * TC-SDK-33: バンドルに external の `require("vscode")` が残存する
 *            （@aws-sdk 同梱 assert は呼び出し側置換〔TASK-04/05〕後に効くため、
 *             本 TASK 時点では extension.ts が SDK を import しておらず存在しない。
 *             よって @aws-sdk 存在は「あれば確認・無くても pending にしない」弱い扱いとし、
 *             ここでは vscode external の残存のみを確定 assert する。判断は generator-log 参照）
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const BUNDLE_PATH = path.join(REPO_ROOT, 'out', 'extension.js');
const MESSAGES_SRC = path.join(REPO_ROOT, 'src', 'i18n', 'messages.ts');

// esbuild は速い（<1s）が、child_process spawn + 型なし bundle のため余裕を持たせる。
test.setTimeout(60000);

test.beforeAll(() => {
    // 実バンドルを生成（out/extension.js を上書き）。失敗すれば例外で全 TC が落ちる。
    execFileSync('node', ['esbuild.js'], { cwd: REPO_ROOT, stdio: 'pipe' });
});

test.describe('D. bundle-smoke (esbuild 実行後の out/extension.js)', () => {
    test('TC-SDK-30: バンドルを vscode stub つきで require → activate/deactivate export・throw なし', () => {
        expect(fs.existsSync(BUNDLE_PATH), 'out/extension.js が生成されていない').toBe(true);

        // extension.ts のグラフには module-load 時に `class X extends vscode.TreeItem`
        // など vscode を触るものがある（notesFolderProvider 等）。空 stub では extends が壊れる。
        //
        // 重要: esbuild(cjs/node) は `import * as vscode` を `__toESM(require("vscode"))` に変換する。
        //   __toESM は namespace object を `Object.create(Object.getPrototypeOf(mod))` で作り、
        //   mod の **own property 名だけ**を getter でコピーする。よって単純な catch-all Proxy を
        //   返しても own-name が無く `vscode.TreeItem` は undefined になり `class extends undefined` で throw。
        //   → stub の **prototype** を catch-all Proxy にして返す。namespace object がその prototype を
        //   継承するため、未知メンバー（TreeItem 等）アクセスが prototype の get trap に落ち、
        //   construct 可能な proxy が返る（メンバーを列挙せず全 vscode 参照を吸収）。
        const Module = require('module');
        const origLoad = Module._load;

        // construct / call / property いずれも受ける再帰 Proxy。
        const makeCallableProxy = (): any => {
            const fn: any = function () {
                return makeCallableProxy();
            };
            return new Proxy(fn, {
                get(_t, prop) {
                    if (prop === Symbol.toPrimitive) {
                        return () => '';
                    }
                    if (prop === 'then') {
                        return undefined;
                    }
                    return makeCallableProxy();
                },
                // `new vscode.TreeItem(...)` / `new vscode.EventEmitter()` を受ける
                construct() {
                    return {};
                },
                apply() {
                    return makeCallableProxy();
                },
            });
        };

        // 任意メンバーを吸収する catch-all（namespace object の prototype になる）。
        const catchAllProto: any = new Proxy(function () {}, {
            get(_t, prop) {
                if (prop === Symbol.toPrimitive || prop === 'then' || prop === '__esModule') {
                    return undefined;
                }
                return makeCallableProxy();
            },
        });
        // __toESM が Object.getPrototypeOf(stub) を namespace の prototype にする → catchAllProto。
        const vscodeStub: any = Object.create(catchAllProto);

        Module._load = function (request: string) {
            if (request === 'vscode') {
                return vscodeStub;
            }
            // eslint-disable-next-line prefer-rest-params
            return origLoad.apply(this, arguments as any);
        };

        // require キャッシュから前回ロードを外して確実に再評価。
        try {
            delete require.cache[require.resolve(BUNDLE_PATH)];
        } catch {
            /* not cached */
        }

        let mod: any;
        let threw: Error | null = null;
        try {
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            mod = require(BUNDLE_PATH);
        } catch (e) {
            threw = e as Error;
        } finally {
            Module._load = origLoad;
        }

        expect(threw, threw ? `require が throw: ${threw.message}` : undefined).toBeNull();
        expect(typeof mod.activate, 'activate が export されていない').toBe('function');
        expect(typeof mod.deactivate, 'deactivate が export されていない').toBe('function');
    });

    test("TC-SDK-31: R2 番人 — バンドル環境で initLocale('ja') が messages/webviewMessages 両方 ja 実値を返す", () => {
        // extension.ts バンドルは i18n の t()/getWebviewMessages() を re-export しないため、
        // messages.ts を単体でバンドルして駆動する（judgement: notes 参照）。
        // 静的 require マップに畳み込まれていれば ja が解決される。variable require のままなら
        // `Cannot find module '.../locales/ja.js'` で英語 fallback = RED（counterfactual）。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const esbuild = require('esbuild');
        const outFile = path.join(REPO_ROOT, 'out', '__bundle-smoke-messages.js');
        esbuild.buildSync({
            entryPoints: [MESSAGES_SRC],
            outfile: outFile,
            bundle: true,
            platform: 'node',
            format: 'cjs',
            target: 'node20',
        });

        try {
            delete require.cache[require.resolve(outFile)];
        } catch {
            /* not cached */
        }
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const m = require(outFile);

        // en / ja の実値を直接 import して基準にする（値の食い違い = ロケール解決成功の証拠）。
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const enMod = require(path.join(REPO_ROOT, 'src', 'i18n', 'locales', 'en'));
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const jaMod = require(path.join(REPO_ROOT, 'src', 'i18n', 'locales', 'ja'));

        // 前提: en と ja で値が異なるキーを使う（同値だと fallback を検出できない）。
        expect(jaMod.messages.reload).not.toBe(enMod.messages.reload);
        expect(jaMod.webviewMessages.bold).not.toBe(enMod.webviewMessages.bold);

        m.initLocale('ja', 'ja');
        expect(m.getLocale()).toBe('ja');

        // messages 側: ja 実値であること（en fallback でない）。
        expect(m.t('reload'), 'messages.reload が ja 実値でない（英語 fallback = locale 解決失敗）').toBe(
            jaMod.messages.reload
        );
        // webviewMessages 側: 2 フィールド契約の保存（HIGH-3 番人。messages のみだと縮約 regression を見逃す）。
        const wm = m.getWebviewMessages();
        expect(wm.bold, 'webviewMessages.bold が ja 実値でない（2 フィールド契約が縮約された）').toBe(
            jaMod.webviewMessages.bold
        );
    });

    test('TC-SDK-32: バンドルサイズ ≤ 3MB (NFR-SDK-03)', () => {
        const stat = fs.statSync(BUNDLE_PATH);
        const THREE_MB = 3 * 1024 * 1024;
        expect(stat.size, `out/extension.js が ${(stat.size / 1024 / 1024).toFixed(2)}MB で 3MB 超`).toBeLessThanOrEqual(
            THREE_MB
        );
    });

    test('TC-SDK-33: バンドルに external の require("vscode") が残存する', () => {
        const bundle = fs.readFileSync(BUNDLE_PATH, 'utf8');
        // esbuild は external モジュールを `require("vscode")`（minify 後も文字列は保持）として残す。
        expect(bundle.includes('require("vscode")'), 'vscode が external として残っていない').toBe(true);

        // @aws-sdk は本 TASK 時点で extension.ts の import グラフに無い（aws-translate は spawn のまま）。
        // TASK-04/05 が呼び出し側を SDK に差し替えた後にバンドルへ入る。存在すれば同梱の裏取りになるが、
        // 無くても本 TASK では FAIL にしない（pending/skip にもしない = 単に情報ログ）。判断: generator-log 参照。
        const hasSdk = bundle.includes('@aws-sdk');
        console.log(`[TC-SDK-33] @aws-sdk present in bundle: ${hasSdk} (TASK-03 時点では false が想定・TASK-04/05 で true 化)`);
    });
});
