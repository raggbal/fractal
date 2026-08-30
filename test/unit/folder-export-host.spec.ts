/**
 * Sprint 20260827-172802 TASK-11 — Export folder の host glue（design §C5）
 *
 * TC-EXF-05（host 側の配線 pin。deps 分岐の網羅は TASK-10 の folder-export-plan.spec.ts が担当）:
 * ① notes-message-handler の `exportOutlinerFolder` dispatch が platform へ委譲する（2 端配線の受信側）
 * ② 出力先ガードの reason 別扱い: invalid/self/ancestor/descendant は拒否・**duplicate は拒否しない**
 *    （duplicate = folder link 登録済みという無関係な理由で export 先を弾かない — design §C5）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const SRC_PREFIX = path.join(ROOT, 'src') + path.sep;

function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}

function requireWithVscodeStub(modulePath: string, stub?: any): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    purgeSrcCache();
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return stub || {
                workspace: { getConfiguration: () => ({ get: () => undefined }), fs: { delete: async () => {} } },
                Uri: { file: (p: string) => ({ fsPath: p }), joinPath: () => ({}) },
                commands: { executeCommand: () => {} },
                window: {}, env: {}, ViewColumn: {}, EventEmitter: class {},
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(modulePath);
    } finally {
        Module._load = origLoad;
        purgeSrcCache();
    }
}

test.describe('Export folder host glue（FR-EXF-01/05・design §C5）', () => {

    test('TC-EXF-05: exportOutlinerFolder message が platform へ委譲される（受信側の配線 pin）', async () => {
        const mod = requireWithVscodeStub('../../src/shared/notes-message-handler');
        const received: any[] = [];
        const sender = { postMessage: () => {} };
        const platform = { exportOutlinerFolder: (args: any) => { received.push(args); } };
        const tree = [{ text: 'A', children: [{ text: 'b' }] }];

        // fileManager からパス 4 本を解決して platform に渡す（Import 側 importFolderDialog と同型）
        const noteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fexh-'));
        const fileManager = {
            getPagesDirPath: () => path.join(noteDir, 'pages'),
            getCurrentFilePath: () => path.join(noteDir, 'doc.out'),
            getFileDirPath: () => path.join(noteDir, 'files'),
            getOutlinerFileDirPath: () => path.join(noteDir, 'files'),
            getOutlinerImageDirPath: () => path.join(noteDir, 'images'),
        };

        await mod.handleNotesMessage({ type: 'exportOutlinerFolder', tree }, fileManager as any, sender as any, platform as any);

        expect(received, 'platform へ 1 回委譲').toHaveLength(1);
        expect(received[0].tree, 'tree が素通しで渡る').toEqual(tree);
        // パス 4 本が解決済みで渡る（host glue は解決済みパスを受け取るだけ = design §C5）
        expect(received[0].srcOutDir).toBe(noteDir);
        expect(received[0].srcPagesDir).toBe(path.join(noteDir, 'pages'));
        expect(received[0].srcFileDir).toBe(path.join(noteDir, 'files'));
        expect(received[0].srcImageDir).toBe(path.join(noteDir, 'images'));
    });

    test('TC-EXF-05: 出力先ガードは invalid/self/ancestor/descendant のみ拒否し duplicate は通す', () => {
        const mod = requireWithVscodeStub('../../src/shared/folder-export-host');
        expect(typeof mod.isExportDestinationRejected, 'reason 判定が export された関数として存在する').toBe('function');

        // 拒否する reason
        for (const reason of ['invalid', 'self', 'ancestor', 'descendant']) {
            expect(mod.isExportDestinationRejected({ ok: false, reason }), `${reason} は拒否`).toBe(true);
        }
        // 拒否しない: duplicate（folder link 登録済み = export 先としては無関係）
        expect(mod.isExportDestinationRejected({ ok: false, reason: 'duplicate' }), 'duplicate は通す').toBe(false);
        // ok:true は当然通す
        expect(mod.isExportDestinationRejected({ ok: true })).toBe(false);
        // ガード機構が無い面（standalone .out）は undefined を渡す → 通す
        expect(mod.isExportDestinationRejected(undefined)).toBe(false);
    });

    test('TC-EXF-05: bridge（共有ファクトリ）に exportOutlinerFolder が 1 箇所だけ定義されている', () => {
        // FR-EB NFR-02 の規範: 新規 bridge メソッドは共有ファクトリに置く（2 bridge へ個別定義しない）
        const factory = fs.readFileSync(path.join(ROOT, 'src', 'shared', 'sidepanel-bridge-methods.js'), 'utf8');
        expect(factory, '共有ファクトリに定義がある').toContain('exportOutlinerFolder');
        for (const f of ['outliner-host-bridge.js', 'notes-host-bridge.js']) {
            const body = fs.readFileSync(path.join(ROOT, 'src', 'shared', f), 'utf8');
            expect(body, `${f} に個別定義しない（共有ファクトリ経由）`).not.toContain('exportOutlinerFolder:');
        }
    });
});
