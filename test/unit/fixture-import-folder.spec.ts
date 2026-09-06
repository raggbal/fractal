/**
 * TASK-04 の完了条件 smoke — 外部フォルダ fixture の 4 派生が意図どおり組めていることを確認する。
 * （sprint 20260901-075849-multiselect-dnd-copy-sendto-menufit / FR-OIF-05/06/07 の検証前提）
 *
 * fixture 側が壊れていると TC-OIF-10..19 が vacuous pass になるため、
 * 「a.md の参照が意図どおり解決される」ことを独立に固定する。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { makeImportFolderFixture, makeDestNote } from '../utils/fixture-import-folder';

/** md 本文から参照を素朴に取り出す（fixture 検証用。本番の closure 抽出は CLEANUP_MD_LINK_RE が正典）。 */
function refsOf(mdAbs: string): string[] {
    const body = fs.readFileSync(mdAbs, 'utf8');
    const out: string[] = [];
    const re = /!?\[\[?[^\]]*\]?\]\(([^)]+)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) { out.push(m[1]); }
    return out;
}

test('TASK-04 smoke: basic — closure 4 件と closure 外 1 件が実在し、参照が解決できる', () => {
    const fx = makeImportFolderFixture('basic');
    try {
        // closure / nonClosure に挙げた実体がすべて存在する
        for (const rel of [...fx.closure, ...fx.nonClosure]) {
            expect(fs.existsSync(path.join(fx.target, rel)), `${rel} が無い`).toBe(true);
        }
        expect(fx.closure.sort()).toEqual(['a.md', 'files/spec.pdf', 'images/pic.png', 'sub.md']);
        expect(fx.nonClosure).toEqual(['images/orphan.png']);

        // a.md の参照 3 本が target 起点で実在する（= closure 判定の入力が正しい）
        const refs = refsOf(path.join(fx.target, 'a.md'));
        expect(refs.sort()).toEqual(['files/spec.pdf', 'images/pic.png', 'sub.md']);
        for (const r of refs) {
            expect(fs.existsSync(path.join(fx.target, r)), `参照 ${r} が解決できない`).toBe(true);
        }

        // subpage が [[label]](sub.md) 形式で書かれている（TC-OIF-13 の要 — この形式が要点）
        const body = fs.readFileSync(path.join(fx.target, 'a.md'), 'utf8');
        expect(body, '[[label]](x.md) 形式の subpage が無いと関数 pin の番人が空回りする')
            .toContain('[[sub]](sub.md)');

        // closure 外は a.md から参照されていない（前提が崩れると TC-OIF-11 が無意味になる）
        expect(refs).not.toContain('images/orphan.png');
    } finally {
        fx.cleanup();
    }
});

test('TASK-04 smoke: no-md — md が 1 つも無い（TC-OIF-12 の回帰確認用）', () => {
    const fx = makeImportFolderFixture('no-md');
    try {
        const mds = fs.readdirSync(fx.target).filter((f) => f.endsWith('.md'));
        expect(mds, 'md があると「md 無しフォルダは従来どおり」の検証にならない').toEqual([]);
        expect(fx.closure).toEqual([]);
        expect(fx.nonClosure).toEqual(['files/x.pdf']);
        expect(fs.existsSync(path.join(fx.target, 'files', 'x.pdf'))).toBe(true);
    } finally {
        fx.cleanup();
    }
});

test('TASK-04 smoke: deep — 中間 dir 3 段の最深部にだけ closure 外がある（TC-OIF-18）', () => {
    const fx = makeImportFolderFixture('deep');
    try {
        expect(fx.nonClosure).toEqual(['deep/a/b/x.pdf']);
        expect(fs.existsSync(path.join(fx.target, 'deep', 'a', 'b', 'x.pdf'))).toBe(true);
        // 中間 dir に直接の実体が無いこと（「直下だけ見る」実装が RED になる条件）
        for (const d of ['deep', path.join('deep', 'a')]) {
            const entries = fs.readdirSync(path.join(fx.target, d), { withFileTypes: true });
            expect(entries.filter((e) => e.isFile()).length, `${d} に直下ファイルがあると行 3 の検証が弱まる`).toBe(0);
        }
    } finally {
        fx.cleanup();
    }
});

test('TASK-04 smoke: urlencoded — 実名はスペース入り / 参照は %20（TC-OIF-14）', () => {
    const fx = makeImportFolderFixture('urlencoded');
    try {
        // 実ファイル名はスペース
        expect(fs.existsSync(path.join(fx.target, 'images', 'pic a.png'))).toBe(true);
        // 本文は %20 でエンコードされている（decode を欠くと偽陰性になる条件）
        const body = fs.readFileSync(path.join(fx.target, 'a.md'), 'utf8');
        expect(body).toContain('images/pic%20a.png');
        // エンコードのまま解決すると失敗する = decode が必要という前提の固定
        expect(fs.existsSync(path.join(fx.target, 'images', 'pic%20a.png'))).toBe(false);
        expect(fx.closure.sort()).toEqual(['a.md', 'images/pic a.png']);
    } finally {
        fx.cleanup();
    }
});

test('TASK-04 smoke: escape — 絶対パスと ../ escape を参照する md（TC-OIF-16 / NFR-DCP-01）', () => {
    const fx = makeImportFolderFixture('escape');
    try {
        const body = fs.readFileSync(path.join(fx.target, 'a.md'), 'utf8');
        expect(body).toContain('](/etc/passwd)');
        expect(body).toContain('](../outside/escape.png)');
        // escape 先の実体が target の外に実在する（複製が起きたら検出できる状態）
        const outside = path.join(fx.root, 'outside', 'escape.png');
        expect(fs.existsSync(outside), 'escape 先が無いと「複製されない」の検証が空回りする').toBe(true);
        expect(path.relative(fx.target, outside).startsWith('..'),
            'escape 先が target 配下にあると境界外の検証にならない').toBe(true);
        // 境界内の正常参照も併存する（全部落ちる実装を green にしないため）
        expect(fx.closure.sort()).toEqual(['a.md', 'images/pic.png']);
    } finally {
        fx.cleanup();
    }
});

test('TASK-04 smoke: makeDestNote は空の note 骨格を作る / cleanup で残らない', () => {
    const dest = makeDestNote();
    try {
        for (const d of ['images', 'files', 'pages']) {
            expect(fs.existsSync(path.join(dest.dir, d)), `${d}/ が無い`).toBe(true);
        }
        const st = JSON.parse(fs.readFileSync(path.join(dest.dir, 'outline.note'), 'utf8'));
        expect(st.rootIds).toEqual([]);
    } finally {
        const dir = dest.dir;
        dest.cleanup();
        expect(fs.existsSync(dir), '一時ディレクトリが残っている').toBe(false);
    }
});
