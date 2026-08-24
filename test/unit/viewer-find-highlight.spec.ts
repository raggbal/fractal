/**
 * viewer-find-highlight.spec.ts — find-highlight 共通ユーティリティ（src/webview/viewer-common/find-highlight.mjs）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-01 / TC-VEX-19。
 * jsdom 上で: span ラップ → unwrap の DOM 原状復帰（normalize 比較）/ display:none 配下除外 / 1,000 件上限。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { JSDOM } from 'jsdom';

const MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-common', 'find-highlight.mjs');
const load = async () => await import(/* webpackIgnore: true */ MOD);

function makeRoot(html: string) {
    const dom = new JSDOM(`<!doctype html><body><div id="root">${html}</div></body>`);
    return dom.window.document.getElementById('root')!;
}

test('TC-VEX-19: span ラップと unwrap 原状復帰', async () => {
    const { execFind, clearFind } = await load();
    const root = makeRoot('<p>alpha beta alpha</p><p>gamma <b>alpha</b></p>');
    const before = root.innerHTML;
    const r = execFind(root, 'alpha');
    expect(r.count).toBe(3);
    expect(root.querySelectorAll('span.fv-find-hit').length).toBe(3);
    r.jumpTo(1);
    expect(root.querySelectorAll('span.fv-find-current').length).toBe(1);
    clearFind(root);
    expect(root.querySelectorAll('span.fv-find-hit').length).toBe(0);
    expect(root.innerHTML).toBe(before); // normalize 済み原状復帰
});

test('TC-VEX-19: 大小文字非区別・display:none 配下は対象外', async () => {
    const { execFind } = await load();
    const root = makeRoot('<p>Alpha</p><div style="display:none"><p>alpha hidden</p></div>');
    const r = execFind(root, 'alpha');
    expect(r.count).toBe(1);
});

test('TC-VEX-19: 1,000 件上限', async () => {
    const { execFind } = await load();
    const root = makeRoot(`<p>${'hit '.repeat(1500)}</p>`);
    const r = execFind(root, 'hit');
    expect(r.count).toBe(1000);
});
