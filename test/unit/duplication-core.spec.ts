/**
 * DuplicationCore（sprint 20260818-183407 TASK-07 / ADRL-0078）
 *
 * testcases.md 上の専用 TC は無い（消費側 TC-MDM-06/07・TC-FTM-03..06 が実 green 化で保証）が、
 * core の実体分離・uniquify 正典・deep copy の基本性質をここで pin する
 * （naive fs.copyFile 単体 = asset 1:1 invariant 破りの counterfactual）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    duplicateFileEntity,
    duplicateMdEntity,
    duplicateOutEntity,
} from '../../src/shared/paste-asset-handler';

function mkNote(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'dup-core-'));
}
function writeF(dir: string, rel: string, content: string): string {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
}

test('DUP-01 duplicateFileEntity: files/ 実体を uniquify 複製（元は不変）', () => {
    const note = mkNote();
    writeF(note, 'files/doc.pdf', 'PDF-1');
    const newName = duplicateFileEntity(path.join(note, 'files'), 'doc.pdf');
    expect(newName).toBe('doc-1.pdf'); // generateUniqueFileNamePreserving 正典の命名
    expect(fs.readFileSync(path.join(note, 'files', 'doc-1.pdf'), 'utf8')).toBe('PDF-1');
    expect(fs.readFileSync(path.join(note, 'files', 'doc.pdf'), 'utf8')).toBe('PDF-1');
    // 実体分離: 複製を編集しても元不変
    fs.writeFileSync(path.join(note, 'files', 'doc-1.pdf'), 'PDF-EDITED');
    expect(fs.readFileSync(path.join(note, 'files', 'doc.pdf'), 'utf8')).toBe('PDF-1');
});

test('DUP-02 duplicateMdEntity: 本文参照 asset を複製しリンク書換（subpage は再帰複製・参照リンクは共有温存）', () => {
    // 2026-08-19 改訂（許可: test_update — ADRL-0078 Consequences 改訂 = subpage 再帰複製する）
    const note = mkNote();
    writeF(note, 'images/pic.png', 'PNG-1');
    writeF(note, 'files/att.pdf', 'ATT-1');
    writeF(note, 'other.md', '# Other\n');
    writeF(note, 'shared.md', '# Shared\n');
    const mdAbs = writeF(note, 'page.md',
        '# P\n![i](images/pic.png)\n[📎 att.pdf](files/att.pdf)\n[[Other]](other.md)\n[ref](shared.md)\n');

    const r = duplicateMdEntity(mdAbs, note);
    expect(r.newStem).toBe('page-1');
    const newBody = fs.readFileSync(r.newMdPath, 'utf8');
    // asset は複製新名を指す（元 asset を共有しない = 1:1）
    expect(newBody).toContain('images/pic-1.png');
    expect(newBody).toContain('files/att-1.pdf');
    expect(fs.existsSync(path.join(note, 'images/pic-1.png'))).toBe(true);
    expect(fs.existsSync(path.join(note, 'files/att-1.pdf'))).toBe(true);
    // subpage リンクは再帰複製され新名を指す（ADRL-0078 改訂版）
    expect(newBody).toContain('(other-1.md)');
    expect(fs.existsSync(path.join(note, 'other-1.md'))).toBe(true);
    expect(fs.readFileSync(path.join(note, 'other-1.md'), 'utf8')).toContain('# Other');
    // 参照リンク（非 subpage）は複製しない = 共有参照温存（counterfactual）
    expect(newBody).toContain('(shared.md)');
    expect(fs.existsSync(path.join(note, 'shared-1.md'))).toBe(false);
    // 元 md は byte 不変
    expect(fs.readFileSync(mdAbs, 'utf8')).toContain('images/pic.png');
    expect(fs.readFileSync(mdAbs, 'utf8')).toContain('(other.md)');
});

test('DUP-04 duplicateMdEntity 再帰チェーン + 循環: root→[[A]]→[[B]]→[[A]] が各 1 個の複製で閉じる', () => {
    const note = mkNote();
    writeF(note, 'images/a.png', 'A-PNG');
    writeF(note, 'a.md', '# A\n![x](images/a.png)\n[[B]](b.md)\n');
    writeF(note, 'b.md', '# B\n[[A]](a.md)\n');
    const rootAbs = writeF(note, 'root.md', '# Root\n[[A]](a.md)\n');

    const r = duplicateMdEntity(rootAbs, note);
    expect(r.newStem).toBe('root-1');
    // 循環しても a/b は各 1 個だけ複製される（visited set 打ち切り）
    expect(fs.existsSync(path.join(note, 'a-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(note, 'b-1.md'))).toBe(true);
    expect(fs.existsSync(path.join(note, 'a-2.md'))).toBe(false);
    expect(fs.existsSync(path.join(note, 'b-2.md'))).toBe(false);
    // 複製グラフは新名で閉じる: root-1→a-1→b-1→a-1
    expect(fs.readFileSync(r.newMdPath, 'utf8')).toContain('(a-1.md)');
    const a1 = fs.readFileSync(path.join(note, 'a-1.md'), 'utf8');
    expect(a1).toContain('(b-1.md)');
    expect(a1).toContain('images/a-1.png'); // 下位 subpage の asset も複製
    expect(fs.existsSync(path.join(note, 'images/a-1.png'))).toBe(true);
    expect(fs.readFileSync(path.join(note, 'b-1.md'), 'utf8')).toContain('(a-1.md)');
    // 元 3 md は byte 不変
    expect(fs.readFileSync(path.join(note, 'a.md'), 'utf8')).toContain('(b.md)');
    expect(fs.readFileSync(path.join(note, 'b.md'), 'utf8')).toContain('(a.md)');
    expect(fs.readFileSync(rootAbs, 'utf8')).toContain('(a.md)');
});

test('DUP-05 noteDir 境界: 自note外への subpage リンクは複製されずリンク不変（省略時 fallback = dirname(md)）', () => {
    const base = mkNote();
    const note = path.join(base, 'note');
    writeF(base, 'outside/x.md', '# X\n');
    const mdAbs = writeF(note, 'page.md', '# P\n[[X]](../outside/x.md)\n');

    const r = duplicateMdEntity(mdAbs, note);
    const newBody = fs.readFileSync(r.newMdPath, 'utf8');
    // 自note外（ADRL-0002 同一裁定）→ 複製せずリンク不変
    expect(newBody).toContain('(../outside/x.md)');
    expect(fs.existsSync(path.join(base, 'outside/x-1.md'))).toBe(false);

    // noteDirAbs 省略時 fallback = dirname(md): 同 dir の subpage は複製される
    writeF(note, 'sub.md', '# Sub\n');
    const md2 = writeF(note, 'page2.md', '# P2\n[[Sub]](sub.md)\n[[X]](../outside/x.md)\n');
    const r2 = duplicateMdEntity(md2);
    const body2 = fs.readFileSync(r2.newMdPath, 'utf8');
    expect(body2).toContain('(sub-1.md)');
    expect(body2).toContain('(../outside/x.md)');
    expect(fs.existsSync(path.join(note, 'sub-1.md'))).toBe(true);
});

test('DUP-03 duplicateOutEntity: page md / filePath / images を deep copy し参照書換', () => {
    const note = mkNote();
    writeF(note, 'pg1.md', '# Page1\n![x](images/inner.png)\n');
    writeF(note, 'images/inner.png', 'INNER');
    writeF(note, 'files/n2.bin', 'BIN');
    writeF(note, 'images/n3.png', 'N3');
    const outAbs = writeF(note, 'myout.out', JSON.stringify({
        version: 1,
        title: 'My Out',
        rootIds: ['n1', 'n2', 'n3'],
        nodes: {
            n1: { id: 'n1', text: 'page node', isPage: true, pageId: 'pg1', children: [] },
            n2: { id: 'n2', text: 'file node', filePath: 'files/n2.bin', children: [] },
            n3: { id: 'n3', text: 'img node', images: ['images/n3.png'], children: [] },
        },
    }));

    const r = duplicateOutEntity(outAbs, note);
    expect(r.newOutId).toBe('myout-1');
    const dup = JSON.parse(fs.readFileSync(r.newOutPath, 'utf8'));
    // pageId は複製された md の新 stem
    expect(dup.nodes.n1.pageId).toBe('pg1-1');
    expect(fs.existsSync(path.join(note, 'pg1-1.md'))).toBe(true);
    // page md 本文の asset も複製されている（2 段 deep copy）
    expect(fs.readFileSync(path.join(note, 'pg1-1.md'), 'utf8')).toContain('images/inner-1.png');
    // filePath / images も複製新名
    expect(dup.nodes.n2.filePath).toBe('files/n2-1.bin');
    expect(dup.nodes.n3.images[0]).toBe('images/n3-1.png');
    expect(fs.existsSync(path.join(note, 'files/n2-1.bin'))).toBe(true);
    expect(fs.existsSync(path.join(note, 'images/n3-1.png'))).toBe(true);
    // 元 .out は byte 不変・title は uniquify 追従
    expect(JSON.parse(fs.readFileSync(outAbs, 'utf8')).nodes.n1.pageId).toBe('pg1');
    expect(dup.title).toBe('My Out-1');
    // 実体分離: 複製側 page md を書き換えても元 pg1.md 不変
    fs.writeFileSync(path.join(note, 'pg1-1.md'), 'EDITED');
    expect(fs.readFileSync(path.join(note, 'pg1.md'), 'utf8')).toContain('# Page1');
});

test('DUP-06 duplicateOutEntity 再帰: page md の subpage とその画像も複製される（3 段 deep copy）', () => {
    // 2026-08-19 改訂（ADRL-0078 改訂版 — page md → subpage md → その asset の再帰）
    const note = mkNote();
    writeF(note, 'images/deep.png', 'DEEP');
    writeF(note, 'sub.md', '# Sub\n![d](images/deep.png)\n');
    writeF(note, 'pg1.md', '# Page1\n[[Sub]](sub.md)\n');
    const outAbs = writeF(note, 'myout.out', JSON.stringify({
        version: 1,
        title: 'My Out',
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', text: 'page node', isPage: true, pageId: 'pg1', children: [] } },
    }));

    const r = duplicateOutEntity(outAbs, note);
    const dup = JSON.parse(fs.readFileSync(r.newOutPath, 'utf8'));
    expect(dup.nodes.n1.pageId).toBe('pg1-1');
    // 複製側 page md は複製 subpage を指し、subpage の画像も複製される
    expect(fs.readFileSync(path.join(note, 'pg1-1.md'), 'utf8')).toContain('(sub-1.md)');
    expect(fs.readFileSync(path.join(note, 'sub-1.md'), 'utf8')).toContain('images/deep-1.png');
    expect(fs.existsSync(path.join(note, 'images/deep-1.png'))).toBe(true);
    // 元は byte 不変
    expect(fs.readFileSync(path.join(note, 'pg1.md'), 'utf8')).toContain('(sub.md)');
    expect(fs.readFileSync(path.join(note, 'sub.md'), 'utf8')).toContain('images/deep.png');
});
