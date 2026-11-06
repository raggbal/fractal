/**
 * The application menu (spec D2: switching notes and adding a .fractal happen here — there is no
 * VS Code tree view). The Notes / Notes Lists submenus are built from the extension's own tree data
 * providers (notesExplorer / notesLists) and run the commands their items carry.
 * Edit uses the standard roles: on macOS the page sees Cmd+Z / Cmd+C … first, so the webview's own
 * undo / clipboard handling wins and the role only acts when the page leaves the key alone.
 */
import { app, Menu, type MenuItemConstructorOptions } from 'electron';

export interface NoteMenuEntry {
    label: string;
    folderPath: string;
    open: boolean;
}

export interface ListMenuEntry {
    label: string;
    file: string;
    active: boolean;
    error?: string;
}

export interface MenuActions {
    newNote(): void;
    openNoteFolder(): void;
    addNoteFolderToList(): void;
    openNote(folderPath: string): void;
    activateList(file: string): void;
    addExistingList(): void;
    createList(): void;
    removeList(): void;
    save(): void;
    revealNote(): void;
    toggleSidePanel(): void;
    reloadNote(): void;
    toggleDevTools(): void;
    openSettings(): void;
    openLogs(): void;
}

export interface MenuModel {
    notes: NoteMenuEntry[];
    lists: ListMenuEntry[];
    hasPanel: boolean;
}

export function buildMenu(model: MenuModel, a: MenuActions): Menu {
    const isMac = process.platform === 'darwin';
    const notesSubmenu: MenuItemConstructorOptions[] =
        model.notes.length > 0
            ? model.notes.map((n) => ({
                  label: n.label,
                  sublabel: n.folderPath,
                  toolTip: n.folderPath,
                  type: 'checkbox' as const,
                  checked: n.open,
                  click: () => a.openNote(n.folderPath),
              }))
            : [{ label: 'No notes in the active list', enabled: false }];
    const listsSubmenu: MenuItemConstructorOptions[] = [
        ...model.lists.map((l) => ({
            label: `${l.error ? '⚠ ' : ''}${l.label}`,
            sublabel: l.file,
            toolTip: l.error ? `${l.error}\n${l.file}` : l.file,
            type: 'radio' as const,
            checked: l.active,
            click: () => a.activateList(l.file),
        })),
        ...(model.lists.length > 0 ? [{ type: 'separator' as const }] : []),
        { label: 'Add Existing .fractal…', click: () => a.addExistingList() },
        { label: 'Create New .fractal…', click: () => a.createList() },
        { label: 'Remove .fractal from List…', enabled: model.lists.length > 0, click: () => a.removeList() },
    ];

    const template: MenuItemConstructorOptions[] = [
        ...(isMac
            ? [
                  {
                      label: app.name,
                      submenu: [
                          { role: 'about' as const },
                          { type: 'separator' as const },
                          { label: 'Settings…', accelerator: 'Cmd+,', click: () => a.openSettings() },
                          { type: 'separator' as const },
                          { role: 'services' as const },
                          { type: 'separator' as const },
                          { role: 'hide' as const },
                          { role: 'hideOthers' as const },
                          { role: 'unhide' as const },
                          { type: 'separator' as const },
                          { role: 'quit' as const },
                      ],
                  },
              ]
            : []),
        {
            label: 'File',
            submenu: [
                // no Cmd+N: the outliner uses it (new node)
                { label: 'New Note…', click: () => a.newNote() },
                { label: 'Open Note Folder…', accelerator: 'CmdOrCtrl+O', click: () => a.openNoteFolder() },
                { label: 'Add Note Folder to List…', click: () => a.addNoteFolderToList() },
                { type: 'separator' },
                { label: 'Notes', submenu: notesSubmenu },
                { label: 'Notes Lists (.fractal)', submenu: listsSubmenu },
                { type: 'separator' },
                { label: 'Save', accelerator: 'CmdOrCtrl+S', enabled: model.hasPanel, click: () => a.save() },
                { label: 'Reveal Note in Finder', enabled: model.hasPanel, click: () => a.revealNote() },
                { type: 'separator' },
                ...(isMac ? [] : [{ label: 'Settings…', accelerator: 'Ctrl+,', click: () => a.openSettings() }, { type: 'separator' as const }]),
                { role: 'close' },
            ],
        },
        { role: 'editMenu' },
        {
            label: 'View',
            submenu: [
                { label: 'Toggle Side Panel', accelerator: 'CmdOrCtrl+\\', enabled: model.hasPanel, click: () => a.toggleSidePanel() },
                { type: 'separator' },
                { label: 'Reload Note', accelerator: 'CmdOrCtrl+R', enabled: model.hasPanel, click: () => a.reloadNote() },
                { label: 'Toggle Developer Tools', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', enabled: model.hasPanel, click: () => a.toggleDevTools() },
                { type: 'separator' },
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
            ],
        },
        { role: 'windowMenu' },
        {
            role: 'help',
            submenu: [
                { label: 'Open Settings File', click: () => a.openSettings() },
                { label: 'Open Logs Folder', click: () => a.openLogs() },
            ],
        },
    ];
    return Menu.buildFromTemplate(template);
}
