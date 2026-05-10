/**
 * aws-translate Custom Terminology unit tests (sprint 20260510-140531)
 *
 * TC-NEW-04: resolveTerminologyPath の 3 path パターン
 */

import { test, expect } from '@playwright/test';
import * as os from 'os';
import * as path from 'path';
import { resolveTerminologyPath } from '../../src/shared/aws-translate';

test.describe('aws-translate / resolveTerminologyPath (FR-TR-03)', () => {
    test('TC-NEW-04a: 絶対 path はそのまま返す', () => {
        const result = resolveTerminologyPath('/abs/path/file.csv', '/wrk');
        expect(result).toBe('/abs/path/file.csv');
    });

    test('TC-NEW-04b: ~/... を home dir に展開', () => {
        const result = resolveTerminologyPath('~/foo/file.csv', '/wrk');
        expect(result).toBe(path.join(os.homedir(), 'foo/file.csv'));
    });

    test('TC-NEW-04c: 相対 path は workspaceRoot を base に解決', () => {
        const result = resolveTerminologyPath('rel/file.csv', '/wrk');
        expect(result).toBe('/wrk/rel/file.csv');
    });

    test('TC-NEW-04d: workspaceRoot 未指定なら cwd を base に', () => {
        const result = resolveTerminologyPath('rel/file.csv');
        expect(result).toBe(path.resolve(process.cwd(), 'rel/file.csv'));
    });

    test('TC-NEW-04e: 空文字列は空文字列を返す', () => {
        expect(resolveTerminologyPath('', '/wrk')).toBe('');
        expect(resolveTerminologyPath('')).toBe('');
    });

    test('TC-NEW-04f: 前後 trim される', () => {
        const result = resolveTerminologyPath('  /abs/file.csv  ', '/wrk');
        expect(result).toBe('/abs/file.csv');
    });
});
