/**
 * 設定削除の governance ゲート（TC-REG-01 / NFR-SD-02）。
 * outlinerPageTitle / imageDefaultDir / fileDefaultDir / forceRelativeImagePath / forceRelativeFilePath が
 * src/ + package.json から完全に消えていること（config 宣言・読み取り・interface・コメント含め 0 件）。
 */
import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import * as path from 'path';

const projectRoot = path.resolve(__dirname, '../..');
const REMOVED = ['imageDefaultDir', 'fileDefaultDir', 'forceRelativeImagePath', 'forceRelativeFilePath', 'outlinerPageTitle'];

test.describe('TC-REG-01 削除設定が src/package.json に残っていない', () => {
    for (const key of REMOVED) {
        test(`${key} は src/ + package.json に 0 件`, () => {
            // -F: 固定文字列。src/ と package.json を対象（test/ は対象外＝本 spec 内の言及を除外）
            const cmd = `grep -rnF '${key}' "${projectRoot}/src" "${projectRoot}/package.json" || true`;
            const out = execSync(cmd, { encoding: 'utf-8' }).trim();
            expect(out, `残存:\n${out}`).toBe('');
        });
    }
});
