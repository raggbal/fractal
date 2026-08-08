/**
 * TC-XP-01 / TC-XP-09 — main md ↔ main md cross-note paste の dest 解決 seam +
 * copyMdPasteAssets の main md dest での複製実測（sprint 20260808-000219 FR-XP-01）。
 *
 * 背景: pasteWithAssetCopy handler は従来 `if (message.sidePanelFilePath)` 必須ガードで、
 * main md paste（sidePanelFilePath undefined）が silent no-op だった。
 * seam resolvePasteWithAssetCopyDest が sidepanel 優先 + main md fallback を返す。
 *
 * counterfactual: 旧ガード相当（sidePanelFilePath 無し → null 扱い）だと main md paste が
 * 何も複製しない = TC-XP-01b の fallback assert が RED。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolvePasteWithAssetCopyDest, copyMdPasteAssets } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'md-xp-dest-'));
}

function writeF(dir: string, rel: string, content: string): void {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
}

// ─── seam: resolvePasteWithAssetCopyDest ───────────────────────────────────

test('TC-XP-01a sidepanel 経路: sidePanelFilePath が最優先', () => {
    expect(resolvePasteWithAssetCopyDest('/notes/A/page.md', '/docs/main.md'))
        .toBe('/notes/A/page.md');
});

test('TC-XP-01b (load-bearing) main md 経路: sidePanelFilePath 無し → document へ fallback', () => {
    // counterfactual: 旧実装（sidePanelFilePath 必須ガード）はここで null 相当 → silent no-op
    expect(resolvePasteWithAssetCopyDest(undefined, '/docs/main.md')).toBe('/docs/main.md');
    expect(resolvePasteWithAssetCopyDest('', '/docs/main.md')).toBe('/docs/main.md');
    expect(resolvePasteWithAssetCopyDest(null, '/docs/main.md')).toBe('/docs/main.md');
});

test('TC-XP-01c 両方無し → null（no-op が正しい）', () => {
    expect(resolvePasteWithAssetCopyDest(undefined, undefined)).toBeNull();
    expect(resolvePasteWithAssetCopyDest('', '')).toBeNull();
});

// ─── main md dest での複製実測（エンジン流用の end-to-end unit） ────────────

test('TC-XP-01d main md dest: 画像 + 📎 + subpage closure が dest note に複製されリンク書換', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    const noteB = path.join(root, 'noteB');
    fs.mkdirSync(noteA, { recursive: true });
    fs.mkdirSync(noteB, { recursive: true });

    // note A: 画像 / 📎 添付 / subpage md（その中にさらに画像）
    writeF(noteA, 'images/pic.png', 'PNG-A');
    writeF(noteA, 'files/doc.pdf', 'PDF-A');
    writeF(noteA, 'sub1.md', '# Sub\n![inner](images/inner.png)\n');
    writeF(noteA, 'images/inner.png', 'PNG-INNER');

    const markdown = [
        '![p](images/pic.png)',
        '[📎 doc.pdf](files/doc.pdf)',
        '[[Sub]](sub1.md)',
    ].join('\n');

    // main md paste: dest は seam が返した main md（noteB/main.md）基準の dir
    const destMd = resolvePasteWithAssetCopyDest(undefined, path.join(noteB, 'main.md'))!;
    expect(destMd).toBe(path.join(noteB, 'main.md'));

    const { rewrittenMarkdown } = copyMdPasteAssets({
        markdown,
        sourceMdDir: noteA,
        sourceImageDir: path.join(noteA, 'images'),
        sourceFileDir: path.join(noteA, 'files'),
        destImageDir: path.join(noteB, 'images'),
        destFileDir: path.join(noteB, 'files'),
        destMdDir: path.dirname(destMd),
    });

    // 画像実体が dest に複製されている
    const destImages = fs.readdirSync(path.join(noteB, 'images'));
    expect(destImages.some(f => f.endsWith('pic.png'))).toBe(true);
    // 📎 実体が dest に複製されている
    const destFiles = fs.readdirSync(path.join(noteB, 'files'));
    expect(destFiles).toContain('doc.pdf');
    // subpage closure（sub1.md + その中の inner.png）が dest に複製されている
    const destMds = fs.readdirSync(noteB).filter(f => f.endsWith('.md'));
    expect(destMds.length).toBeGreaterThanOrEqual(1);
    expect(destImages.some(f => f.endsWith('inner.png'))).toBe(true);

    // リンクが dest 実体を指す（source の絶対/元相対パスが残らない）
    expect(rewrittenMarkdown).not.toContain('noteA');
    // source 実体は温存（copy = orphan にしない、cut でも実体は消さない規約）
    expect(fs.existsSync(path.join(noteA, 'images/pic.png'))).toBe(true);
    expect(fs.existsSync(path.join(noteA, 'files/doc.pdf'))).toBe(true);
    expect(fs.existsSync(path.join(noteA, 'sub1.md'))).toBe(true);
});

test('TC-XP-09 uniquify: dest に同名先置きで衝突 → 連番分岐（1:1 所有・dedup なし）', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    const noteB = path.join(root, 'noteB');
    writeF(noteA, 'files/doc.pdf', 'PDF-NEW');
    writeF(noteB, 'files/doc.pdf', 'PDF-OLD'); // 先置き衝突

    const { rewrittenMarkdown } = copyMdPasteAssets({
        markdown: '[📎 doc.pdf](files/doc.pdf)',
        sourceMdDir: noteA,
        sourceImageDir: path.join(noteA, 'images'),
        sourceFileDir: path.join(noteA, 'files'),
        destImageDir: path.join(noteB, 'images'),
        destFileDir: path.join(noteB, 'files'),
        destMdDir: noteB,
    });

    const destFiles = fs.readdirSync(path.join(noteB, 'files'));
    // 既存 doc.pdf は無傷 + 新実体は別名（dedup で同一視しない）
    expect(fs.readFileSync(path.join(noteB, 'files/doc.pdf'), 'utf8')).toBe('PDF-OLD');
    const renamed = destFiles.find(f => f !== 'doc.pdf' && f.endsWith('.pdf'));
    expect(renamed).toBeTruthy();
    expect(fs.readFileSync(path.join(noteB, 'files', renamed!), 'utf8')).toBe('PDF-NEW');
    expect(rewrittenMarkdown).toContain(renamed!);
});
