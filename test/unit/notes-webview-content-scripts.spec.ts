/**
 * 本番 notesWebviewContent.ts は shared JS を fs.readFileSync + <script> 注入で読み込む。
 * 「init 呼び出し（window.__initXxx）は書いたが script 注入を忘れた」class の bug を防ぐ番人。
 *
 * sprint 20260723-233506: notes-tab-manager.js の script 注入漏れで本番タブが全く動かなかった
 * （standalone build は別の 4 点登録機構なので E2E ですり抜けた）。この source-level check で再発を止める。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const SRC = fs.readFileSync(
    path.join(__dirname, '../../src/notesWebviewContent.ts'), 'utf8');

// 本番 webview が init する shared モジュール（window.__initXxx を呼ぶもの）は、
// 対応する *.js を fs.readFileSync し <script> で注入していなければならない。
const REQUIRED = [
    { js: 'notes-tab-manager.js', init: '__initNotesTabManager' },
    { js: 'notes-md-dispatcher.js', init: '__initNotesMdDispatcher' },
    { js: 'notes-history-panel.js', init: '__initNotesHistoryPanel' },
    { js: 'notes-file-panel.js', init: null }, // notesFilePanel.init
];

test.describe('notesWebviewContent.ts — shared script 注入の完全性', () => {
    for (const { js, init } of REQUIRED) {
        test(`${js} が readFileSync + <script> 注入されている`, () => {
            // readFileSync 参照（ファイル名がソースに現れる）
            expect(SRC.includes(js), `${js} を fs.readFileSync していない`).toBe(true);
        });
        if (init) {
            test(`${init} を呼ぶなら対応 script も注入されている（init と script の対）`, () => {
                if (SRC.includes(init + '(')) {
                    // init を呼ぶ = そのモジュールの script が注入されていること（js 名がソースにある）
                    expect(SRC.includes(js), `${init} を呼ぶのに ${js} の注入が無い`).toBe(true);
                }
            });
        }
    }
});
