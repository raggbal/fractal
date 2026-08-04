/**
 * translate-routing.spec.ts — FR-TR-02 応答エコーバックの unit テスト
 *
 * Sprint: 20260803-013547-translate-button-and-scope / TASK-01
 *
 * 検証する契約（FR-TR-02 の host 側）:
 *   host の translateContent handler は、要求 message.sidePanelFilePath を
 *   translateResult / translateError の**全応答**にそのまま透過エコーバックする
 *   （sidepanel 要求 → 応答に sidePanelFilePath / main 要求 → undefined）。
 *   webview 受信（editor.js）はこの値で「sidepanel instance に委譲 or main で開く」を
 *   振り分ける。エコーバックが無いと sidepanel 要求でも main が翻訳ビュー化する（＝バグ）。
 *
 * 戦略:
 *   - notes-message-handler.ts は `handleNotesMessage(message, fileManager, sender, platform)`
 *     の clean な export seam があるため **behavioral** に検証する（TC-PDF-64 と同じ
 *     Module._load vscode-stub パターン + './aws-translate' の translateText を mock）。
 *   - editorProvider.ts の translateContent handler は resolveCustomTextEditor の
 *     ~500 行クロージャに inline で、provider+webviewPanel+document を構築せずに
 *     behavioral 起動できない。よって TC-TR-12 は **source-contract 検証**（case ブロックを
 *     抽出し、全 translateResult/translateError post が sidePanelFilePath を運ぶことを pin）。
 *     routing の behavioral な番人は E2E TC-TR-04（main DOM 不変）が担う。
 *
 * counterfactual: いずれの TC も「エコーバック行を落とすと sidePanelFilePath が
 *   欠落 → RED」。現 HEAD（エコーバック未実装）では TC-TR-10/11 は RED。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Module._load を差し替えて 'vscode' と './aws-translate' を stub し、
 * notes-message-handler を **fresh require** して handleNotesMessage を返す。
 * translateMock は translateText の実装（成功なら結果 object を返す / 失敗なら throw）。
 */
function loadNotesHandlerWithMocks(translateMock: (input: any) => any) {
    const Module = require('module');
    const origLoad = Module._load;
    // 前テストが cache した実 module を捨て、stub 付きで再評価させる。
    for (const key of Object.keys(require.cache)) {
        if (/notes-message-handler|aws-translate/.test(key)) {
            delete require.cache[key];
        }
    }
    Module._load = function (request: string) {
        if (request === 'vscode') {
            return {
                workspace: { getConfiguration: () => ({ get: () => undefined }) },
                Uri: { file: (p: string) => ({ fsPath: p }) },
                commands: { executeCommand: () => {} },
                window: {},
                env: {},
                ViewColumn: {},
            };
        }
        if (/aws-translate$/.test(request)) {
            return {
                translateText: (input: any) => translateMock(input),
                TRANSLATE_LANGUAGES: [],
            };
        }
        // eslint-disable-next-line prefer-rest-params
        return origLoad.apply(this, arguments as any);
    };
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const mod = require('../../src/shared/notes-message-handler');
    return { handleNotesMessage: mod.handleNotesMessage, restore: () => { Module._load = origLoad; } };
}

/** 資格情報ありの platform（translateText 経路に到達する）を組む。 */
function makePlatformWithCreds(captured: any[]) {
    return {
        getWorkspaceConfig: () => ({
            get: (key: string, def: any) => {
                const table: Record<string, any> = {
                    transAccessKeyId: 'AKIAEXAMPLE',
                    transSecretAccessKey: 'SECRETEXAMPLE',
                    transRegion: 'us-east-1',
                    translateTerminologyName: '',
                };
                return key in table ? table[key] : def;
            },
        }),
        postMessage: () => {}, // guard（platform.postMessage の存在）用。応答は sender へ。
    };
}

test.describe('FR-TR-02: notes-message-handler の応答エコーバック', () => {
    test('TC-TR-10: translateResult が sidePanelFilePath を透過エコーバック（あれば載せ / 無ければ undefined）', async () => {
        const { handleNotesMessage, restore } = loadNotesHandlerWithMocks(
            () => ({ translatedText: 'こんにちは', sourceLang: 'en', targetLang: 'ja' })
        );
        try {
            // (1) sidepanel 要求（sidePanelFilePath あり）→ 応答に透過。
            const capturedSp: any[] = [];
            const senderSp = { postMessage: (m: any) => capturedSp.push(m) };
            await handleNotesMessage(
                { type: 'translateContent', markdown: 'hi', sourceLang: 'en', targetLang: 'ja', sidePanelFilePath: '/sp/a.md' },
                {} as any,
                senderSp as any,
                makePlatformWithCreds(capturedSp) as any
            );
            const resSp = capturedSp.find((m) => m.type === 'translateResult');
            expect(resSp).toBeTruthy();
            expect(resSp.translatedMarkdown).toBe('こんにちは');
            // ★ load-bearing: sidepanel 要求の応答は sidePanelFilePath を運ぶ（エコーバック未実装なら undefined = RED）
            expect(resSp.sidePanelFilePath).toBe('/sp/a.md');

            // (2) main 要求（sidePanelFilePath なし）→ 応答の sidePanelFilePath は undefined（main で開く）。
            const capturedMain: any[] = [];
            const senderMain = { postMessage: (m: any) => capturedMain.push(m) };
            await handleNotesMessage(
                { type: 'translateContent', markdown: 'hi', sourceLang: 'en', targetLang: 'ja' },
                {} as any,
                senderMain as any,
                makePlatformWithCreds(capturedMain) as any
            );
            const resMain = capturedMain.find((m) => m.type === 'translateResult');
            expect(resMain).toBeTruthy();
            expect(resMain.sidePanelFilePath).toBeUndefined();
        } finally {
            restore();
        }
    });

    test('TC-TR-11: translateError（catch 例外・資格情報不足）も sidePanelFilePath を透過エコーバック', async () => {
        // (A) catch 経路: translateText が throw → translateError に echo。
        {
            const { handleNotesMessage, restore } = loadNotesHandlerWithMocks(() => {
                throw new Error('boom');
            });
            try {
                const captured: any[] = [];
                const sender = { postMessage: (m: any) => captured.push(m) };
                await handleNotesMessage(
                    { type: 'translateContent', markdown: 'hi', sourceLang: 'en', targetLang: 'ja', sidePanelFilePath: '/sp/b.md' },
                    {} as any,
                    sender as any,
                    makePlatformWithCreds(captured) as any
                );
                const err = captured.find((m) => m.type === 'translateError');
                expect(err).toBeTruthy();
                // ★ sidepanel 要求のエラーは sidepanel 側に届く（main の翻訳 UI を汚さない）
                expect(err.sidePanelFilePath).toBe('/sp/b.md');
            } finally {
                restore();
            }
        }
        // (B) 資格情報不足の早期 translateError も echo（translateText 到達前）。
        {
            const { handleNotesMessage, restore } = loadNotesHandlerWithMocks(() => {
                throw new Error('should-not-reach');
            });
            try {
                const captured: any[] = [];
                const sender = { postMessage: (m: any) => captured.push(m) };
                const platformNoCreds = {
                    getWorkspaceConfig: () => ({ get: (_k: string, def: any) => def }), // 資格情報 = 空文字（default）
                    postMessage: () => {},
                };
                await handleNotesMessage(
                    { type: 'translateContent', markdown: 'hi', sourceLang: 'en', targetLang: 'ja', sidePanelFilePath: '/sp/c.md' },
                    {} as any,
                    sender as any,
                    platformNoCreds as any
                );
                const err = captured.find((m) => m.type === 'translateError');
                expect(err).toBeTruthy();
                expect(err.message).toContain('credentials');
                expect(err.sidePanelFilePath).toBe('/sp/c.md');
            } finally {
                restore();
            }
        }
    });
});

test.describe('FR-TR-02: editorProvider の応答エコーバック（source-contract）', () => {
    test('TC-TR-12: editorProvider の translateContent case の全 translateResult/translateError post が sidePanelFilePath を運ぶ', () => {
        // editorProvider の handler は resolveCustomTextEditor の ~500 行クロージャに inline で
        // behavioral 起動が非現実的なため、case ブロックを抽出して契約を pin する。
        // routing 自体の behavioral 番人は E2E TC-TR-04 が担う。
        const src = fs.readFileSync(
            path.resolve(__dirname, '../../src/editorProvider.ts'),
            'utf8'
        );
        // case 'translateContent' { ... } ブロックを抽出（次の case 'translateSelectLang' まで）。
        const startIdx = src.indexOf("case 'translateContent':");
        expect(startIdx).toBeGreaterThan(-1);
        const nextCaseIdx = src.indexOf("case 'translateSelectLang':", startIdx);
        expect(nextCaseIdx).toBeGreaterThan(startIdx);
        const block = src.slice(startIdx, nextCaseIdx);

        // このブロック内の translateResult / translateError post 数を数える。
        const resultPosts = (block.match(/type:\s*'translateResult'/g) || []).length;
        const errorPosts = (block.match(/type:\s*'translateError'/g) || []).length;
        expect(resultPosts).toBe(1); // translateResult は 1 経路
        expect(errorPosts).toBe(2); // 資格情報不足 + catch の 2 経路

        // 全応答（3 post）が sidePanelFilePath: message.sidePanelFilePath を運ぶこと。
        const echoCount = (block.match(/sidePanelFilePath:\s*message\.sidePanelFilePath/g) || []).length;
        // ★ load-bearing: 3 応答すべてに echo が必要（エコーバック未実装なら 0 = RED）
        expect(echoCount).toBe(resultPosts + errorPosts);
    });
});
