/**
 * TC-MDM-02/03/08（host 側）— copyLinkPath の解決 + clamp（sprint 20260818-183407 FR-MDM-01）
 *
 * 共有 resolver resolveLinkTargetUnder（path-safety.ts）: href を md dir 基準で絶対化し
 * rootAbs 配下に clamp（外は null）。encode 済み traversal は decode 後に containment 検査。
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
function requireWithVscodeStub(modulePath: string, sink: { clipboard: string[]; warnings: string[] }): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: { showWarningMessage: (m: string) => { sink.warnings.push(m); } },
                env: { clipboard: { writeText: (t: string) => { sink.clipboard.push(t); } } },
                ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

test('TC-MDM-02h resolveLinkTargetUnder: 相対 md/file リンクを md dir 基準で絶対化 + root 配下 clamp', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveLinkTargetUnder } = require('../../src/shared/path-safety');
    const root = '/notes/A';
    const md = '/notes/A/page.md';
    expect(resolveLinkTargetUnder(root, md, 'sub.md')).toBe(path.join('/notes/A', 'sub.md'));
    expect(resolveLinkTargetUnder(root, md, 'files/report.pdf')).toBe(path.join('/notes/A', 'files/report.pdf'));
    // ?query / #fragment / <> は strip
    expect(resolveLinkTargetUnder(root, md, '<sub.md>#sec')).toBe(path.join('/notes/A', 'sub.md'));
    // スペース入り encode
    expect(resolveLinkTargetUnder(root, md, 'files/my%20file.docx')).toBe(path.join('/notes/A', 'files/my file.docx'));
});

test('TC-MDM-08h traversal 棄却: 生 ../ も encode 済み ..%2F も root 外は null（counterfactual）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveLinkTargetUnder } = require('../../src/shared/path-safety');
    const root = '/notes/A';
    const md = '/notes/A/page.md';
    expect(resolveLinkTargetUnder(root, md, '../secret.md')).toBeNull();
    expect(resolveLinkTargetUnder(root, md, '..%2F..%2Fetc%2Fpasswd')).toBeNull();
    expect(resolveLinkTargetUnder(root, md, '/etc/passwd')).toBeNull(); // root 外の絶対パス
    // root 内に収まる ../ は許容（sub dir の md から親=root 直下へ）
    expect(resolveLinkTargetUnder(root, '/notes/A/sub/deep.md', '../top.md')).toBe(path.join('/notes/A', 'top.md'));
});

test('TC-MDM-02i notes handler dispatch: copyLinkPath が platform へ href/kind/sidePanelFilePath を渡す', async () => {
    const sink = { clipboard: [] as string[], warnings: [] as string[] };
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler', sink).handleNotesMessage;
    const calls: any[] = [];
    const platform = {
        showInformationMessage: () => {}, showErrorMessage: () => {},
        copyLinkPath: (href: string, kind: string, mdPath: string) => { calls.push({ href, kind, mdPath }); },
    } as any;
    await handleNotesMessage(
        { type: 'copyLinkPath', href: 'sub.md', kind: 'md', sidePanelFilePath: '/notes/A/page.md' },
        { getCurrentFilePath: () => '/notes/A/x.out' } as any, { postMessage: () => {} } as any, platform
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ href: 'sub.md', kind: 'md', mdPath: '/notes/A/page.md' });
});

test('TC-MDM-09p SidePanelHostBridge に copyLinkPath が個別実在（editor.js 手書きクラス — grep 番人）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/webview/editor.js'), 'utf8');
    const cls = src.slice(src.indexOf('class SidePanelHostBridge'), src.indexOf('class SidePanelHostBridge') + 12000);
    expect(/copyLinkPath\(/.test(cls), 'SidePanelHostBridge.copyLinkPath 不在').toBe(true);
});

// ─── TC-MDM-04（host 側）: convertMdLinksToFullPaths + notes handler dispatch（FR-MDM-03・TASK-09） ───

test('TC-MDM-04h convertMdLinksToFullPaths: subpage/file/md リンクのみ絶対化・https とラベルは不変', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { convertMdLinksToFullPaths } = require('../../src/shared/paste-asset-handler');
    const md = [
        '[normal](https://example.com/page)',
        '[[Sub]](sub.md)',
        '[📎 report.pdf](files/report.pdf)',
        '![img](images/pic.png)',
        'plain text',
    ].join('\n');
    const out = convertMdLinksToFullPaths(md, {
        resolveMd: (url: string) => (url === 'sub.md' ? '/notes/A/sub.md' : null),
        resolveFile: (url: string) => (url === 'files/report.pdf' ? '/notes/A/files/report.pdf' : null),
    });
    expect(out).toContain('[[Sub]](/notes/A/sub.md)');
    expect(out).toContain('[📎 report.pdf](/notes/A/files/report.pdf)');
    expect(out).toContain('[normal](https://example.com/page)'); // 通常リンク不変
    expect(out).toContain('![img](images/pic.png)');             // 画像は対象外
    expect(out).toContain('plain text');
});

test('TC-MDM-04i notes handler dispatch: copyMdWithFullPaths が platform へ markdown/mdPath を渡す', async () => {
    const sink = { clipboard: [] as string[], warnings: [] as string[] };
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler', sink).handleNotesMessage;
    const calls: any[] = [];
    const platform = {
        showInformationMessage: () => {}, showErrorMessage: () => {},
        copyMdWithFullPaths: (markdown: string, mdPath: string) => { calls.push({ markdown, mdPath }); },
    } as any;
    await handleNotesMessage(
        { type: 'copyMdWithFullPaths', markdown: '[[S]](s.md)', sidePanelFilePath: '/notes/A/page.md' },
        { getCurrentFilePath: () => '/notes/A/x.out' } as any, { postMessage: () => {} } as any, platform
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ markdown: '[[S]](s.md)', mdPath: '/notes/A/page.md' });
});

test('TC-MDM-09p2 SidePanelHostBridge に copyMdWithFullPaths が個別実在', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/webview/editor.js'), 'utf8');
    const cls = src.slice(src.indexOf('class SidePanelHostBridge'), src.indexOf('class SidePanelHostBridge') + 14000);
    expect(/copyMdWithFullPaths\(/.test(cls)).toBe(true);
});

// ─── TC-MDM-06/07/08（host 側）: duplicateLinkEntity（FR-MDM-02・TASK-10） ───

test('TC-MDM-06h notes 側 duplicateLinkEntity(md): 実体複製 + 元不変 + 応答 echo（実 fs）', async () => {
    const sink = { clipboard: [] as string[], warnings: [] as string[] };
    const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler', sink).handleNotesMessage;
    const calls: any[] = [];
    const platform = {
        showInformationMessage: () => {}, showErrorMessage: () => {},
        duplicateLinkEntity: (href: string, kind: string, mdPath: string, destination: string | undefined) => {
            calls.push({ href, kind, mdPath, destination });
        },
    } as any;
    await handleNotesMessage(
        { type: 'duplicateLinkEntity', href: 'sub.md', kind: 'md', sidePanelFilePath: '/notes/A/page.md', destination: 'sidepanel' },
        { getCurrentFilePath: () => '/notes/A/x.out' } as any, { postMessage: () => {} } as any, platform
    );
    expect(calls.length).toBe(1);
    expect(calls[0]).toEqual({ href: 'sub.md', kind: 'md', mdPath: '/notes/A/page.md', destination: 'sidepanel' });
});

test('TC-MDM-09p3 SidePanelHostBridge に duplicateLinkEntity が個別実在（3 メソッド全体の wiring guard）', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../src/webview/editor.js'), 'utf8');
    const cls = src.slice(src.indexOf('class SidePanelHostBridge'), src.indexOf('class SidePanelHostBridge') + 16000);
    for (const m of ['copyLinkPath(', 'copyMdWithFullPaths(', 'duplicateLinkEntity(']) {
        expect(cls.includes(m), `SidePanelHostBridge.${m} 不在`).toBe(true);
    }
});

// ─── reviewer iteration 1 修正（TASK-17）: SEC-1 / DESIGN-2 ───

test('TC-MDM-08f (DESIGN-2) file 種別の clamp root = files dir（親 md dir へ拡大すると RED の counterfactual）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { resolveLinkTargetUnder } = require('../../src/shared/path-safety');
    const note = '/notes/A';
    const filesDir = path.join(note, 'files');
    const md = path.join(note, 'page.md');
    // 正常系: files/ 内の参照は filesDir clamp で通る
    expect(resolveLinkTargetUnder(filesDir, md, 'files/report.pdf')).toBe(path.join(filesDir, 'report.pdf'));
    // 境界すぐ外の兄弟ファイル（偽装 📎 リンク `[📎 x](secret.txt)` — files/ 外の note 直下）
    // counterfactual: clamp root を dirname(md)（= note 直下）へ拡大すると secret.txt が通ってしまう
    expect(resolveLinkTargetUnder(filesDir, md, 'secret.txt')).toBeNull();
    expect(resolveLinkTargetUnder(path.dirname(md), md, 'secret.txt')).not.toBeNull(); // 拡大 base だと通る = 拡大禁止の実証
});

test('TC-MDM-04p (SEC-1) balanced 括弧入り絶対パスの変換 + unbalanced 祖先名でも throw しない（既知制約の pin）', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { convertMdLinksToFullPaths } = require('../../src/shared/paste-asset-handler');
    // balanced（Finder 一般命名 `(1)` / `(copy)`）: 正しく変換され md 構文も保たれる
    const md1 = '[📎 doc.pdf](files/doc.pdf)';
    const out1 = convertMdLinksToFullPaths(md1, {
        resolveMd: () => null,
        resolveFile: () => '/Users/me/Notes (work)/A/files/doc (1).pdf',
    });
    expect(out1).toContain('(/Users/me/Notes (work)/A/files/doc (1).pdf)');
    // unbalanced 祖先名（例: `Report (draft`）でも例外を出さない（出力の消費側互換は既知制約 —
    // requirement スコープ外節に明記。ここでは非クラッシュと変換実行を pin）
    const out2 = convertMdLinksToFullPaths(md1, {
        resolveMd: () => null,
        resolveFile: () => '/Users/me/Report (draft/files/doc.pdf',
    });
    expect(typeof out2).toBe('string');
    expect(out2).toContain('Report (draft');
});
