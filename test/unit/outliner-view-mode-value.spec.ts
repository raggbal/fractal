/**
 * The outliner's display mode in the .out (`viewMode`): 'outliner' (or absent) / 'database' / 'mindmap' — the same names
 * as on screen (Outliner / Database / Mindmap Mode). Before 1.4.2-rc.4 Database mode was saved as 'table': it is read
 * as 'database', and written back as 'database'.
 */
import { test, expect } from '@playwright/test';
import * as path from 'path';

/* eslint-disable @typescript-eslint/no-var-requires */
const OutlinerModel = require(path.join(__dirname, '../../src/webview/outliner-model.js'));
const doc = (viewMode?: string) => ({ rootIds: ['n1'], nodes: { n1: { id: 'n1', parentId: null, children: [], text: 'a', tags: [], isPage: false, pageId: null, collapsed: false, checked: null, subtext: '', images: [], filePath: null } }, ...(viewMode ? { viewMode } : {}) });

test('TC-VMV-01 read: database / table → database, mindmap → mindmap, anything else → outliner', () => {
    expect([undefined, 'outliner', 'database', 'table', 'mindmap', 'board', ''].map((v) => new OutlinerModel(doc(v)).viewMode))
        .toEqual(['outliner', 'outliner', 'database', 'database', 'mindmap', 'outliner', 'outliner']);
    expect(OutlinerModel.normalizeViewMode('table')).toBe('database');
});

test('TC-VMV-02 write: database is saved as "database" (also for a file that said "table"); outliner is not written', () => {
    expect(new OutlinerModel(doc('table')).serialize().viewMode).toBe('database');
    expect(new OutlinerModel(doc('database')).serialize().viewMode).toBe('database');
    expect(new OutlinerModel(doc('mindmap')).serialize().viewMode).toBe('mindmap');
    expect(new OutlinerModel(doc()).serialize()).not.toHaveProperty('viewMode');
});
