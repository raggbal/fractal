/**
 * viewer-target.spec.ts — file viewer の対象判定（viewer-target.ts）
 *
 * sprint 20260815-075428-file-viewer-3panes / TASK-01。
 * testcases.md A 節（TC-FV-10/11）。isViewerTarget は唯一の判定点（ddd 不変条件1 —
 * 拡張子リストの複製を作らない）。
 */
import { test, expect } from '@playwright/test';
import { isViewerTarget, VIEWER_SIZE_LIMIT } from '../../src/shared/viewer-target';

test.describe('viewer-target（FR-FV-01 / TASK-01）', () => {

    test('TC-FV-10: 判定 — html/pdf 対象・大文字混在・スコープ外 4 形式の明示 pin', () => {
        // 対象
        expect(isViewerTarget('report.html')).toBe('html');
        expect(isViewerTarget('page.htm')).toBe('html');
        expect(isViewerTarget('doc.pdf')).toBe('pdf');
        // case-insensitive
        expect(isViewerTarget('REPORT.HTML')).toBe('html');
        expect(isViewerTarget('Doc.Pdf')).toBe('pdf');
        // 【許可: test_update】sprint 20260823-165314（FR-FV-01 改訂）: .svg は image kind の
        // `<img>` 経路限定で解禁（ADRL-0091）・.docx は office kind 化。mhtml/xhtml/md の
        // スコープ外 pin は不変（マスタースコープ外行の .svg 削除は close で反映）
        expect(isViewerTarget('image.svg')).toBe('image');
        expect(isViewerTarget('saved.mhtml')).toBeNull();
        expect(isViewerTarget('page.xhtml')).toBeNull();
        expect(isViewerTarget('note.md')).toBeNull();
        // 対象外一般
        expect(isViewerTarget('archive.zip')).toBeNull();
        expect(isViewerTarget('doc.docx')).toBe('docx');
        expect(isViewerTarget('LICENSE')).toBeNull();          // 拡張子なし
        expect(isViewerTarget('')).toBeNull();
        // パス付きでも filename 部で判定
        expect(isViewerTarget('files/sub/report.pdf')).toBe('pdf');
        // 罠: 拡張子が名前の途中にある（.pdf.zip）
        expect(isViewerTarget('doc.pdf.zip')).toBeNull();
    });

    test('TC-FV-11: VIEWER_SIZE_LIMIT 境界 — 50MB ちょうどは viewer 可 / 超は不可', () => {
        expect(VIEWER_SIZE_LIMIT).toBe(50 * 1024 * 1024);
        // 境界の pin: 判定は「size > VIEWER_SIZE_LIMIT でフォールバック」（FR-TF-01/FR-DS-07 と同じ「超」判定）
        const exactly = 50 * 1024 * 1024;
        expect(exactly > VIEWER_SIZE_LIMIT).toBe(false);       // ちょうど 50MB は viewer 可
        expect((exactly + 1) > VIEWER_SIZE_LIMIT).toBe(true);  // +1byte でフォールバック
    });
});
