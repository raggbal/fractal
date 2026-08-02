/**
 * pdf-export-host.spec.ts — runExportMdToPdf(deps) の編成順序・掃除の unit テスト
 *
 * TASK-04 / FR-PDF-01/05/07 / NFR-PDF-03/04。
 * deps 全 mock・spawn 抜き（execFile / mkdtemp / rmSync / findChromiumExecutable
 * を注入で差し替え）。drop-stream-host.ts の deps 注入パターンと同型
 * （export-bundle-host は vscode 直呼びのため precedent ではない）。
 *
 * 番人方針:
 *  - TC-PDF-24: showSaveDialog=undefined（キャンセル）→ mkdtemp / execFile が未呼出
 *    （FR-PDF-05 副作用ゼロ）。
 *  - TC-PDF-25: core 以降で例外 → finally の rmSync が呼ばれる（NFR-PDF-03 全経路掃除。
 *    counterfactual = tmp を作った後に例外を投げ、rmSync が呼ばれなければ RED）。
 *  - TC-PDF-26: 正常系で dialog < mkdtemp < execFile の呼び出し順を配列で記録。
 *  - TC-PDF-27: findChromiumExecutable=undefined → execFile 未呼出・notify.error 呼出・
 *    （tmp を作っていれば）掃除。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { runExportMdToPdf, PdfExportDeps } from '../../src/shared/pdf-export-host';

/** 呼び出し順を記録するトレース配列。 */
type Trace = string[];

interface MockState {
    trace: Trace;
    notifyInfo: string[];
    notifyWarn: string[];
    notifyError: string[];
    mkdtempCalls: number;
    execFileCalls: number;
    rmSyncCalls: number;
    writeFileCalls: number;
}

/**
 * 正常系寄りの deps を組み立てるファクトリ。overrides で個別に差し替える。
 * 既定は「active な target 1 つ・HTML 回収成功・dialog で保存先を返す・
 * chromium 発見・execFile 成功・dest 生成済み」。
 */
function makeDeps(overrides: Partial<PdfExportDeps>, state: MockState): PdfExportDeps {
    const tmpDir = '/tmp/fractal-pdf-mock';
    const base: PdfExportDeps = {
        getTargets: () => [
            {
                panel: {
                    active: true,
                    webview: {
                        postMessage: () => {},
                        onDidReceiveMessage: () => ({ dispose: () => {} }),
                    },
                },
                filePath: '/notes/doc.md',
            },
        ],
        // HTML 回収を deps で差し替え可能に（既定 = 即 resolve）
        requestHtml: async () => ({ html: '<h1>x</h1>', filePath: '/notes/doc.md' }),
        showSaveDialog: async () => {
            state.trace.push('dialog');
            return { fsPath: '/out/doc.pdf' };
        },
        withProgress: async (_opts, task) => {
            const token = {
                isCancellationRequested: false,
                onCancellationRequested: () => ({ dispose: () => {} }),
            };
            return task({ report: () => {} }, token);
        },
        getConfig: (key: string) => {
            if (key === 'pdfStyles') return [];
            if (key === 'pdfIncludeDefaultStyles') return true;
            if (key === 'pdfBrowserPath') return '';
            return undefined;
        },
        notify: {
            info: (m: string) => state.notifyInfo.push(m),
            warn: (m: string) => state.notifyWarn.push(m),
            error: (m: string) => state.notifyError.push(m),
        },
        t: (key: string) => key,
        fs: {
            mkdtemp: (_prefix: string) => {
                state.trace.push('mkdtemp');
                state.mkdtempCalls++;
                return tmpDir;
            },
            writeFile: (_p: string, _data: string) => {
                state.writeFileCalls++;
            },
            existsSync: (_p: string) => true, // dest 生成済み扱い
            rmSync: (_p: string) => {
                state.rmSyncCalls++;
            },
        },
        findChromium: () => '/usr/bin/chromium',
        execFile: async () => {
            state.trace.push('execFile');
            state.execFileCalls++;
            return { code: 0, stderr: '' };
        },
        workspaceRoot: '/ws',
    };
    return { ...base, ...overrides };
}

function freshState(): MockState {
    return {
        trace: [],
        notifyInfo: [],
        notifyWarn: [],
        notifyError: [],
        mkdtempCalls: 0,
        execFileCalls: 0,
        rmSyncCalls: 0,
        writeFileCalls: 0,
    };
}

test.describe('runExportMdToPdf 編成順序・掃除（TC-PDF-24〜27）', () => {
    test('TC-PDF-24: showSaveDialog=undefined（キャンセル）→ mkdtemp / execFile 未到達（副作用ゼロ）', async () => {
        const state = freshState();
        const deps = makeDeps(
            {
                showSaveDialog: async () => {
                    state.trace.push('dialog');
                    return undefined; // キャンセル
                },
            },
            state
        );
        await runExportMdToPdf(deps);
        expect(state.mkdtempCalls).toBe(0);
        expect(state.execFileCalls).toBe(0);
        expect(state.writeFileCalls).toBe(0);
        // dialog は呼ばれている（キャンセルはその後の副作用のみゼロ）
        expect(state.trace).toEqual(['dialog']);
    });

    test('TC-PDF-25: core 以降で例外 → finally で rmSync が呼ばれる（全経路掃除・counterfactual）', async () => {
        const state = freshState();
        const deps = makeDeps(
            {
                // mkdtemp は成功（tmp を作る）。その後 execFile で例外。
                execFile: async () => {
                    state.trace.push('execFile');
                    state.execFileCalls++;
                    throw new Error('spawn boom');
                },
            },
            state
        );
        await runExportMdToPdf(deps); // 例外は内部で握って通知に落とす（reject させない）
        expect(state.mkdtempCalls).toBe(1);
        // tmp を作った経路で例外 → finally の rmSync が必ず呼ばれる
        expect(state.rmSyncCalls).toBeGreaterThanOrEqual(1);
    });

    test('TC-PDF-26: 正常系で dialog < mkdtemp < execFile の順', async () => {
        const state = freshState();
        const deps = makeDeps({}, state);
        await runExportMdToPdf(deps);
        const di = state.trace.indexOf('dialog');
        const mi = state.trace.indexOf('mkdtemp');
        const ei = state.trace.indexOf('execFile');
        expect(di).toBeGreaterThanOrEqual(0);
        expect(mi).toBeGreaterThan(di);
        expect(ei).toBeGreaterThan(mi);
        // 正常系は完了トースト（pdfExportDone）
        expect(state.notifyInfo.some(m => m.includes('pdfExportDone'))).toBe(true);
    });

    test('TC-PDF-27: findChromium=undefined → execFile 未到達・pdfExportBrowserNotFound 通知・掃除', async () => {
        const state = freshState();
        const deps = makeDeps(
            {
                findChromium: () => undefined,
            },
            state
        );
        await runExportMdToPdf(deps);
        expect(state.execFileCalls).toBe(0);
        expect(state.notifyError.some(m => m.includes('pdfExportBrowserNotFound'))).toBe(true);
        // tmp を作った後に chromium 不在で抜けても finally 掃除は走る
        expect(state.rmSyncCalls).toBeGreaterThanOrEqual(1);
    });

    test('TC-PDF-51: pdfExportComingSoon が src/ 全体から 0 ヒット（削除完了 gate・コメント含め除去）', () => {
        const srcRoot = path.resolve(__dirname, '../../src');
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const name of fs.readdirSync(dir)) {
                const p = path.join(dir, name);
                const st = fs.statSync(p);
                if (st.isDirectory()) {
                    walk(p);
                } else if (/\.(ts|js)$/.test(name)) {
                    if (fs.readFileSync(p, 'utf8').includes('pdfExportComingSoon')) hits.push(p);
                }
            }
        };
        walk(srcRoot);
        expect(hits).toEqual([]);
    });

    test('TC-PDF-28: 第 1 execFile 実行中に cancel → legacyHeadless リトライ（第 2 execFile）が呼ばれない（FR-PDF-05 / counterfactual）', async () => {
        // onCancellationRequested は one-shot（第 1 プロセス kill で消費済み）なので、
        // リトライ経路では token.isCancellationRequested の明示確認が唯一の防御。
        // 第 1 execFile 内で cancel をセット + code!==0（失敗）を返し、
        // ガードが無いと第 2 execFile（legacyHeadless リトライ）が呼ばれる。
        //
        // counterfactual 実測（開発時）: pdf-export-host.ts の
        //   `if (token.isCancellationRequested) { return; }`（リトライ前ガード）を
        // コメントアウトすると execFileCalls===2 になり本 TC は RED。ガードを戻すと 1 で green。
        const state = freshState();
        // withProgress / execFile 間で共有する可変トークン。
        const token = {
            isCancellationRequested: false,
            onCancellationRequested: () => ({ dispose: () => {} }),
        };
        const deps = makeDeps(
            {
                withProgress: async (_opts, task) => {
                    return task({ report: () => {} }, token);
                },
                // dest 未生成扱い（code!==0 かつ existsSync=false でリトライ経路へ）。
                fs: {
                    mkdtemp: (_prefix: string) => {
                        state.trace.push('mkdtemp');
                        state.mkdtempCalls++;
                        return '/tmp/fractal-pdf-mock';
                    },
                    writeFile: (_p: string, _data: string) => {
                        state.writeFileCalls++;
                    },
                    existsSync: (_p: string) => false, // dest 未生成 → 本来ならリトライ判定に入る
                    rmSync: (_p: string) => {
                        state.rmSyncCalls++;
                    },
                },
                execFile: async () => {
                    state.trace.push('execFile');
                    state.execFileCalls++;
                    // 第 1 execFile 実行中に cancel（onCancellationRequested は消費済みの想定）。
                    token.isCancellationRequested = true;
                    return { code: 1, stderr: 'cancelled' }; // code!==0 = 失敗
                },
            },
            state
        );
        await runExportMdToPdf(deps);
        // ガードにより第 2 execFile（リトライ）は呼ばれない。
        expect(state.execFileCalls).toBe(1);
        // tmp を作っているので finally 掃除は走る（全経路掃除・NFR-PDF-03）。
        expect(state.rmSyncCalls).toBeGreaterThanOrEqual(1);
    });

    test('TC-PDF-24b: target 無し（getTargets が空）→ pdfExportNoTarget 通知・副作用ゼロ', async () => {
        const state = freshState();
        const deps = makeDeps(
            {
                getTargets: () => [undefined],
            },
            state
        );
        await runExportMdToPdf(deps);
        expect(state.trace).toEqual([]); // dialog すら呼ばれない
        expect(state.mkdtempCalls).toBe(0);
        expect(state.notifyInfo.some(m => m.includes('pdfExportNoTarget'))).toBe(true);
    });
});
