/**
 * llms-txt-builder unit tests
 *
 * buildLlmsTxt() の振る舞いを検証する:
 * - root のみ (子なし、添付あり)
 * - 中間ノード (子あり、添付なし) は見出しとして残る
 * - 添付なし leaf はスキップ
 * - 添付ありながら disk に存在しないものは bullet 出さない (resolver が null を返すケース)
 * - 深い tree で H6 clamp
 */

import { test, expect } from '@playwright/test';
import { buildLlmsTxt, LlmsTxtTreeNode, LlmsTxtResolvers } from '../../src/shared/llms-txt-builder';

function mdResolver(map: Record<string, string | null>): LlmsTxtResolvers {
    return {
        resolveMdPath: (pageId: string) => map[pageId] ?? null,
        resolveFilePath: () => null,
    };
}

function fileResolver(map: Record<string, string | null>): LlmsTxtResolvers {
    return {
        resolveMdPath: () => null,
        resolveFilePath: (rel: string) => map[rel] ?? null,
    };
}

test.describe('llms-txt-builder', () => {
    test('root のみで MD 添付ありなら H1 + 自己 bullet', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: 'p1', filePath: null, children: [],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ p1: '/abs/p1.md' }));
        expect(out).toBe('# Root\n\n- [Root](/abs/p1.md)\n');
    });

    test('root のみで添付なし leaf は空文字', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({}));
        expect(out).toBe('');
    });

    test('中間ノードは見出し、leaf with MD は bullet', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                {
                    id: 'a', text: 'SectionA', pageId: null, filePath: null, children: [
                        { id: 'a1', text: 'LeafA1', pageId: 'pa1', filePath: null, children: [] },
                        { id: 'a2', text: 'LeafA2', pageId: 'pa2', filePath: null, children: [] },
                    ],
                },
            ],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ pa1: '/abs/a1.md', pa2: '/abs/a2.md' }));
        expect(out).toBe(
            '# Root\n\n' +
            '## SectionA\n\n' +
            '- [LeafA1](/abs/a1.md)\n' +
            '- [LeafA2](/abs/a2.md)\n'
        );
    });

    test('添付なし leaf はスキップ (兄弟 leaf は出る)', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                { id: 'a', text: 'WithMd', pageId: 'pa', filePath: null, children: [] },
                { id: 'b', text: 'NoMd', pageId: null, filePath: null, children: [] },
                { id: 'c', text: 'WithMd2', pageId: 'pc', filePath: null, children: [] },
            ],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ pa: '/abs/a.md', pc: '/abs/c.md' }));
        expect(out).toContain('- [WithMd](/abs/a.md)');
        expect(out).toContain('- [WithMd2](/abs/c.md)');
        expect(out).not.toContain('NoMd');
    });

    test('disk 不在で resolver が null を返した leaf はスキップ', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                { id: 'a', text: 'Real', pageId: 'pa', filePath: null, children: [] },
                { id: 'b', text: 'Missing', pageId: 'pb', filePath: null, children: [] },
            ],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ pa: '/abs/a.md', pb: null }));
        expect(out).toContain('- [Real](/abs/a.md)');
        expect(out).not.toContain('Missing');
    });

    test('contributing 子孫を持たない section subtree は丸ごとスキップ', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: 'pr', filePath: null, children: [
                {
                    id: 'empty', text: 'EmptyBranch', pageId: null, filePath: null, children: [
                        { id: 'l1', text: 'NoAttach', pageId: null, filePath: null, children: [] },
                    ],
                },
            ],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ pr: '/abs/r.md' }));
        expect(out).toContain('# Root');
        expect(out).toContain('- [Root](/abs/r.md)');
        expect(out).not.toContain('EmptyBranch');
        expect(out).not.toContain('NoAttach');
    });

    test('section が自己 MD 添付を持つ場合、見出し + 自己 bullet + 子', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                {
                    id: 's', text: 'Section', pageId: 'ps', filePath: null, children: [
                        { id: 'c1', text: 'Child', pageId: 'pc1', filePath: null, children: [] },
                    ],
                },
            ],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ ps: '/abs/s.md', pc1: '/abs/c1.md' }));
        expect(out).toBe(
            '# Root\n\n' +
            '## Section\n\n' +
            '- [Section](/abs/s.md)\n\n' +
            '- [Child](/abs/c1.md)\n'
        );
    });

    test('深さ 7 は H6 で clamp', () => {
        const leaf: LlmsTxtTreeNode = { id: 'l', text: 'Leaf', pageId: 'pl', filePath: null, children: [] };
        let node: LlmsTxtTreeNode = leaf;
        for (let i = 7; i >= 2; i--) {
            node = { id: 's' + i, text: 'S' + i, pageId: null, filePath: null, children: [node] };
        }
        const root: LlmsTxtTreeNode = { id: 'r', text: 'Root', pageId: null, filePath: null, children: [node] };
        const out = buildLlmsTxt(root, 'md', mdResolver({ pl: '/abs/leaf.md' }));
        // H1〜H6 で止まり、H7 にはならない
        expect(out).toContain('# Root');
        expect(out).toContain('###### ');
        expect(out).not.toContain('####### ');
    });

    test('mode=file は filePath を resolver で引いて bullet 化', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                { id: 'a', text: 'PDF', pageId: null, filePath: 'attached/doc.pdf', children: [] },
            ],
        };
        const out = buildLlmsTxt(tree, 'file', fileResolver({ 'attached/doc.pdf': '/abs/attached/doc.pdf' }));
        expect(out).toContain('# Root');
        expect(out).toContain('- [PDF](/abs/attached/doc.pdf)');
    });

    test('text のクリーニング: #tag / @tag / Markdown 強調を除去', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: '**bold** title #tag1 @mention', pageId: 'p', filePath: null, children: [],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ p: '/abs/p.md' }));
        expect(out).toContain('# bold title');
        expect(out).not.toContain('#tag1');
        expect(out).not.toContain('@mention');
        expect(out).not.toContain('**');
    });

    test('空 text は Untitled にフォールバック', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: '', pageId: 'p', filePath: null, children: [],
        };
        const out = buildLlmsTxt(tree, 'md', mdResolver({ p: '/abs/p.md' }));
        expect(out).toContain('# Untitled');
        expect(out).toContain('- [Untitled](/abs/p.md)');
    });

    test('mode=file: pageId のみ持つ leaf は厳格にスキップ (MD page 混入なし)', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                { id: 'pg', text: 'PageOnly', pageId: 'pg-id', filePath: null, children: [] },
                { id: 'fl', text: 'FileOnly', pageId: null, filePath: 'attach/f.pdf', children: [] },
            ],
        };
        const resolvers = {
            resolveMdPath: () => { throw new Error('mode=file should never call resolveMdPath'); },
            resolveFilePath: (rel: string) => rel === 'attach/f.pdf' ? '/abs/f.pdf' : null,
        };
        const out = buildLlmsTxt(tree, 'file', resolvers);
        expect(out).toContain('- [FileOnly](/abs/f.pdf)');
        expect(out).not.toContain('PageOnly');
        expect(out).not.toContain('pg-id');
        expect(out).not.toContain('.md');
    });

    test('mode=both: 同一ノードに pageId + filePath があれば 2 本 bullet', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                { id: 'a', text: 'Hybrid', pageId: 'ph', filePath: 'attach/h.pdf', children: [] },
                { id: 'b', text: 'MdOnly', pageId: 'pb', filePath: null, children: [] },
                { id: 'c', text: 'FileOnly', pageId: null, filePath: 'attach/c.pdf', children: [] },
            ],
        };
        const out = buildLlmsTxt(tree, 'both', {
            resolveMdPath: (pid: string) => ({ ph: '/abs/h.md', pb: '/abs/b.md' } as Record<string,string>)[pid] ?? null,
            resolveFilePath: (rel: string) => ({ 'attach/h.pdf': '/abs/h.pdf', 'attach/c.pdf': '/abs/c.pdf' } as Record<string,string>)[rel] ?? null,
        });
        expect(out).toContain('- [Hybrid](/abs/h.md)');
        expect(out).toContain('- [Hybrid](/abs/h.pdf)');
        expect(out).toContain('- [MdOnly](/abs/b.md)');
        expect(out).toContain('- [FileOnly](/abs/c.pdf)');
    });

    test('mode=both: section ノードが自己 page + file を持つ場合、heading 直後に 2 本 bullet', () => {
        const tree: LlmsTxtTreeNode = {
            id: 'r', text: 'Root', pageId: null, filePath: null, children: [
                {
                    id: 's', text: 'Section', pageId: 'ps', filePath: 'attach/s.pdf', children: [
                        { id: 'c', text: 'Child', pageId: 'pc', filePath: null, children: [] },
                    ],
                },
            ],
        };
        const out = buildLlmsTxt(tree, 'both', {
            resolveMdPath: (pid: string) => ({ ps: '/abs/s.md', pc: '/abs/c.md' } as Record<string,string>)[pid] ?? null,
            resolveFilePath: (rel: string) => rel === 'attach/s.pdf' ? '/abs/s.pdf' : null,
        });
        expect(out).toBe(
            '# Root\n\n' +
            '## Section\n\n' +
            '- [Section](/abs/s.md)\n' +
            '- [Section](/abs/s.pdf)\n\n' +
            '- [Child](/abs/c.md)\n'
        );
    });
});

// ─── TC-OCM-05/07（builder 側）: forest 対応（sprint 20260818-183407 FR-OCM-02・ADRL-0077） ───

test.describe('llms-txt-builder forest (FR-OCM-02)', () => {
    const t = (id: string, text: string, pageId: string | null): LlmsTxtTreeNode =>
        ({ id, text, pageId, filePath: null, children: [] });

    test('TC-OCM-05b 単一 root の配列は従来の単一 tree 出力と byte 一致（後方互換 pin）', () => {
        const tree = t('r', 'Root', 'p1');
        const res = mdResolver({ p1: '/abs/p1.md' });
        const single = buildLlmsTxt(tree, 'md', res);
        const asForest = buildLlmsTxt([tree], 'md', res);
        expect(asForest).toBe(single);
        expect(single).toBe('# Root\n\n- [Root](/abs/p1.md)\n');
    });

    test('TC-OCM-05c 複数 root: 各 root が H1・root 間は空行 1 つ', () => {
        const res = mdResolver({ p1: '/abs/p1.md', p2: '/abs/p2.md' });
        const out = buildLlmsTxt([t('a', 'A', 'p1'), t('b', 'B', 'p2')], 'md', res);
        expect(out).toBe('# A\n\n- [A](/abs/p1.md)\n\n# B\n\n- [B](/abs/p2.md)\n');
    });

    test('TC-OCM-05d 貢献ゼロの root は落ちる（全部ゼロなら空文字）', () => {
        const res = mdResolver({ p1: '/abs/p1.md' });
        expect(buildLlmsTxt([t('a', 'A', null), t('b', 'B', 'p1')], 'md', res))
            .toBe('# B\n\n- [B](/abs/p1.md)\n');
        expect(buildLlmsTxt([t('a', 'A', null)], 'md', res)).toBe('');
    });
});
