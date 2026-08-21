/**
 * TC-CAN-01..04 — 複製系の正典集約（sprint 20260819-231621 TASK-01..04）
 *
 * - copyEntityWithUniquify: file 実体コピー正典（uniquify+copyFileSync・成功=dstAbs/失敗=null）を
 *   notes-message-handler の module-local から paste-asset-handler へ export 移設
 * - replicateMdClosureToDest: md closure 複製フェーズ（copyMdPasteAssets フェーズ B と
 *   handlePageAssets mdLinks ブロックの逐語重複 ~35 行 × 2）の共通エンジン
 *
 * 挙動 byte 互換が絶対条件の sprint — 本旨の証明は既存複製系 spec の回帰 green。
 * ここでは canon/エンジンの unit + 分散残存ゼロの grep 番人のみを持つ。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.join(__dirname, '..', '..');

function mkTmp(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('TC-CAN-01 copyEntityWithUniquify（export 正典）: 成功=dstAbs + uniquify / src 不在=null 副作用ゼロ', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pah = require('../../src/shared/paste-asset-handler');
    expect(typeof pah.copyEntityWithUniquify, 'copyEntityWithUniquify の export 不在').toBe('function');
    const src = mkTmp('can-src-');
    const dst = mkTmp('can-dst-');
    fs.writeFileSync(path.join(src, 'doc.pdf'), 'PDF-1', 'utf8');

    // 1 回目 = 元名保持
    const r1 = pah.copyEntityWithUniquify(path.join(src, 'doc.pdf'), dst, 'doc.pdf');
    expect(r1).toBe(path.join(dst, 'doc.pdf'));
    expect(fs.readFileSync(r1, 'utf8')).toBe('PDF-1');
    // 2 回目 = uniquify -1（既存契約: generateUniqueFileNamePreserving 正典の命名）
    const r2 = pah.copyEntityWithUniquify(path.join(src, 'doc.pdf'), dst, 'doc.pdf');
    expect(r2).toBe(path.join(dst, 'doc-1.pdf'));
    // src 不在 = null + dst 副作用ゼロ
    const before = fs.readdirSync(dst).length;
    const r3 = pah.copyEntityWithUniquify(path.join(src, 'missing.pdf'), dst, 'missing.pdf');
    expect(r3).toBeNull();
    expect(fs.readdirSync(dst).length).toBe(before);
});

test('TC-CAN-02a/c grep 番人: nmh の module-local 定義と importMdSubpageIntoOut の裸コピーが残存しない', () => {
    const nmh = fs.readFileSync(path.join(ROOT, 'src/shared/notes-message-handler.ts'), 'utf8');
    // (a) module-local 定義の残存ゼロ（import 経由のみ）
    expect(/function copyEntityWithUniquify\(/.test(nmh),
        'notes-message-handler に module-local copyEntityWithUniquify が残存').toBe(false);
    expect(nmh.includes('copyEntityWithUniquify'), 'canon の import/使用が消えている（置換でなく削除）').toBe(true);
    // (c) importMdSubpageIntoOut 関数本体に裸の fs.copyFileSync が残存しない（canon 経由のみ）。
    // sprint 20260820-063902（許可: test_update — FR-ACC-03）: 経由 canon は copyEntityWithUniquify →
    // 随伴転送 transferMdWithAssets へ変更（cross-note md は資産随伴が仕様になったため）
    const fnStart = nmh.indexOf('export function importMdSubpageIntoOut');
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = nmh.indexOf('\nexport function', fnStart + 10);
    const body = nmh.slice(fnStart, fnEnd);
    expect(body.includes('fs.copyFileSync'),
        'importMdSubpageIntoOut に裸の fs.copyFileSync が残存（canon 未経由）').toBe(false);
    expect(body.includes('transferMdWithAssets'), '随伴転送 canon 呼び出しが実在しない').toBe(true);
});

test('TC-CAN-02b grep 番人: editorProvider のローカル generateUniqueFileNamePreserving が残存しない（shared 正典 import のみ）', () => {
    const ep = fs.readFileSync(path.join(ROOT, 'src/editorProvider.ts'), 'utf8');
    // ローカル再実装の残存ゼロ（ADRL-0005「新規衝突解決ロジック禁止」への完全準拠）
    expect(/\nfunction generateUniqueFileNamePreserving\(/.test(ep),
        'editorProvider にローカル generateUniqueFileNamePreserving が残存').toBe(false);
    // shared 正典の import + 使用が実在（削除でなく置換であることの対の番人）
    expect(/import \{[^}]*generateUniqueFileNamePreserving[^}]*\} from '\.\/shared\/paste-asset-handler'/.test(ep)
        || /generateUniqueFileNamePreserving[,\s][^}]*\} = require\('\.\/shared\/paste-asset-handler'\)/.test(ep),
        'shared 正典の import が無い').toBe(true);
    expect((ep.match(/generateUniqueFileNamePreserving\(/g) || []).length,
        '使用サイト（:2047/:2095 の 2 箇所）が消えている').toBeGreaterThanOrEqual(2);
});

test('TC-CAN-03 replicateMdClosureToDest: closure 2 md を dest へ uniquify 複製 + nameMap 返却 + リンクが dest 内で閉じる', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pah = require('../../src/shared/paste-asset-handler');
    expect(typeof pah.replicateMdClosureToDest, 'replicateMdClosureToDest の export 不在').toBe('function');
    const srcNote = mkTmp('can-eng-src-');
    const destMd = mkTmp('can-eng-dmd-');
    const destImg = path.join(destMd, 'images');
    const destFile = path.join(destMd, 'files');
    fs.mkdirSync(path.join(srcNote, 'images'), { recursive: true });
    fs.writeFileSync(path.join(srcNote, 'images', 'pic.png'), 'PNG', 'utf8');
    const aAbs = path.join(srcNote, 'a.md');
    const bAbs = path.join(srcNote, 'b.md');
    fs.writeFileSync(aAbs, '# A\n![i](images/pic.png)\n[to b](b.md)\n', 'utf8');
    fs.writeFileSync(bAbs, '# B\n[back to a](a.md)\n', 'utf8');
    // dest に a.md が既存 → 複製は a-1.md へ uniquify（衝突時の命名 = 既存挙動 pin）
    fs.writeFileSync(path.join(destMd, 'a.md'), 'EXISTING', 'utf8');

    const nameMap = pah.replicateMdClosureToDest({
        closure: [aAbs, bAbs], destMdDir: destMd, destImageDir: destImg, destFileDir: destFile,
    });
    // nameMap = srcAbs → destMdDir 基準 rel（uniquify 済み）
    expect(nameMap.get(aAbs)).toBe('a-1.md');
    expect(nameMap.get(bAbs)).toBe('b.md');
    // 複製側のリンクは dest 内の新名で閉じる（b の a 参照 → a-1.md）
    const bBody = fs.readFileSync(path.join(destMd, 'b.md'), 'utf8');
    expect(bBody).toContain('(a-1.md)');
    // a の画像は destImageDir へ複製され本文が書き換わる
    const aBody = fs.readFileSync(path.join(destMd, 'a-1.md'), 'utf8');
    expect(fs.readdirSync(destImg).length).toBe(1);
    const imgName = fs.readdirSync(destImg)[0];
    expect(aBody).toContain(`images/${imgName}`);
    // a→b 方向: b.md は dest で同名のまま → a-1.md のリンクは '(b.md)' で dest 内に閉じる（実 assert）
    expect(aBody).toContain('](b.md)');
    // 元 md 群は byte 不変・dest 既存ファイルも不変
    expect(fs.readFileSync(aAbs, 'utf8')).toContain('images/pic.png');
    expect(fs.readFileSync(bAbs, 'utf8')).toContain('(a.md)');
    expect(fs.readFileSync(path.join(destMd, 'a.md'), 'utf8')).toBe('EXISTING');
});

test('TC-CAN-04 grep 番人: closure 複製ループの字面重複が残存しない（エンジン 1 箇所 + 呼び出し 2 サイト）', () => {
    const pahSrc = fs.readFileSync(path.join(ROOT, 'src/shared/paste-asset-handler.ts'), 'utf8');
    // 複製ループの実体（closureNameMap 構築）はエンジン内の 1 箇所のみ
    expect((pahSrc.match(/const closureNameMap = new Map/g) || []).length,
        'closure 複製ループの字面が複数残存（copyMdPasteAssets / handlePageAssets に未集約の重複）').toBe(1);
    // 両呼び出しサイト（copyMdPasteAssets / handlePageAssets）はエンジン呼び出しに置換済み
    expect((pahSrc.match(/= replicateMdClosureToDest\(\{/g) || []).length,
        'エンジン呼び出しサイトが 2 箇所（copyMdPasteAssets + handlePageAssets）に配線されていない').toBe(2);
});
