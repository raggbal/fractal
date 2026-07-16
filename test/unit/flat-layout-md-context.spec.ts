/**
 * sidepanel-paste-note-context TASK-01 — md 絶対パス起点の images/files dir 解決
 *
 * sidepanel で開いた md（別 note / 非 note どちらも）の隣の共有 images/files に保存するための純関数。
 * resolveImagesDirForMd(mdAbsPath) / resolveFilesDirForMd(mdAbsPath)。
 *
 * TC-SP-01 フラット note md → <note>/images
 * TC-SP-02 別 note md → <noteB>/images（メイン基準にフォールバックしない・load-bearing）
 * TC-SP-03 非 note md（images サブなし）→ <dir>/images（新 default）
 * TC-SP-04 files 版 → <note>/files
 * TC-SP-05 legacy pages/ 吸収 → 親 <note>/images（load-bearing）
 * TC-SP-06 相対整合（画像）→ images/img.png
 * TC-SP-07 相対整合（files）→ files/a.pdf
 * TC-SP-10 後方互換: 自 note md が従来の共有 <note>/images と一致
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resolveImagesDirForMd,
    resolveFilesDirForMd,
} from '../../src/shared/flat-layout';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flat-md-ctx-'));
}

test('TC-SP-01: フラット note md → <note>/images', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    fs.mkdirSync(path.join(noteA, 'images'), { recursive: true });
    const md = path.join(noteA, 'x.md');
    fs.writeFileSync(md, '# x');
    expect(resolveImagesDirForMd(md)).toBe(path.join(noteA, 'images'));
});

test('TC-SP-02: 別 note md → <noteB>/images（メイン基準にフォールバックしない）', () => {
    const root = mkTmp();
    const noteB = path.join(root, 'noteB');
    fs.mkdirSync(path.join(noteB, 'images'), { recursive: true });
    const md = path.join(noteB, 'y.md');
    fs.writeFileSync(md, '# y');
    // メインが noteA でも、md=noteB/y.md なら noteB/images を返す（load-bearing）
    expect(resolveImagesDirForMd(md)).toBe(path.join(noteB, 'images'));
});

test('TC-SP-03: 非 note md（images サブなし）→ <dir>/images（新 default）', () => {
    const root = mkTmp();
    const loose = path.join(root, 'loose');
    fs.mkdirSync(loose, { recursive: true });
    const md = path.join(loose, 'z.md');
    fs.writeFileSync(md, '# z');
    // images サブが存在しなくても新 default パスを返す（呼び出し側が mkdir）
    expect(resolveImagesDirForMd(md)).toBe(path.join(loose, 'images'));
});

test('TC-SP-04: files 版 → <note>/files', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    fs.mkdirSync(path.join(noteA, 'files'), { recursive: true });
    const md = path.join(noteA, 'x.md');
    fs.writeFileSync(md, '# x');
    expect(resolveFilesDirForMd(md)).toBe(path.join(noteA, 'files'));
});

test('TC-SP-05: legacy pages/ 吸収 → 親 <note>/images（load-bearing）', () => {
    const root = mkTmp();
    const noteC = path.join(root, 'noteC');
    fs.mkdirSync(path.join(noteC, 'pages'), { recursive: true });
    fs.mkdirSync(path.join(noteC, 'images'), { recursive: true }); // 共有 images は親にある
    // noteC/pages/images は作らない → 親遡上で noteC/images に吸収
    const md = path.join(noteC, 'pages', 'x.md');
    fs.writeFileSync(md, '# x');
    expect(resolveImagesDirForMd(md)).toBe(path.join(noteC, 'images'));
    // load-bearing: pages 親遡上を消すと noteC/pages/images（新 default）になり fail するはず
});

test('TC-SP-06: 相対整合（画像）→ images/img.png', () => {
    const root = mkTmp();
    const noteB = path.join(root, 'noteB');
    fs.mkdirSync(path.join(noteB, 'images'), { recursive: true });
    const md = path.join(noteB, 'y.md');
    fs.writeFileSync(md, '# y');
    const destPath = path.join(resolveImagesDirForMd(md), 'img.png');
    const rel = path.relative(path.dirname(md), destPath).replace(/\\/g, '/');
    expect(rel).toBe('images/img.png');
});

test('TC-SP-07: 相対整合（files）→ files/a.pdf', () => {
    const root = mkTmp();
    const noteB = path.join(root, 'noteB');
    fs.mkdirSync(path.join(noteB, 'files'), { recursive: true });
    const md = path.join(noteB, 'y.md');
    fs.writeFileSync(md, '# y');
    const destPath = path.join(resolveFilesDirForMd(md), 'a.pdf');
    const rel = path.relative(path.dirname(md), destPath).replace(/\\/g, '/');
    expect(rel).toBe('files/a.pdf');
});

test('TC-SP-10: 後方互換 — 自 note md が共有 <note>/images と一致', () => {
    const root = mkTmp();
    const noteA = path.join(root, 'noteA');
    fs.mkdirSync(path.join(noteA, 'images'), { recursive: true });
    const md = path.join(noteA, 'p.md');
    fs.writeFileSync(md, '# p');
    // 自 note のページ md も dirname(md)=noteA なので共有 <note>/images に一致（従来 getOutlinerImageDirPath と同じ）
    expect(resolveImagesDirForMd(md)).toBe(path.join(noteA, 'images'));
});
