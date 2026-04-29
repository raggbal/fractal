/**
 * buildUniqueDrawioName tests (TC-03 / TC-09)
 *
 * 多重拡張子（.drawio.svg / .drawio.png）対応の suffix 付与:
 *   foo.drawio.svg + 既存 → foo-1.drawio.svg
 *   （NG: foo.drawio-1.svg）
 */

import { test, expect } from '@playwright/test';
import { buildUniqueDrawioName } from '../../src/shared/drawioTemplate';

test.describe('buildUniqueDrawioName multi-extension suffix', () => {
    test('TC-03: foo.drawio.svg 衝突 → foo-1.drawio.svg', () => {
        const taken = new Set(['foo.drawio.svg']);
        const result = buildUniqueDrawioName('foo.drawio.svg', (n) => taken.has(n));
        expect(result).toBe('foo-1.drawio.svg');
    });

    test('foo.drawio.svg 連続衝突 → foo-2.drawio.svg', () => {
        const taken = new Set(['foo.drawio.svg', 'foo-1.drawio.svg']);
        const result = buildUniqueDrawioName('foo.drawio.svg', (n) => taken.has(n));
        expect(result).toBe('foo-2.drawio.svg');
    });

    test('未衝突 → 元名そのまま', () => {
        const taken = new Set<string>();
        const result = buildUniqueDrawioName('clean.drawio.svg', (n) => taken.has(n));
        expect(result).toBe('clean.drawio.svg');
    });

    test('drawio.png 多重拡張子も同様', () => {
        const taken = new Set(['x.drawio.png']);
        const result = buildUniqueDrawioName('x.drawio.png', (n) => taken.has(n));
        expect(result).toBe('x-1.drawio.png');
    });

    test('単一拡張子 (foo.svg) は通常 suffix', () => {
        const taken = new Set(['foo.svg']);
        const result = buildUniqueDrawioName('foo.svg', (n) => taken.has(n));
        expect(result).toBe('foo-1.svg');
    });

    test('拡張子なしも動作', () => {
        const taken = new Set(['noext']);
        const result = buildUniqueDrawioName('noext', (n) => taken.has(n));
        expect(result).toBe('noext-1');
    });

    test('TC-09 (Cmd+/ 衝突): mychart.drawio.svg → mychart-1.drawio.svg', () => {
        const taken = new Set(['mychart.drawio.svg']);
        const result = buildUniqueDrawioName('mychart.drawio.svg', (n) => taken.has(n));
        expect(result).toBe('mychart-1.drawio.svg');
    });
});
