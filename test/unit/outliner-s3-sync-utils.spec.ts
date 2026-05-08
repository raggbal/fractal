/**
 * outliner-toolbar-s3-sync 用 unit test (TC-U-01 〜 TC-U-03 + 一部)
 *
 * sprint: 20260508-112516-outliner-toolbar-s3-sync
 * 対応: testcases.md TC-U-01, TC-U-02, TC-U-03
 *
 * vscode 不依存の utils 関数を直接 require して assert する。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

// @ts-ignore - require TS module via ts-node or compiled output
const utils = require('../../src/outliner-s3-sync-utils');

test.describe('outliner-s3-sync-utils (TC-U-01 〜 TC-U-03)', () => {
    // ────────────────────────────────────────────────────────────
    // TC-U-01: ボタン表示条件判定 (s3BucketPathSet)
    // ────────────────────────────────────────────────────────────
    test('TC-U-01: isS3BucketPathSet returns false for empty/null/whitespace', () => {
        expect(utils.isS3BucketPathSet('')).toBe(false);
        expect(utils.isS3BucketPathSet(null)).toBe(false);
        expect(utils.isS3BucketPathSet(undefined)).toBe(false);
        expect(utils.isS3BucketPathSet('   ')).toBe(false);
        expect(utils.isS3BucketPathSet('\t\n  ')).toBe(false);
    });

    test('TC-U-01: isS3BucketPathSet returns true for valid bucket path', () => {
        expect(utils.isS3BucketPathSet('s3://my-bucket/notes')).toBe(true);
        expect(utils.isS3BucketPathSet('my-bucket/notes/')).toBe(true);
        expect(utils.isS3BucketPathSet('my-bucket')).toBe(true);
    });

    // ────────────────────────────────────────────────────────────
    // TC-U-02: target paths 計算
    // ────────────────────────────────────────────────────────────
    test('TC-U-02: computeTargetPaths returns outFilePath + folderPath with trailing sep', () => {
        const r = utils.computeTargetPaths('abc', '/home/user/notes');
        expect(r.outFilePath).toBe(path.join('/home/user/notes', 'abc.out'));
        expect(r.folderPath).toBe(path.join('/home/user/notes', 'abc') + path.sep);
        expect(r.folderPath.endsWith(path.sep)).toBe(true);
    });

    test('TC-U-02: computeTargetTextDocPaths returns outFilePath + pagesDir', () => {
        const r = utils.computeTargetTextDocPaths('abc', '/home/user/notes');
        expect(r.outFilePath).toBe(path.join('/home/user/notes', 'abc.out'));
        expect(r.pagesDir).toBe(path.join('/home/user/notes', 'abc', 'pages') + path.sep);
        expect(r.pagesDir.endsWith(path.sep)).toBe(true);
    });

    test('TC-U-02 / M15: isTargetTextDoc accepts .out and pages/*.md only', () => {
        const targets = utils.computeTargetTextDocPaths('abc', '/local');
        // .out 本体は対象
        expect(utils.isTargetTextDoc(path.join('/local', 'abc.out'), targets)).toBe(true);
        // pages/*.md は対象
        expect(utils.isTargetTextDoc(path.join('/local', 'abc', 'pages', 'foo.md'), targets)).toBe(true);
        // 別 outliner の .out は対象外
        expect(utils.isTargetTextDoc(path.join('/local', 'def.out'), targets)).toBe(false);
        // バイナリは対象外
        expect(utils.isTargetTextDoc(path.join('/local', 'abc', 'images', 'a.png'), targets)).toBe(false);
        // outline.note は対象外 (sync 範囲外)
        expect(utils.isTargetTextDoc(path.join('/local', 'outline.note'), targets)).toBe(false);
    });

    // ────────────────────────────────────────────────────────────
    // TC-U-03: aws cli 引数構築
    // ────────────────────────────────────────────────────────────
    test('TC-U-03: buildSyncCommandArgs - download phase uses default mtime comparison (no --exact-timestamps)', () => {
        const { folderUri: s3Folder, parentUri: s3Parent } = utils.normalizeBucketUri('my-bucket/notes', 'abc');
        const { folderPath: localFolder, parentPath: localParent } = utils.normalizeLocalUri('/local/notes', 'abc');
        const { downloadArgs } = utils.buildSyncCommandArgs({
            outlinerId: 'abc', s3Folder, s3Parent, localFolder, localParent,
        });
        expect(downloadArgs.length).toBe(2);
        // 1: folder sync, default 動作 (local newer なら skip = user 編集保護)
        expect(downloadArgs[0]).not.toContain('--exact-timestamps');
        expect(downloadArgs[0]).toContain('s3://my-bucket/notes/abc/');
        expect(downloadArgs[0]).toContain(path.join('/local/notes', 'abc') + path.sep);
        // 2: .out filter sync, default 動作 + --exclude '*' --include 'abc.out'
        expect(downloadArgs[1]).not.toContain('--exact-timestamps');
        expect(downloadArgs[1]).toContain('--exclude');
        expect(downloadArgs[1]).toContain('*');
        expect(downloadArgs[1]).toContain('--include');
        expect(downloadArgs[1]).toContain('abc.out');
    });

    test('TC-U-03: buildSyncCommandArgs - upload phase has NO --exact-timestamps (default mtime)', () => {
        const { folderUri: s3Folder, parentUri: s3Parent } = utils.normalizeBucketUri('my-bucket/notes', 'abc');
        const { folderPath: localFolder, parentPath: localParent } = utils.normalizeLocalUri('/local/notes', 'abc');
        const { uploadArgs } = utils.buildSyncCommandArgs({
            outlinerId: 'abc', s3Folder, s3Parent, localFolder, localParent,
        });
        expect(uploadArgs.length).toBe(2);
        // 1: folder upload, no --exact-timestamps
        expect(uploadArgs[0]).not.toContain('--exact-timestamps');
        expect(uploadArgs[0]).toContain('s3://my-bucket/notes/abc/');
        // 2: .out upload with filter, no --exact-timestamps
        expect(uploadArgs[1]).not.toContain('--exact-timestamps');
        expect(uploadArgs[1]).toContain('--include');
        expect(uploadArgs[1]).toContain('abc.out');
    });

    test('TC-U-03: buildSyncCommandArgs - --delete is NEVER included anywhere', () => {
        const { folderUri: s3Folder, parentUri: s3Parent } = utils.normalizeBucketUri('my-bucket/notes', 'abc');
        const { folderPath: localFolder, parentPath: localParent } = utils.normalizeLocalUri('/local/notes', 'abc');
        const { downloadArgs, uploadArgs } = utils.buildSyncCommandArgs({
            outlinerId: 'abc', s3Folder, s3Parent, localFolder, localParent,
        });
        for (const args of [...downloadArgs, ...uploadArgs]) {
            expect(args).not.toContain('--delete');
        }
    });

    test('TC-U-03: buildSyncCommandArgs - bucket URI normalization (s3:// prefix optional, trailing slash)', () => {
        // s3:// 有り
        const r1 = utils.normalizeBucketUri('s3://my-bucket/notes/', 'abc');
        expect(r1.folderUri).toBe('s3://my-bucket/notes/abc/');
        expect(r1.parentUri).toBe('s3://my-bucket/notes/');
        // s3:// 無し
        const r2 = utils.normalizeBucketUri('my-bucket/notes', 'abc');
        expect(r2.folderUri).toBe('s3://my-bucket/notes/abc/');
        expect(r2.parentUri).toBe('s3://my-bucket/notes/');
        // 余白
        const r3 = utils.normalizeBucketUri('  my-bucket/notes//  ', 'abc');
        expect(r3.folderUri).toBe('s3://my-bucket/notes/abc/');
    });

    // ────────────────────────────────────────────────────────────
    // TC-U-05 part: pathBelongsToSyncingOutliner (helper の path 判定)
    // ────────────────────────────────────────────────────────────
    test('TC-U-05: pathBelongsToSyncingOutliner - <id>.out and <id>/** match, others do not', () => {
        const folderPath = '/local';
        const ids = new Set(['abc']);
        // <id>.out
        expect(utils.pathBelongsToSyncingOutliner('/local/abc.out', folderPath, ids)).toBe(true);
        // <id>/pages/*.md
        expect(utils.pathBelongsToSyncingOutliner('/local/abc/pages/x.md', folderPath, ids)).toBe(true);
        // <id>/images/*.png
        expect(utils.pathBelongsToSyncingOutliner('/local/abc/images/a.png', folderPath, ids)).toBe(true);
        // 別 id の .out は false
        expect(utils.pathBelongsToSyncingOutliner('/local/def.out', folderPath, ids)).toBe(false);
        // 別 id の フォルダ配下も false
        expect(utils.pathBelongsToSyncingOutliner('/local/def/pages/x.md', folderPath, ids)).toBe(false);
        // outline.note は false (sync 範囲外)
        expect(utils.pathBelongsToSyncingOutliner('/local/outline.note', folderPath, ids)).toBe(false);
    });

    test('TC-U-05: pathBelongsToSyncingOutliner - empty ids returns false for any path', () => {
        const ids = new Set<string>();
        expect(utils.pathBelongsToSyncingOutliner('/local/abc.out', '/local', ids)).toBe(false);
    });

    // ────────────────────────────────────────────────────────────
    // TC-U-06: decideSyncDirection (true newer-wins、tolerance window)
    // ────────────────────────────────────────────────────────────
    test('TC-U-06: both null → skip', () => {
        expect(utils.decideSyncDirection(null, null)).toBe('skip');
    });

    test('TC-U-06: only S3 exists → download', () => {
        expect(utils.decideSyncDirection({ mtime: new Date(), size: 100 }, null)).toBe('download');
    });

    test('TC-U-06: only local exists → upload', () => {
        expect(utils.decideSyncDirection(null, { mtime: new Date(), size: 100 })).toBe('upload');
    });

    test('TC-U-06: S3 newer (well outside tolerance) → download', () => {
        const s3 = { mtime: new Date('2026-05-08T10:00:00Z'), size: 100 };
        const local = { mtime: new Date('2026-05-08T09:00:00Z'), size: 200 };  // size 違っても mtime で判定
        expect(utils.decideSyncDirection(s3, local)).toBe('download');
    });

    test('TC-U-06: local newer (well outside tolerance) → upload', () => {
        const s3 = { mtime: new Date('2026-05-08T09:00:00Z'), size: 100 };
        const local = { mtime: new Date('2026-05-08T10:00:00Z'), size: 50 };
        expect(utils.decideSyncDirection(s3, local)).toBe('upload');
    });

    test('TC-U-06: within tolerance window AND size match → skip', () => {
        const t = new Date('2026-05-08T10:00:00Z').getTime();
        const s3 = { mtime: new Date(t), size: 100 };
        const local = { mtime: new Date(t + 3000), size: 100 };  // 3 秒差、size 同じ
        expect(utils.decideSyncDirection(s3, local, 5)).toBe('skip');
    });

    test('TC-U-06: size differs (with mtime within tolerance) → newer-wins (skip しない)', () => {
        const t = new Date('2026-05-08T10:00:00Z').getTime();
        const s3 = { mtime: new Date(t + 3000), size: 100 };  // S3 が 3 秒後、size 違う
        const local = { mtime: new Date(t), size: 200 };
        // size 違う → tolerance 無視で newer-wins
        expect(utils.decideSyncDirection(s3, local, 5)).toBe('download');
    });

    test('TC-U-06: just outside tolerance → newer wins', () => {
        const t = new Date('2026-05-08T10:00:00Z').getTime();
        const s3 = { mtime: new Date(t), size: 100 };
        const localNewer = { mtime: new Date(t + 6000), size: 100 };  // 6 秒差
        expect(utils.decideSyncDirection(s3, localNewer, 5)).toBe('upload');
    });

    test('TC-U-06: bug regression - 別マシンで size 違いの新しい編集 → 古い local が上書きしない', () => {
        // Android が新しく編集 (S3 size 200, mtime 11:00)
        // Desktop は古いまま (local size 150, mtime 10:00)
        // 期待: download (Android の編集を取り込む) — 古い local で S3 を上書きしない
        const s3 = { mtime: new Date('2026-05-08T11:00:00Z'), size: 200 };
        const local = { mtime: new Date('2026-05-08T10:00:00Z'), size: 150 };
        expect(utils.decideSyncDirection(s3, local)).toBe('download');
    });

    // ────────────────────────────────────────────────────────────
    // TC-U-07: parseBucketPath
    // ────────────────────────────────────────────────────────────
    test('TC-U-07: parseBucketPath - bucket only', () => {
        const r = utils.parseBucketPath('my-bucket');
        expect(r.bucket).toBe('my-bucket');
        expect(r.prefix).toBe('');
    });

    test('TC-U-07: parseBucketPath - bucket + prefix', () => {
        const r = utils.parseBucketPath('my-bucket/notes');
        expect(r.bucket).toBe('my-bucket');
        expect(r.prefix).toBe('notes/');
    });

    test('TC-U-07: parseBucketPath - s3:// prefix stripped', () => {
        const r = utils.parseBucketPath('s3://my-bucket/notes/path');
        expect(r.bucket).toBe('my-bucket');
        expect(r.prefix).toBe('notes/path/');
    });

    test('TC-U-07: parseBucketPath - trailing slash and whitespace', () => {
        const r = utils.parseBucketPath('  my-bucket/notes//  ');
        expect(r.bucket).toBe('my-bucket');
        expect(r.prefix).toBe('notes/');
    });
});
