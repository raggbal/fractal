/**
 * The E2E build of the desktop app (test/e2e-electron-app): the release config (package.json "build")
 * plus only what the tests need —
 * - its own output folder (dist/e2e), so it is never taken for the app you use (dist/mac-arm64);
 * - Electron's --inspect fuse on: Playwright's _electron drives the main process through the inspector;
 * - package.json "fractalTestBuild": true, so the app honors --fractal-user-data (each test runs on a
 *   temp profile). See src/main/launch-options.ts. RunAsNode / NODE_OPTIONS stay off as in the release.
 *
 *   npm run build:e2e
 */
const pkg = require('./package.json');

const base = pkg.build;

module.exports = {
    ...base,
    directories: { ...base.directories, output: 'dist/e2e' },
    extraMetadata: { ...(base.extraMetadata || {}), fractalTestBuild: true },
    electronFuses: { ...base.electronFuses, enableNodeCliInspectArguments: true },
};
