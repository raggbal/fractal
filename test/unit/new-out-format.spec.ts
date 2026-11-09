/**
 * A new outliner made by NotesFileManager.createFile (the Notes tree's +out / New Outline) is in the format the outliner
 * model reads: its empty first line has `children` (not the old `childIds`, which OutlinerModel reports as unsupported
 * old data) and the same fields as a node the model makes itself (outliner-model.js addNode).
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { NotesFileManager } from '../../src/shared/notes-file-manager';

/* eslint-disable @typescript-eslint/no-var-requires */
const OutlinerModel = require(path.join(__dirname, '../../src/webview/outliner-model.js'));

test('TC-NOF-01 a new .out loads into the outliner model as is, with one empty root line', () => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-new-out-')));
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...a: unknown[]) => { errors.push(a.map(String).join(' ')); };
    try {
        const fm = new NotesFileManager(dir);
        fm.loadStructure();
        const outPath = fm.createFile('fresh');
        fm.dispose();
        const data = JSON.parse(fs.readFileSync(outPath, 'utf8'));
        expect(data.rootIds).toHaveLength(1);
        const node = data.nodes[data.rootIds[0]];
        expect(node).not.toHaveProperty('childIds');

        const model = new OutlinerModel(JSON.parse(JSON.stringify(data)));
        expect(errors.filter((e) => e.includes('OutlinerModel')), errors.join('\n')).toEqual([]);
        expect(model.rootIds).toEqual(data.rootIds);
        expect(model.getNode(data.rootIds[0])).toMatchObject({ text: '', parentId: null, children: [] });

        // the same fields as a line the model adds itself
        const made = new OutlinerModel({ rootIds: [], nodes: {} }).addNode(null, null, '');
        expect(Object.keys(node).sort()).toEqual(Object.keys(made).sort());
    } finally {
        console.error = orig;
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
