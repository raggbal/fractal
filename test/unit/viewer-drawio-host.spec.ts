/**
 * md の openLink から drawio が viewer に届く（host 側受信 — sprint 20261009-130815-file-viewer-drawio / TASK-09）
 *
 * TC-DIO-41: (a) sidepanel / notes 面 = SidePanelManager.handleOpenLink → openViewerPanel{kind:'drawio'}
 *            (b) standalone md = editorProvider の openLocalLinkTarget → vscode.openWith(…, 'fractal.fileViewerDrawio')
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SRC_PREFIX = path.join(__dirname, '..', '..', 'src') + path.sep;
function purgeSrcCache(): void {
    for (const key of Object.keys(require.cache)) {
        if (key.startsWith(SRC_PREFIX)) { delete require.cache[key]; }
    }
}
function requireWithVscodeStub(modulePath: string, rec: { openWith: any[]; external: any[] }): any {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Mod = require('module');
    const origLoad = Mod._load;
    purgeSrcCache();
    const uri = (p: string) => ({ fsPath: p, toString: () => 'file://' + p });
    const stub = {
        workspace: { getConfiguration: () => ({ get: () => undefined }), fs: {} },
        Uri: { file: uri, joinPath: (b: any, ...parts: string[]) => uri(path.join((b && b.fsPath) || '', ...parts)), parse: (s: string) => uri(s) },
        commands: { executeCommand: (cmd: string, ...args: any[]) => { if (cmd === 'vscode.openWith') { rec.openWith.push(args); } } },
        env: { openExternal: (u: any) => { rec.external.push(u); } },
        window: { showErrorMessage: () => {}, showInformationMessage: () => {}, showWarningMessage: () => {}, createOutputChannel: () => ({ appendLine() {} }) },
        ViewColumn: {}, EventEmitter: class { event = () => {}; fire() {} }, Disposable: class {},
        RelativePattern: class {}, FileSystemWatcher: class {},
    };
    Mod._load = function (request: string) {
        if (request === 'vscode') { return stub; }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    try { return require(modulePath); } finally { Mod._load = origLoad; purgeSrcCache(); }
}

test.describe('drawio: md の openLink → viewer', () => {
    let dir = '';
    test.beforeAll(() => {
        dir = fs.mkdtempSync(path.join(os.tmpdir(), 'drawio-host-'));
        fs.mkdirSync(path.join(dir, 'img'));
        fs.writeFileSync(path.join(dir, 'img', 'a.drawio.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
        fs.writeFileSync(path.join(dir, 'b.drawio'), '<mxfile/>');
        fs.writeFileSync(path.join(dir, 'note.md'), '# n');
    });
    test.afterAll(() => { fs.rmSync(dir, { recursive: true, force: true }); });

    test('TC-DIO-41a: sidepanel の handleOpenLink は drawio を openViewerPanel（kind:drawio）で開く', async () => {
        const rec = { openWith: [] as any[], external: [] as any[] };
        const { SidePanelManager } = requireWithVscodeStub('../../src/shared/sidePanelManager', rec);
        const posted: any[] = [];
        const host = { postMessage: (m: any) => { posted.push(m); }, asWebviewUri: (u: any) => ({ toString: () => 'vscode-resource://' + u.fsPath }) };
        const mgr = new SidePanelManager(host as any, {} as any);
        await mgr.handleOpenLink('img/a.drawio.svg', path.join(dir, 'note.md'));
        const v = posted.filter((m) => m.type === 'openViewerPanel');
        expect(v).toHaveLength(1);
        expect(v[0].kind).toBe('drawio');
        expect(v[0].filePath).toBe(path.join(dir, 'img', 'a.drawio.svg'));
        expect(rec.external).toHaveLength(0);
    });

    test('TC-DIO-41b: standalone md の openLocalLinkTarget は .drawio を fractal.fileViewerDrawio で開く', async () => {
        const rec = { openWith: [] as any[], external: [] as any[] };
        const mod = requireWithVscodeStub('../../src/editorProvider', rec);
        expect(typeof mod.openLocalLinkTarget).toBe('function');
        mod.openLocalLinkTarget({ fsPath: path.join(dir, 'b.drawio') });
        expect(rec.openWith).toHaveLength(1);
        expect(rec.openWith[0][1]).toBe('fractal.fileViewerDrawio');
        // viewer 対象外は従来どおり外部起動
        mod.openLocalLinkTarget({ fsPath: path.join(dir, 'x.zip') });
        expect(rec.external).toHaveLength(1);
    });
});
