/**
 * Makes require('vscode') resolve to the shim, so the extension bundle (out/extension.js) is loaded
 * unchanged: Module._resolveFilename maps the request 'vscode' to a synthetic module id whose
 * Module._cache entry already holds the shim object (Node returns cached exports without touching
 * the disk). Install BEFORE the first require of the bundle — esbuild's __toESM copies the shim's
 * own property names once, at that first require.
 */
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Module = require('module') as {
    _resolveFilename: (request: string, parent: unknown, isMain: boolean, options?: unknown) => string;
    _cache: Record<string, unknown>;
    new (id: string, parent: unknown): { filename: string; loaded: boolean; exports: unknown; paths: string[] };
};

export const VSCODE_SHIM_MODULE_ID = path.join(__dirname, '__vscode_shim__.js');

let installed: { api: object; restore: () => void } | undefined;

export function installVscodeShim(api: object): () => void {
    if (installed) {
        if (installed.api === api) {
            return installed.restore;
        }
        installed.restore();
    }
    const mod = new Module(VSCODE_SHIM_MODULE_ID, null);
    mod.filename = VSCODE_SHIM_MODULE_ID;
    mod.loaded = true;
    mod.exports = api;
    mod.paths = [];
    Module._cache[VSCODE_SHIM_MODULE_ID] = mod;

    const original = Module._resolveFilename;
    const patched = function (this: unknown, request: string, parent: unknown, isMain: boolean, options?: unknown): string {
        if (request === 'vscode') {
            return VSCODE_SHIM_MODULE_ID;
        }
        return original.call(this, request, parent, isMain, options);
    };
    Module._resolveFilename = patched;

    const restore = () => {
        if (Module._resolveFilename === patched) {
            Module._resolveFilename = original;
        }
        if (Module._cache[VSCODE_SHIM_MODULE_ID] === mod) {
            delete Module._cache[VSCODE_SHIM_MODULE_ID];
        }
        if (installed && installed.api === api) {
            installed = undefined;
        }
    };
    installed = { api, restore };
    return restore;
}
