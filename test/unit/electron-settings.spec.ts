/**
 * electron-settings.spec.ts — デスクトップ版の設定の画面（electron/src/main/settings-*.ts・src/renderer/settings-page.ts）
 *
 * TC-SET-01: 本物の package.json + package.nls.ja.json から、カテゴリの順・日本語の見出しと説明・欄の種類を作る（deprecated は出さない）
 * TC-SET-02: package.json の %key% はどの package.nls*.json にもある（VS Code の設定画面とデスクトップ版で文が欠けない）
 * TC-SET-03: 書く前の確かめ: 型・選択肢・数の範囲（丸める）・文字の長さ・パスの一覧（空白・重複を落とす）
 * TC-SET-04: アプリの言語 → package.nls の接尾辞、画面のボタンの文
 * TC-SET-05: ページ（jsdom）: 見出し・欄を出し、変えたら set、既定に戻すは変えた欄だけ、settings.json が壊れていれば変えられない
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { JSDOM } from 'jsdom';
import * as ts from 'typescript';
import { buildSettingsSchema, checkSettingValue, findField, localize, nlsSuffix } from '../../electron/src/main/settings-schema';
import { settingsTexts } from '../../electron/src/main/settings-texts';

const ROOT = path.resolve(__dirname, '../..');
const readJson = (f: string) => JSON.parse(fs.readFileSync(path.join(ROOT, f), 'utf8'));
const pkg = readJson('package.json');
const en = readJson('package.nls.json');
const ja = readJson('package.nls.ja.json');

test('TC-SET-01 カテゴリの順・日本語の文・欄の種類', () => {
    const sections = buildSettingsSchema(pkg, ja, en);
    expect(sections.map((s) => s.title)).toEqual(['表示', 'ファイル', 'PDF の書き出し', 'AWS（S3 同期・翻訳）', '詳細']);
    const keys = sections.flatMap((s) => s.fields.map((f) => f.key));
    expect(keys).toEqual([
        'theme', 'language', 'fontSize', 'imageMaxWidth', 'toolbarMode', 'showTranslateButtons', 'showOpenInTextEditor',
        'resourceRoots', 'viewerHtmlAllowScripts',
        'pdfBrowserPath', 'pdfStyles',
        'awsAccessKeyId', 'awsSecretAccessKey', 'awsRegion', 'translateTerminology',
        'enableDebugLogging',
    ]);
    // ★ 古い設定（移すために deprecated で残したもの）は出さない
    for (const old of ['s3AccessKeyId', 'transAccessKeyId', 'translateSourceLang', 'translateTerminologyName', 'pdfIncludeDefaultStyles']) {
        expect(keys).not.toContain(old);
    }
    const theme = findField(sections, 'theme')!;
    expect(theme).toMatchObject({ kind: 'enum', title: 'テーマ', defaultValue: 'auto' });
    expect(theme.options).toEqual([{ value: 'auto', label: '自動' }, { value: 'light', label: 'ライト' }, { value: 'dark', label: 'ダーク' }]);
    expect(findField(sections, 'language')!.options![0]).toEqual({ value: 'default', label: '既定' });
    expect(findField(sections, 'fontSize')).toMatchObject({ kind: 'number', min: 8, max: 40, defaultValue: 12 });
    expect(findField(sections, 'awsSecretAccessKey')).toMatchObject({ kind: 'secret', title: 'AWS のシークレットアクセスキー' });
    expect(findField(sections, 'resourceRoots')).toMatchObject({ kind: 'list', pick: 'folder' });
    expect(findField(sections, 'pdfStyles')).toMatchObject({ kind: 'list', pick: 'css' });
    expect(findField(sections, 'translateTerminology')).toMatchObject({ kind: 'string', pick: 'terminology' });
    expect(findField(sections, 'pdfBrowserPath')).toMatchObject({ kind: 'string', pick: 'browser' });
    expect(findField(sections, 'showTranslateButtons')).toMatchObject({ kind: 'boolean', title: '翻訳ボタンを出す' });
    expect(findField(sections, 'awsAccessKeyId')!.description).toContain('AWS CLI');
});

test('TC-SET-02 %key% はどの package.nls*.json にもある', () => {
    const keys = new Set<string>();
    const walk = (o: unknown) => {
        if (typeof o === 'string') {
            const m = /^%(.+)%$/.exec(o);
            if (m) {
                keys.add(m[1]);
            }
        } else if (Array.isArray(o)) {
            o.forEach(walk);
        } else if (o && typeof o === 'object') {
            Object.values(o).forEach(walk);
        }
    };
    walk(pkg);
    expect(keys.size).toBeGreaterThan(30);
    const files = fs.readdirSync(ROOT).filter((f) => /^package\.nls(\.[a-z-]+)?\.json$/.test(f)).sort();
    expect(files).toEqual(['package.nls.es.json', 'package.nls.fr.json', 'package.nls.ja.json', 'package.nls.json', 'package.nls.ko.json', 'package.nls.zh-cn.json', 'package.nls.zh-tw.json']);
    for (const f of files) {
        const nls = readJson(f);
        for (const k of keys) {
            expect(typeof nls[k] === 'string' && nls[k].length > 0, `${f}: ${k}`).toBe(true);
        }
    }
    expect(localize('%config.theme.title%', {}, en)).toBe('Theme'); // 無ければ英語
    expect(localize('plain', ja, en)).toBe('plain');
});

test('TC-SET-03 書く前の確かめ', () => {
    const sections = buildSettingsSchema(pkg, en, en);
    const f = (k: string) => findField(sections, k)!;
    expect(checkSettingValue(f('showTranslateButtons'), true)).toEqual({ ok: true, value: true });
    expect(checkSettingValue(f('showTranslateButtons'), 'true').ok).toBe(false);
    expect(checkSettingValue(f('fontSize'), '14')).toEqual({ ok: true, value: 14 });
    expect(checkSettingValue(f('fontSize'), 400)).toEqual({ ok: true, value: 40 }); // 範囲に丸める
    expect(checkSettingValue(f('fontSize'), 'abc').ok).toBe(false);
    expect(checkSettingValue(f('theme'), 'dark')).toEqual({ ok: true, value: 'dark' });
    expect(checkSettingValue(f('theme'), 'sepia').ok).toBe(false);
    expect(checkSettingValue(f('awsRegion'), '  ap-northeast-1 ')).toEqual({ ok: true, value: 'ap-northeast-1' });
    expect(checkSettingValue(f('awsRegion'), 'x'.repeat(5000)).ok).toBe(false);
    expect(checkSettingValue(f('awsRegion'), 3).ok).toBe(false);
    expect(checkSettingValue(f('resourceRoots'), [' ~/notes ', '', '~/notes', '/Volumes/ext'])).toEqual({ ok: true, value: ['~/notes', '/Volumes/ext'] });
    expect(checkSettingValue(f('resourceRoots'), [1]).ok).toBe(false);
    expect(checkSettingValue(f('resourceRoots'), 'not-a-list').ok).toBe(false);
});

test('TC-SET-04 言語', () => {
    expect(nlsSuffix('ja')).toBe('ja');
    expect(nlsSuffix('ja-JP')).toBe('ja');
    expect(nlsSuffix('zh-CN')).toBe('zh-cn');
    expect(nlsSuffix('zh-TW')).toBe('zh-tw');
    expect(nlsSuffix('zh-Hant-HK')).toBe('zh-tw');
    expect(nlsSuffix('ko-KR')).toBe('ko');
    expect(nlsSuffix('en-US')).toBe('');
    expect(nlsSuffix('de')).toBe('');
    expect(nlsSuffix('jam')).toBe(''); // 'ja' で始まるだけの別の言語ではない
    expect(settingsTexts('ja').title).toBe('設定');
    expect(settingsTexts('de').title).toBe('Settings');
});

/** settings-page.ts を JS にして jsdom で動かす（window.fractalSettings は差し替え） */
async function loadPage(state: any) {
    const src = fs.readFileSync(path.join(ROOT, 'electron/src/renderer/settings-page.ts'), 'utf8');
    const js = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="root"></div></body></html>', { runScripts: 'outside-only' });
    const calls: Array<[string, ...unknown[]]> = [];
    let push: (s: any) => void = () => undefined;
    (dom.window as any).fractalSettings = {
        getState: async () => state,
        set: async (key: string, value: unknown) => {
            calls.push(['set', key, value]);
            return { ok: true };
        },
        reset: async (key: string) => {
            calls.push(['reset', key]);
            return { ok: true };
        },
        pick: async (key: string) => {
            calls.push(['pick', key]);
            return '/picked/folder';
        },
        openFile: () => calls.push(['openFile']),
        onState: (l: (s: any) => void) => { push = l; },
        onFocus: () => undefined,
    };
    dom.window.eval(js);
    await new Promise((r) => setTimeout(r, 20));
    return { dom, doc: dom.window.document, calls, push: (s: any) => push(s) };
}

function stateWith(extra: Record<string, unknown> = {}) {
    const sections = buildSettingsSchema(pkg, ja, en);
    const values: Record<string, unknown> = {};
    for (const s of sections) {
        for (const f of s.fields) {
            values[f.key] = f.defaultValue;
        }
    }
    values.resourceRoots = ['~/notes'];
    return { dark: false, texts: settingsTexts('ja'), sections, values, modified: ['resourceRoots'], ...extra };
}

test('TC-SET-05 ページ: 欄を出し、変えたら set、既定に戻す、壊れた settings.json', async () => {
    const { doc, calls, push } = await loadPage(stateWith());
    expect(doc.querySelector('h1')!.textContent).toBe('設定');
    expect(Array.from(doc.querySelectorAll('h2')).map((h) => h.textContent)).toEqual(['表示', 'ファイル', 'PDF の書き出し', 'AWS（S3 同期・翻訳）', '詳細']);
    const row = (key: string) => doc.querySelector(`.row[data-key="${key}"]`) as HTMLElement;

    // 選択肢を変える → set(theme, 'dark')
    const select = row('theme').querySelector('select') as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['自動', 'ライト', 'ダーク']);
    select.value = 'dark';
    select.dispatchEvent(new doc.defaultView!.Event('change'));
    // オン/オフ
    const box = row('showTranslateButtons').querySelector('input[type="checkbox"]') as HTMLInputElement;
    box.checked = true;
    box.dispatchEvent(new doc.defaultView!.Event('change'));
    // 文字は離れたとき（change）に書く
    const region = row('awsRegion').querySelector('input') as HTMLInputElement;
    region.value = 'ap-northeast-1';
    region.dispatchEvent(new doc.defaultView!.Event('change'));
    // シークレットはパスワードの欄
    expect((row('awsSecretAccessKey').querySelector('input') as HTMLInputElement).type).toBe('password');
    // パスの一覧: 今の値を出し、「追加…」で選んだフォルダを足す
    expect(row('resourceRoots').querySelector('.path')!.textContent).toBe('~/notes');
    (Array.from(row('resourceRoots').querySelectorAll('button')).find((b) => b.textContent === '追加…') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls).toEqual([
        ['set', 'theme', 'dark'],
        ['set', 'showTranslateButtons', true],
        ['set', 'awsRegion', 'ap-northeast-1'],
        ['pick', 'resourceRoots'],
        ['set', 'resourceRoots', ['~/notes', '/picked/folder']],
    ]);

    // 既定に戻すは変えた欄だけに見える
    const resetOf = (key: string) => row(key).querySelector('.reset') as HTMLButtonElement;
    expect(resetOf('resourceRoots').style.visibility).toBe('visible');
    expect(resetOf('theme').style.visibility).toBe('hidden');
    resetOf('resourceRoots').click();
    await new Promise((r) => setTimeout(r, 10));
    expect(calls[calls.length - 1]).toEqual(['reset', 'resourceRoots']);

    // 新しい状態で欄の値が変わる（作り直さない）
    const before = row('theme');
    push(stateWith({ values: { ...stateWith().values, theme: 'light' }, modified: ['theme'] }));
    expect(row('theme')).toBe(before);
    expect((row('theme').querySelector('select') as HTMLSelectElement).value).toBe('light');
    expect(resetOf('theme').style.visibility).toBe('visible');

    // settings.json が壊れている: 知らせて、欄は変えられない
    push(stateWith({ error: 'line 3: CloseBraceExpected' }));
    const banner = doc.querySelector('.banner') as HTMLElement;
    expect(banner.style.display).toBe('');
    expect(banner.textContent).toContain('CloseBraceExpected');
    expect((row('theme').querySelector('select') as HTMLSelectElement).disabled).toBe(true);
    expect((row('awsRegion').querySelector('input') as HTMLInputElement).disabled).toBe(true);

    // settings.json を開く
    (Array.from(doc.querySelectorAll('.footer button')) as HTMLButtonElement[])[0].click();
    expect(calls[calls.length - 1]).toEqual(['openFile']);
});
