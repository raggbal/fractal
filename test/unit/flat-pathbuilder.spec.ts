/**
 * notes-flat-storage TASK-01 / TASK-08 — flat layout path resolution
 *
 * decision 2026-07-07: md（ページ）は basedir 直下、画像/添付は共有 images/・files/。
 *
 * TC-FS-01  新規ページは basedir 直下（<basedir>/<pageId>.md）
 * TC-FS-02  新規画像/添付は共有 <basedir>/images・<basedir>/files（Single Outliner 相当）
 * TC-FS-02b 同上（Notes provider 相当 = 同じ純ヘルパを使う）
 * TC-FS-03  legacy fallback: 旧 <basedir>/<basename>/ レイアウトを読む
 * TC-FS-04  新 wins: pageDir="." 指定で basedir 直下を優先
 * TC-FS-05  Notes-md も basedir 直下 + 共有 images/
 * TC-FS-24  共有 images/ で同名保存は unique 名で共存
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    resolvePagesDir,
    resolveImagesDir,
    resolveFilesDir,
    resolvePageFilePath,
} from '../../src/shared/flat-layout';
import { generateUniqueFileNamePreserving } from '../../src/shared/paste-asset-handler';

function mkTmp(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'flat-pb-'));
}

test('TC-FS-01 新規ページは basedir 直下に解決される', () => {
    const dir = mkTmp();
    const outFile = path.join(dir, 'memo.out');
    fs.writeFileSync(outFile, JSON.stringify({ title: 'memo', rootIds: [], nodes: {} }));
    // 新規 (legacy <basename>/ が存在しない) → basedir 直下
    expect(resolvePagesDir(outFile)).toBe(dir);
    expect(resolvePageFilePath(outFile, 'PID')).toBe(path.join(dir, 'PID.md'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-02 新規画像/添付は共有 images/ files/ に解決される', () => {
    const dir = mkTmp();
    const outFile = path.join(dir, 'memo.out');
    fs.writeFileSync(outFile, JSON.stringify({ title: 'memo', rootIds: [], nodes: {} }));
    expect(resolveImagesDir(outFile)).toBe(path.join(dir, 'images'));
    expect(resolveFilesDir(outFile)).toBe(path.join(dir, 'files'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-02b Notes provider 相当も同じヘルパで共有 dir に解決 (basedir=mainFolder)', () => {
    // Notes モードでは outFile が <mainFolder>/<name>.out。basedir=dirname(outFile)=mainFolder。
    const main = mkTmp();
    const outFile = path.join(main, 'daily.out');
    fs.writeFileSync(outFile, JSON.stringify({ title: 'daily', rootIds: [], nodes: {} }));
    expect(resolveImagesDir(outFile)).toBe(path.join(main, 'images'));
    expect(resolveFilesDir(outFile)).toBe(path.join(main, 'files'));
    expect(resolvePagesDir(outFile)).toBe(main);
    fs.rmSync(main, { recursive: true, force: true });
});

test('TC-FS-03 legacy fallback: 旧 <basename>/ レイアウトを移行せず読める', () => {
    const dir = mkTmp();
    const outFile = path.join(dir, 'memo.out');
    fs.writeFileSync(outFile, JSON.stringify({ title: 'memo', rootIds: [], nodes: {} }));
    // 旧レイアウト: <dir>/memo/<pageId>.md が存在（新 basedir 直下 md は無し）
    const legacyPagesDir = path.join(dir, 'memo');
    fs.mkdirSync(legacyPagesDir, { recursive: true });
    fs.writeFileSync(path.join(legacyPagesDir, 'p1.md'), '# legacy');
    fs.mkdirSync(path.join(legacyPagesDir, 'images'), { recursive: true });
    expect(resolvePagesDir(outFile)).toBe(legacyPagesDir);
    expect(resolveImagesDir(outFile)).toBe(path.join(legacyPagesDir, 'images'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-04 新 wins: pageDir="." 指定で basedir 直下を優先（legacy が併存しても）', () => {
    const dir = mkTmp();
    const outFile = path.join(dir, 'memo.out');
    // 新旧併存 + 移行済みマーカー pageDir="."
    fs.writeFileSync(outFile, JSON.stringify({ title: 'memo', pageDir: '.', imageDir: './images', fileDir: './files', rootIds: [], nodes: {} }));
    fs.mkdirSync(path.join(dir, 'memo'), { recursive: true }); // legacy dir も存在
    fs.writeFileSync(path.join(dir, 'PID.md'), '# new'); // 新 md も存在
    expect(resolvePagesDir(outFile)).toBe(dir); // basedir 直下（新）
    expect(resolveImagesDir(outFile)).toBe(path.join(dir, 'images'));
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-05 Notes-md も basedir 直下 + 共有 images/ (outFile 無しの純 md)', () => {
    // 純 Notes-md は outFile を持たない。mainFolder 直下 + 共有 images。
    const main = mkTmp();
    expect(resolvePagesDir(null, main)).toBe(main);
    expect(resolveImagesDir(null, main)).toBe(path.join(main, 'images'));
    expect(resolveFilesDir(null, main)).toBe(path.join(main, 'files'));
    fs.rmSync(main, { recursive: true, force: true });
});

test('TC-FS-42 pageDir="." hint がある flat .out は legacy dir 併存でも basedir 直下に解決（TASK-12）', () => {
    const dir = mkTmp();
    const outFile = path.join(dir, 'memo.out');
    // flat hint あり + legacy <basename>/ dir に .md が併存（部分移行 or hint 書換直後）
    fs.writeFileSync(outFile, JSON.stringify({ title: 'memo', pageDir: '.', rootIds: [], nodes: {} }));
    const legacyDir = path.join(dir, 'memo');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'old.md'), '# legacy');
    // hint 最優先 → basedir 直下（legacy に誤 fallback しない）
    expect(resolvePagesDir(outFile, undefined, { pageDir: '.' })).toBe(dir);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('TC-FS-24 共有 images/ で同名保存は unique 名で共存（上書きしない）', () => {
    const dir = mkTmp();
    const imagesDir = path.join(dir, 'images');
    fs.mkdirSync(imagesDir, { recursive: true });
    const n1 = generateUniqueFileNamePreserving(imagesDir, 'photo.png');
    fs.writeFileSync(path.join(imagesDir, n1), 'A');
    const n2 = generateUniqueFileNamePreserving(imagesDir, 'photo.png');
    fs.writeFileSync(path.join(imagesDir, n2), 'B');
    expect(n1).toBe('photo.png');
    expect(n2).not.toBe(n1); // 別名で共存
    expect(fs.readFileSync(path.join(imagesDir, n1), 'utf8')).toBe('A'); // 上書きなし
    expect(fs.readFileSync(path.join(imagesDir, n2), 'utf8')).toBe('B');
    fs.rmSync(dir, { recursive: true, force: true });
});
