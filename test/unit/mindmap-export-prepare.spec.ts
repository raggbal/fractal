/**
 * mindmap-export-prepare unit tests (sprint 20260701-122355-outliner-mindmap-mode)
 * TC-226 相当: host 側エクスポートの純粋部分 (payload→bytes + パス解決 + サニタイズ)。
 * vscode glue (SaveDialog/writeFile) は手動テスト US-009 に委譲 (reviewer 裁定)。
 */

import { test, expect } from '@playwright/test';
import * as path from 'path';
import { prepareExport, EXT_BY_FORMAT } from '../../src/shared/mindmap-export-prepare';

test.describe('prepareExport (TC-226 pure part)', () => {
    test('opml/markdown/svg → utf8 bytes', () => {
        const r = prepareExport({ type: 'exportMindmap', format: 'opml', payload: '<opml/>', suggestedName: 'map' }, '/base');
        expect(r).not.toBeNull();
        expect(Buffer.from(r!.bytes).toString('utf8')).toBe('<opml/>');
        expect(r!.defaultName).toBe('map.opml');
    });

    test('markdown ext is md', () => {
        expect(EXT_BY_FORMAT.markdown).toBe('md');
        const r = prepareExport({ type: 'exportMindmap', format: 'markdown', payload: '# Hi', suggestedName: 'doc' }, '/base');
        expect(r!.defaultName).toBe('doc.md');
        expect(Buffer.from(r!.bytes).toString('utf8')).toBe('# Hi');
    });

    test('png data URL → decoded binary bytes', () => {
        const pngB64 = Buffer.from('PNGDATA').toString('base64');
        const r = prepareExport({ type: 'exportMindmap', format: 'png', payload: 'data:image/png;base64,' + pngB64, suggestedName: 'pic' }, '/base');
        expect(Buffer.from(r!.bytes).toString('utf8')).toBe('PNGDATA'); // decoded back
        expect(r!.defaultName).toBe('pic.png');
    });

    test('png without data: prefix still decodes', () => {
        const b64 = Buffer.from('XY').toString('base64');
        const r = prepareExport({ type: 'exportMindmap', format: 'png', payload: b64 }, '/base');
        expect(Buffer.from(r!.bytes).toString('utf8')).toBe('XY');
    });

    test('unknown format → null', () => {
        const r = prepareExport({ type: 'exportMindmap', format: 'xml' as any, payload: 'x' }, '/base');
        expect(r).toBeNull();
    });

    test('suggestedName default is "mindmap"', () => {
        const r = prepareExport({ type: 'exportMindmap', format: 'svg', payload: '<svg/>' }, '/base');
        expect(r!.defaultName).toBe('mindmap.svg');
    });

    test('path separators in suggestedName are stripped (traversal guard)', () => {
        const r = prepareExport({ type: 'exportMindmap', format: 'opml', payload: 'x', suggestedName: '../../etc/passwd' }, '/base');
        // separators (/ and \) replaced with _ → single flat filename, no traversal
        expect(r!.defaultName).not.toContain('/');
        expect(r!.defaultName).not.toContain('\\');
        expect(r!.defaultName.endsWith('.opml')).toBe(true);
    });

    test('defaultPath resolves under baseDir (no escape)', () => {
        const base = path.resolve('/base/dir');
        const r = prepareExport({ type: 'exportMindmap', format: 'svg', payload: '<svg/>', suggestedName: 'x' }, base);
        expect(r!.defaultPath).toBe(path.join(base, 'x.svg'));
        // resolved path stays under baseDir
        expect(r!.defaultPath!.startsWith(base)).toBe(true);
    });

    test('empty baseDir → defaultPath null', () => {
        const r = prepareExport({ type: 'exportMindmap', format: 'svg', payload: '<svg/>', suggestedName: 'x' }, '');
        expect(r!.defaultPath).toBeNull();
    });
});
