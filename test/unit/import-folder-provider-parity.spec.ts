/**
 * TASK-21 — `importFolderResult` の payload 契約（両 provider で同一）
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-OIF-05 配線 / TC-OIF-19）
 *
 * closure 判定は **host 側でしか算出できない**（webview は外部フォルダの md 本文を読めない）ため、
 * closure 除外済みの node 木を `importFolderResult.entries` に載せる。
 * **両 provider が同じ関数（`runFolderImport` / `runFolderImportWithDialog`）を通す**ことが
 * 「面ごとに挙動が割れない」ことの担保なので、そこを機械的に固定する。
 *
 * 🔴 counterfactual: 片方の provider が `outcome.entries` ではなく生の walk 結果
 * （`walkFolderForImport` の戻り）を渡すようにすると「同じ node 木」が崩れて RED。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { makeImportFolderFixture, makeDestNote } from '../utils/fixture-import-folder';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const fi = require('../../src/shared/folder-import');

const REPO = path.join(__dirname, '..', '..');

/** entries 木を平坦化して `<path>/<kind>:<name>` の一覧にする（順序込みで比較する）。 */
function flatten(entries: any[], prefix = ''): string[] {
    const out: string[] = [];
    for (const e of entries) {
        out.push(`${prefix}${e.kind}:${e.name}`);
        if (e.kind === 'dir') { out.push(...flatten(e.children, `${prefix}${e.name}/`)); }
    }
    return out;
}

/** provider が渡す dir 群を模して runFolderImport を回す。 */
async function runAs(target: string, destDir: string, dirs: { pageDir: string; imageDir: string; fileDir: string }) {
    return fi.runFolderImport({
        pickFolder: () => target,
        confirmLarge: () => true,
        notifyLimitExceeded: () => { /* noop */ },
        notifySkipped: () => { /* noop */ },
        pageDir: dirs.pageDir,
        imageDir: dirs.imageDir,
        fileDir: dirs.fileDir,
        outDir: destDir,
    });
}

test.describe('TC-OIF-19 両 provider で同一の node 木', () => {
    test('Notes 面 / Outliner 面の dir 構成の違いが node 木に影響しない', async () => {
        const fx = makeImportFolderFixture('basic');
        const destNotes = makeDestNote();
        const destOut = makeDestNote();
        try {
            // Notes 面: fileManager.getPagesDirPath() / getOutlinerImageDirPath() / getOutlinerFileDirPath()
            const notes = await runAs(fx.target, destNotes.dir, {
                pageDir: path.join(destNotes.dir, 'pages'),
                imageDir: path.join(destNotes.dir, 'images'),
                fileDir: path.join(destNotes.dir, 'files'),
            });
            // Outliner 面: imageDir が pageDir/images になる（outlinerProvider.ts の実装差）
            const outliner = await runAs(fx.target, destOut.dir, {
                pageDir: path.join(destOut.dir, 'pages'),
                imageDir: path.join(destOut.dir, 'pages', 'images'),
                fileDir: path.join(destOut.dir, 'files'),
            });

            expect(notes.status, 'Notes 面の import が失敗').toBe('imported');
            expect(outliner.status, 'Outliner 面の import が失敗').toBe('imported');

            const a = flatten(notes.entries);
            const b = flatten(outliner.entries);
            // ⚠️ md の pageId は毎回 uuid が振られるので name/kind/階層で比較する（値は面ごとに違って当然）
            expect(b, `node 木が面で割れている:\nNotes   = ${a.join(', ')}\nOutliner = ${b.join(', ')}`).toEqual(a);

            // closure 抑止が両面で効いている（片方だけ生 walk を渡す実装だとここで崩れる）
            for (const flat of [a, b]) {
                expect(flat.some((x) => x.endsWith('dir:files')), 'closure だけの files/ に node ができた').toBe(false);
                expect(flat.some((x) => x.endsWith('file:spec.pdf')), 'closure の spec.pdf に node ができた').toBe(false);
                expect(flat.some((x) => x.endsWith('dir:images')), 'closure 外を持つ images/ の node が無い').toBe(true);
            }
        } finally { fx.cleanup(); destNotes.cleanup(); destOut.cleanup(); }
    });

    test('両 provider が同じ入口（runFolderImportWithDialog）を通し、生 walk 結果を渡していない', () => {
        const notesSrc = fs.readFileSync(path.join(REPO, 'src', 'notesEditorProvider.ts'), 'utf8');
        const outSrc = fs.readFileSync(path.join(REPO, 'src', 'outlinerProvider.ts'), 'utf8');

        for (const [name, src] of [['notesEditorProvider', notesSrc], ['outlinerProvider', outSrc]] as const) {
            // importFolderResult を送る箇所の周辺 20 行を取る
            const lines = src.split('\n');
            const at = lines.findIndex((l) => l.includes("type: 'importFolderResult'"));
            expect(at, `${name} に importFolderResult の送出が無い`).toBeGreaterThan(-1);
            const around = lines.slice(Math.max(0, at - 20), at + 8).join('\n');

            expect(around.includes('runFolderImportWithDialog'),
                `${name} が runFolderImportWithDialog を通っていない（面ごとに挙動が割れる）`).toBe(true);
            expect(around.includes('outcome.entries'),
                `${name} が outcome.entries を渡していない`).toBe(true);
            // 生 walk 結果を直接渡していない（closure 抑止をすり抜ける経路）
            expect(around.includes('walkFolderForImport'),
                `${name} が walkFolderForImport の生結果を渡している（closure 抑止をすり抜ける）`).toBe(false);
        }
    });
});
