/**
 * Mindmap .out persistence unit tests (sprint 20260701-122355-outliner-mindmap-mode)
 * TC-120〜125, TC-243 — viewMode / mindmap の serialize / load / 後方互換 / 冪等。
 */

import { test, expect } from '@playwright/test';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

function complexInput() {
    return {
        version: 1,
        rootIds: ['n1'],
        nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a', mindmap: { fill: '#f00', shape: 'capsule' } } },
        viewMode: 'mindmap',
        mindmap: {
            layout: 'radial', linkStyle: 'elbow', linkColor: null, linkWidth: 3,
            siblingSpacing: 20, levelSpacing: 100,
            groups: [{ id: 'g1', nodeIds: ['n1'], label: '', color: null }], relationships: []
        }
    };
}

test.describe('Mindmap persistence', () => {
    test('TC-120 round-trip preserves mindmap fields', () => {
        const out = new OutlinerModel(complexInput()).serialize();
        expect(out.viewMode).toBe('mindmap');
        expect(out.mindmap.layout).toBe('radial');
        expect(out.mindmap.linkWidth).toBe(3);
        expect(out.mindmap.groups[0].id).toBe('g1');
        expect(out.nodes.n1.mindmap.fill).toBe('#f00');
        expect(out.nodes.n1.mindmap.shape).toBe('capsule');
    });

    test('TC-121 old .out untouched (no mindmap fields sprout)', () => {
        const old = { version: 1, rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a' } } };
        const out = new OutlinerModel(old).serialize();
        expect('viewMode' in out).toBe(false);
        expect('mindmap' in out).toBe(false);
        expect('mindmap' in out.nodes.n1).toBe(false);
        expect(out.rootIds).toEqual(['n1']);
        expect(out.nodes.n1.text).toBe('a');
    });

    test('TC-122 default settings not emitted', () => {
        const out = new OutlinerModel({ version: 1, rootIds: [], nodes: {}, viewMode: 'mindmap' }).serialize();
        expect(out.viewMode).toBe('mindmap');
        expect('mindmap' in out).toBe(false); // all-default settings omitted
    });

    test('TC-125 viewMode defaults to outliner', () => {
        expect(new OutlinerModel({ version: 1, rootIds: [], nodes: {} }).viewMode).toBe('outliner');
    });

    test('invalid viewMode falls back to outliner', () => {
        expect(new OutlinerModel({ version: 1, rootIds: [], nodes: {}, viewMode: 'bogus' }).viewMode).toBe('outliner');
    });

    test('TC-243 idempotent serialize (JSON equality)', () => {
        const json1 = JSON.stringify(new OutlinerModel(complexInput()).serialize());
        const json2 = JSON.stringify(new OutlinerModel(JSON.parse(json1)).serialize());
        expect(json1).toBe(json2);
    });
});
