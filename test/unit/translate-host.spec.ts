/**
 * translate-host.spec.ts — 翻訳の依頼の共通の受け口（ADRL-0141）と用語集の設定
 *
 * TC-TRH-01: 設定のキー・リージョン・用語集の名前を translate に渡し、translateResult に sidePanelFilePath を返す
 * TC-TRH-02: キーが空でも訳す（AWS CLI の認証）。キーが片方だけなら translate を呼ばずに translateError（sidePanelFilePath つき）
 * TC-TRH-03: 失敗は translateError（sidePanelFilePath つき）+ 通知、用語集が無かったら通知だけ
 * TC-TRH-04: 用語集の設定: 名前の形 → 名前 / それ以外 → ファイル（名前はファイル名から）
 */
import { test, expect } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';
import { TranslateClient } from '@aws-sdk/client-translate';
import { initLocale } from '../../src/i18n/messages';
import { translateText } from '../../src/shared/aws-translate';
import { handleTranslateRequest } from '../../src/shared/translate-host';
import { parseTerminologySetting, terminologyNameFromFile, TERMINOLOGY_NAME_RE } from '../../src/shared/translate-terminology';

function deps(config: Record<string, unknown>, translate: (o: any) => Promise<any>) {
    const posts: any[] = [];
    const errors: string[] = [];
    const infos: string[] = [];
    return {
        posts, errors, infos,
        d: {
            getConfig: (k: string) => config[k],
            workspaceRoot: '/ws',
            translate,
            post: (m: any) => posts.push(m),
            notifyError: (m: string) => errors.push(m),
            notifyInfo: (m: string) => infos.push(m),
        },
    };
}

test.beforeAll(() => initLocale('en', 'en'));

const req = (extra: Record<string, unknown> = {}) => ({ markdown: '# Hi', sourceLang: 'en', targetLang: 'ja', ...extra });

test('TC-TRH-01 設定を渡し、結果に sidePanelFilePath を返す', async () => {
    let got: any;
    const t = deps({ awsAccessKeyId: 'AK', awsSecretAccessKey: 'SK', awsRegion: 'ap-northeast-1', translateTerminology: 'glossary' }, async (o) => {
        got = o;
        return { translatedText: '# こんにちは', sourceLang: o.sourceLang, targetLang: o.targetLang };
    });
    await handleTranslateRequest(req({ sidePanelFilePath: '/sp/a.md' }), t.d);
    expect(got).toMatchObject({ accessKeyId: 'AK', secretAccessKey: 'SK', region: 'ap-northeast-1', text: '# Hi', sourceLang: 'en', targetLang: 'ja', terminologyName: 'glossary' });
    expect(t.posts).toEqual([{ type: 'translateResult', translatedMarkdown: '# こんにちは', sourceLang: 'en', targetLang: 'ja', sidePanelFilePath: '/sp/a.md' }]);
    expect(t.errors).toEqual([]);

    const main = deps({}, async (o) => ({ translatedText: 'x', sourceLang: o.sourceLang, targetLang: o.targetLang }));
    await handleTranslateRequest(req(), main.d);
    expect(main.posts[0].type).toBe('translateResult');
    expect(main.posts[0].sidePanelFilePath).toBeUndefined();
});

test('TC-TRH-02 キーが空なら AWS CLI の認証で訳す・片方だけなら止める', async () => {
    let calls = 0;
    const empty = deps({}, async (o) => {
        calls++;
        expect(o.accessKeyId).toBe('');
        expect(o.secretAccessKey).toBe('');
        return { translatedText: 'ok', sourceLang: 'en', targetLang: 'ja' };
    });
    await handleTranslateRequest(req(), empty.d);
    expect(calls).toBe(1);
    expect(empty.posts[0].type).toBe('translateResult');

    const half = deps({ awsAccessKeyId: 'AK' }, async () => {
        throw new Error('should-not-reach');
    });
    await handleTranslateRequest(req({ sidePanelFilePath: '/sp/b.md' }), half.d);
    expect(half.posts).toHaveLength(1);
    expect(half.posts[0]).toMatchObject({ type: 'translateError', sidePanelFilePath: '/sp/b.md' });
    expect(half.posts[0].message).not.toContain('should-not-reach');
    expect(half.errors).toHaveLength(1);
});

test('TC-TRH-03 失敗は translateError + 通知、用語集が無ければ通知', async () => {
    const fail = deps({}, async () => {
        throw Object.assign(new Error('AccessDeniedException: not allowed'), { name: 'AccessDeniedException' });
    });
    await handleTranslateRequest(req({ sidePanelFilePath: '/sp/c.md' }), fail.d);
    expect(fail.posts).toEqual([{ type: 'translateError', message: 'AccessDeniedException: not allowed', sidePanelFilePath: '/sp/c.md' }]);
    expect(fail.errors[0]).toContain('AccessDeniedException: not allowed');

    const missing = deps({ translateTerminology: 'gone' }, async () => ({ translatedText: 't', sourceLang: 'en', targetLang: 'ja', terminologyMissing: 'gone' }));
    await handleTranslateRequest(req(), missing.d);
    expect(missing.posts[0].type).toBe('translateResult');
    expect(missing.infos).toHaveLength(1);
    expect(missing.infos[0]).toContain('gone');
});

test('TC-TRH-04 用語集の設定: 名前か、ファイル（名前はファイル名から）', () => {
    expect(parseTerminologySetting('')).toEqual({});
    expect(parseTerminologySetting(undefined)).toEqual({});
    expect(parseTerminologySetting('my-terms_2026')).toEqual({ name: 'my-terms_2026' });
    expect(parseTerminologySetting('/abs/Glossary v2.csv')).toEqual({ name: 'Glossary-v2', filePath: '/abs/Glossary v2.csv' });
    expect(parseTerminologySetting('~/t/terms.tmx')).toEqual({ name: 'terms', filePath: path.join(os.homedir(), 't', 'terms.tmx') });
    expect(parseTerminologySetting('rel/terms.csv', '/ws')).toEqual({ name: 'terms', filePath: '/ws/rel/terms.csv' });
    for (const [file, name] of [['/a/用語集.csv', 'fractal-terminology'], ['/a/__x__y.csv', 'x_y'], ['/a/a--b.csv', 'a--b'], ['/a/.csv', 'csv'], ['/a/-.csv', 'fractal-terminology']]) {
        const n = terminologyNameFromFile(file);
        expect(n).toBe(name);
        expect(TERMINOLOGY_NAME_RE.test(n)).toBe(true);
    }
});

test('TC-TRH-05 translateText: 用語集が Amazon Translate に無ければ、用語集なしで訳し直して terminologyMissing を返す', async () => {
    const original = TranslateClient.prototype.send;
    const seen: Array<string[] | undefined> = [];
    (TranslateClient.prototype as any).send = async function (cmd: any) {
        seen.push(cmd.input.TerminologyNames);
        if (cmd.input.TerminologyNames) {
            throw Object.assign(new Error('The resource you are looking for has not been found.'), { name: 'ResourceNotFoundException' });
        }
        return { TranslatedText: `[${cmd.input.Text}]` };
    };
    try {
        const r = await translateText({ text: 'Hello', sourceLang: 'en', targetLang: 'ja', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'us-east-1', terminologyName: 'gone' });
        expect(r.translatedText).toBe('[Hello]');
        expect(r.terminologyMissing).toBe('gone');
        expect(seen).toEqual([['gone'], undefined]);
        // ほかの失敗は訳し直さずに投げる
        (TranslateClient.prototype as any).send = async () => {
            throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        };
        await expect(translateText({ text: 'Hello', sourceLang: 'en', targetLang: 'ja', accessKeyId: 'AK', secretAccessKey: 'SK', region: 'us-east-1', terminologyName: 'gone' })).rejects.toThrow('denied');
    } finally {
        TranslateClient.prototype.send = original;
    }
});
