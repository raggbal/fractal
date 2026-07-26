/**
 * バグ修正 (2026-07-26): note を開いたときツリー先頭が md item だと、md 本文が
 * jsonContent として webview に渡り JSON.parse が落ちて空 outliner が表示されていた。
 * 修正: initialMd で md ペイン初期表示に分岐。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const webviewContentSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/notesWebviewContent.ts'), 'utf-8');
const providerSrc = fs.readFileSync(
    path.resolve(__dirname, '../../src/notesEditorProvider.ts'), 'utf-8');

test('TC-IMD-01 provider: 初期ファイルが .md なら jsonContent でなく initialMd に入れる', () => {
    // 初期 open ブロックに md 分岐がある（.md → initialMdContent / それ以外 → jsonContent）
    expect(providerSrc).toMatch(/fp\.endsWith\('\.md'\)\s*\)\s*\{\s*initialMdContent = content;/);
    // initialMd を initData として渡している
    expect(providerSrc).toMatch(/initialMd:\s*\(initialMdContent !== null && currentFilePath\)/);
    // 初期 md にも外部変更 watcher（mdMain.setupFileWatcher）を張る
    expect(providerSrc).toMatch(/initialMdContent !== null && currentFilePath\) \{\s*const initialMdPath/);
});

test('TC-IMD-02 webview: initialMd があれば dispatcher.loadMarkdown で md ペイン初期表示 + タブ kind=md', () => {
    // loadMarkdown 呼び出し（初期 md 分岐）
    expect(webviewContentSrc).toContain('window.__notesMdDispatcher.loadMarkdown(');
    expect(webviewContentSrc).toContain("var __initialMdB64 = '${initialMdB64}'");
    // initFirstTab の kind が initialMd 有無で md/out に分岐
    expect(webviewContentSrc).toContain("${initData.initialMd ? \"'md'\" : \"'out'\"}");
});

test('TC-IMD-03 refresh 経路: 現ファイルが .md なら refreshInitialMd に分岐（theme 変更で空 outliner に戻らない）', () => {
    expect(providerSrc).toMatch(/refreshCurrentFile\.endsWith\('\.md'\)\)\s*\{\s*refreshInitialMd = \{/);
    expect(providerSrc).toContain('initialMd: refreshInitialMd');
});
