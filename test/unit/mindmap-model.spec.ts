/**
 * MindmapModel unit tests (sprint 20260701-122355-outliner-mindmap-mode)
 * TC-110〜119, TC-174/175 (Floating Topic 純関数)
 */

import { test, expect } from '@playwright/test';
// IIFE + module.exports モジュール (Node CommonJS で読める)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const MM = require('../../src/webview/mindmap-model.js');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const OutlinerModel = require('../../src/webview/outliner-model.js');

test.describe('MindmapModel — settings', () => {
    test('TC-110 defaultMindmapSettings', () => {
        expect(MM.defaultMindmapSettings()).toEqual({
            layout: 'right', linkStyle: 'curved', linkColor: null, linkWidth: 2,
            siblingSpacing: 16, levelSpacing: 80, groups: [], relationships: []
        });
    });

    test('TC-111 createGroup adds Boundary', () => {
        const s = MM.defaultMindmapSettings();
        const g = MM.createGroup(s, ['n1', 'n2'], 'Grp', '#ff0000');
        expect(g.id).toMatch(/^g/);
        expect(g.nodeIds).toEqual(['n1', 'n2']);
        expect(g.label).toBe('Grp');
        expect(g.color).toBe('#ff0000');
        expect(s.groups).toHaveLength(1);
    });

    test('TC-112 createGroup default label/color', () => {
        const s = MM.defaultMindmapSettings();
        const g = MM.createGroup(s, ['n1']);
        expect(g.label).toBe('');
        expect(g.color).toBe(null);
    });

    test('TC-113 createRelationship', () => {
        const s = MM.defaultMindmapSettings();
        const r = MM.createRelationship(s, 'n1', 'n2');
        expect(r.id).toMatch(/^r/);
        expect(r.fromNodeId).toBe('n1');
        expect(r.toNodeId).toBe('n2');
        expect(r.label).toBe('');
        expect(r.color).toBe(null);
        expect(s.relationships).toHaveLength(1);
    });
});

test.describe('MindmapModel — floating topic', () => {
    function model() {
        return new OutlinerModel({
            version: 1, rootIds: ['nR'], nodes: {
                nR: { id: 'nR', parentId: null, children: ['nC'], text: 'R' },
                nC: { id: 'nC', parentId: 'nR', children: [], text: 'C' },
                nF: { id: 'nF', parentId: null, children: [], text: 'F', mindmap: { x: 100, y: 50 } }
            }
        });
    }

    test('TC-114 isFloatingTopic', () => {
        const m = model();
        expect(MM.isFloatingTopic(m, 'nF')).toBe(true);
        expect(MM.isFloatingTopic(m, 'nR')).toBe(false); // in rootIds
        expect(MM.isFloatingTopic(m, 'nC')).toBe(false); // has parent
    });

    test('TC-115 getFloatingTopicIds', () => {
        expect(MM.getFloatingTopicIds(model())).toEqual(['nF']);
    });

    test('TC-174 detachToFloating', () => {
        const m = new OutlinerModel({
            version: 1, rootIds: ['n1'], nodes: {
                n1: { id: 'n1', parentId: null, children: ['n2'], text: '1' },
                n2: { id: 'n2', parentId: 'n1', children: [], text: '2' }
            }
        });
        MM.detachToFloating(m, 'n2', 300, 200);
        expect(m.nodes.n2.parentId).toBe(null);
        expect(m.rootIds.indexOf('n2')).toBe(-1);
        expect(m.nodes.n1.children.indexOf('n2')).toBe(-1);
        expect(m.nodes.n2.mindmap.x).toBe(300);
        expect(m.nodes.n2.mindmap.y).toBe(200);
        expect(MM.isFloatingTopic(m, 'n2')).toBe(true);
    });

    test('TC-175 attachFromFloating', () => {
        const m = new OutlinerModel({
            version: 1, rootIds: ['n1'], nodes: {
                n1: { id: 'n1', parentId: null, children: [], text: '1' },
                n2: { id: 'n2', parentId: null, children: [], text: '2', mindmap: { x: 5, y: 5 } }
            }
        });
        MM.attachFromFloating(m, 'n2', 'n1', null);
        expect(m.nodes.n2.parentId).toBe('n1');
        expect(m.nodes.n1.children.indexOf('n2')).toBeGreaterThanOrEqual(0);
        expect(m.nodes.n2.mindmap == null || m.nodes.n2.mindmap.x == null).toBe(true);
        expect(MM.isFloatingTopic(m, 'n2')).toBe(false);
    });
});

test.describe('MindmapModel — cleanup & normalize', () => {
    test('TC-116 cleanupDanglingRefs removes dangling relationship', () => {
        const s = MM.defaultMindmapSettings();
        s.relationships = [{ id: 'r1', fromNodeId: 'n1', toNodeId: 'nDeleted' }];
        const m = new OutlinerModel({ version: 1, rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a' } } });
        MM.cleanupDanglingRefs(m, s);
        expect(s.relationships).toEqual([]);
        expect(m.nodes.n1).toBeTruthy(); // other node intact
    });

    test('TC-117 cleanupDanglingRefs prunes group nodeIds', () => {
        const s = MM.defaultMindmapSettings();
        s.groups = [{ id: 'g1', nodeIds: ['n1', 'nGone'], label: '', color: null }];
        const m = new OutlinerModel({ version: 1, rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a' } } });
        MM.cleanupDanglingRefs(m, s);
        expect(s.groups[0].nodeIds).toEqual(['n1']);
        expect(s.groups).toHaveLength(1);
    });

    test('TC-118 cleanupDanglingRefs removes empty group', () => {
        const s = MM.defaultMindmapSettings();
        s.groups = [{ id: 'g1', nodeIds: ['nGone'], label: '', color: null }];
        const m = new OutlinerModel({ version: 1, rootIds: [], nodes: {} });
        MM.cleanupDanglingRefs(m, s);
        expect(s.groups).toEqual([]);
    });

    test('TC-119 normalizeNodeMindmap drops empty', () => {
        const node: any = { id: 'n1', mindmap: { fill: null, stroke: null, shape: null, x: null, y: null } };
        MM.normalizeNodeMindmap(node);
        expect(node.mindmap).toBeUndefined();
        const node2: any = { id: 'n2', mindmap: { fill: '#f00', stroke: null, shape: null, x: null, y: null } };
        MM.normalizeNodeMindmap(node2);
        expect(node2.mindmap && node2.mindmap.fill).toBe('#f00');
    });
});
