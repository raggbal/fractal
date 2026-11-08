/**
 * The sidebar has no codicon font: the few icons it draws are inline SVG (16×16, stroked with
 * currentColor). Keys are VS Code codicon ids — the `$(name)` of package.json command icons and the
 * ThemeIcon ids of the extension's tree items — plus the sidebar's own chrome. An id that is not
 * here is drawn without an icon. No Electron import (unit-tested: every icon the contributes and the
 * tree items use is here).
 */

export interface IconPath {
    d: string;
    /** filled instead of stroked */
    fill?: boolean;
}

export interface IconDef {
    paths: IconPath[];
}

const page = 'M4.5 1.5h5l3 3v9a1 1 0 0 1-1 1h-7a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z';
const fold = 'M9.5 1.5v3h3';

export const SIDEBAR_ICONS: Readonly<Record<string, IconDef>> = {
    // command icons (package.json contributes.commands[].icon)
    'new-file': { paths: [{ d: 'M8 14.5H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5l3 3V8' }, { d: fold }, { d: 'M12.5 10v5M10 12.5h5' }] },
    'new-folder': {
        paths: [{ d: 'M8 13.5H2.5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1V8' }, { d: 'M12.5 10v5M10 12.5h5' }],
    },
    'folder-opened': { paths: [{ d: 'M1.5 12.5V4a1 1 0 0 1 1-1h3.6l1.5 1.5h4.9a1 1 0 0 1 1 1V7' }, { d: 'M1.5 12.5l2-5.5h11l-2 5.5z' }] },
    'go-to-file': {
        paths: [{ d: 'M7 14.5H4.5a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1h5l3 3V7' }, { d: fold }, { d: 'M8.5 11.5h6M12.5 9.5l2 2-2 2' }],
    },
    close: { paths: [{ d: 'M4 4l8 8M12 4l-8 8' }] },
    // tree item icons (ThemeIcon ids of NotesListItem / NotesFolderItem)
    check: { paths: [{ d: 'M3 8.5l3.2 3.2L13 5' }] },
    warning: { paths: [{ d: 'M8 2l6.5 11.5h-13z' }, { d: 'M8 6.5v3.5M8 12v.01' }] },
    file: { paths: [{ d: page }, { d: fold }] },
    notebook: { paths: [{ d: 'M3.5 1.5h8a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-8z' }, { d: 'M5.5 1.5v13M8 5h2.5M8 7.5h2.5' }] },
    folder: { paths: [{ d: 'M1.5 4a1 1 0 0 1 1-1h3.6l1.5 1.5h5.9a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z' }] },
    // the sidebar's own chrome
    'chevron-right': { paths: [{ d: 'M6 3.5l4.5 4.5L6 12.5' }] },
    'chevron-down': { paths: [{ d: 'M3.5 6l4.5 4.5L12.5 6' }] },
    'layout-sidebar-left': { paths: [{ d: 'M1.5 2.5h13v11h-13z' }, { d: 'M2 3h4v10H2z', fill: true }, { d: 'M6 2.5v11' }] },
    'layout-sidebar-left-off': { paths: [{ d: 'M1.5 2.5h13v11h-13z' }, { d: 'M6 2.5v11' }] },
    'circle-filled': { paths: [{ d: 'M8 4.75a3.25 3.25 0 1 0 0 6.5a3.25 3.25 0 1 0 0-6.5z', fill: true }] },
    ellipsis: { paths: [{ d: 'M2.4 8a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0zM6.9 8a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0zM11.4 8a1.1 1.1 0 1 0 2.2 0a1.1 1.1 0 1 0-2.2 0z', fill: true }] },
};

/** The chrome icons the page always needs. */
export const SIDEBAR_CHROME_ICONS: readonly string[] = [
    'chevron-right',
    'chevron-down',
    'layout-sidebar-left',
    'layout-sidebar-left-off',
    'circle-filled',
    'close',
    'ellipsis',
];
