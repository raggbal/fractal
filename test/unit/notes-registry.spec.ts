/**
 * spec 20261026-1845-fractal-file-views（20261026-1555-fractal-notes-json を一部上書き）—
 * Notes 一覧ファイル（<name>.fractal）の形式・検証・読み書き（src/shared/notes-registry.ts。vscode 非依存）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createRegistryFile,
    defaultRegistryPath,
    ensureDefaultRegistry,
    parseRegistry,
    readRegistry,
    registryFileName,
    updateRegistryNotes,
    validateName,
    RegistryExistsError,
} from '../../src/shared/notes-registry';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'notes-registry-'));
}

test.describe('Notes 一覧ファイル（.fractal）', () => {
    test('AC-3 name は <name>.fractal になり、不正な name・同名では書かない', () => {
        for (const ok of ['work', 'Work2', 'my-work', 'a_b', '0', 'a'.repeat(64)]) expect(validateName(ok), ok).toBeNull();
        for (const ng of ['', '-work', '_a', 'my work', '仕事', 'a/b', '../x', 'a.b', 'a'.repeat(65)]) expect(validateName(ng), ng).not.toBeNull();
        expect(registryFileName('work')).toBe('work.fractal');

        const dir = tmpDir();
        expect(() => createRegistryFile(dir, 'bad name')).toThrow();
        expect(fs.readdirSync(dir)).toEqual([]);
        const file = createRegistryFile(dir, 'ok', ['/a', '/a', '/b/../c']);
        expect(path.basename(file)).toBe('ok.fractal');
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, notes: ['/a', '/c'] });
        expect(fs.readdirSync(dir)).toEqual(['ok.fractal']); // tmp を残さない

        fs.writeFileSync(file, 'keep');
        expect(() => createRegistryFile(dir, 'ok')).toThrow(RegistryExistsError);
        expect(fs.readFileSync(file, 'utf8')).toBe('keep');
    });

    test('AC-3 notes の更新は未知キーを保持し、壊れた・新しい version のファイルには書かない。rc.8 の json も読める', () => {
        const dir = tmpDir();
        const file = path.join(dir, 'w.fractal');
        fs.writeFileSync(file, JSON.stringify({ version: 1, notes: ['/a'], color: 'red' }));
        expect(updateRegistryNotes(file, n => [...n, '/b']).notes).toEqual(['/a', '/b']);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, notes: ['/a', '/b'], color: 'red' });

        for (const bad of ['{ broken', JSON.stringify({ version: 2, notes: [] }), JSON.stringify({ version: 1, notes: [1] })]) {
            fs.writeFileSync(file, bad);
            expect(() => updateRegistryNotes(file, n => [...n, '/c'])).toThrow();
            expect(fs.readFileSync(file, 'utf8')).toBe(bad);
        }
        expect(readRegistry(path.join(dir, 'missing.fractal')).ok).toBe(false);
        expect(parseRegistry('[]').ok).toBe(false);
        // rc.8 の <name>-fractal-notes.json（name / title 付き）も読め、書き戻しで name / title を残す
        const old = path.join(dir, 'work-fractal-notes.json');
        fs.writeFileSync(old, JSON.stringify({ version: 1, name: 'work', title: '仕事', notes: ['/x'] }));
        expect(updateRegistryNotes(old, n => [...n, '/y']).notes).toEqual(['/x', '/y']);
        expect(JSON.parse(fs.readFileSync(old, 'utf8'))).toEqual({ version: 1, notes: ['/x', '/y'], name: 'work', title: '仕事' });
    });

    test('AC-1 default.fractal はホーム直下の .fractal に作られ、既にあれば無い Note だけ足す', () => {
        const home = tmpDir();
        const file = defaultRegistryPath(home);
        expect(file).toBe(path.join(home, '.fractal', 'default.fractal'));
        expect(ensureDefaultRegistry(file, ['/a', '/b'])).toEqual({ created: true, added: 2 });
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, notes: ['/a', '/b'] });
        expect(ensureDefaultRegistry(file, ['/b', '/c'])).toEqual({ created: false, added: 1 });
        expect(JSON.parse(fs.readFileSync(file, 'utf8')).notes).toEqual(['/a', '/b', '/c']);
        fs.writeFileSync(file, '{ broken');
        expect(() => ensureDefaultRegistry(file, ['/d'])).toThrow();
        expect(fs.readFileSync(file, 'utf8')).toBe('{ broken');
    });
});
