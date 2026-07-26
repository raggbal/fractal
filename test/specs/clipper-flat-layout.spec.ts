/**
 * chrome-extension のフラットレイアウト対応 + md 取込 + プリセット（sprint 20260726-013730 / FR-CL）。
 *
 * lib/*.js は IIFE + module.exports 併設なので node から直接 require できる。
 * FS Access API 依存（handle 走査・実 clip）は手動 US。ここは pure ロジックの番人。
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const flat = require(path.resolve(__dirname, '../../chrome-extension/lib/flat-layout-mirror.js'));
const core = require(path.resolve(__dirname, '../../chrome-extension/lib/clipper-core.js'));
const registry = require(path.resolve(__dirname, '../../chrome-extension/lib/folder-registry.js'));

test.describe('A. clipper パス解決（flat-layout-mirror）', () => {
    // TC-CF-01: isFlatOut（flat-layout.ts:56 と同値）
    test('TC-CF-01 isFlatOut の判定', () => {
        expect(flat.isFlatOut('.')).toBe(true);
        expect(flat.isFlatOut('')).toBe(true);
        expect(flat.isFlatOut('./')).toBe(true);
        expect(flat.isFlatOut('./abc')).toBe(false);
        expect(flat.isFlatOut('abc')).toBe(false);
        expect(flat.isFlatOut(undefined)).toBe(false);
    });

    // TC-CF-02（★load-bearing・FR-CL-01）: ヒント無しのデフォルトはフラット（旧 <outId> を廃止）
    test('TC-CF-02 ヒント無しデフォルト = フラット（旧 outId でない）', () => {
        expect(flat.resolvePageDirRel(undefined, 'myout')).toBe('');
        expect(flat.resolvePageDirRel({}, 'myout')).toBe('');
        // counterfactual: 旧実装は 'myout' を返していた
        expect(flat.resolvePageDirRel({}, 'myout')).not.toBe('myout');
    });

    // TC-CF-03: ヒント尊重
    test('TC-CF-03 pageDir ヒントの尊重', () => {
        expect(flat.resolvePageDirRel({ pageDir: '.' }, 'x')).toBe('');
        expect(flat.resolvePageDirRel({ pageDir: './sub' }, 'x')).toBe('sub');
        expect(flat.resolvePageDirRel({ pageDir: 'sub/' }, 'x')).toBe('sub');
    });

    // TC-CF-04（★load-bearing）: 書き込み判定は新フラット前提（hint 尊重・無ければ直下。legacy fallback 廃止 = ユーザー決定 2026-07-26）
    test('TC-CF-04 chooseWriteDirRel は hint 尊重 + フラット default', () => {
        // ① hints 有り → hints 従属
        expect(flat.chooseWriteDirRel({ pageDir: '.' }, 'out1')).toBe('');
        expect(flat.chooseWriteDirRel({ pageDir: './sub' }, 'out1')).toBe('sub');
        // ② hints 無し → ''（flat。旧 <outId>/ デフォルトは廃止）
        expect(flat.chooseWriteDirRel(undefined, 'out1')).toBe('');
        expect(flat.chooseWriteDirRel({}, 'out1')).toBe('');
        // counterfactual: 旧実装は 'out1' を返していた
        expect(flat.chooseWriteDirRel(undefined, 'out1')).not.toBe('out1');
    });

    // TC-CF-05（★load-bearing 化・review iter1 code_fix②）: 画像 dir 解決 + 実配線
    test('TC-CF-05 resolveImagesDirRel（共有 images / ヒント尊重）+ 実経路配線', () => {
        expect(flat.resolveImagesDirRel(undefined)).toBe('images');
        expect(flat.resolveImagesDirRel({})).toBe('images');
        expect(flat.resolveImagesDirRel({ imageDir: './images' })).toBe('images');
        expect(flat.resolveImagesDirRel({ imageDir: './assets/img' })).toBe('assets/img');
        // 配線確認（dead code 防止）: popup/background が resolveImagesDirRel を呼び、
        // extractor に imagesSubdir を渡している（source-text。FS Access 実書き込みは手動 US）
        const fs = require('fs');
        const popup = fs.readFileSync(path.resolve(__dirname, '../../chrome-extension/popup.js'), 'utf-8');
        const bg = fs.readFileSync(path.resolve(__dirname, '../../chrome-extension/background.js'), 'utf-8');
        expect(popup).toContain('resolveImagesDirRel');
        expect(bg).toContain('resolveImagesDirRel');
        expect(popup).toMatch(/processDataUrlsInMd\([^)]*imagesSubdir\)/);
        expect(bg).toMatch(/processDataUrlsInMd\([^)]*imagesSubdir\)/);
    });
});

test.describe('B. clipper md 取込 + プリセット', () => {
    // TC-CF-06（FR-CL-05）: 末尾に subpage リンク追記・既存本文不変
    test('TC-CF-06 buildMdClipResult の追記形式', () => {
        const r = core.buildMdClipResult({ targetMdText: '# A\n\nbody', title: 'T', uuid: 'u1' });
        expect(r.newMdName).toBe('u1.md');
        expect(r.appendedTargetText).toBe('# A\n\nbody\n\n[[T]](u1.md)\n');
        // 空本文 → リンクのみ
        const r2 = core.buildMdClipResult({ targetMdText: '', title: 'T', uuid: 'u2' });
        expect(r2.appendedTargetText).toBe('[[T]](u2.md)\n');
    });

    // TC-CF-07（design-review MEDIUM⑤）: title の ] 全数を全角へ・空 title・改行
    test('TC-CF-07 タイトルサニタイズ（] 全数置換）', () => {
        expect(core.sanitizeSubpageTitle('a]b')).toBe('a］b');       // ] 単体も置換（]] だけでは不足）
        expect(core.sanitizeSubpageTitle('a]]b')).toBe('a］］b');
        expect(core.sanitizeSubpageTitle('[x]')).toBe('［x］');
        expect(core.sanitizeSubpageTitle('')).toBe('(untitled)');
        expect(core.sanitizeSubpageTitle('a\nb')).toBe('a b');
        // リンク形式が壊れない（label 内に生の ] が無い）
        const r = core.buildMdClipResult({ targetMdText: '', title: 'x]]y', uuid: 'u3' });
        const m = r.appendedTargetText.match(/^\[\[([^\]]*)\]\]\(u3\.md\)\n$/);
        expect(m).not.toBeNull();
    });

    // TC-CF-08（FR-CL-04/07）: プリセット schema の pure 操作 + lastSelection 正規化
    test('TC-CF-08 プリセット操作 + lastSelection 旧形式正規化', () => {
        // addPreset 相当（withPreset）
        const { presets: p1, added } = registry.withPreset([], { name: 'Work', folderId: 'f1', targetId: 'o1', targetKind: 'out' });
        expect(p1.length).toBe(1);
        expect(added.id).toBeTruthy();
        expect(added.targetKind).toBe('out');
        // removePreset 相当（withoutPreset・default 参照 clear）
        const { presets: p2, defaultPresetId } = registry.withoutPreset(p1, added.id, added.id);
        expect(p2.length).toBe(0);
        expect(defaultPresetId).toBeUndefined();
        // default が別 preset なら維持
        const r3 = registry.withoutPreset(p1, 'other-id', added.id);
        expect(r3.defaultPresetId).toBe(added.id);
        // lastSelection 旧形式（outId）→ 新形式
        expect(registry.normalizeLastSelection({ folderId: 'f1', outId: 'o1' }))
            .toEqual({ folderId: 'f1', targetId: 'o1', targetKind: 'out' });
        expect(registry.normalizeLastSelection({ folderId: 'f1', targetId: 'm1', targetKind: 'md' }))
            .toEqual({ folderId: 'f1', targetId: 'm1', targetKind: 'md' });
        expect(registry.normalizeLastSelection(null)).toBeNull();
    });

    // TC-CF-09（FR-CL-03）: outline.note structure から out/md 種別付き抽出
    test('TC-CF-09 extractTargets が ext:md を kind:md で返す', () => {
        const structure = {
            version: 1,
            rootIds: ['out1', 'fol1', 'md1'],
            items: {
                out1: { type: 'file', id: 'out1', title: 'Outliner A' },
                fol1: { type: 'folder', id: 'fol1', title: 'Folder', childIds: ['md2'], collapsed: false },
                md1: { type: 'file', id: 'md1', title: 'Note MD', ext: 'md' },
                md2: { type: 'file', id: 'md2', title: 'Nested MD', ext: 'md' },
            },
        };
        const targets = registry.extractTargets(structure);
        expect(targets.map((t: any) => [t.id, t.kind])).toEqual([
            ['out1', 'out'],
            ['md2', 'md'],
            ['md1', 'md'],
        ]);
        // folder 階層
        const md2 = targets.find((t: any) => t.id === 'md2');
        expect(md2.depth).toBe(1);
        expect(md2.folderPath).toBe('Folder');
        // 壊れ structure → null（fallback へ）
        expect(registry.extractTargets(null)).toBeNull();
        expect(registry.extractTargets({})).toBeNull();
    });
});

test.describe('D. 網羅（TC-REG-01）', () => {
    test('TC-REG-01 register-fractal.mjs 6 種 + collect に独自パス解決なし', () => {
        const fs = require('fs');
        const skills = ['arxiv-md', 'aws-doc-maker', 'doc-md', 'pptx-pages-md', 'web-crawler-md', 'youtube-md'];
        for (const s of skills) {
            const p = path.resolve(__dirname, `../../ai_skills/${s}/scripts/register-fractal.mjs`);
            const body = fs.readFileSync(p, 'utf-8');
            // fractal-md.mjs 委譲のみで、独自の pageDir/images 解決を持たない
            expect(body).not.toMatch(/pageDir\s*[=:]/);
            expect(body).not.toMatch(/join\([^)]*['"]images['"]/);
        }
        const collect = fs.readFileSync(path.resolve(__dirname, '../../ai_skills/collect/scripts/list-default-outs.mjs'), 'utf-8');
        expect(collect).not.toMatch(/pageDir\s*[=:]/);
    });
});
