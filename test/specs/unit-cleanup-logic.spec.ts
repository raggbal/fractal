/**
 * v7 Cleanup Logic Unit Tests
 * - DOD-11: handleRemovePage has no workspace.fs.delete
 * - DOD-24: src/ has no unlinkSync/rmSync/rmdirSync
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import path from 'path';

const projectRoot = path.resolve(__dirname, '../..');

test.describe('v7 Cleanup Logic - Static Verification', () => {
    test('DOD-11: handleRemovePage does not call workspace.fs.delete', () => {
        const cmd = `grep -n 'workspace.fs.delete' "${projectRoot}/src/outlinerProvider.ts" || true`;
        const output = execSync(cmd, { encoding: 'utf-8' });

        // handleRemovePage 関数内 (L753-766 付近) に workspace.fs.delete があってはならない
        const lines = output.split('\n').filter(line => line.trim());
        const inHandleRemovePage = lines.some(line => {
            const lineNum = parseInt(line.split(':')[0], 10);
            return lineNum >= 753 && lineNum <= 770;
        });

        expect(inHandleRemovePage).toBe(false);
    });

    test('DOD-24: src/ has no immediate delete APIs (unlinkSync, rmSync, rmdirSync)', () => {
        const cmd = `grep -rn 'unlinkSync\\|rmSync\\|rmdirSync' "${projectRoot}/src/" --include='*.ts' --include='*.js' | grep -v 'test/' | grep -v 'paste-asset-handler.ts' | grep -v 'notes-s3-sync.ts' || true`;
        const output = execSync(cmd, { encoding: 'utf-8' }).trim();

        // paste-asset-handler.ts と notes-s3-sync.ts は例外 (cross-outliner cut-paste の move, S3 sync)
        // 将来的には vscode API に切り替えを検討
        expect(output).toBe('');
    });
});
