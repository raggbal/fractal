/**
 * TASK-02 / FR-KBS-01 / NFR-KBS-01
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / GitHub issue #2）
 *
 * `contributes.keybindings` の `when` 句スコープの番人。
 *
 * 背景（GitHub issue #2 / @CMCFL / Theia v1.75 / FractalNote v1.3.7）:
 * 報告は「Ctrl+A =『Select all nodes』がグローバル発火する」だったが、`ctrl+a` は
 * `contributes.keybindings` に存在せず（`git log -S'"ctrl+a"' -- package.json` = 0 件）
 * その機構では成立しない。一方で `fractal.redo` の 2 件だけが `when: "!editorTextFocus"`
 * （テキストエディタにフォーカスが無ければ真 ≒ ほぼどこでも真）で、**報告された defect クラス
 * （拡張コンテキスト外でのグローバル発火）自体は実在していた**。
 *
 * - TC-KBS-01: `!editorTextFocus` 単独のエントリが 0 件（NFR-KBS-01）
 * - TC-KBS-02: redo の `when` が自前エディタ面に限定されている
 * - TC-KBS-03: `ctrl+a` が keybindings に無い（Cmd+A は webview 内ハンドラ = TASK-12 の担当）
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

interface Keybinding {
    key?: string;
    mac?: string;
    command?: string;
    when?: string;
}

function readKeybindings(): Keybinding[] {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const kb = pkg?.contributes?.keybindings;
    // 前提が崩れたら vacuous pass にせず fail させる
    expect(Array.isArray(kb), 'package.json の contributes.keybindings が配列でない').toBe(true);
    expect(kb.length, 'keybindings が空 — 検査が空回りする').toBeGreaterThan(0);
    return kb as Keybinding[];
}

test.describe('contributes.keybindings の when スコープ（FR-KBS-01）', () => {
    test('TC-KBS-01 `!editorTextFocus` 単独の when を持つエントリが 0 件', () => {
        const kb = readKeybindings();
        const offenders = kb.filter((k) => (k.when || '').trim() === '!editorTextFocus');
        expect(
            offenders.map((k) => `${k.key} → ${k.command}`),
            '`!editorTextFocus` 単独はテキストエディタ外のほぼ全域で真になり、'
            + '拡張コンテキスト外でキーを奪う（GitHub issue #2 の defect クラス）',
        ).toEqual([]);
    });

    test('TC-KBS-02 fractal.redo の when が自前カスタムエディタ面に限定されている', () => {
        const kb = readKeybindings();
        const redos = kb.filter((k) => k.command === 'fractal.redo');
        // 前提: redo の binding が存在する（消えていたらこの TC は無意味）
        expect(redos.length, 'fractal.redo の keybinding が無い').toBeGreaterThan(0);

        for (const k of redos) {
            const when = k.when || '';
            expect(when, `${k.key} の when が空 = 常時グローバル`).not.toBe('');
            // 自前エディタ面の限定が入っていること
            expect(
                when.includes('activeCustomEditorId'),
                `${k.key} の when に activeCustomEditorId が無い（面の限定が効かない）: ${when}`,
            ).toBe(true);
        }
    });

    test('TC-KBS-03 ctrl+a / cmd+a が keybindings に無い（ホストへグローバル登録しない）', () => {
        const kb = readKeybindings();
        const aBindings = kb.filter((k) => {
            const keys = [k.key, k.mac].filter(Boolean).map((s) => String(s).toLowerCase());
            return keys.some((s) => s === 'ctrl+a' || s === 'cmd+a');
        });
        expect(
            aBindings.map((k) => `${k.key}/${k.mac} → ${k.command}`),
            'Cmd+A は webview 内ハンドラで扱う（FR-MSEL-06）。ホストへの keybinding 登録はしない',
        ).toEqual([]);
    });
});
