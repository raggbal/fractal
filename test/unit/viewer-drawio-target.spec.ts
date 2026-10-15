/**
 * drawio kind の判定・viewType・customEditors 登録・インライン viewType マップ撤去
 * （sprint 20261009-130815-file-viewer-drawio / TASK-01 / FR-FV-01・FR-FV-16・FR-DIO-03）
 *
 * TC-DIO-01 / 02 / 03 / 04 / 08
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}

/** registerCustomEditorProvider の呼び出しを記録する vscode stub で require する */
function requireProviderWithRecorder(): { mod: any; registered: string[] } {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    const registered: string[] = [];
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                window: {
                    registerCustomEditorProvider: (viewType: string) => { registered.push(viewType); return { dispose() {} }; },
                },
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                env: {}, commands: { executeCommand: () => {} },
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        return { mod: require('../../src/fileViewerProvider'), registered };
    } finally { Module._load = origLoad; purgeSrcCache(); }
}

test.describe('drawio kind の判定', () => {
    test('TC-DIO-01: drawio 系 6 拡張子は drawio kind（大文字小文字・パス付きも）', () => {
        const { isViewerTarget } = require('../../src/shared/viewer-target');
        for (const name of ['a.drawio', 'a.dio', 'a.drawio.svg', 'a.dio.svg', 'a.drawio.png', 'a.dio.png',
            'A.DRAWIO.SVG', '/x/y/B.Dio.Png']) {
            expect(isViewerTarget(name), name).toBe('drawio');
        }
    });

    test('TC-DIO-02: 非 drawio は従来どおり（回帰番人）', () => {
        const { isViewerTarget } = require('../../src/shared/viewer-target');
        expect(isViewerTarget('p.svg')).toBe('image');
        expect(isViewerTarget('p.png')).toBe('image');
        expect(isViewerTarget('drawio.svg')).toBe('image');   // stem が空 = 複合拡張子ではない
        expect(isViewerTarget('.drawio')).toBeNull();          // basename そのもの
        expect(isViewerTarget('a.drawio.bak')).toBeNull();
        expect(isViewerTarget('a.xml')).toBe('text');
        expect(isViewerTarget('a.pdf')).toBe('pdf');
    });

    test('TC-DIO-03: viewerViewType(drawio) と未知 kind の throw', () => {
        const { viewerViewType } = require('../../src/shared/viewer-target');
        expect(viewerViewType('drawio')).toBe('fractal.fileViewerDrawio');
        expect(() => viewerViewType('nope')).toThrow();
    });
});

test.describe('drawio viewType の登録', () => {
    test('TC-DIO-04: customEditors は 6 パターン・priority option、provider も登録する', () => {
        const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
        const eds = pkg.contributes.customEditors.filter((e: any) => e.viewType === 'fractal.fileViewerDrawio');
        expect(eds).toHaveLength(1);
        const patterns = eds[0].selector.map((s: any) => s.filenamePattern).sort();
        expect(patterns).toEqual(['*.dio', '*.dio.png', '*.dio.svg', '*.drawio', '*.drawio.png', '*.drawio.svg']);
        expect(eds[0].priority).toBe('option');

        const { mod, registered } = requireProviderWithRecorder();
        mod.registerFileViewer({ subscriptions: { push() {} } });
        expect(registered.filter((v) => v === 'fractal.fileViewerDrawio')).toHaveLength(1);
    });

    test('TC-DIO-08: fileViewerHtml のリテラルは viewer-target.ts / fileViewerProvider.ts にしか無い', () => {
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
                const p = path.join(dir, ent.name);
                if (ent.isDirectory()) { walk(p); continue; }
                if (!/\.(ts|js|mjs)$/.test(ent.name)) { continue; }
                if (fs.readFileSync(p, 'utf8').includes("'fractal.fileViewerHtml'")) { hits.push(path.relative(ROOT, p)); }
            }
        };
        walk(path.join(ROOT, 'src'));
        expect(hits.sort()).toEqual(['src/fileViewerProvider.ts', 'src/shared/viewer-target.ts']);
        const ep = fs.readFileSync(path.join(ROOT, 'src', 'editorProvider.ts'), 'utf8');
        expect(ep).toMatch(/import\s*\{[^}]*\bviewerViewType\b[^}]*\}\s*from\s*'\.\/shared\/viewer-target'/);
        expect(ep).toMatch(/viewerViewType\(kind\)/);
    });
});
