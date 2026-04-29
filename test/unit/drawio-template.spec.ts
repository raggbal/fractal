/**
 * drawioTemplate unit tests
 *
 * - MXFILE_WITH_PLACEHOLDER に placeholder shape (mxCell id=2) が含まれる
 * - buildPlaceholderDrawioSvg() の出力が dual-format SVG（content 属性に mxfile を XML-escape して埋め込む）
 */

import { test, expect } from '@playwright/test';
import { MXFILE_EMPTY, MXFILE_WITH_PLACEHOLDER, buildDrawioSvg, buildPlaceholderDrawioSvg } from '../../src/shared/drawioTemplate';

test.describe('drawioTemplate', () => {
    test('MXFILE_EMPTY は mxCell id=0/1 のみ', () => {
        expect(MXFILE_EMPTY).toContain('<mxfile');
        expect(MXFILE_EMPTY).toContain('<mxCell id="0"/>');
        expect(MXFILE_EMPTY).toContain('<mxCell id="1" parent="0"/>');
        // placeholder shape は含まれない
        expect(MXFILE_EMPTY).not.toContain('id="2"');
    });

    test('MXFILE_WITH_PLACEHOLDER は placeholder rect (id=2) を含む', () => {
        expect(MXFILE_WITH_PLACEHOLDER).toContain('<mxfile');
        expect(MXFILE_WITH_PLACEHOLDER).toContain('<mxCell id="2"');
        expect(MXFILE_WITH_PLACEHOLDER).toContain('vertex="1"');
        expect(MXFILE_WITH_PLACEHOLDER).toContain('mxGeometry');
    });

    test('buildDrawioSvg は dual-format（content 属性に mxfile を XML-escape）', () => {
        const svg = buildDrawioSvg(MXFILE_WITH_PLACEHOLDER);
        expect(svg.startsWith('<?xml version="1.0"')).toBe(true);
        expect(svg).toContain('<svg');
        expect(svg).toContain('xmlns="http://www.w3.org/2000/svg"');
        expect(svg).toContain('content="');
        // content 内の < は &lt; にエスケープ
        expect(svg).toContain('&lt;mxfile');
        expect(svg).toContain('&lt;mxCell id=&quot;2&quot;');
        // placeholder visual 要素も出力される（drawio が読めない場合の fallback 描画）
        expect(svg).toContain('<rect');
        expect(svg).toContain('<text');
        expect(svg).toContain('empty diagram');
    });

    test('buildPlaceholderDrawioSvg は MXFILE_WITH_PLACEHOLDER を埋め込む', () => {
        const svg = buildPlaceholderDrawioSvg();
        expect(svg).toContain('&lt;mxCell id=&quot;2&quot;');
    });

    test('default size は 120x80', () => {
        const svg = buildPlaceholderDrawioSvg();
        expect(svg).toContain('width="120"');
        expect(svg).toContain('height="80"');
    });

    test('custom size を渡せる', () => {
        const svg = buildDrawioSvg(MXFILE_EMPTY, { width: 200, height: 150 });
        expect(svg).toContain('width="200"');
        expect(svg).toContain('height="150"');
    });
});
