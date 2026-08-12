/**
 * Sprint 20260812-110538 再オープン①(2): removeMdAnchorFromFile — 元 md からの
 * アンカー fs 直接除去(webview エコー非依存。mindmap 表示中 = md instance 不在でも消える)
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { removeMdAnchorFromFile } = require('../../out/shared/md-anchor-remove');

function tmpMd(content: string): string {
    const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'rma-')), 'src.md');
    fs.writeFileSync(p, content, 'utf8');
    return p;
}

test('TC-RMA-01 file link anchor is removed from fs', () => {
    const p = tmpMd('before [📎 doc.pdf](files/doc.pdf) after\n');
    removeMdAnchorFromFile(p, 'files/doc.pdf');
    const out = fs.readFileSync(p, 'utf8');
    expect(out).not.toContain('files/doc.pdf');
    expect(out).toContain('before');
    expect(out).toContain('after');
});

test('TC-RMA-02 subpage double-bracket anchor is removed', () => {
    const p = tmpMd('- item\n[[Sub Page]](sub-page.md)\ntail\n');
    removeMdAnchorFromFile(p, 'sub-page.md');
    const out = fs.readFileSync(p, 'utf8');
    expect(out).not.toContain('sub-page.md');
    expect(out).toContain('tail');
});

test('TC-RMA-03 only first matching anchor removed; others intact', () => {
    const p = tmpMd('[a](files/x.pdf) and [b](files/y.pdf)\n');
    removeMdAnchorFromFile(p, 'files/x.pdf');
    const out = fs.readFileSync(p, 'utf8');
    expect(out).not.toContain('files/x.pdf');
    expect(out).toContain('files/y.pdf');
});

test('TC-RMA-04 special-char href (parens-encoded, dots) removes safely', () => {
    const p = tmpMd('x [r](files/Report%20(2).pdf) y\n');
    removeMdAnchorFromFile(p, 'files/Report%20(2).pdf');
    const out = fs.readFileSync(p, 'utf8');
    expect(out).not.toContain('Report%20(2).pdf');
    expect(out).toContain('x');
    expect(out).toContain('y');
});

test('TC-RMA-05 no match leaves file byte-identical', () => {
    const content = 'no links here\n';
    const p = tmpMd(content);
    removeMdAnchorFromFile(p, 'files/none.pdf');
    expect(fs.readFileSync(p, 'utf8')).toBe(content);
});
