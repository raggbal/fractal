// pdf-export-host — md → PDF export の VS Code 依存 host（対象解決→HTML 回収→
// dialog→core→spawn→progress→掃除の編成）。
//
// design/system.md §5 / TASK-04。deps 注入型（export-bundle-host.ts と同型 =
// test 容易化）。vscode API・node fs / child_process はすべて deps 経由で差し替え可能に
// して、unit テストは spawn 抜き・全 mock で編成順序と全経路掃除を検証する。
//
// 対応 FR/NFR: FR-PDF-01（対象解決）・FR-PDF-05（キャンセル副作用ゼロ）・
//              FR-PDF-07（進捗/完了通知）・NFR-PDF-03（全経路 tmp 掃除）・
//              NFR-PDF-04（webview DOM 非破壊 = webview 側 clone で担保）。

import * as nodeFs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import {
    composePdfCss,
    injectNoBreakClasses,
    rewriteImgSrcToFileUri,
    buildSelfContainedHtml,
    buildPrintArgs,
    findChromiumExecutable,
} from './pdf-export-core';

/** webview panel の最小契約（deps 注入で mock 化できる形）。 */
export interface PdfPanelLike {
    active: boolean;
    webview: {
        postMessage(m: unknown): void;
        onDidReceiveMessage(cb: (m: any) => void): { dispose(): void };
    };
}

/** 対象解決の返り値（provider getter が返す形）。 */
export interface PdfTarget {
    panel: PdfPanelLike;
    filePath?: string;
}

/** webview から回収した清書結果。 */
export interface PdfHtmlResult {
    html: string;
    filePath?: string;
    /** baseDir 等の追加情報（現状未使用だが将来拡張用）。 */
    baseDir?: string;
    error?: string;
}

/** execFile 相当の返り値（成功/失敗を code と stderr で表す）。 */
export interface ExecResult {
    code: number;
    stderr: string;
}

/** cancellation トークン（vscode.CancellationToken 相当の最小契約）。 */
export interface PdfCancelToken {
    isCancellationRequested: boolean;
    onCancellationRequested(cb: () => void): { dispose(): void } | any;
}

/** fs の注入点（既定 = node fs）。 */
export interface PdfFsDeps {
    mkdtemp: (prefix: string) => string;
    writeFile: (p: string, data: string) => void;
    existsSync: (p: string) => boolean;
    rmSync: (p: string) => void;
}

export interface PdfExportDeps {
    /** 3 provider getter の返り値配列。最初の truthy（active panel）を採用する。 */
    getTargets: () => Array<PdfTarget | undefined>;
    /** HTML 回収（既定 = 実 postMessage 往復・10s timeout。テストは即 resolve）。 */
    requestHtml?: (panel: PdfPanelLike) => Promise<PdfHtmlResult>;
    /** 保存ダイアログ。undefined = キャンセル。 */
    showSaveDialog: (opts: {
        defaultPath?: string;
        filters?: Record<string, string[]>;
    }) => Thenable<{ fsPath: string } | undefined> | Promise<{ fsPath: string } | undefined>;
    /** progress 表示。task を実行してその返り値を返す。 */
    withProgress: <T>(
        opts: { title: string; cancellable?: boolean },
        task: (progress: { report: (v: unknown) => void }, token: PdfCancelToken) => Promise<T>
    ) => Thenable<T> | Promise<T>;
    /** 設定読み（都度）。 */
    getConfig: (key: string) => unknown;
    /** トースト通知。 */
    notify: {
        info(msg: string): void;
        warn(msg: string): void;
        error(msg: string): void;
    };
    /** i18n。 */
    t: (key: string) => string;
    /** fs 注入（既定 = node fs）。 */
    fs?: PdfFsDeps;
    /** execFile 注入（既定 = child_process.execFile ラッパ）。kill 用の子プロセスを返しうる。 */
    execFile?: (
        file: string,
        args: string[],
        opts: { timeout: number },
        onChild?: (kill: () => void) => void
    ) => Promise<ExecResult>;
    /** findChromiumExecutable 注入（既定 = core 実装）。 */
    findChromium?: (explicit?: string) => string | undefined;
    /** workspace root（CSS 相対パス解決用）。 */
    workspaceRoot?: string;
    /** stderr フル等のデバッグログ出力。 */
    debugLog?: (s: string) => void;
}

const HTML_TIMEOUT_MS = 10_000;
const EXEC_TIMEOUT_MS = 120_000;

/** 既定 fs 実装（node fs）。 */
function defaultFs(): PdfFsDeps {
    return {
        mkdtemp: (prefix: string) => nodeFs.mkdtempSync(prefix),
        writeFile: (p: string, data: string) => nodeFs.writeFileSync(p, data, 'utf8'),
        existsSync: (p: string) => nodeFs.existsSync(p),
        rmSync: (p: string) => nodeFs.rmSync(p, { recursive: true, force: true }),
    };
}

/**
 * panel に requestPdfHtml を投げて pdfHtmlResult を待つ。requestId 相関・10s timeout。
 * 一時購読は必ず dispose する（既存 handler と重複受信しても requestId 不一致は無視）。
 */
export function requestPdfHtmlFromPanel(panel: PdfPanelLike): Promise<PdfHtmlResult> {
    return new Promise<PdfHtmlResult>((resolve, reject) => {
        const requestId = 'pdf-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
        let settled = false;
        let sub: { dispose(): void } | undefined;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            if (sub) sub.dispose();
            reject(new Error('requestPdfHtml timed out'));
        }, HTML_TIMEOUT_MS);

        sub = panel.webview.onDidReceiveMessage((m: any) => {
            if (settled) return;
            if (!m || m.type !== 'pdfHtmlResult' || m.requestId !== requestId) return;
            settled = true;
            clearTimeout(timer);
            if (sub) sub.dispose();
            resolve({ html: m.html, filePath: m.filePath, baseDir: m.baseDir, error: m.error });
        });

        panel.webview.postMessage({ type: 'requestPdfHtml', requestId, target: 'auto' });
    });
}

/** stderr の末尾数行だけ抜き出す（トースト向け要約）。 */
function summarizeStderr(stderr: string, lines = 4): string {
    if (!stderr) return '';
    const arr = stderr.split(/\r?\n/).filter(l => l.trim().length > 0);
    return arr.slice(-lines).join('\n');
}

/**
 * md → PDF export の編成本体。編成順序が仕様（design/system.md §5）:
 *   1. 対象解決 → 無ければ pdfExportNoTarget して return（副作用ゼロ）
 *   2. HTML 回収（requestPdfHtml 往復・no-target 応答も no-target 扱い）
 *   3. showSaveDialog（キャンセル → return・disk 副作用ゼロ = mkdtemp 未実行）
 *   4. withProgress 内: config 読み → core 合成 → mkdtemp → findChromium → execFile → 通知
 *   5. finally: tmp を作った場合のみ rmSync（全経路掃除）
 */
export async function runExportMdToPdf(deps: PdfExportDeps): Promise<void> {
    const t = deps.t;
    const fs = deps.fs || defaultFs();
    const findChromium = deps.findChromium || ((explicit?: string) => findChromiumExecutable(explicit));
    const requestHtml = deps.requestHtml || requestPdfHtmlFromPanel;

    // 1. 対象解決 — getTargets の返り値から最初の truthy（active panel）
    const targets = deps.getTargets() || [];
    const target = targets.find((x): x is PdfTarget => !!x);
    if (!target) {
        deps.notify.info(t('pdfExportNoTarget'));
        return; // 副作用ゼロ
    }

    // 2. HTML 回収
    let collected: PdfHtmlResult;
    try {
        collected = await requestHtml(target.panel);
    } catch (err: any) {
        deps.notify.error(t('pdfExportFailed') + (err?.message || String(err)));
        return;
    }
    if (!collected || collected.error === 'no-target') {
        deps.notify.info(t('pdfExportNoTarget'));
        return; // 副作用ゼロ
    }

    // filePath は webview 返信優先 → provider getter → untitled
    const filePath = collected.filePath || target.filePath || '';
    const defaultPath = deriveDefaultPdfPath(filePath);

    // 3. showSaveDialog（キャンセル = 副作用ゼロ = mkdtemp より前）
    const saved = await deps.showSaveDialog({
        defaultPath,
        filters: { PDF: ['pdf'] },
    });
    if (!saved) {
        return; // キャンセル。HTML 回収済みでも disk 副作用ゼロ
    }
    const dest = saved.fsPath;

    // 4. withProgress 内で core → mkdtemp → findChromium → execFile
    await deps.withProgress(
        { title: t('pdfExportProgress'), cancellable: true },
        async (_progress, token) => {
            let tmp: string | undefined;
            try {
                // a. config 読み（都度）
                const stylePaths = (deps.getConfig('pdfStyles') as string[]) || [];
                const includeDefault = deps.getConfig('pdfIncludeDefaultStyles') !== false;
                const browserPath = (deps.getConfig('pdfBrowserPath') as string) || '';

                // b. core 合成
                const { css, skipped } = composePdfCss({
                    includeDefault,
                    stylePaths,
                    workspaceRoot: deps.workspaceRoot,
                });
                if (skipped.length > 0) {
                    deps.notify.warn(t('pdfExportCssSkipped') + skipped.join(', '));
                }
                let bodyHtml = injectNoBreakClasses(collected.html || '');
                bodyHtml = rewriteImgSrcToFileUri(bodyHtml);
                const title = filePath ? path.basename(filePath) : '';
                const fullHtml = buildSelfContainedHtml({ bodyHtml, css, title });

                // c. mkdtemp → input.html 書き出し
                tmp = fs.mkdtemp(path.join(os.tmpdir(), 'fractal-pdf-'));
                const inputHtml = path.join(tmp, 'input.html');
                fs.writeFile(inputHtml, fullHtml);

                // d. findChromium
                const browser = findChromium(browserPath);
                if (!browser) {
                    deps.notify.error(t('pdfExportBrowserNotFound'));
                    return; // finally で掃除
                }

                // e. execFile（失敗 → legacyHeadless リトライ 1 回）
                const inputUrl = pathToFileURL(inputHtml).href;
                const execFile =
                    deps.execFile ||
                    (async () => {
                        throw new Error('execFile not injected');
                    });

                let result: ExecResult;
                let killChild: (() => void) | undefined;
                const onChild = (kill: () => void) => {
                    killChild = kill;
                };
                // cancel トークンで child kill
                const cancelSub = token.onCancellationRequested(() => {
                    if (killChild) killChild();
                });

                try {
                    result = await execFile(
                        browser,
                        buildPrintArgs(dest, inputUrl),
                        { timeout: EXEC_TIMEOUT_MS },
                        onChild
                    );
                    if (result.code !== 0 || !fs.existsSync(dest)) {
                        // legacyHeadless で 1 回だけリトライ
                        result = await execFile(
                            browser,
                            buildPrintArgs(dest, inputUrl, { legacyHeadless: true }),
                            { timeout: EXEC_TIMEOUT_MS },
                            onChild
                        );
                    }
                } finally {
                    if (cancelSub && typeof cancelSub.dispose === 'function') cancelSub.dispose();
                }

                // f. dest 存在確認 → 成功/失敗通知
                if (fs.existsSync(dest)) {
                    deps.notify.info(t('pdfExportDone') + dest);
                } else {
                    const summary = summarizeStderr(result.stderr);
                    if (deps.debugLog && result.stderr) deps.debugLog(result.stderr);
                    deps.notify.error(t('pdfExportFailed') + summary);
                }
            } catch (err: any) {
                const msg = err?.message || String(err);
                if (deps.debugLog) deps.debugLog(msg);
                deps.notify.error(t('pdfExportFailed') + msg);
            } finally {
                // 5. tmp を作った場合のみ掃除（全経路 = NFR-PDF-03）
                if (tmp) {
                    try {
                        fs.rmSync(tmp);
                    } catch {
                        /* 掃除失敗は握りつぶす */
                    }
                }
            }
        }
    );
}

/**
 * 保存ダイアログの初期パスを導出する。
 * filePath があれば dirname/<basename>.pdf、無ければ untitled.pdf。
 */
export function deriveDefaultPdfPath(filePath: string): string {
    if (!filePath) return 'untitled.pdf';
    const dir = path.dirname(filePath);
    const base = path.basename(filePath).replace(/\.[^.]+$/, '');
    return path.join(dir, base + '.pdf');
}
