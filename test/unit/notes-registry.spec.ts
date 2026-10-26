/**
 * spec 20261026-1555-fractal-notes-json — Notes 一覧ファイル（<name>-fractal-notes.json）の形式・検証・読み書き
 * （src/shared/notes-registry.ts。vscode 非依存）。
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    createRegistryFile,
    parseRegistry,
    readRegistry,
    registryFileName,
    updateRegistryNotes,
    validateName,
    validateTitle,
    RegistryExistsError,
} from '../../src/shared/notes-registry';

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'notes-registry-'));
}

test.describe('Notes 一覧ファイル', () => {
    test('AC-1 正しい name は <name>-fractal-notes.json、不正な name・空の title は拒否', () => {
        for (const ok of ['work', 'Work2', 'my-work', 'a_b', '0', 'a'.repeat(64)]) expect(validateName(ok), ok).toBeNull();
        for (const ng of ['', '-work', '_a', 'my work', '仕事', 'a/b', '../x', 'a.b', 'a'.repeat(65)]) expect(validateName(ng), ng).not.toBeNull();
        expect(registryFileName('work')).toBe('work-fractal-notes.json');
        expect(validateTitle('仕事 / メモ ✨')).toBeNull();
        expect(validateTitle('   ')).not.toBeNull();
        expect(validateTitle('x'.repeat(101))).not.toBeNull();

        const dir = tmpDir();
        expect(() => createRegistryFile(dir, 'bad name', 'T')).toThrow();
        expect(() => createRegistryFile(dir, 'ok', '  ')).toThrow();
        expect(fs.readdirSync(dir)).toEqual([]);
        const file = createRegistryFile(dir, 'ok', '  仕事  ', ['/a', '/a', '/b/../c']);
        expect(path.basename(file)).toBe('ok-fractal-notes.json');
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, name: 'ok', title: '仕事', notes: ['/a', '/c'] });
        expect(fs.readdirSync(dir)).toEqual(['ok-fractal-notes.json']); // tmp を残さない
    });

    test('AC-2 同名ファイルがあれば上書きしない', () => {
        const dir = tmpDir();
        const file = path.join(dir, 'work-fractal-notes.json');
        fs.writeFileSync(file, 'keep');
        expect(() => createRegistryFile(dir, 'work', 'T')).toThrow(RegistryExistsError);
        expect(fs.readFileSync(file, 'utf8')).toBe('keep');
        expect(fs.readdirSync(dir)).toEqual(['work-fractal-notes.json']);
    });

    test('AC-4 notes の更新は未知キーを保持し、壊れた・新しい version のファイルには書かない', () => {
        const dir = tmpDir();
        const file = path.join(dir, 'w-fractal-notes.json');
        fs.writeFileSync(file, JSON.stringify({ version: 1, name: 'w', title: 'W', notes: ['/a'], color: 'red' }));
        const doc = updateRegistryNotes(file, n => [...n, '/b']);
        expect(doc.notes).toEqual(['/a', '/b']);
        expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ version: 1, name: 'w', title: 'W', notes: ['/a', '/b'], color: 'red' });

        for (const bad of ['{ broken', JSON.stringify({ version: 2, name: 'w', title: 'W', notes: [] }), JSON.stringify({ version: 1, name: 'w', title: 'W', notes: [1] })]) {
            fs.writeFileSync(file, bad);
            expect(() => updateRegistryNotes(file, n => [...n, '/c'])).toThrow();
            expect(fs.readFileSync(file, 'utf8')).toBe(bad);
        }
        expect(readRegistry(path.join(dir, 'missing.json')).ok).toBe(false);
        expect(parseRegistry('[]').ok).toBe(false);
        expect(fs.readdirSync(dir)).toEqual(['w-fractal-notes.json']);
    });
});
