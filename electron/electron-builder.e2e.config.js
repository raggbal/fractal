/**
 * The E2E build of the desktop app (test/e2e-electron-app): the release config (electron-builder.config.js)
 * plus only what the tests need —
 * - its own output folder (dist/e2e), so it is never taken for the app you use (dist/mac-arm64);
 * - Electron's --inspect fuse on: Playwright's _electron drives the main process through the inspector;
 * - package.json "fractalTestBuild": true, so the app honors --fractal-user-data (each test runs on a
 *   temp profile). See src/main/launch-options.ts. RunAsNode / NODE_OPTIONS stay off as in the release;
 * - ad-hoc signing and no notarization: the tests need no Developer ID certificate in the keychain.
 *
 *   npm run build:e2e
 */
const base = require('./electron-builder.config.js');

module.exports = {
    ...base,
    mac: { ...base.mac, identity: '-', notarize: false },
    directories: { ...base.directories, output: 'dist/e2e' },
    extraMetadata: { ...(base.extraMetadata || {}), fractalTestBuild: true },
    electronFuses: { ...base.electronFuses, enableNodeCliInspectArguments: true },
};
