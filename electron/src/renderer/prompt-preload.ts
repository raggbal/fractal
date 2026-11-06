/**
 * Preload of a prompt window (showInputBox / showQuickPick). Exposes window.fractalPrompt to the
 * prompt page only: read the request, run the extension's validateInput, return the result.
 * Channel names duplicated from electron/src/main/ipc.ts (a sandboxed preload cannot import it).
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
    get: 'fractal-prompt:get',
    validate: 'fractal-prompt:validate',
    done: 'fractal-prompt:done',
} as const;

contextBridge.exposeInMainWorld('fractalPrompt', {
    getRequest: (): Promise<unknown> => ipcRenderer.invoke(CH.get),
    validate: (value: string): Promise<string | undefined> => ipcRenderer.invoke(CH.validate, String(value)),
    done: (result: unknown): void => {
        ipcRenderer.send(CH.done, result);
    },
});
