/**
 * Preload of the settings window. Exposes window.fractalSettings to the settings page only: read the
 * state, write / reset one setting, pick a path for a field, open settings.json.
 * Channel names duplicated from electron/src/main/ipc.ts (a sandboxed preload cannot import it).
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
    getState: 'fractal-settings:get-state',
    set: 'fractal-settings:set',
    reset: 'fractal-settings:reset',
    pick: 'fractal-settings:pick',
    openFile: 'fractal-settings:open-file',
    state: 'fractal-settings:state',
    focus: 'fractal-settings:focus',
} as const;

contextBridge.exposeInMainWorld('fractalSettings', {
    getState: (): Promise<unknown> => ipcRenderer.invoke(CH.getState),
    set: (key: string, value: unknown): Promise<unknown> => ipcRenderer.invoke(CH.set, String(key), value),
    reset: (key: string): Promise<unknown> => ipcRenderer.invoke(CH.reset, String(key)),
    pick: (key: string): Promise<unknown> => ipcRenderer.invoke(CH.pick, String(key)),
    openFile: (): void => {
        ipcRenderer.send(CH.openFile);
    },
    onState: (listener: (state: unknown) => void): void => {
        ipcRenderer.on(CH.state, (_e, state: unknown) => listener(state));
    },
    onFocus: (listener: (key: string) => void): void => {
        ipcRenderer.on(CH.focus, (_e, key: unknown) => listener(String(key)));
    },
});
