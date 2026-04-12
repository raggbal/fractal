/**
 * File Directory Manager Unit Tests (v8)
 * - DOD-15: FILE_DIR and FORCE_RELATIVE_FILE_PATH directives extracted from MD footer
 * - DOD-16: FileDirectoryManager resolves file directory with correct priority chain
 * - DOD-17: removeAllDirectives strips FILE_DIR and FORCE_RELATIVE_FILE_PATH
 */

import { test, expect } from '@playwright/test';
import { extractFileDir, extractForceRelativeFilePath, removeAllDirectives } from '../../src/shared/markdown-directives';

test.describe('DOD-15: extractFileDir — extract FILE_DIR directive from markdown', () => {
    test('RED: extracts FILE_DIR from standalone directive block', () => {
        const content = `# Test Doc

Some content here.

---
FILE_DIR: ./files`;

        const result = extractFileDir(content);
        expect(result).toBe('./files');
    });

    test('GREEN: extracts FILE_DIR from combined directive block', () => {
        const content = `# Test Doc

---
IMAGE_DIR: ./images
FILE_DIR: ./attachments
FORCE_RELATIVE_PATH: true`;

        const result = extractFileDir(content);
        expect(result).toBe('./attachments');
    });

    test('REFACTOR: returns null when FILE_DIR not present', () => {
        const content = `# Test Doc

---
IMAGE_DIR: ./images`;

        const result = extractFileDir(content);
        expect(result).toBeNull();
    });

    test('handles FILE_DIR with absolute path', () => {
        const content = `# Test

---
FILE_DIR: /Users/test/files`;

        const result = extractFileDir(content);
        expect(result).toBe('/Users/test/files');
    });

    test('trims whitespace from FILE_DIR value', () => {
        const content = `---
FILE_DIR:   ./files  `;

        const result = extractFileDir(content);
        expect(result).toBe('./files');
    });
});

test.describe('DOD-15: extractForceRelativeFilePath — extract FORCE_RELATIVE_FILE_PATH directive', () => {
    test('RED: extracts FORCE_RELATIVE_FILE_PATH: true', () => {
        const content = `# Test

---
FORCE_RELATIVE_FILE_PATH: true`;

        const result = extractForceRelativeFilePath(content);
        expect(result).toBe(true);
    });

    test('GREEN: extracts FORCE_RELATIVE_FILE_PATH: false', () => {
        const content = `---
FILE_DIR: ./files
FORCE_RELATIVE_FILE_PATH: false`;

        const result = extractForceRelativeFilePath(content);
        expect(result).toBe(false);
    });

    test('REFACTOR: returns null when not present', () => {
        const content = `# Test

---
FILE_DIR: ./files`;

        const result = extractForceRelativeFilePath(content);
        expect(result).toBeNull();
    });

    test('case-insensitive matching', () => {
        const content = `---
FORCE_RELATIVE_FILE_PATH: TRUE`;

        const result = extractForceRelativeFilePath(content);
        expect(result).toBe(true);
    });

    test('handles combined directive block', () => {
        const content = `---
IMAGE_DIR: ./images
FILE_DIR: ./files
FORCE_RELATIVE_PATH: true
FORCE_RELATIVE_FILE_PATH: false`;

        const result = extractForceRelativeFilePath(content);
        expect(result).toBe(false);
    });
});

test.describe('DOD-17: removeAllDirectives — strips all 4 directive types', () => {
    test('RED: removes FILE_DIR standalone directive', () => {
        const content = `# Test Doc

Some content.

---
FILE_DIR: ./files`;

        const result = removeAllDirectives(content);
        expect(result).toBe(`# Test Doc

Some content.
`);
    });

    test('GREEN: removes FORCE_RELATIVE_FILE_PATH standalone directive', () => {
        const content = `# Test

Content

---
FORCE_RELATIVE_FILE_PATH: true`;

        const result = removeAllDirectives(content);
        expect(result).toBe(`# Test

Content
`);
    });

    test('REFACTOR: removes all 4 directives from combined block', () => {
        const content = `# Document

Main content here.

---
IMAGE_DIR: ./images
FORCE_RELATIVE_PATH: true
FILE_DIR: ./files
FORCE_RELATIVE_FILE_PATH: false`;

        const result = removeAllDirectives(content);
        expect(result).toBe(`# Document

Main content here.
`);
    });

    test('preserves content when no directives present', () => {
        const content = `# Clean Document

No directives here.`;

        const result = removeAllDirectives(content);
        expect(result).toBe(content);
    });

    test('handles IMAGE_DIR + FILE_DIR combination', () => {
        const content = `# Test

---
IMAGE_DIR: ./img
FILE_DIR: ./docs`;

        const result = removeAllDirectives(content);
        expect(result).toBe(`# Test
`);
    });

    test('removes directives but preserves other content blocks', () => {
        const content = `# Doc

Code:
\`\`\`
---
FILE_DIR: fake
\`\`\`

---
FILE_DIR: ./real`;

        const result = removeAllDirectives(content);
        // Should preserve code block, remove actual directive
        expect(result).toContain('```');
        expect(result).not.toContain('FILE_DIR: ./real');
        expect(result).toContain('FILE_DIR: fake'); // Inside code block
    });
});

test.describe('DOD-16: FileDirectoryManager priority chain (conceptual test)', () => {
    // Note: FileDirectoryManager is not exported, so we test the directive extraction
    // which forms the basis of the priority chain. Full priority testing would require
    // integration tests with VS Code settings mock.

    test('directive extraction forms basis for priority: directive > setting > default', () => {
        const withDirective = `---
FILE_DIR: ./from-directive`;
        const withoutDirective = `# No directive`;

        const result1 = extractFileDir(withDirective);
        const result2 = extractFileDir(withoutDirective);

        expect(result1).toBe('./from-directive');
        expect(result2).toBeNull(); // Falls back to settings/default
    });

    test('FORCE_RELATIVE_FILE_PATH directive takes priority', () => {
        const content = `---
FORCE_RELATIVE_FILE_PATH: true`;

        const result = extractForceRelativeFilePath(content);
        expect(result).toBe(true); // Would override VS Code setting
    });
});
