import { defineConfig } from '@playwright/test';
import * as path from 'path';

// README（VS Code）とホームページ（デスクトップアプリ）の画像を撮る。テストではない（npm test では走らない）:
//   npx playwright test -c screenshots [readme|site] [-g <場面>]
// デスクトップアプリは既定でリポジトリの electron/ を素の Electron で動かす（FRACTAL_E2E_DEV=0 なら electron/dist/e2e の build）。
process.env.FRACTAL_E2E_DEV = process.env.FRACTAL_E2E_DEV || '1';

export default defineConfig({
    testDir: '.',
    testMatch: ['*.shots.ts'],
    fullyParallel: false,
    workers: 1,
    retries: 0,
    reporter: 'list',
    timeout: 240000,
    outputDir: path.join(process.env.SHOTS_WORK || '/tmp/fractal-shots', 'test-results'),
});
