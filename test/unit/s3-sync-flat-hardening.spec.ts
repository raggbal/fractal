/**
 * s3-sync-flat-hardening — S3 sync 監査で見つかった潜在バグ3件の修正検証。
 * sprint 20260721-025753-s3-sync-flat-hardening。
 *
 * BUG-1: s3Uri が `s3://` scheme を strip しない（二重スキーム）
 * BUG-2: .out parse 失敗時の isFlat フォールバックが legacy（取りこぼし側）
 * BUG-3: walkLocalDir が末尾スラッシュを補正せず relPath 欠落
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { s3Uri } from '../../src/notes-s3-sync';
import { walkLocalDir } from '../../src/s3-per-file-sync';
import { resolveIsFlatFromOut } from '../../src/outliner-s3-sync-utils';

const cfg = (bucketPath: string) => ({
    bucketPath, localPath: '/x', accessKeyId: '', secretAccessKey: '', region: 'us-east-1',
});

// TC-SF-01 (BUG-1): s3Uri が scheme 付き/無しで同一 URI（二重スキームにしない）
test('TC-SF-01 s3Uri は s3:// scheme を正規化（二重スキーム回避）', () => {
    expect(s3Uri(cfg('bucket/p'))).toBe('s3://bucket/p/');
    expect(s3Uri(cfg('s3://bucket/p'))).toBe('s3://bucket/p/');       // 二重スキームにならない
    expect(s3Uri(cfg('s3://bucket/p/'))).toBe('s3://bucket/p/');      // 末尾slash も正規化
    expect(s3Uri(cfg('  bucket/p  '))).toBe('s3://bucket/p/');        // trim
    expect(s3Uri(cfg('bucket'))).toBe('s3://bucket/');               // prefix 無し bucket のみ
});

// TC-SF-02 (BUG-3): walkLocalDir は末尾slash 有無で同一 relPath 集合
test('TC-SF-02 walkLocalDir は末尾slash 有無で同一 relPath', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3-walk-'));
    try {
        fs.writeFileSync(path.join(tmp, 'a.md'), 'A');
        fs.mkdirSync(path.join(tmp, 'images'));
        fs.writeFileSync(path.join(tmp, 'images', 'b.png'), 'B');
        const noSlash = Array.from(walkLocalDir(tmp).keys()).sort();
        const withSlash = Array.from(walkLocalDir(tmp + '/').keys()).sort();
        expect(noSlash).toEqual(['a.md', 'images/b.png']);
        expect(withSlash).toEqual(noSlash);   // 末尾slash でも一致
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// TC-SF-03 (BUG-3): 末尾slash 付きでも relPath 先頭が欠落しない
test('TC-SF-03 walkLocalDir の relPath が先頭欠落しない', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 's3-walk2-'));
    try {
        fs.writeFileSync(path.join(tmp, 'foo.md'), 'F');
        const keys = Array.from(walkLocalDir(tmp + '/').keys());
        expect(keys).toContain('foo.md');       // 'oo.md' 等に欠落しない
        expect(keys).not.toContain('oo.md');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// TC-SF-04 (BUG-2): .out parse 失敗時の isFlat フォールバックが flat（安全側）
test('TC-SF-04 resolveIsFlatFromOut: 正常判定 + parse 失敗は flat 既定', () => {
    // (a) 正常 flat .out（pageDir='.'）→ true
    expect(resolveIsFlatFromOut('/x.out', () => JSON.stringify({ pageDir: '.' }))).toBe(true);
    // (b) 正常 legacy .out（pageDir='<id>'）→ false
    expect(resolveIsFlatFromOut('/x.out', () => JSON.stringify({ pageDir: 'work123' }))).toBe(false);
    // (c) parse 失敗（不正 JSON）→ flat 既定 true（取りこぼし回避）
    expect(resolveIsFlatFromOut('/x.out', () => '{ this is not json')).toBe(true);
    // (d) 読み取り失敗（throw）→ flat 既定 true
    expect(resolveIsFlatFromOut('/x.out', () => { throw new Error('ENOENT'); })).toBe(true);
});
