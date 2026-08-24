/**
 * file-icon-glyph.spec.ts — file 添付の拡張子別表示アイコン（2026-08-23 ユーザー要望）
 *
 * 写像の単一真実 = MarkdownLinkParser.fileIconGlyph（editor ::before / outliner 添付 /
 * mindmap / folder view / file panel の全消費面が参照）。
 * text viewer 系（txt/js 等）は md の 📄 と紛らわしいため**意図的にクリップ据え置き**（ユーザー裁定）。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const parser = require(path.join(__dirname, '..', '..', 'src', 'shared', 'markdown-link-parser.js'));

test('fileIconGlyph: office/pdf/html は種別 glyph（大文字小文字・レガシー拡張子・query/fragment 耐性）', () => {
    expect(parser.fileIconGlyph('report.pdf')).toBe('📕');
    expect(parser.fileIconGlyph('files/議事録.docx')).toBe('📘');
    expect(parser.fileIconGlyph('DATA.XLSX')).toBe('📗');
    expect(parser.fileIconGlyph('deck.pptx')).toBe('📙');
    expect(parser.fileIconGlyph('page.html')).toBe('🌐');
    expect(parser.fileIconGlyph('old.htm')).toBe('🌐');
    // レガシー Office も同系 glyph
    expect(parser.fileIconGlyph('a.doc')).toBe('📘');
    expect(parser.fileIconGlyph('b.xls')).toBe('📗');
    expect(parser.fileIconGlyph('c.ppt')).toBe('📙');
    // URL の query/fragment は拡張子判定から除外
    expect(parser.fileIconGlyph('files/x.pdf?v=1.2')).toBe('📕');
    expect(parser.fileIconGlyph('files/y.xlsx#Sheet1!A1')).toBe('📗');
});

test('fileIconGlyph: text viewer 系・md・その他はクリップ縮退（意図的 — md 📄 との混同回避）', () => {
    for (const name of ['a.txt', 'b.js', 'c.json', 'd.py', 'e.md', 'f.out', 'g.zip', 'noext', '', null]) {
        expect(parser.fileIconGlyph(name as string), `${name} は 📎`).toBe('📎');
    }
});
