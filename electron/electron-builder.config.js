/**
 * The release build of the desktop app (npm run build:app-dir / build:mac): package.json "build", with
 * the app's version taken from the extension's package.json — the app ships the extension's own code,
 * so both carry one version and only the extension's is bumped. The E2E build
 * (electron-builder.e2e.config.js) starts from this one.
 */
const pkg = require('./package.json');
const ext = require('../package.json');

module.exports = {
    ...pkg.build,
    extraMetadata: { ...(pkg.build.extraMetadata || {}), version: ext.version },
};
