/**
 * Sprint 20260827-172802 TASK-09 — TC-EXF-04: node text → FS 安全名（DOM-FsNameSanitize）
 *
 * FR-EXF-04 / ADRL-0105: 既存 sanitizeTreeFileName（tree item 名向け）は FS 制約を扱わないため
 * Export 専用の新規関数 1 本。連番 uniquify はこの関数の責務外（既存正典 generateUniqueFileNamePreserving）。
 * design/system/outliner-folder-export.md §C3 / §C3-b が仕様。
 */
import { test, expect } from '@playwright/test';
import { sanitizeFsName } from '../../src/shared/folder-export';

const utf8 = (s: string) => Buffer.byteLength(s, 'utf8');

test.describe('DOM-FsNameSanitize（FR-EXF-04）', () => {

    test('TC-EXF-04: 禁止文字・制御文字は `_` に置換', () => {
        const cases: Array<[string, string]> = [
            ['a/b:c', 'a_b_c'],
            ['x*?"<>|y', 'x______y'],           // * ? " < > | の 6 文字
            ['back\\slash', 'back_slash'],
            ['tab\tnl\n', 'tab_nl_'],           // 制御文字も `_`（末尾 `_` は残す = 空白/ドットではない）
            ['plain name', 'plain name'],       // 空白は名前の内部では保持
            ['日本語のフォルダ名', '日本語のフォルダ名'],
            ['a.b.c.md', 'a.b.c.md'],           // 内部のドットは保持
        ];
        for (const [input, expected] of cases) {
            expect(sanitizeFsName(input), `input=${JSON.stringify(input)}`).toBe(expected);
        }
    });

    test('TC-EXF-04: 末尾のドット・空白は除去', () => {
        expect(sanitizeFsName('name.')).toBe('name');
        expect(sanitizeFsName('name ')).toBe('name');
        expect(sanitizeFsName('name...  ')).toBe('name');
        expect(sanitizeFsName('  name')).toBe('  name');   // 先頭の空白は FS 上有効なので保持
    });

    test("TC-EXF-04: 空・空白のみ・. / .. は既定名 'blank' を返す", () => {
        // 仕様（ユーザー裁定 2026-08-30 確定）: node text が空なら **文字列 'blank'** を名前にする。
        // 旧 'export'（発明語）は廃止。連番は衝突したときだけ付く（'blank' → 'blank-1' → …）。
        for (const input of ['', '   ', '.', '..', '. ', '...']) {
            expect(sanitizeFsName(input), `input=${JSON.stringify(input)}`).toBe('blank');
        }
    });

    test("TC-EXF-04b: 見た目が空（全角空白 / NBSP / ゼロ幅文字だけ）の text も 'blank' になる（2026-09-04 実機の「-1」名）", () => {
        // 実機: 空に見える node（U+3000 全角空白 or U+200B）を「linkedfd に送る」と、不可視文字 1 文字の名前が
        // 作られ、同名衝突の 2 件目が `<不可視>-1` = 目には「-1」というフォルダ / ファイルに見えた。
        // 既定名 `blank` の判定は**見た目の空**で行う（ユーザー裁定 2026-08-30「空なら blank」の本来の意図）。
        for (const input of ['\u3000', '\u3000\u3000', '\u00a0', ' \u00a0 ', '\u200b', '\u200b\u200b', '\ufeff', '\u2060', '\u00ad', '\u200b \u3000.']) {
            expect(sanitizeFsName(input), `input=${JSON.stringify(input)}`).toBe('blank');
        }
        // 不可視文字は名前の途中にあっても落とす（`na\u200bme` → `name`）。末尾の全角空白も落とす
        expect(sanitizeFsName('na\u200bme')).toBe('name');
        expect(sanitizeFsName('name\u3000')).toBe('name');
        expect(sanitizeFsName('name\u00a0.')).toBe('name');
        // 先頭の全角空白は（半角と同じく）FS 上有効なので保持する
        expect(sanitizeFsName('\u3000name')).toBe('\u3000name');
        // counterfactual: 旧実装は `[. ]+$` しか見ないので U+3000 が残り、'\u3000' を返していた
        expect(sanitizeFsName('\u3000')).not.toBe('\u3000');
    });

    test('TC-EXF-04: Windows 予約名は `_` 前置（拡張子を除いた base で大小無視判定）', () => {
        expect(sanitizeFsName('CON')).toBe('_CON');
        expect(sanitizeFsName('con.md')).toBe('_con.md');
        expect(sanitizeFsName('NUL')).toBe('_NUL');
        expect(sanitizeFsName('aux.txt')).toBe('_aux.txt');
        expect(sanitizeFsName('COM1')).toBe('_COM1');
        expect(sanitizeFsName('lpt9.pdf')).toBe('_lpt9.pdf');
        // 予約名に似ているが該当しないものは触らない
        expect(sanitizeFsName('CONSOLE')).toBe('CONSOLE');
        expect(sanitizeFsName('COM10')).toBe('COM10');
        expect(sanitizeFsName('conf.md')).toBe('conf.md');
    });

    test('TC-EXF-04: UTF-8 255 バイトへクランプし文字境界を壊さない', () => {
        // 日本語 1 文字 = 3 バイト → 100 文字で 300 バイト（255 超）
        const long = 'あ'.repeat(100);
        const out = sanitizeFsName(long);
        expect(utf8(long), 'fixture 前提: 入力が 255 バイト超').toBeGreaterThan(255);
        expect(utf8(out), '255 バイト以内').toBeLessThanOrEqual(255);
        expect(out, '文字境界を壊さない（U+FFFD が出ない）').not.toContain('�');
        expect(out, 'すべて元の文字で構成される').toBe('あ'.repeat(Math.floor(255 / 3)));

        // サロゲートペア（絵文字 = 4 バイト）も途中で切らない
        const emoji = '😀'.repeat(80); // 320 バイト
        const eOut = sanitizeFsName(emoji);
        expect(utf8(eOut)).toBeLessThanOrEqual(255);
        expect(eOut).not.toContain('�');
        expect(Array.from(eOut).every((c) => c === '😀'), '半端なコードユニットが残らない').toBe(true);
    });

    test('TC-EXF-04: reserveBytes 指定で「拡張子の分」を空けてクランプ（§C3-b の責務）', () => {
        const long = 'あ'.repeat(100);
        const forMd = sanitizeFsName(long, { reserveBytes: 3 });   // '.md'
        expect(utf8(forMd) + 3, '拡張子を足しても 255 以内').toBeLessThanOrEqual(255);
        const forPdf = sanitizeFsName(long, { reserveBytes: 4 });  // '.pdf'
        expect(utf8(forPdf) + 4).toBeLessThanOrEqual(255);
        expect(utf8(forPdf), 'reserveBytes が大きいほど短くなる').toBeLessThan(utf8(forMd));
        // 短い名前は reserveBytes に影響されない
        expect(sanitizeFsName('short', { reserveBytes: 4 })).toBe('short');
        // クランプで全部落ちたら既定名 'blank'
        expect(sanitizeFsName('あ', { reserveBytes: 255 })).toBe('blank');
    });

    test('TC-EXF-04: 置換→末尾除去→既定名→予約名→クランプ の順序で適用される', () => {
        // `/` 置換の結果が末尾ドットを作るケース: 'a/.' → 'a_.' → 末尾ドット除去 → 'a_'
        expect(sanitizeFsName('a/.')).toBe('a_');
        // 置換の結果が空にならないので blank にはならない
        expect(sanitizeFsName('///')).toBe('___');
        // 予約名判定は置換後の文字列に対して行う（'C/ON' → 'C_ON' は予約名ではない）
        expect(sanitizeFsName('C/ON')).toBe('C_ON');
        // 末尾除去の結果が予約名になるケース: 'CON.' → 'CON' → 予約名 → '_CON'
        expect(sanitizeFsName('CON.')).toBe('_CON');
    });
});
