/**
 * outliner-s3-sync-utils 用 unit test
 *
 * 左サイドパネル sync (notes-s3-sync.ts / s3-per-file-sync.ts) が使う
 * vscode 不依存の pure 関数を直接 require して assert する。
 */
import { test, expect } from '@playwright/test';

// @ts-ignore - require TS module via ts-node or compiled output
const utils = require('../../src/outliner-s3-sync-utils');

test.describe('outliner-s3-sync-utils', () => {
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
