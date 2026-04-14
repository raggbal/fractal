/**
 * TOC Extraction Unit Tests
 *
 * Tests for extractToc() function (T-1.7)
 * - DOD-TOC-1: TOC displays all heading levels h1-h6
 * - DOD-TOC-2: TOC handles non-hierarchical heading structures
 */

import { test, expect } from '@playwright/test';
import { extractToc } from '../../src/shared/toc-utils';

test.describe('extractToc', () => {
    test('should extract all heading levels h1-h6', () => {
        const markdown = `# H1
## H2
### H3
#### H4
##### H5
###### H6`;

        const toc = extractToc(markdown);

        expect(toc).toHaveLength(6);
        expect(toc[0]).toEqual({ level: 1, text: 'H1', anchor: 'h1' });
        expect(toc[1]).toEqual({ level: 2, text: 'H2', anchor: 'h2' });
        expect(toc[2]).toEqual({ level: 3, text: 'H3', anchor: 'h3' });
        expect(toc[3]).toEqual({ level: 4, text: 'H4', anchor: 'h4' });
        expect(toc[4]).toEqual({ level: 5, text: 'H5', anchor: 'h5' });
        expect(toc[5]).toEqual({ level: 6, text: 'H6', anchor: 'h6' });
    });

    test('should handle non-hierarchical structure (h1 then h3)', () => {
        const markdown = `# Title
### Subsection A
### Subsection B`;

        const toc = extractToc(markdown);

        expect(toc).toHaveLength(3);
        expect(toc[0]).toEqual({ level: 1, text: 'Title', anchor: 'title' });
        expect(toc[1]).toEqual({ level: 3, text: 'Subsection A', anchor: 'subsection-a' });
        expect(toc[2]).toEqual({ level: 3, text: 'Subsection B', anchor: 'subsection-b' });
    });

    test('should extract h1 and h2 (regression test)', () => {
        const markdown = `# Main Title
## Section 1
## Section 2`;

        const toc = extractToc(markdown);

        expect(toc).toHaveLength(3);
        expect(toc[0].level).toBe(1);
        expect(toc[1].level).toBe(2);
        expect(toc[2].level).toBe(2);
    });

    test('should skip code blocks', () => {
        const markdown = `# Real Heading
\`\`\`markdown
# Code block heading (should be ignored)
\`\`\`
## Another Real Heading`;

        const toc = extractToc(markdown);

        expect(toc).toHaveLength(2);
        expect(toc[0].text).toBe('Real Heading');
        expect(toc[1].text).toBe('Another Real Heading');
    });

    test('should generate correct anchors for CJK text', () => {
        const markdown = `# 日本語の見出し
## タイトル`;

        const toc = extractToc(markdown);

        expect(toc).toHaveLength(2);
        expect(toc[0].anchor).toBe('日本語の見出し');
        expect(toc[1].anchor).toBe('タイトル');
    });
});
