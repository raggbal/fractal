/**
 * translate-sdk-client unit tests (sprint 20260802-212934-aws-sdk-migration / TASK-02)
 *
 * translate-sdk-client.ts の I/O 層ラッパを、client を mock 注入して検証する。
 * mock client は send(command) で command を捕捉し、command.input（SDK が
 * 構築した実 input）を assert する。これにより「CLI 引数 → SDK Command input」の
 * 1:1 マッピングが正しいことを番人化する。
 *
 * 対象TC:
 *   TC-SDK-10: translateTextSdk（terminology 指定あり/なし）
 *   TC-SDK-11: importTerminologySdk（.csv / .tmx）
 */

import { test, expect } from '@playwright/test';
import {
    TranslateTextCommand,
    ImportTerminologyCommand,
} from '@aws-sdk/client-translate';
import {
    translateTextSdk,
    importTerminologySdk,
} from '../../src/shared/translate-sdk-client';

/**
 * send(command) で受け取った command を capture し、指定レスポンスを返す fake client。
 * TranslateClient として型付けするため unknown 経由で cast する。
 */
function makeMockClient(response: any) {
    const sent: any[] = [];
    const client: any = {
        send: async (command: any) => {
            sent.push(command);
            return response;
        },
    };
    return { client, sent };
}

test.describe('translate-sdk-client / translateTextSdk (TC-SDK-10)', () => {
    test('TC-SDK-10a: terminology 指定ありで TerminologyNames:[name] が input に透過し TranslatedText が返る', async () => {
        const { client, sent } = makeMockClient({ TranslatedText: 'こんにちは' });

        const result = await translateTextSdk(client, {
            text: 'hello',
            sourceLang: 'en',
            targetLang: 'ja',
            terminologyName: 'my-terms',
        });

        // 送られた command は TranslateTextCommand
        expect(sent).toHaveLength(1);
        expect(sent[0]).toBeInstanceOf(TranslateTextCommand);

        const input = sent[0].input;
        // CLI: --source-language-code / --target-language-code / --text の 1:1 対応
        expect(input.SourceLanguageCode).toBe('en');
        expect(input.TargetLanguageCode).toBe('ja');
        expect(input.Text).toBe('hello');
        // CLI: --terminology-names <name> → TerminologyNames: [name]
        expect(input.TerminologyNames).toEqual(['my-terms']);

        // 返り値は TranslatedText
        expect(result).toBe('こんにちは');
    });

    test('TC-SDK-10b: terminology 未指定なら TerminologyNames キー自体が input に存在しない', async () => {
        const { client, sent } = makeMockClient({ TranslatedText: 'bonjour' });

        const result = await translateTextSdk(client, {
            text: 'hello',
            sourceLang: 'en',
            targetLang: 'fr',
        });

        const input = sent[0].input;
        // undefined ではなくキー自体が不在（CLI で --terminology-names を push しないのと同等）。
        // counterfactual: spread ガードを外して常に {TerminologyNames: [undefined]} を入れると RED。
        expect('TerminologyNames' in input).toBe(false);
        expect(input.SourceLanguageCode).toBe('en');
        expect(input.TargetLanguageCode).toBe('fr');
        expect(input.Text).toBe('hello');
        expect(result).toBe('bonjour');
    });

    test('TC-SDK-10c: TranslatedText が欠落しても空文字を返す（fail-safe な返り値正規化）', async () => {
        const { client } = makeMockClient({});
        const result = await translateTextSdk(client, {
            text: 'x',
            sourceLang: 'en',
            targetLang: 'ja',
        });
        expect(result).toBe('');
    });

    test('TC-SDK-10d: client.send が reject したら例外がそのまま透過（fail-fast）', async () => {
        const client: any = {
            send: async () => { throw new Error('AccessDenied'); },
        };
        await expect(translateTextSdk(client, {
            text: 'x',
            sourceLang: 'en',
            targetLang: 'ja',
        })).rejects.toThrow('AccessDenied');
    });
});

test.describe('translate-sdk-client / importTerminologySdk (TC-SDK-11)', () => {
    test('TC-SDK-11a: CSV → Format=CSV / MergeStrategy=OVERWRITE / File が渡した Uint8Array', async () => {
        const bytes = new Uint8Array([0x66, 0x6f, 0x6f, 0x2c, 0x62, 0x61, 0x72]); // "foo,bar"
        const { client, sent } = makeMockClient({
            TerminologyProperties: { Name: 'glossary', TermCount: 12 },
        });

        const result = await importTerminologySdk(client, {
            name: 'glossary',
            fileBytes: bytes,
            format: 'CSV',
        });

        expect(sent).toHaveLength(1);
        expect(sent[0]).toBeInstanceOf(ImportTerminologyCommand);

        const input = sent[0].input;
        // CLI: --name <name>
        expect(input.Name).toBe('glossary');
        // CLI: --merge-strategy OVERWRITE
        expect(input.MergeStrategy).toBe('OVERWRITE');
        // CLI: --terminology-data Format=CSV
        expect(input.TerminologyData.Format).toBe('CSV');
        // CLI: --data-file fileb://<path> → 生バイト。渡した Uint8Array がそのまま乗る。
        expect(input.TerminologyData.File).toBeInstanceOf(Uint8Array);
        expect(input.TerminologyData.File).toBe(bytes); // identity: 変換せず透過
        expect(Array.from(input.TerminologyData.File as Uint8Array)).toEqual(Array.from(bytes));

        // TerminologyProperties から name / termCount を拾う
        expect(result).toEqual({ name: 'glossary', termCount: 12 });
    });

    test('TC-SDK-11b: TMX → Format=TMX / MergeStrategy=OVERWRITE / File が渡した Uint8Array', async () => {
        const bytes = new Uint8Array([0x3c, 0x74, 0x6d, 0x78, 0x3e]); // "<tmx>"
        const { client, sent } = makeMockClient({
            TerminologyProperties: { Name: 'tmx-terms' },
        });

        const result = await importTerminologySdk(client, {
            name: 'tmx-terms',
            fileBytes: bytes,
            format: 'TMX',
        });

        const input = sent[0].input;
        expect(input.Name).toBe('tmx-terms');
        expect(input.MergeStrategy).toBe('OVERWRITE');
        expect(input.TerminologyData.Format).toBe('TMX');
        expect(input.TerminologyData.File).toBe(bytes);

        // TermCount 欠落時は undefined を含む { name }
        expect(result.name).toBe('tmx-terms');
        expect(result.termCount).toBeUndefined();
    });

    test('TC-SDK-11c: TerminologyProperties.Name 欠落時は渡した name を fallback で返す', async () => {
        const { client } = makeMockClient({});
        const result = await importTerminologySdk(client, {
            name: 'fallback-name',
            fileBytes: new Uint8Array([1, 2, 3]),
            format: 'CSV',
        });
        expect(result.name).toBe('fallback-name');
    });

    test('TC-SDK-11d: client.send が reject したら例外がそのまま透過（fail-fast）', async () => {
        const client: any = {
            send: async () => { throw new Error('LimitExceeded'); },
        };
        await expect(importTerminologySdk(client, {
            name: 'n',
            fileBytes: new Uint8Array([1]),
            format: 'CSV',
        })).rejects.toThrow('LimitExceeded');
    });
});
