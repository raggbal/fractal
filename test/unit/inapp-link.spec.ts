/**
 * sprint 20260804-145603 TASK-02b — FR-B11 fractal:// リンク文法の additive 拡張
 *
 * 文法の単一真実 src/shared/inapp-link-utils.js の parse/build を検証する。
 * TC-B11-01/02  既存 node / page link の回帰（従来どおり解釈される）
 * TC-B11-03/04  新形式 out link（2 セグメント）/ md link（/md/ プレフィックス）
 * TC-B11-05     build → parse round-trip（encode 規則 = セグメント encodeURIComponent）
 * TC-B11-06     最長一致順の counterfactual: md link が node link（outFileId='md'）に
 *               誤解釈されない / page link が node link に誤解釈されない
 * TC-B11-07     不正形式は null
 */
import { test, expect } from '@playwright/test';

const utils = require('../../src/shared/inapp-link-utils');

test('TC-B11-01 既存 node link が従来どおり解釈される（回帰）', () => {
    const p = utils.parseFractalLink('fractal://note/mynote/file123/node456');
    expect(p).toEqual({ noteFolderName: 'mynote', outFileId: 'file123', nodeId: 'node456' });
});

test('TC-B11-02 既存 page link が従来どおり解釈される（回帰）', () => {
    const p = utils.parseFractalLink('fractal://note/mynote/file123/page/pg789');
    expect(p).toEqual({ noteFolderName: 'mynote', outFileId: 'file123', pageId: 'pg789' });
});

test('TC-B11-03 新 out link（2 セグメント）が outFileId のみで解釈される', () => {
    const p = utils.parseFractalLink('fractal://note/mynote/file123');
    expect(p).toEqual({ noteFolderName: 'mynote', outFileId: 'file123' });
    expect(p.nodeId).toBeUndefined();
});

test('TC-B11-04 新 md link（/md/ プレフィックス）が mdFileId で解釈される', () => {
    const p = utils.parseFractalLink('fractal://note/mynote/md/1234567890');
    expect(p).toEqual({ noteFolderName: 'mynote', mdFileId: '1234567890' });
});

test('TC-B11-05 build → parse round-trip（日本語・空白 folder 名の encode 込み）', () => {
    const folder = 'メモ note 2026';
    expect(utils.parseFractalLink(utils.buildNodeLink(folder, 'f1', 'n1')))
        .toEqual({ noteFolderName: folder, outFileId: 'f1', nodeId: 'n1' });
    expect(utils.parseFractalLink(utils.buildPageLink(folder, 'f1', 'p1')))
        .toEqual({ noteFolderName: folder, outFileId: 'f1', pageId: 'p1' });
    expect(utils.parseFractalLink(utils.buildOutLink(folder, 'f1')))
        .toEqual({ noteFolderName: folder, outFileId: 'f1' });
    expect(utils.parseFractalLink(utils.buildMdLink(folder, 'm1')))
        .toEqual({ noteFolderName: folder, mdFileId: 'm1' });
    // encode 規則が outliner.js の既存生成（素の文字列連結 + encodeURIComponent）と同一
    expect(utils.buildNodeLink(folder, 'f1', 'n1')).toBe(
        'fractal://note/' + encodeURIComponent(folder) + '/f1/n1');
});

test('TC-B11-06 最長一致順: md/page link が node link に誤解釈されない（counterfactual）', () => {
    // md link が node 判定に先取りされると { outFileId: 'md', nodeId: '...' } になる（=RED）
    const md = utils.parseFractalLink('fractal://note/n/md/abc');
    expect(md.mdFileId).toBe('abc');
    expect(md.outFileId).toBeUndefined();
    expect(md.nodeId).toBeUndefined();
    // page link が node 判定に先取りされると nodeId='page' 系の誤解釈になる（=RED）
    const pg = utils.parseFractalLink('fractal://note/n/f1/page/p1');
    expect(pg.pageId).toBe('p1');
    expect(pg.nodeId).toBeUndefined();
});

test('TC-B11-07 不正形式は null', () => {
    expect(utils.parseFractalLink('fractal://note/onlyfolder')).toBeNull();
    expect(utils.parseFractalLink('fractal://other/a/b')).toBeNull();
    expect(utils.parseFractalLink('https://example.com/a/b')).toBeNull();
    expect(utils.parseFractalLink('fractal://note/a/b/c/d/e')).toBeNull();
});
