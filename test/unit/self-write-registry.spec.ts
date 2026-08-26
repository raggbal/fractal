/**
 * self-write-registry — 自己書き込み台帳（FR-LV-06 基盤 / NFR-SWR-02）
 * sprint 20260825-055613-livereload-selfsave-revert TASK-01
 *
 * TC-SWR-05: registry 単体（vscode/fs 非依存 pure — stub 不要の直 require）
 *   (a) record → isRecentSelfWrite = true / 未記録内容 = false
 *   (b) CRLF 正規化: record('a\nb') に対し isRecentSelfWrite('a\r\nb') = true（逆方向も）
 *   (c) 17 世代 record → 最古の 1 件が false・直近 16 件は true（16 世代リング）
 *   (d) clearSelfWrites 後は全て false
 *   (e) パスキー正規化: 相対/絶対の同一ファイルが同一エントリ
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

// pure モジュール（vscode/fs 非依存）— stub なしで直 require
// eslint-disable-next-line @typescript-eslint/no-var-requires
const registry = require('../../src/shared/self-write-registry');

test.describe('TC-SWR-05: self-write-registry 単体', () => {

    test('(a) record した内容は isRecentSelfWrite=true、未記録内容は false', () => {
        const fp = '/fake/reg/a.md';
        registry.clearSelfWrites(fp);
        expect(registry.isRecentSelfWrite(fp, 'hello')).toBe(false);
        registry.recordSelfWrite(fp, 'hello');
        expect(registry.isRecentSelfWrite(fp, 'hello')).toBe(true);
        expect(registry.isRecentSelfWrite(fp, 'hello!')).toBe(false);
        // 別ファイルのエントリには波及しない
        expect(registry.isRecentSelfWrite('/fake/reg/other.md', 'hello')).toBe(false);
        registry.clearSelfWrites(fp);
    });

    test('(b) CRLF→LF 正規化の双方向一致', () => {
        const fp = '/fake/reg/crlf.md';
        registry.clearSelfWrites(fp);
        registry.recordSelfWrite(fp, 'a\nb');
        expect(registry.isRecentSelfWrite(fp, 'a\r\nb')).toBe(true);
        registry.recordSelfWrite(fp, 'c\r\nd');
        expect(registry.isRecentSelfWrite(fp, 'c\nd')).toBe(true);
        registry.clearSelfWrites(fp);
    });

    test('(c) 16 世代リング — 17 件 record で最古 1 件だけ false', () => {
        const fp = '/fake/reg/ring.md';
        registry.clearSelfWrites(fp);
        const contents: string[] = [];
        for (let i = 0; i < 17; i++) {
            const c = `content-${i}`;
            contents.push(c);
            registry.recordSelfWrite(fp, c);
        }
        expect(registry.isRecentSelfWrite(fp, contents[0]), '最古（17 件目で押し出し）').toBe(false);
        for (let i = 1; i < 17; i++) {
            expect(registry.isRecentSelfWrite(fp, contents[i]), `直近 16 件目内 (${i})`).toBe(true);
        }
        registry.clearSelfWrites(fp);
    });

    test('(c-2) 重複ハッシュの再記録は 1 エントリ（最新位置へ移動 — 押し出しを起こさない）', () => {
        const fp = '/fake/reg/dup.md';
        registry.clearSelfWrites(fp);
        registry.recordSelfWrite(fp, 'first');
        for (let i = 0; i < 20; i++) {
            registry.recordSelfWrite(fp, 'repeated'); // 同一内容の再記録はリングを消費しない
        }
        expect(registry.isRecentSelfWrite(fp, 'first')).toBe(true);
        expect(registry.isRecentSelfWrite(fp, 'repeated')).toBe(true);
        registry.clearSelfWrites(fp);
    });

    test('(d) clearSelfWrites 後は全て false', () => {
        const fp = '/fake/reg/clear.md';
        registry.recordSelfWrite(fp, 'x');
        registry.recordSelfWrite(fp, 'y');
        registry.clearSelfWrites(fp);
        expect(registry.isRecentSelfWrite(fp, 'x')).toBe(false);
        expect(registry.isRecentSelfWrite(fp, 'y')).toBe(false);
    });

    test('(e) パスキー正規化 — 相対/絶対の同一ファイルが同一エントリ', () => {
        const abs = path.resolve('fake-rel/target.md');
        registry.clearSelfWrites(abs);
        registry.recordSelfWrite('fake-rel/target.md', 'via-relative');
        expect(registry.isRecentSelfWrite(abs, 'via-relative')).toBe(true);
        registry.clearSelfWrites(abs);
        expect(registry.isRecentSelfWrite('fake-rel/target.md', 'via-relative')).toBe(false);
    });
});
