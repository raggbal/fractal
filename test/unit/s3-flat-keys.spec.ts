/**
 * notes-flat-storage TASK-06 — S3 key 構造 + dirty flush 判定（フラット対応）
 *
 * TC-FS-30 key 構造がフラット（md=root 直下 + 共有 images/files、per-<id>/ を生成しない）
 * TC-FS-31 dirty flush 判定が新レイアウト（basedir 直下 md）を認識（stale upload 回避）
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import {
    computeSyncFolderPaths,
    computeTargetTextDocPaths,
    isTargetTextDoc,
} from '../../src/outliner-s3-sync-utils';

test('TC-FS-30 flat レイアウトの sync 範囲は共有 root（per-<id>/ prefix を作らない）', () => {
    const prefix = 'notes/'; // parseBucketPath 済みの prefix 相当
    // flat: pageDir="." → S3 は <prefix>、local は <localDir> root
    const flat = computeSyncFolderPaths('work', '/local/note', prefix, true);
    expect(flat.s3FolderPrefix).toBe('notes/');            // <prefix><id>/ を作らない
    expect(flat.localFolderPath).toBe('/local/note');      // root 全体
    // legacy: per-<id>/
    const legacy = computeSyncFolderPaths('work', '/local/note', prefix, false);
    expect(legacy.s3FolderPrefix).toBe('notes/work/');
    expect(legacy.localFolderPath).toBe(path.join('/local/note', 'work'));
});

test('TC-FS-31 dirty flush 判定が basedir 直下 md を認識（.out は除外）', () => {
    const targets = computeTargetTextDocPaths('work', '/local/note');
    // flat: <localDir>/<pageId>.md（root 直下）は flush 対象
    expect(isTargetTextDoc(path.join('/local/note', 'p1.md'), targets)).toBe(true);
    // 別 .out（outFilePath でない）は対象外（md でもない）
    expect(isTargetTextDoc(path.join('/local/note', 'other.out'), targets)).toBe(false);
    // legacy <id>/pages/*.md も引き続き対象（後方互換）
    expect(isTargetTextDoc(path.join('/local/note', 'work', 'pages', 'p1.md'), targets)).toBe(true);
    // サブディレクトリの md（共有でない深い階層）は root 直下でないので除外
    expect(isTargetTextDoc(path.join('/local/note', 'sub', 'deep.md'), targets)).toBe(false);
    // outFilePath 一致は true（.out 本体の flush）
    expect(isTargetTextDoc(targets.outFilePath, targets)).toBe(true);
});
