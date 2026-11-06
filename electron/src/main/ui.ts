/**
 * UiAdapter with Electron:
 * - show*Message: modal → a native message box (a sheet on the Notes window); non-modal → a toast in
 *   the current Notes window (VS Code's notification), or a message box when no window is open.
 *   Buttons follow VS Code: a modal without a close-affordance item gets a Cancel; Esc / Cancel
 *   returns the close-affordance item if there is one.
 * - open / save dialogs: native, as sheets on the current window.
 * - input box / quick pick: PromptService (prompt-window.ts).
 * - progress: a toast with a spinner (and Cancel when cancellable).
 */
import { dialog, type BrowserWindow, type MessageBoxOptions, type OpenDialogOptions, type SaveDialogOptions } from 'electron';
import type {
    InputBoxRequest,
    MessageRequest,
    OpenDialogRequest,
    ProgressHandle,
    ProgressRequest,
    QuickPickRequest,
    SaveDialogRequest,
    ShimLogger,
    UiAdapter,
} from '../vscode-shim/adapters';
import type { PanelHost } from './panel-host';
import type { PromptService } from './prompt-window';
import { plainLabel } from './labels';

export interface ElectronUiOptions {
    panels: PanelHost;
    prompts: PromptService;
    log: ShimLogger;
}

export class ElectronUi implements UiAdapter {
    constructor(private readonly o: ElectronUiOptions) {}

    /** The window dialogs attach to (a visible Notes window), if any. */
    parentWindow(): BrowserWindow | undefined {
        const p = this.o.panels.current();
        if (p && !p.isClosingOrGone && p.win.isVisible()) {
            return p.win;
        }
        return undefined;
    }

    async showMessage(req: MessageRequest): Promise<number | undefined> {
        const titles = req.items.map((i) => plainLabel(i.title));
        const panel = this.o.panels.current();
        if (!req.modal && panel && !panel.isClosingOrGone && panel.win.isVisible()) {
            const timeoutMs = titles.length > 0 ? 0 : req.severity === 'error' ? 15000 : 7000;
            return panel.showToast({ severity: req.severity, message: plainLabel(req.message), detail: req.detail, items: titles, timeoutMs }).result;
        }
        return this.messageBox(req, titles);
    }

    private async messageBox(req: MessageRequest, titles: string[]): Promise<number | undefined> {
        const closeIdx = req.items.findIndex((i) => i.isCloseAffordance);
        const buttons = titles.slice();
        let cancelId: number;
        if (closeIdx >= 0) {
            cancelId = closeIdx;
        } else {
            buttons.push(titles.length === 0 ? 'OK' : 'Cancel');
            cancelId = buttons.length - 1;
        }
        const opts: MessageBoxOptions = {
            type: req.severity === 'warning' ? 'warning' : req.severity === 'error' ? 'error' : 'info',
            message: plainLabel(req.message),
            detail: req.detail,
            buttons,
            cancelId,
            defaultId: 0,
            noLink: true,
        };
        const parent = this.parentWindow();
        const r = parent ? await dialog.showMessageBox(parent, opts) : await dialog.showMessageBox(opts);
        return r.response >= 0 && r.response < req.items.length ? r.response : undefined;
    }

    async showOpenDialog(req: OpenDialogRequest): Promise<string[] | undefined> {
        const properties: NonNullable<OpenDialogOptions['properties']> = ['createDirectory'];
        if (req.canSelectFiles || !req.canSelectFolders) {
            properties.push('openFile');
        }
        if (req.canSelectFolders) {
            properties.push('openDirectory');
        }
        if (req.canSelectMany) {
            properties.push('multiSelections');
        }
        const opts: OpenDialogOptions = {
            title: req.title,
            message: req.title, // macOS shows this inside the panel (sheets have no title bar)
            buttonLabel: req.openLabel,
            defaultPath: req.defaultPath,
            properties,
            filters: req.filters,
        };
        const parent = this.parentWindow();
        const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
        return r.canceled || r.filePaths.length === 0 ? undefined : r.filePaths;
    }

    async showSaveDialog(req: SaveDialogRequest): Promise<string | undefined> {
        const opts: SaveDialogOptions = {
            title: req.title,
            message: req.title,
            buttonLabel: req.saveLabel,
            defaultPath: req.defaultPath,
            filters: req.filters,
            properties: ['createDirectory', 'showOverwriteConfirmation'],
        };
        const parent = this.parentWindow();
        const r = parent ? await dialog.showSaveDialog(parent, opts) : await dialog.showSaveDialog(opts);
        return r.canceled || !r.filePath ? undefined : r.filePath;
    }

    showInputBox(req: InputBoxRequest): Promise<string | undefined> {
        return this.o.prompts.input(req);
    }

    showQuickPick(req: QuickPickRequest): Promise<number[] | undefined> {
        return this.o.prompts.pick(req);
    }

    startProgress(req: ProgressRequest, onCancel: () => void): ProgressHandle {
        const panel = this.o.panels.current();
        const title = plainLabel(req.title || 'Working…');
        if (!panel || panel.isClosingOrGone) {
            this.o.log.info(`[progress] ${title}`);
            return { report: () => undefined, done: () => undefined };
        }
        const items = req.cancellable ? ['Cancel'] : [];
        const toast = { severity: 'info' as const, message: title, items, timeoutMs: 0, progress: true };
        const { id, result } = panel.showToast(toast);
        let finished = false;
        void result.then((index) => {
            if (!finished && index === 0 && req.cancellable) {
                onCancel();
            }
        });
        return {
            report: (value) => {
                if (!finished && value && typeof value.message === 'string' && value.message) {
                    panel.updateToast(id, { ...toast, message: `${title} — ${plainLabel(value.message)}` });
                }
            },
            done: () => {
                finished = true;
                panel.closeToast(id);
            },
        };
    }
}
