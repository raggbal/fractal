/**
 * aws-translate code-block protection unit tests (sprint 20260510-140531)
 *
 * - TC-NEW-01: splitProtectedSegments が code block 等を preserve segment にする
 * - TC-NEW-02: translate / preserve segment の往復で code block が AWS に送られない
 *   (translateChunk は private なので、splitProtectedSegments の output を用いて
 *    segment 列の正しさで validate)
 */

import { test, expect } from '@playwright/test';
import { splitProtectedSegments } from '../../src/shared/aws-translate';

test.describe('aws-translate / splitProtectedSegments (FR-TR-04)', () => {
    test('TC-NEW-01a: fenced code block を preserve segment にする', () => {
        const text = 'hello\n```python\ncode\n```\nworld';
        const segments = splitProtectedSegments(text);
        expect(segments).toHaveLength(3);
        expect(segments[0]).toEqual({ type: 'translate', content: 'hello\n' });
        expect(segments[1]).toEqual({ type: 'preserve', content: '```python\ncode\n```' });
        expect(segments[2]).toEqual({ type: 'translate', content: '\nworld' });
    });

    test('TC-NEW-01b: inline code を preserve segment にする', () => {
        const text = 'use `npm install` to install';
        const segments = splitProtectedSegments(text);
        expect(segments).toHaveLength(3);
        expect(segments[0]).toEqual({ type: 'translate', content: 'use ' });
        expect(segments[1]).toEqual({ type: 'preserve', content: '`npm install`' });
        expect(segments[2]).toEqual({ type: 'translate', content: ' to install' });
    });

    test('TC-NEW-01c: block math を preserve segment にする', () => {
        const text = 'before\n$$\nx = 1\n$$\nafter';
        const segments = splitProtectedSegments(text);
        const preserve = segments.find((s) => s.type === 'preserve');
        expect(preserve).toBeDefined();
        expect(preserve!.content).toBe('$$\nx = 1\n$$');
    });

    test('TC-NEW-01d: HTML comment を preserve segment にする', () => {
        const text = 'visible <!-- hidden --> text';
        const segments = splitProtectedSegments(text);
        const preserve = segments.find((s) => s.type === 'preserve');
        expect(preserve).toBeDefined();
        expect(preserve!.content).toBe('<!-- hidden -->');
    });

    test('TC-NEW-01e: code block なし text は 1 つの translate segment', () => {
        const text = 'just plain text without any code';
        const segments = splitProtectedSegments(text);
        expect(segments).toHaveLength(1);
        expect(segments[0]).toEqual({ type: 'translate', content: 'just plain text without any code' });
    });

    test('TC-NEW-01f: 複数 code block を順番に保護', () => {
        const text = 'a `x` b `y` c';
        const segments = splitProtectedSegments(text);
        expect(segments).toHaveLength(5);
        expect(segments[0].content).toBe('a ');
        expect(segments[1]).toEqual({ type: 'preserve', content: '`x`' });
        expect(segments[2].content).toBe(' b ');
        expect(segments[3]).toEqual({ type: 'preserve', content: '`y`' });
        expect(segments[4].content).toBe(' c');
    });

    test('TC-NEW-01g: 言語タグ付き fenced を保護', () => {
        const text = '```javascript\nconst x = 1;\n```';
        const segments = splitProtectedSegments(text);
        expect(segments).toHaveLength(1);
        expect(segments[0]).toEqual({ type: 'preserve', content: '```javascript\nconst x = 1;\n```' });
    });

    test('TC-NEW-02: segment 列を join すると元 text 復元 (情報無欠)', () => {
        const text = 'hello\n```py\ncode\n```\nuse `console.log`\n$$x=1$$\n<!-- todo -->\nend';
        const segments = splitProtectedSegments(text);
        const reconstructed = segments.map((s) => s.content).join('');
        expect(reconstructed).toBe(text);
    });

    test('TC-NEW-02b: AWS に送るのは translate segment のみ (preserve は素通り)', () => {
        const text = 'hello\n```\nsecret_api_key = "abc123"\n```\nworld';
        const segments = splitProtectedSegments(text);
        const sentToAws = segments.filter((s) => s.type === 'translate').map((s) => s.content);
        // code block の中身は AWS に送られる候補 list に含まれない
        expect(sentToAws.join('')).not.toContain('secret_api_key');
        expect(sentToAws.join('')).not.toContain('abc123');
        // 周辺の翻訳対象 text のみ含まれる
        expect(sentToAws.join('')).toContain('hello');
        expect(sentToAws.join('')).toContain('world');
    });
});
