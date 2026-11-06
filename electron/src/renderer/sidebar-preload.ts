/**
 * Preload of the sidebar page (fractal-ui://sidebar/index.html; sandbox + contextIsolation, no Node —
 * spec 20261107-0431-electron-sidebar D4). Exposes window.fractalSidebar to the page, and only:
 *   - the list model (getModel / onModel)
 *   - run the TreeItem.command of an item the page was given (runItem(handle)), a button / welcome
 *     link the page was given (runAction(token)), open an item's / a header's native menu, close a
 *     note's view (closeNote(handle)) — by handle / token only: the main process maps them to what
 *     package.json declares and refuses anything else
 *   - the sidebar's own UI state (collapsed, width, which sections are expanded)
 * Channel names duplicated from electron/src/main/ipc.ts (a sandboxed preload cannot import it).
 */
import { contextBridge, ipcRenderer } from 'electron';

const CH = {
    getModel: 'fractal-sidebar:get-model',
    model: 'fractal-sidebar:model',
    runItem: 'fractal-sidebar:run-item',
    runAction: 'fractal-sidebar:run-action',
    itemMenu: 'fractal-sidebar:item-menu',
    titleMenu: 'fractal-sidebar:title-menu',
    closeNote: 'fractal-sidebar:close-note',
    setCollapsed: 'fractal-sidebar:set-collapsed',
    setWidth: 'fractal-sidebar:set-width',
    setSection: 'fractal-sidebar:set-section',
} as const;

let listener: ((model: unknown) => void) | null = null;
ipcRenderer.on(CH.model, (_e, model: unknown) => {
    if (listener) {
        listener(model);
    }
});

contextBridge.exposeInMainWorld('fractalSidebar', {
    getModel: (): Promise<unknown> => ipcRenderer.invoke(CH.getModel),
    onModel: (cb: (model: unknown) => void): void => {
        listener = typeof cb === 'function' ? cb : null;
    },
    runItem: (handle: string): void => ipcRenderer.send(CH.runItem, String(handle)),
    runAction: (token: string): void => ipcRenderer.send(CH.runAction, String(token)),
    showItemMenu: (handle: string): void => ipcRenderer.send(CH.itemMenu, String(handle)),
    showTitleMenu: (viewId: string): void => ipcRenderer.send(CH.titleMenu, String(viewId)),
    closeNote: (handle: string): void => ipcRenderer.send(CH.closeNote, String(handle)),
    setCollapsed: (collapsed: boolean): void => ipcRenderer.send(CH.setCollapsed, collapsed === true),
    setWidth: (width: number, done: boolean): void => ipcRenderer.send(CH.setWidth, Number(width), done === true),
    setSectionExpanded: (viewId: string, expanded: boolean): void => ipcRenderer.send(CH.setSection, String(viewId), expanded === true),
});
