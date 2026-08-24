/**
 * viewer-kinds.spec.ts — viewer 対象判定の 3 群拡張（FR-FV-01 改訂）+ viewType 明示マップ（FR-FV-16 / ADRL-0093）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-02。
 *  - TC-VEX-01: isViewerTarget 3 群（text/image/office）+ 対象外 null + case-insensitive
 *  - TC-VEX-02: viewerViewType 明示マップ + 未知 kind throw（旧「fileViewerHtml へ寄せる」既定の廃止 counterfactual）
 */
import { test, expect } from '@playwright/test';
import { isViewerTarget, viewerViewType } from '../../src/shared/viewer-target';

test.describe('TC-VEX-01: isViewerTarget 3 群拡張', () => {
    test('既存 kind 不変（pdf/html）', () => {
        expect(isViewerTarget('a.pdf')).toBe('pdf');
        expect(isViewerTarget('a.html')).toBe('html');
        expect(isViewerTarget('a.htm')).toBe('html');
    });
    test('text 群', () => {
        for (const f of ['a.txt', 'b.log', 'c.json', 'd.xml', 'e.yaml', 'f.yml', 'g.csv', 'h.tsv', 'i.js', 'j.ts', 'k.py', 'l.sh', 'm.sql', 'n.ini', 'o.toml', 'p.conf', 'q.jsonl', 'r.mjs', 's.tsx', 't.go', 'u.rs', 'v.java', 'w.c', 'x.cpp', 'y.rb', 'z.cs']) {
            expect(isViewerTarget(f), f).toBe('text');
        }
    });
    test('image 群（svg 含む — ADRL-0091）', () => {
        for (const f of ['a.png', 'b.jpg', 'c.jpeg', 'd.gif', 'e.webp', 'f.avif', 'g.bmp', 'h.ico', 'i.svg']) {
            expect(isViewerTarget(f), f).toBe('image');
        }
    });
    test('office 群', () => {
        expect(isViewerTarget('a.docx')).toBe('docx');
        expect(isViewerTarget('b.xlsx')).toBe('xlsx');
        expect(isViewerTarget('c.pptx')).toBe('pptx');
    });
    test('対象外は null（.md は md editor の領分 / macro 系・OLE2・zip はスコープ外）', () => {
        for (const f of ['a.md', 'a.markdown', 'a.zip', 'a.docm', 'a.xlsm', 'a.pptm', 'a.doc', 'a.xls', 'a.ppt', 'a.mhtml', 'a.xhtml', 'a.out', 'noext', 'a.']) {
            expect(isViewerTarget(f), f).toBeNull();
        }
    });
    test('case-insensitive + パス付き', () => {
        expect(isViewerTarget('/x/y/REPORT.XLSX')).toBe('xlsx');
        expect(isViewerTarget('Photo.PNG')).toBe('image');
        expect(isViewerTarget('NOTES.TXT')).toBe('text');
    });
});

test.describe('TC-VEX-02: viewerViewType 明示マップ + 未知 kind throw', () => {
    test('7 kind → 5 viewType', () => {
        expect(viewerViewType('pdf')).toBe('fractal.fileViewer');
        expect(viewerViewType('html')).toBe('fractal.fileViewerHtml');
        expect(viewerViewType('docx')).toBe('fractal.fileViewerOffice');
        expect(viewerViewType('xlsx')).toBe('fractal.fileViewerOffice');
        expect(viewerViewType('pptx')).toBe('fractal.fileViewerOffice');
        expect(viewerViewType('text')).toBe('fractal.fileViewerText');
        expect(viewerViewType('image')).toBe('fractal.fileViewerImage');
    });
    test('未知 kind は throw（旧既定 fileViewerHtml が返らない — counterfactual）', () => {
        expect(() => viewerViewType(undefined as any)).toThrow();
        expect(() => viewerViewType(null as any)).toThrow();
        expect(() => viewerViewType('bogus' as any)).toThrow();
    });
});
