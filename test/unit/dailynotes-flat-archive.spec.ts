/**
 * dailynotes 旧レイアウト再発バグの修正 (sprint 20260812-171126-dailynotes-flat-archive)
 *
 * - TC-DNF-01/02: ensureDailyNotesFile が flat ヒント (pageDir/imageDir/fileDir) を書く + 冪等性
 * - TC-DNF-03/04/05: notesArchiveTasks の dest dir 解決が flat-layout 正典
 *   (resolvePagesDir/resolveFilesDir) を通り、旧 `./dailynotes/` フォールバックで
 *   旧レイアウト dir を新規に作らない (作ると移行ゲートが再発する)
 *
 * ハーネス: 実 fs (mkdtemp) + NotesFileManager 直駆動 + handleNotesMessage 直呼び。
 * sender/platform は必要メソッドだけ持つ明示 stub (Proxy fake 禁止)。
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';
import { FLAT_OUT_HINTS } from '../../src/shared/flat-layout';

// notes-message-handler / notesEditorProvider は `vscode` を top-level import する
// (前者は mindmap-export-host 経由)。検証対象の経路自体は vscode を触らないため、
// require('vscode') を空 stub して実モジュールを require する
// (先例: test/unit/pdf-export-host.spec.ts TC-PDF-64)。
function requireWithVscodeStub(modulePath: string): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Module = require('module');
    const origLoad = Module._load;
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
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
    }
}

function requireHandlerWithVscodeStub(): (msg: any, fm: any, sender: any, platform: any) => Promise<void> {
    return requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;
}

const noopSender = { postMessage: () => {} } as any;
const noopPlatform = {
    showInformationMessage: () => {},
    showErrorMessage: () => {},
} as any;

test.describe('dailynotes flat archive', () => {
    let tempDir: string;

    test.beforeEach(() => {
        tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-test-'));
    });
    test.afterEach(() => {
        if (tempDir && fs.existsSync(tempDir)) {
            fs.rmSync(tempDir, { recursive: true, force: true });
        }
    });

    // TC-DNF-01: 新規 dailynotes.out が flat ヒント付きで作られる
    test('TC-DNF-01 ensureDailyNotesFile が pageDir/imageDir/fileDir の flat ヒントを書く', () => {
        const fm = new NotesFileManager(tempDir);
        const p = fm.ensureDailyNotesFile();
        expect(p).toBe(path.join(tempDir, 'dailynotes.out'));
        const data = JSON.parse(fs.readFileSync(p, 'utf8'));
        expect(data.pageDir).toBe(FLAT_OUT_HINTS.pageDir);   // '.'
        expect(data.imageDir).toBe(FLAT_OUT_HINTS.imageDir); // './images'
        expect(data.fileDir).toBe(FLAT_OUT_HINTS.fileDir);   // './files'
        // 既存挙動維持: outline.note に dailynotes item が登録される
        const structure = JSON.parse(fs.readFileSync(path.join(tempDir, 'outline.note'), 'utf8'));
        expect(structure.items['dailynotes']).toBeTruthy();
        expect(structure.rootIds[0]).toBe('dailynotes');
    });

    // TC-DNF-02: 既存 dailynotes.out は書き換えない (冪等・pageDir 後付けスタンプなし)
    test('TC-DNF-02 既存 dailynotes.out があれば内容を書き換えない', () => {
        const p = path.join(tempDir, 'dailynotes.out');
        const original = JSON.stringify({
            version: 1, title: 'Daily Notes', rootIds: [], nodes: {}, custom: 'keep',
        }, null, 2);
        fs.writeFileSync(p, original, 'utf8');
        const fm = new NotesFileManager(tempDir);
        const ret = fm.ensureDailyNotesFile();
        expect(ret).toBe(p);
        expect(fs.readFileSync(p, 'utf8')).toBe(original); // byte 同一
    });

    /** hint 無し dailynotes.out (旧 ensure が作った形) + flat source .out を組み立てる共通 setup */
    function setupHintlessDailynotes(): { fm: NotesFileManager; dailyPath: string } {
        const dailyPath = path.join(tempDir, 'dailynotes.out');
        fs.writeFileSync(dailyPath, JSON.stringify({
            version: 1, title: 'Daily Notes', rootIds: [], nodes: {},
        }, null, 2), 'utf8');
        const fm = new NotesFileManager(tempDir);
        return { fm, dailyPath };
    }

    function writeFlatSourceOut(nodes: Record<string, unknown>, rootIds: string[]): string {
        const srcPath = path.join(tempDir, 'src.out');
        fs.writeFileSync(srcPath, JSON.stringify({
            version: 1, pageDir: '.', imageDir: './images', fileDir: './files',
            rootIds, nodes,
        }, null, 2), 'utf8');
        return srcPath;
    }

    // TC-DNF-03: hint 無し dailynotes.out への archive が旧レイアウト dir を新規に作らない
    test('TC-DNF-03 archive で <note>/dailynotes/ が誕生せず page md は note 直下のまま', async () => {
        const { fm, dailyPath } = setupHintlessDailynotes();
        // flat source: page md は note 直下
        fs.writeFileSync(path.join(tempDir, 'pg1.md'), '# Task page\n', 'utf8');
        const srcPath = writeFlatSourceOut({
            n1: { id: 'n1', text: 'task done', checked: true, isPage: true, pageId: 'pg1', images: [] },
        }, ['n1']);
        fm.openFile(srcPath);

        const handleNotesMessage = requireHandlerWithVscodeStub();
        await handleNotesMessage(
            { type: 'notesArchiveTasks', subtrees: [{ rootId: 'n1', nodes: { n1: { id: 'n1', text: 'task done', checked: true, isPage: true, pageId: 'pg1', images: [] } } }] },
            fm as any, noopSender, noopPlatform
        );

        // 旧レイアウト dir が誕生しない (誕生すると移行ゲートが再発する — バグ本体の番人)
        expect(fs.existsSync(path.join(tempDir, 'dailynotes'))).toBe(false);
        // page md は note 直下のまま (src=dest 同一 dir → sameDirSkip)
        expect(fs.existsSync(path.join(tempDir, 'pg1.md'))).toBe(true);
        // node は dailynotes.out に archive されている
        const daily = JSON.parse(fs.readFileSync(dailyPath, 'utf8'));
        expect(daily.nodes['n1']).toBeTruthy();
        expect(daily.nodes['n1'].pageId).toBe('pg1');
    });

    // TC-DNF-04: file 添付の dest が共有 files/ に解決される (dailynotes/files/ へ複製しない)
    test('TC-DNF-04 archive で file 添付が共有 files/ のまま複製されない', async () => {
        const { fm } = setupHintlessDailynotes();
        fs.mkdirSync(path.join(tempDir, 'files'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'files', 'a.txt'), 'attach', 'utf8');
        const srcPath = writeFlatSourceOut({
            n1: { id: 'n1', text: 'task', checked: true, filePath: 'files/a.txt', images: [] },
        }, ['n1']);
        fm.openFile(srcPath);

        const handleNotesMessage = requireHandlerWithVscodeStub();
        await handleNotesMessage(
            { type: 'notesArchiveTasks', subtrees: [{ rootId: 'n1', nodes: { n1: { id: 'n1', text: 'task', checked: true, filePath: 'files/a.txt', images: [] } } }] },
            fm as any, noopSender, noopPlatform
        );

        expect(fs.existsSync(path.join(tempDir, 'dailynotes', 'files'))).toBe(false);
        expect(fs.existsSync(path.join(tempDir, 'files', 'a.txt'))).toBe(true);
    });

    // TC-DNF-05: 真の legacy dailynotes/ には legacy に書く (読み取り正典 resolvePagesDir と一致)
    test('TC-DNF-05 legacy dailynotes/ 実在 + flat md 無しなら dest も legacy', async () => {
        const { fm } = setupHintlessDailynotes();
        // legacy: <note>/dailynotes/ に md 実在 + note 直下に .md ゼロ → resolvePagesDir は legacy を返す
        fs.mkdirSync(path.join(tempDir, 'dailynotes'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'dailynotes', 'existing.md'), '# old\n', 'utf8');
        // source .out は legacy per-stem 構成 (pageDir hint 明示)
        fs.mkdirSync(path.join(tempDir, 'src-stem'), { recursive: true });
        fs.writeFileSync(path.join(tempDir, 'src-stem', 'pg2.md'), '# legacy page\n', 'utf8');
        const srcPath = path.join(tempDir, 'src.out');
        fs.writeFileSync(srcPath, JSON.stringify({
            version: 1, pageDir: './src-stem',
            rootIds: ['n1'],
            nodes: { n1: { id: 'n1', text: 'task', checked: true, isPage: true, pageId: 'pg2', images: [] } },
        }, null, 2), 'utf8');
        fm.openFile(srcPath);

        const handleNotesMessage = requireHandlerWithVscodeStub();
        await handleNotesMessage(
            { type: 'notesArchiveTasks', subtrees: [{ rootId: 'n1', nodes: { n1: { id: 'n1', text: 'task', checked: true, isPage: true, pageId: 'pg2', images: [] } } }] },
            fm as any, noopSender, noopPlatform
        );

        // 本体の読み取り (resolvePagesDir) が返す legacy dir に書かれている
        expect(fs.existsSync(path.join(tempDir, 'dailynotes', 'pg2.md'))).toBe(true);
    });

    // TC-DNF-06: resolvePagePath (fractal:// page リンク解決) が flat page md を解決する
    test('TC-DNF-06 resolvePagePath が hint 無し flat .out の note 直下 page md を返す', () => {
        const { NotesEditorProvider } = requireWithVscodeStub('../../src/notesEditorProvider');
        const resolvePagePath = NotesEditorProvider.prototype.resolvePagePath;

        // (1) flat 実データ形: hint 無し .out + note 直下 page md
        fs.writeFileSync(path.join(tempDir, 'x.out'), JSON.stringify({
            version: 1, rootIds: [], nodes: {},
        }), 'utf8');
        fs.writeFileSync(path.join(tempDir, 'pg9.md'), '# flat page\n', 'utf8');
        const flat = resolvePagePath.call({}, tempDir, 'x', 'pg9');
        expect(flat).toBe(path.join(tempDir, 'pg9.md'));

        // (2) legacy 変種: <note>/y/<pageId>.md 実在 + note 直下 .md 無しなら legacy を返す
        //     (読み取り正典 resolvePageFilePath と一致)
        const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnf-legacy-'));
        try {
            fs.writeFileSync(path.join(legacyDir, 'y.out'), JSON.stringify({
                version: 1, rootIds: [], nodes: {},
            }), 'utf8');
            fs.mkdirSync(path.join(legacyDir, 'y'), { recursive: true });
            fs.writeFileSync(path.join(legacyDir, 'y', 'pg9.md'), '# legacy page\n', 'utf8');
            const legacy = resolvePagePath.call({}, legacyDir, 'y', 'pg9');
            expect(legacy).toBe(path.join(legacyDir, 'y', 'pg9.md'));
        } finally {
            fs.rmSync(legacyDir, { recursive: true, force: true });
        }
    });
});
