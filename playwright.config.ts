import { defineConfig, devices } from '@playwright/test';

// The desktop app E2E (test/e2e-electron-app, AC-4 of spec 20261106-1312-electron-vscode-shim) opens
// real windows of the built app, so it is left out of the normal run and only selected when the
// command line names it:  npx playwright test test/e2e-electron-app/notes-smoke.spec.ts
// The env var carries the choice to the worker processes (they load this file again).
const ELECTRON_APP_E2E =
    process.env.FRACTAL_E2E_ELECTRON_APP === '1' || process.argv.some((a) => a.includes('e2e-electron-app'));
if (ELECTRON_APP_E2E) {
    process.env.FRACTAL_E2E_ELECTRON_APP = '1';
}

const electronAppE2E = defineConfig({
    testDir: './test',
    testMatch: ['e2e-electron-app/**/*.spec.ts'],
    fullyParallel: false,
    forbidOnly: !!process.env.CI,
    retries: 0,
    workers: 1,
    reporter: 'list',
    timeout: 180000,
    projects: [{ name: 'electron-app' }],
});

const specsAndUnits = defineConfig({
    testDir: './test',
    testMatch: ['specs/**/*.spec.ts', 'unit/**/*.spec.ts'],
    fullyParallel: true,
    forbidOnly: !!process.env.CI,
    retries: process.env.CI ? 2 : 0,
    workers: process.env.CI ? 1 : 4,
    reporter: 'list',
    timeout: 30000,
    
    use: {
        baseURL: 'http://localhost:3000',
        trace: 'on-first-retry',
        headless: true,
        permissions: ['clipboard-read', 'clipboard-write'],
    },

    projects: [
        {
            name: 'chromium',
            use: { ...devices['Desktop Chrome'] },
        },
    ],

    webServer: {
        // loopback only (`-l 3000` alone listens on every interface and shares test/html with the network)
        command: 'npx serve test/html -l tcp://127.0.0.1:3000',
        port: 3000,
        timeout: 30000,
        reuseExistingServer: true,
    },
});

export default ELECTRON_APP_E2E ? electronAppE2E : specsAndUnits;
