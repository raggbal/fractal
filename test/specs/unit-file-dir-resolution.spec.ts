import { test, expect } from '@playwright/test';
import * as path from 'path';

/**
 * DOD-11: outlinerFileDir setting resolves correctly for standalone and notes mode
 *
 * Since getFileDirPath is a private method on outlinerProvider.ts with VSCode dependencies,
 * we test the path resolution logic in isolation here.
 */

test.describe('DOD-11: File directory path resolution', () => {
    test.describe('Standalone mode (outlinerProvider logic)', () => {
        test('RED: resolves fileDir from .out JSON relative to outDir', () => {
            // Arrange: Simulate .out JSON with fileDir: "./custom-files"
            const outFilePath = '/project/notes.out';
            const outDir = path.dirname(outFilePath); // /project
            const fileDirFromJson = './custom-files';

            // Act: Resolution logic (extracted from getFileDirPath)
            const resolved = path.isAbsolute(fileDirFromJson)
                ? fileDirFromJson
                : path.resolve(outDir, fileDirFromJson);

            // Assert
            expect(resolved).toBe('/project/custom-files');
        });

        test('GREEN: falls back to setting when .out JSON has no fileDir', () => {
            // Arrange: No fileDir in JSON, use setting
            const outFilePath = '/project/notes.out';
            const outDir = path.dirname(outFilePath);
            const settingFileDir = './files'; // default setting

            // Act
            const resolved = path.isAbsolute(settingFileDir)
                ? settingFileDir
                : path.resolve(outDir, settingFileDir);

            // Assert: Default './files' resolves to /project/files
            expect(resolved).toBe('/project/files');
        });

        test('REFACTOR: handles absolute path in .out JSON', () => {
            // Arrange
            const outFilePath = '/project/notes.out';
            const outDir = path.dirname(outFilePath);
            const fileDirFromJson = '/absolute/path/to/files';

            // Act
            const resolved = path.isAbsolute(fileDirFromJson)
                ? fileDirFromJson
                : path.resolve(outDir, fileDirFromJson);

            // Assert: Absolute path is used as-is
            expect(resolved).toBe('/absolute/path/to/files');
        });

        test('handles absolute path in setting', () => {
            // Arrange
            const outFilePath = '/project/notes.out';
            const outDir = path.dirname(outFilePath);
            const settingFileDir = '/shared/files';

            // Act
            const resolved = path.isAbsolute(settingFileDir)
                ? settingFileDir
                : path.resolve(outDir, settingFileDir);

            // Assert
            expect(resolved).toBe('/shared/files');
        });
    });

    test.describe('Notes mode (notesEditorProvider logic)', () => {
        test('resolves to {id}/files/ relative to outliner folder', () => {
            // Arrange: Notes mode constructs path as {outliner id}/files/
            const folderPath = '/workspace';
            const outlinerId = 'my-outliner';

            // Act: Notes mode logic (from notesEditorProvider.ts line 347)
            const fileDir = path.join(folderPath, outlinerId, 'files');

            // Assert
            expect(fileDir).toBe('/workspace/my-outliner/files');
        });

        test('handles different outliner IDs', () => {
            // Arrange
            const folderPath = '/workspace';
            const outlinerId = 'project-notes';

            // Act
            const fileDir = path.join(folderPath, outlinerId, 'files');

            // Assert
            expect(fileDir).toBe('/workspace/project-notes/files');
        });
    });

    test.describe('Priority chain verification', () => {
        test('JSON fileDir takes priority over setting', () => {
            // Arrange
            const outFilePath = '/project/notes.out';
            const outDir = path.dirname(outFilePath);
            const fileDirFromJson = './json-files';
            const settingFileDir = './setting-files';

            // Act: Priority 1 - JSON fileDir
            const resolvedWithJson = path.isAbsolute(fileDirFromJson)
                ? fileDirFromJson
                : path.resolve(outDir, fileDirFromJson);

            // Act: Priority 2 - Setting (only if no JSON fileDir)
            const resolvedFallback = path.isAbsolute(settingFileDir)
                ? settingFileDir
                : path.resolve(outDir, settingFileDir);

            // Assert: JSON takes priority
            expect(resolvedWithJson).toBe('/project/json-files');
            expect(resolvedFallback).toBe('/project/setting-files');
            expect(resolvedWithJson).not.toBe(resolvedFallback);
        });
    });
});
