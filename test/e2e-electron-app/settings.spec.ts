/**
 * The desktop app's settings screen (ADRL-0141): Fractal ▸ Settings… opens fractal-ui://settings, a change
 * is written to userData/User/settings.json at once, an outside edit of the file shows up, and the
 * settings of earlier versions (s3* / trans* / translate languages) are moved on the first start.
 *
 *   FRACTAL_E2E_DEV=1 npx playwright test test/e2e-electron-app/settings.spec.ts   (after `cd electron && npm run compile`)
 *
 * Opens real windows (one app, two windows, about 20 s). Temp HOME (--use-mock-keychain: the keychain is
 * not touched) and temp userData, like the other desktop E2E specs.
 */
import { test, expect, _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { launchEnv, launchTarget, rmrf, sidebarPages, waitForFile } from './harness';

interface Fixture {
    tmp: string;
    home: string;
    userData: string;
    settingsFile: string;
}

function makeFixture(settings: Record<string, unknown>): Fixture {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fx-e2e-settings-')));
    const home = path.join(tmp, 'home');
    const userData = path.join(tmp, 'userData');
    fs.mkdirSync(home, { recursive: true });
    fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
    const settingsFile = path.join(userData, 'User', 'settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 4) + '\n');
    return { tmp, home, userData, settingsFile };
}

async function launch(fx: Fixture): Promise<ElectronApplication> {
    const target = launchTarget();
    const app = await electron.launch({
        executablePath: target.executablePath,
        args: [...target.args, '--use-mock-keychain', `--fractal-user-data=${fx.userData}`],
        env: launchEnv(fx),
        timeout: 90000,
    });
    await app.firstWindow({ timeout: 90000 });
    return app;
}

/** Runs the "Settings…" item of the application menu (what ⌘, does) */
async function openSettings(app: ElectronApplication): Promise<Page> {
    const clicked = await app.evaluate(({ Menu }) => {
        type Item = { label: string; click(): void; submenu?: { items: Item[] } | null };
        const find = (items: Item[]): Item | undefined => {
            for (const it of items) {
                if (it.label === 'Settings…') {
                    return it;
                }
                const sub = it.submenu ? find(it.submenu.items) : undefined;
                if (sub) {
                    return sub;
                }
            }
            return undefined;
        };
        const item = find((Menu.getApplicationMenu()?.items ?? []) as unknown as Item[]);
        item?.click();
        return !!item;
    });
    expect(clicked).toBe(true);
    const end = Date.now() + 20000;
    for (;;) {
        const page = app.windows().find((p) => p.url().startsWith('fractal-ui://settings/'));
        if (page) {
            await page.waitForSelector('.row[data-key="theme"]', { timeout: 20000 });
            return page;
        }
        if (Date.now() > end) {
            throw new Error('the settings window did not open');
        }
        await new Promise((r) => setTimeout(r, 100));
    }
}

const readSettings = (fx: Fixture) => JSON.parse(fs.readFileSync(fx.settingsFile, 'utf8')) as Record<string, unknown>;

/** On failure: the app's log and the screen, into the test's output folder */
async function keepEvidence(fx: Fixture, page: Page | undefined, outDir: string): Promise<void> {
    fs.mkdirSync(outDir, { recursive: true });
    const logs = path.join(fx.userData, 'logs');
    for (const f of fs.existsSync(logs) ? fs.readdirSync(logs) : []) {
        fs.copyFileSync(path.join(logs, f), path.join(outDir, f));
    }
    if (fs.existsSync(fx.settingsFile)) {
        fs.copyFileSync(fx.settingsFile, path.join(outDir, 'settings.json'));
    }
    await page?.screenshot({ path: path.join(outDir, 'settings-page.png') }).catch(() => undefined);
}

test('settings screen: change, reset, outside edit; earlier settings are moved', async ({}, testInfo) => {
    test.setTimeout(90000);
    const fx = makeFixture({
        // earlier versions' settings (moved on the first start)
        'fractal.s3AccessKeyId': 'AKIAOLDEXAMPLE',
        'fractal.s3SecretAccessKey': 'old-secret',
        'fractal.transRegion': 'ap-northeast-1',
        'fractal.translateTargetLang': 'fr',
    });
    const app = await launch(fx);
    let page: Page | undefined;
    try {
        const [sidebar] = await sidebarPages(app);
        await expect(sidebar.locator('.pane[data-view="notesExplorer"] .pane-header')).toBeVisible({ timeout: 30000 });

        // the move: new keys written, old ones removed, the language in globalState
        const moved = await waitForFile(fx.settingsFile, (s) => s.includes('fractal.awsAccessKeyId') && !s.includes('fractal.s3AccessKeyId'), 20000);
        const after = JSON.parse(moved);
        expect(after['fractal.awsAccessKeyId']).toBe('AKIAOLDEXAMPLE');
        expect(after['fractal.awsSecretAccessKey']).toBe('old-secret');
        expect(after['fractal.awsRegion']).toBe('ap-northeast-1');
        for (const old of ['fractal.s3AccessKeyId', 'fractal.s3SecretAccessKey', 'fractal.transRegion', 'fractal.translateTargetLang']) {
            expect(after[old], old).toBeUndefined();
        }
        const state = JSON.parse(await waitForFile(path.join(fx.userData, 'User', 'globalState.json'), (s) => s.includes('translateLangs'), 10000));
        expect(state.translateLangs).toEqual({ sourceLang: 'en', targetLang: 'fr' });
        expect(state.settingsMigration).toBe(1);

        // the screen
        page = await openSettings(app);
        await expect(page.locator('h1')).toHaveText('Settings');
        await expect(page.locator('h2')).toHaveText(['Display', 'Files', 'PDF export', 'AWS (S3 sync and translation)', 'Advanced']);
        await expect(page.locator('.row[data-key="awsAccessKeyId"] input')).toHaveValue('AKIAOLDEXAMPLE');
        await expect(page.locator('.row[data-key="awsSecretAccessKey"] input')).toHaveAttribute('type', 'password');
        await expect(page.locator('.row[data-key="s3AccessKeyId"]')).toHaveCount(0); // deprecated: not shown

        // a choice is written at once
        await page.locator('.row[data-key="theme"] select').selectOption('dark', { timeout: 10000 });
        await waitForFile(fx.settingsFile, (s) => /"fractal\.theme":\s*"dark"/.test(s), 10000);
        expect(readSettings(fx)['fractal.theme']).toBe('dark');
        await expect(page.locator('html')).toHaveAttribute('data-fr-theme', 'dark');

        // text is written when the field loses focus
        const region = page.locator('.row[data-key="awsRegion"] input');
        await region.fill('us-west-2', { timeout: 10000 });
        await region.press('Enter', { timeout: 10000 });
        await waitForFile(fx.settingsFile, (s) => s.includes('us-west-2'), 10000);

        // reset removes the user value
        await page.locator('.row[data-key="theme"] .reset').click({ timeout: 10000 });
        await waitForFile(fx.settingsFile, (s) => !s.includes('fractal.theme'), 10000);
        expect(readSettings(fx)['fractal.theme']).toBeUndefined();

        // an outside edit of settings.json shows up on the screen
        const edited = { ...readSettings(fx), 'fractal.fontSize': 16 };
        fs.writeFileSync(fx.settingsFile, JSON.stringify(edited, null, 4) + '\n');
        await expect(page.locator('.row[data-key="fontSize"] input')).toHaveValue('16', { timeout: 10000 });

        // a value outside the range is kept in it
        const size = page.locator('.row[data-key="fontSize"] input');
        await size.fill('400', { timeout: 10000 });
        await size.press('Enter', { timeout: 10000 });
        await waitForFile(fx.settingsFile, (s) => /"fractal\.fontSize":\s*40\b/.test(s), 10000);
    } catch (err) {
        await keepEvidence(fx, page, testInfo.outputPath('evidence'));
        throw err;
    } finally {
        // never leave the app open on the screen: close, and kill it if it does not quit in 10 s
        const closed = app.close().then(() => true, () => true);
        if (!(await Promise.race([closed, new Promise<boolean>((r) => setTimeout(() => r(false), 10000))]))) {
            app.process().kill('SIGKILL');
        }
        rmrf(fx.tmp);
    }
});
