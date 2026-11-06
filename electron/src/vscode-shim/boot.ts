/**
 * Entry point for the Electron shell: build the shim, hook require('vscode'), load the extension's
 * own bundle (<extensionRoot>/out/extension.js) unchanged and activate it.
 *
 *   const ext = await bootExtension({ extensionRoot, userDataDir, host });
 *   const panel = await ext.controller.openNotesFolder('/path/to/note');   // → ShimWebviewPanel
 *   ...
 *   // quit: flush + dispose every panel first (fires onDidDispose → .out written), then
 *   await ext.deactivate();
 */
import * as path from 'path';
import { createVscodeShim, type ShimOptions, type VscodeShim } from './index';
import { installVscodeShim } from './install';
import { consoleLogger } from './adapters';

export interface ExtensionModule {
    activate(context: unknown): unknown;
    deactivate?(): unknown;
}

export interface BootedExtension extends VscodeShim {
    extension: ExtensionModule;
    /** deactivate() of the extension, then context.subscriptions disposed in order (VS Code), then flush. */
    deactivate(): Promise<void>;
}

export async function bootExtension(options: ShimOptions): Promise<BootedExtension> {
    const shim = createVscodeShim(options);
    const log = options.host.log ?? consoleLogger;
    installVscodeShim(shim.api);
    const entry = path.join(shim.controller.extensionRoot, 'out', 'extension.js');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const extension = require(entry) as ExtensionModule;
    if (!extension || typeof extension.activate !== 'function') {
        throw new Error(`${entry} does not export activate()`);
    }
    await extension.activate(shim.context);

    let deactivated: Promise<void> | undefined;
    const deactivate = (): Promise<void> => {
        if (!deactivated) {
            deactivated = (async () => {
                try {
                    await extension.deactivate?.();
                } catch (err) {
                    log.error('[vscode-shim] deactivate() failed:', err);
                }
                const subs = shim.context.subscriptions.splice(0);
                for (const d of subs) {
                    try {
                        d.dispose();
                    } catch (err) {
                        log.error('[vscode-shim] disposing a subscription failed:', err);
                    }
                }
                await shim.controller.flush();
                shim.controller.dispose();
            })();
        }
        return deactivated;
    };
    return { ...shim, extension, deactivate };
}
