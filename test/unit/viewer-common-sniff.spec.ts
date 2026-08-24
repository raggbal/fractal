/**
 * viewer-common-sniff.spec.ts — text-sniff webview 移植（src/webview/viewer-common/text-sniff.mjs）
 *
 * sprint 20260823-165314-viewer-office-text-image TASK-01 / TC-VEX-08。
 * 判定順の正典 = doc-text-extract.ts sniffAndDecodeText（BOM ①UTF-8 ②UTF-16LE ③UTF-16BE → ④NUL → ⑤UTF-8 fallback）。
 * 同一 fixture を正典（Node 版）にも通し、text 結果が一致することで移植の同順序を照合する。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';
import { sniffAndDecodeText as canonical } from '../../src/shared/doc-text-extract';

const MOD = path.join(__dirname, '..', '..', 'src', 'webview', 'viewer-common', 'text-sniff.mjs');
const load = async () => await import(/* webpackIgnore: true */ MOD);
const toU8 = (b: Buffer): Uint8Array => new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

const CASES: Array<{ name: string; buf: Buffer; binary?: boolean }> = [
    { name: 'UTF-8 BOM', buf: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('あ BOM utf8', 'utf8')]) },
    { name: 'UTF-16LE BOM', buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('日本語LE', 'utf16le')]) },
    {
        name: 'UTF-16BE BOM',
        buf: (() => {
            const le = Buffer.from('大文字BE', 'utf16le');
            const be = Buffer.from(le); be.swap16();
            return Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
        })(),
    },
    { name: 'NUL バイナリ', buf: Buffer.concat([Buffer.from('abc'), Buffer.from([0x00]), Buffer.from('def')]), binary: true },
    { name: 'BOM なし UTF-8 fallback', buf: Buffer.from('plain text 日本語\nline2', 'utf8') },
    // BOM 判定が NUL 検査より先（UTF-16 は ASCII が NUL を含む）— 正典コメントの不変条件
    { name: 'UTF-16LE の ASCII（NUL を含むが BOM が先勝ち）', buf: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('ascii', 'utf16le')]) },
];

test.describe('TC-VEX-08 + TC-TXV-06: sniff 判定順の正典一致', () => {
    for (const c of CASES) {
        test(c.name, async () => {
            const { sniffAndDecodeText } = await load();
            const ported = sniffAndDecodeText(toU8(c.buf));
            const canon = canonical(c.buf);
            if (c.binary) {
                expect(ported).toBeNull();
                expect(canon).toBeNull();
            } else {
                expect(ported).not.toBeNull();
                expect(canon).not.toBeNull();
                expect(ported!.text).toBe(canon!.text);
            }
        });
    }
});
