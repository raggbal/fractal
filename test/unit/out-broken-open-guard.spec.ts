/**
 * out-broken-open-guard.spec.ts — 壊れた .out を「無言で / 空で」開かせない番人
 *
 * sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / TASK-77。
 * 現地不具合: note file tree の item を click しても outliner が開かない（何も起きない）。
 * 原因は .out 本文が 2 世代混在で JSON parse 不能になっていたこと自体ではなく、
 *  (a) NotesFileManager.openFile が null を返すだけで理由が console にしか出ず、
 *      notesOpenFile の失敗枝が file list を再送するだけ = 完全に無言だった（FR-OPF-01）
 *  (b) 単体 .out custom editor 側は webview の catch で init({rootIds:[],nodes:{}}) に縮退し、
 *      空の outliner として編集可能になっていた = 次の 1 編集で salvage 可能な原本が
 *      空データで上書きされ得た（FR-OPF-02）
 *
 * 検証対象（behavioral + counterfactual。source 文字列 assert はしない）:
 *  - TC-OPF-01 (FR-OPF-01): 破損 .out で openFile が null + getLastOpenError() が理由を返す / 正常 open で null に戻る
 *  - TC-OPF-02 (FR-OPF-01): notesOpenFile が showErrorMessage を basename 付きで呼び、updateData を送らない
 *  - TC-OPF-03 (FR-OPF-01): 破損 .out を開こうとしても currentFilePath が前のファイルのまま（破損原本へ書きに行かない）
 *  - TC-OPF-04 (FR-OPF-02): classifyOutlinerContent が 空/正常/破損 を分ける（空 0byte を破損扱いにしない）
 *  - TC-OPF-05 (FR-OPF-02): getBrokenOutlinerHtml に script が無く（= Outliner.init 不可能）file 名と理由を HTML escape して含む
 *  - TC-OPF-06 (FR-OPF-02): 現地と同じ破損署名（2 世代 splice: 二重 `[]` + 途中で別 node へ飛ぶ）が broken 判定される
 */

import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

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

const NotesFileManager = requireWithVscodeStub('../../src/shared/notes-file-manager').NotesFileManager;
const handleNotesMessage = requireWithVscodeStub('../../src/shared/notes-message-handler').handleNotesMessage;
const { classifyOutlinerContent, getBrokenOutlinerHtml } =
    requireWithVscodeStub('../../src/outlinerWebviewContent');

/** 現地 mt0wj1x7eaua.out と同じ破損署名: 二重 `[]` + node 途中から別 node の serialization へ飛ぶ */
const SPLICED = `{
  "version": 1,
  "rootIds": ["n1", "n2"],
  "nodes": {
    "n1": {
      "id": "n1", "parentId": null, "children": [], "text": "alive",
      "images": [][],
      "filePath": null
    },
    "n2": {
      "id": "n2", "parentId": null, "children": [], "text": "cut here",
      "subtext":": {
      "id": "n3", "parentId": null, "children": [], "text": "other generation"
`;

const VALID = JSON.stringify({
    version: 1, rootIds: ['a'],
    nodes: { a: { id: 'a', parentId: null, children: [], text: 'ok', images: [], filePath: null } },
}, null, 2);

test.describe('broken .out open guard (TASK-77)', () => {
    let tempDir: string;
    test.beforeEach(() => { tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opf-test-')); });
    test.afterEach(() => { if (tempDir && fs.existsSync(tempDir)) { fs.rmSync(tempDir, { recursive: true, force: true }); } });

    // TC-OPF-01
    test('TC-OPF-01 破損 .out で openFile が null + 理由を getLastOpenError で取れる', () => {
        const broken = path.join(tempDir, 'broken.out');
        const good = path.join(tempDir, 'good.out');
        fs.writeFileSync(broken, SPLICED, 'utf8');
        fs.writeFileSync(good, VALID, 'utf8');
        const fm = new NotesFileManager(tempDir);

        expect(fm.openFile(broken)).toBe(null);
        const reason = fm.getLastOpenError();
        expect(typeof reason).toBe('string');
        expect((reason || '').length).toBeGreaterThan(0);   // 従来は理由を取る口が無く無言だった

        // 正常 open で理由がリセットされる（古いエラーを次の成功後に出し続けない）
        expect(fm.openFile(good)).not.toBe(null);
        expect(fm.getLastOpenError()).toBe(null);
    });

    // TC-OPF-02 / TC-OPF-03
    test('TC-OPF-02/03 notesOpenFile が破損を通知し updateData を送らず currentFilePath を移さない', async () => {
        const broken = path.join(tempDir, 'broken.out');
        const good = path.join(tempDir, 'good.out');
        fs.writeFileSync(broken, SPLICED, 'utf8');
        fs.writeFileSync(good, VALID, 'utf8');
        const fm = new NotesFileManager(tempDir);
        expect(fm.openFile(good)).not.toBe(null);          // 先に正常な note を開いておく

        const posted: any[] = [];
        const errors: string[] = [];
        const sender = { postMessage: (m: any) => { posted.push(m); } } as any;
        const platform = {
            showInformationMessage: () => {},
            showErrorMessage: (m: string) => { errors.push(m); },
            saveLastOpenedFile: () => {},
        } as any;

        await handleNotesMessage({ type: 'notesOpenFile', filePath: broken }, fm as any, sender, platform);

        // TC-OPF-02: 無言にしない（basename が文面に出る）+ 中身は流さない
        expect(errors.length).toBe(1);
        expect(errors[0]).toContain('broken.out');
        expect(posted.some(m => m && m.type === 'updateData')).toBe(false);

        // TC-OPF-03: 破損原本を「現在のファイル」にしない = 以後の保存が破損 file を潰さない
        expect(fm.getCurrentFilePath()).toBe(good);
        expect(fs.readFileSync(broken, 'utf8')).toBe(SPLICED);  // byte 同一（読むだけ）
    });

    // TC-OPF-04
    test('TC-OPF-04 classifyOutlinerContent が 空 / 正常 / 破損 を分ける', () => {
        expect(classifyOutlinerContent('').kind).toBe('empty');
        expect(classifyOutlinerContent('   \n ').kind).toBe('empty');   // 新規 0byte を破損扱いにしない
        expect(classifyOutlinerContent(VALID).kind).toBe('ok');
        const v = classifyOutlinerContent(SPLICED);
        expect(v.kind).toBe('broken');
        expect((v.error || '').length).toBeGreaterThan(0);
    });

    // TC-OPF-05
    test('TC-OPF-05 破損表示 HTML は script を含まず file 名と理由を escape して出す', () => {
        const html = getBrokenOutlinerHtml('a<b>.out', 'Unexpected token "<" & more');
        expect(html.toLowerCase()).not.toContain('<script');        // init を呼べない = 空上書き不能
        expect(html).not.toContain('Outliner.init');
        expect(html).toContain('a&lt;b&gt;.out');                   // escape 済み
        expect(html).toContain('&amp; more');
        expect(html).not.toContain('a<b>.out');                     // 生の < > を素通しさせない
    });

    // TC-OPF-06
    test('TC-OPF-06 現地の破損署名（2 世代 splice）が broken 判定される', () => {
        expect(SPLICED).toContain('"images": [][]');                // 二重 [] は JSON.stringify では生じない
        expect(classifyOutlinerContent(SPLICED).kind).toBe('broken');
        // 反実仮想: 二重 [] を直しただけでは splice 部が残るのでまだ broken
        expect(classifyOutlinerContent(SPLICED.replace('[][]', '[]')).kind).toBe('broken');
    });
});
