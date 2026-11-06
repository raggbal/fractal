/**
 * AC-3 (spec 20261107-0431-electron-sidebar): the desktop sidebar's reading of package.json
 * contributes (buttons, right-click menus, welcome content, icons), the when-clause subset, the
 * command allowlist (the page gets handles / tokens; only TreeItem.command of an item it was given or
 * a command package.json declares for that view resolves), the IPC sender rule, and the shim's
 * createTreeView registry / setContext that feed it. Plus the real extension bundle's own tree views
 * through the same model (child process, temp HOME).
 *
 * Node-side only (no Electron): the modules under test do not import 'electron'.
 */
import { test, expect } from '@playwright/test';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createHeadlessHost, createVscodeShim } from '../../electron/src/vscode-shim/index';
import {
    codiconId,
    evaluateWhen,
    groupMenuEntries,
    parseCommandLink,
    parseMenuGroup,
    parseWelcomeContents,
    readSidebarContributes,
    type SidebarContributes,
} from '../../electron/src/main/sidebar-contributes';
import { SIDEBAR_CHROME_ICONS, SIDEBAR_ICONS } from '../../electron/src/main/sidebar-icons';
import {
    acceptSidebarSender,
    buildSidebarSnapshot,
    clampSidebarWidth,
    decorateSidebar,
    hasSection,
    resolveAction,
    resolveItem,
    SIDEBAR_PAGE_URL,
    SnapshotHistory,
    type PageSection,
    type SidebarSnapshot,
    type TreeSource,
} from '../../electron/src/main/sidebar-model';
import { AppStateStore, notesToReopen } from '../../electron/src/main/app-state';
import { COMMON, DARK, LIGHT, webviewThemeCss } from '../../electron/src/main/theme-vars';
import { SIDEBAR_CSP, SIDEBAR_META_CSP, SIDEBAR_PAGE_CSS, SIDEBAR_PAGE_HTML } from '../../electron/src/main/sidebar-assets';

const REPO_ROOT = path.resolve(__dirname, '../..');
const PKG = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const contributes = readSidebarContributes(PKG);

function mkTmp(prefix = 'fx-sidebar-'): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p: string): void {
    try {
        fs.rmSync(p, { recursive: true, force: true });
    } catch {
        /* best effort */
    }
}

/** A provider over fixed elements whose TreeItem is the element itself (like NotesFolderProvider). */
function provider(items: unknown[]): unknown {
    return { getChildren: () => items, getTreeItem: (e: unknown) => e };
}

/** The extension's two kinds of rows, the way src/notesFolderProvider.ts builds them. */
function noteItem(folderPath: string): Record<string, unknown> {
    return {
        label: path.basename(folderPath),
        folderPath,
        tooltip: folderPath,
        contextValue: 'notesFolder',
        command: { command: 'fractal.openNotesFolder', title: 'Open Notes', arguments: [folderPath] },
        iconPath: { id: 'notebook' },
    };
}

function listItem(file: string, active: boolean): Record<string, unknown> {
    return {
        label: path.basename(file),
        file,
        description: active ? '●' : undefined,
        tooltip: file,
        contextValue: 'notesList',
        iconPath: { id: active ? 'check' : 'file' },
        command: { command: 'fractal.activateNotesRegistry', title: 'Switch .fractal', arguments: [file] },
    };
}

async function snapshotOf(
    trees: Record<string, unknown[]>,
    keys: Record<string, unknown> = {},
    rev = 1,
    c: SidebarContributes = contributes,
    views: Record<string, TreeSource['view']> = {}
): Promise<SidebarSnapshot> {
    const map = new Map<string, TreeSource>();
    for (const [id, items] of Object.entries(trees)) {
        map.set(id, { provider: provider(items), view: views[id] });
    }
    return buildSidebarSnapshot({ rev, contributes: c, trees: map, contextKeys: new Map(Object.entries(keys)) });
}

function section(s: SidebarSnapshot, viewId: string): PageSection {
    const found = s.sections.find((x) => x.viewId === viewId);
    expect(found, viewId).toBeTruthy();
    return found!;
}

const commandOf = (s: SidebarSnapshot, token: string) => {
    const a = resolveAction(s, token);
    return a && a.kind === 'command' ? a.command : undefined;
};

test.describe('electron sidebar — AC-3 package.json contributes', () => {
    test('AC-3 reads the views of the activity-bar container, their names, the command titles / codicons and the view menus from the real package.json', () => {
        expect(contributes.containerTitle).toBe('Fractal Note');
        expect(contributes.views).toEqual([
            { id: 'notesLists', name: 'Fractal List' },
            { id: 'notesExplorer', name: 'Notes' },
        ]);
        expect(contributes.commands.get('fractal.newNote')).toEqual({ id: 'fractal.newNote', title: 'New Note…', icon: 'new-folder' });
        expect(contributes.commands.get('fractal.removeNotesFolder')?.icon).toBe('close');
        expect(contributes.commands.get('fractal.migrateToFlatLayout')?.icon).toBeUndefined();
        expect(contributes.viewTitle.map((e) => [e.command, e.group, e.order])).toEqual([
            ['fractal.createNotesRegistry', 'navigation', 1],
            ['fractal.openNotesRegistry', 'navigation', 2],
            ['fractal.newNote', 'navigation', 1],
            ['fractal.addNotesFolder', 'navigation', 2],
        ]);
        expect(contributes.viewItemContext.map((e) => [e.command, e.group])).toEqual([
            ['fractal.revealNotesRegistry', 'inline'],
            ['fractal.removeNotesRegistry', 'inline'],
            ['fractal.revealNotesFolder', 'inline'],
            ['fractal.removeNotesFolder', 'inline'],
            ['fractal.migrateToFlatLayout', '1_modification'],
        ]);
        expect(contributes.viewsWelcome.map((w) => [w.view, w.when])).toEqual([
            ['notesLists', undefined],
            ['notesExplorer', '!fractal.hasNotesRegistry'],
            ['notesExplorer', 'fractal.hasNotesRegistry'],
        ]);
        // malformed input never throws and yields nothing
        for (const bad of [undefined, null, 1, 'x', { contributes: { views: 3, menus: { 'view/title': 'x' }, commands: {} } }]) {
            const r = readSidebarContributes(bad);
            expect([r.views.length, r.commands.size, r.viewTitle.length, r.viewItemContext.length, r.viewsWelcome.length]).toEqual([0, 0, 0, 0, 0]);
        }
        expect(codiconId('$(new-folder)')).toBe('new-folder');
        expect(codiconId('$(sync~spin)')).toBe('sync');
        expect(codiconId({ light: 'a.svg', dark: 'b.svg' })).toBeUndefined();
        expect(codiconId('new-folder')).toBeUndefined();
        expect(parseMenuGroup('navigation@2')).toEqual({ group: 'navigation', order: 2 });
        expect(parseMenuGroup('inline')).toEqual({ group: 'inline', order: Number.POSITIVE_INFINITY });
        expect(parseMenuGroup(undefined)).toEqual({ group: '', order: Number.POSITIVE_INFINITY });
    });

    test('AC-3 header buttons (view/title navigation), row buttons (inline) and right-click entries (the rest) follow the when-clauses', async () => {
        const note = '/notes/n1';
        const file = '/home/u/.fractal/default.fractal';
        const withList = await snapshotOf({ notesLists: [listItem(file, true)], notesExplorer: [noteItem(note)] }, { 'fractal.hasNotesRegistry': true });
        const lists = section(withList, 'notesLists');
        const notes = section(withList, 'notesExplorer');
        expect(lists.title).toBe('Fractal List');
        expect(notes.title).toBe('Notes');
        expect(lists.actions.map((a) => [a.title, a.icon])).toEqual([
            ['Create New .fractal…', 'new-file'],
            ['Add Existing .fractal…', 'folder-opened'],
        ]);
        expect(notes.actions.map((a) => [a.title, a.icon])).toEqual([
            ['New Note…', 'new-folder'],
            ['Add Existing Note Folder…', 'folder-opened'],
        ]);
        expect(lists.actions.map((a) => commandOf(withList, a.token))).toEqual([
            { command: 'fractal.createNotesRegistry', args: [] },
            { command: 'fractal.openNotesRegistry', args: [] },
        ]);
        // rows: label / description / tooltip / ThemeIcon; inline buttons with the element as the argument (VS Code)
        const [noteRow] = notes.items;
        expect(noteRow).toMatchObject({ label: 'n1', tooltip: note, icon: 'notebook', note: true, menu: true });
        expect(noteRow.inline.map((a) => [a.title, a.icon])).toEqual([
            ['Reveal in Finder / Explorer', 'go-to-file'],
            ['Remove from Notes (keeps the folder)', 'close'],
        ]);
        const noteRecord = resolveItem(withList, noteRow.handle)!;
        expect(noteRecord.command).toEqual({ command: 'fractal.openNotesFolder', args: [note] });
        expect(noteRecord.noteFolder).toBe(note);
        const reveal = commandOf(withList, noteRow.inline[0].token)!;
        expect(reveal.command).toBe('fractal.revealNotesFolder');
        expect(reveal.args[0]).toBe(noteRecord.element); // the same object the provider returned
        expect(noteRecord.menu.map((g) => g.map((e) => e.title))).toEqual([['Migrate to Flat Layout']]);
        const [listRow] = lists.items;
        expect(listRow).toMatchObject({ label: 'default.fractal', description: '●', icon: 'check', note: false, menu: false });
        expect(listRow.inline.map((a) => commandOf(withList, a.token)?.command)).toEqual(['fractal.revealNotesRegistry', 'fractal.removeNotesRegistry']);
        expect(resolveItem(withList, listRow.handle)?.command).toEqual({ command: 'fractal.activateNotesRegistry', args: [file] });

        // fractal.hasNotesRegistry false / unset → no Notes header buttons; the Fractal List ones do not depend on it
        for (const keys of [{ 'fractal.hasNotesRegistry': false }, {}]) {
            const s = await snapshotOf({ notesLists: [listItem(file, true)], notesExplorer: [] }, keys);
            expect(section(s, 'notesExplorer').actions).toEqual([]);
            expect(section(s, 'notesLists').actions.length).toBe(2);
        }
        // a row whose contextValue no entry names: no buttons, no menu (and not a note without the open command)
        const odd = await snapshotOf({ notesExplorer: [{ label: 'x', contextValue: 'other' }] }, { 'fractal.hasNotesRegistry': true });
        expect(section(odd, 'notesExplorer').items[0]).toMatchObject({ label: 'x', inline: [], menu: false, note: false });
        // only views with a registered tree are drawn, in the contributed order
        expect((await snapshotOf({ notesExplorer: [] })).sections.map((s) => s.viewId)).toEqual(['notesExplorer']);
        expect((await snapshotOf({ notesExplorer: [], notesLists: [] })).sections.map((s) => s.viewId)).toEqual(['notesLists', 'notesExplorer']);
        // TreeView.title / description / message are the header's
        const titled = await snapshotOf({ notesExplorer: [noteItem(note)] }, {}, 1, contributes, {
            notesExplorer: { title: 'My notes', description: 'work.fractal', message: 'Hello' },
        });
        expect(section(titled, 'notesExplorer')).toMatchObject({ title: 'My notes', description: 'work.fractal', message: 'Hello' });
    });

    test('AC-3 VS Code menu order; entries of undeclared commands are not offered; the "…" menu takes the non-navigation title entries', async () => {
        const custom: SidebarContributes = {
            containerTitle: 'C',
            views: [{ id: 'v', name: 'V' }],
            commands: new Map([
                ['c.a', { id: 'c.a', title: 'Alpha', icon: 'add' }],
                ['c.b', { id: 'c.b', title: 'Beta' }],
                ['c.z', { id: 'c.z', title: 'Zed' }],
            ]),
            viewTitle: [
                { command: 'c.b', group: 'navigation', order: 2, index: 0, when: 'view == v' },
                { command: 'c.a', group: 'navigation', order: 1, index: 1, when: 'view == v' },
                { command: 'c.z', group: '2_more', order: Number.POSITIVE_INFINITY, index: 2 },
                { command: 'c.a', group: '1_first', order: Number.POSITIVE_INFINITY, index: 3 },
                { command: 'c.undeclared', group: 'navigation', order: 0, index: 4 },
                { command: 'c.b', group: 'navigation', order: 3, index: 5, when: 'view == other' },
            ],
            viewItemContext: [
                { command: 'c.z', group: '', order: Number.POSITIVE_INFINITY, index: 0 },
                { command: 'c.b', group: 'b_group', order: Number.POSITIVE_INFINITY, index: 1 },
                { command: 'c.a', group: 'navigation', order: Number.POSITIVE_INFINITY, index: 2 },
                { command: 'c.undeclared', group: 'inline', order: 1, index: 3 },
            ],
            viewsWelcome: [],
        };
        const s = await snapshotOf({ v: [{ label: 'row' }] }, {}, 7, custom);
        const v = section(s, 'v');
        expect(v.actions.map((a) => a.title)).toEqual(['Alpha', 'Beta']);
        expect(v.more).toBe(true);
        expect(s.titleMenus.get('v')?.map((g) => g.map((e) => e.command.command))).toEqual([['c.a'], ['c.z']]);
        // navigation first, then by group name, no group last; nothing for the undeclared command
        expect(resolveItem(s, v.items[0].handle)?.menu.map((g) => g.map((e) => e.title))).toEqual([['Alpha'], ['Beta'], ['Zed']]);
        expect(v.items[0].inline).toEqual([]);
        expect(JSON.stringify(s.sections)).not.toContain('undeclared');
        const groups = groupMenuEntries(custom.viewItemContext, (e) => e.command);
        expect(groups.map((g) => g[0].group)).toEqual(['navigation', 'b_group', 'inline', '']);
    });

    test('AC-3 welcome content: shown only for an empty view whose when holds; one-link lines are buttons, other links inline; command links (with args), https links, file: links', async () => {
        const empty = await snapshotOf({ notesLists: [], notesExplorer: [] }, { 'fractal.hasNotesRegistry': true });
        const lists = section(empty, 'notesLists');
        expect(lists.welcome.map((l) => (l.kind === 'button' ? `[${l.title}]` : l.parts.map((p) => ('text' in p ? p.text : `<${p.title}>`)).join('')))).toEqual([
            'Add an existing .fractal, or create a new one.',
            '[Add Existing .fractal]',
            '[Create New .fractal]',
        ]);
        const buttons = lists.welcome.filter((l): l is { kind: 'button'; token: string; title: string } => l.kind === 'button');
        expect(buttons.map((b) => commandOf(empty, b.token))).toEqual([
            { command: 'fractal.openNotesRegistry', args: [] },
            { command: 'fractal.createNotesRegistry', args: [] },
        ]);
        const notes = section(empty, 'notesExplorer');
        expect(notes.welcome.filter((l) => l.kind === 'button').map((l) => (l as { title: string }).title)).toEqual(['New Note', 'Add Existing Note Folder']);
        const noRegistry = await snapshotOf({ notesExplorer: [] }, { 'fractal.hasNotesRegistry': false });
        expect(section(noRegistry, 'notesExplorer').welcome).toEqual([{ kind: 'paragraph', parts: [{ text: 'Choose or create a .fractal in Fractal List above.' }] }]);
        // not shown when the view has items
        const full = await snapshotOf({ notesLists: [listItem('/a.fractal', true)] });
        expect(section(full, 'notesLists').welcome).toEqual([]);

        // the parser (VS Code's linked text)
        expect(parseWelcomeContents('See [docs](https://example.com/d "Docs") and [run](command:x.y) now.\n\n[Only](command:a.b)')).toEqual([
            {
                kind: 'paragraph',
                parts: [
                    { kind: 'text', text: 'See ' },
                    { kind: 'link', title: 'docs', target: 'https://example.com/d' },
                    { kind: 'text', text: ' and ' },
                    { kind: 'link', title: 'run', target: 'command:x.y' },
                    { kind: 'text', text: ' now.' },
                ],
            },
            { kind: 'button', title: 'Only', target: 'command:a.b' },
        ]);
        expect(parseWelcomeContents('[not a link](javascript:alert(1))')).toEqual([{ kind: 'paragraph', parts: [{ kind: 'text', text: '[not a link](javascript:alert(1))' }] }]);
        expect(parseCommandLink('command:a.b')).toEqual({ command: 'a.b', args: [] });
        expect(parseCommandLink(`command:a.b?${encodeURIComponent(JSON.stringify(['x', 1]))}`)).toEqual({ command: 'a.b', args: ['x', 1] });
        expect(parseCommandLink(`command:a.b?${encodeURIComponent(JSON.stringify({ k: 1 }))}`)).toEqual({ command: 'a.b', args: [{ k: 1 }] });
        expect(parseCommandLink('command:a.b?%7Bbroken')).toBeUndefined();
        expect(parseCommandLink('https://example.com')).toBeUndefined();
        // links in a view's welcome: command → command, https → the OS browser, file: → plain text
        const custom: SidebarContributes = {
            ...contributes,
            views: [{ id: 'w', name: 'W' }],
            viewsWelcome: [{ view: 'w', contents: '[A](command:c.a?%5B%22z%22%5D)\n[Web](https://example.com/x)\n[File](file:///etc/hosts)' }],
        };
        const ws = await snapshotOf({ w: [] }, {}, 3, custom);
        const wSection = section(ws, 'w');
        expect(wSection.welcome.map((l) => l.kind)).toEqual(['button', 'button', 'paragraph']);
        const [a, web] = wSection.welcome as Array<{ token: string }>;
        expect(resolveAction(ws, a.token)).toEqual({ kind: 'command', viewId: 'w', command: { command: 'c.a', args: ['z'] } });
        expect(resolveAction(ws, web.token)).toEqual({ kind: 'external', viewId: 'w', url: 'https://example.com/x' });
        expect(wSection.welcome[2]).toEqual({ kind: 'paragraph', parts: [{ text: 'File' }] });
    });

    test('AC-3 icons: every codicon the view menus and the extension tree items use, and the chrome, has an inline SVG', async () => {
        const used = new Set<string>(SIDEBAR_CHROME_ICONS);
        for (const e of [...contributes.viewTitle, ...contributes.viewItemContext]) {
            const icon = contributes.commands.get(e.command)?.icon;
            if (icon) {
                used.add(icon);
            }
        }
        // ThemeIcons of src/notesFolderProvider.ts (NotesListItem: warning / check / file; NotesFolderItem: notebook)
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'notesFolderProvider.ts'), 'utf8');
        for (const m of src.matchAll(/new vscode\.ThemeIcon\(([^)]*)\)/g)) {
            for (const id of m[1].matchAll(/'([a-z-]+)'/g)) {
                used.add(id[1]);
            }
        }
        expect([...used].sort()).toEqual(expect.arrayContaining(['check', 'close', 'file', 'folder-opened', 'go-to-file', 'new-file', 'new-folder', 'notebook', 'warning']));
        for (const id of used) {
            const def = SIDEBAR_ICONS[id];
            expect(def, `no SVG for $(${id})`).toBeTruthy();
            for (const p of def.paths) {
                expect(p.d, id).toMatch(/^[MmLlHhVvCcSsQqTtAaZz0-9 .,-]+$/);
            }
        }
        // the snapshot ships the icons its rows / buttons use
        const s = await snapshotOf({ notesLists: [listItem('/a.fractal', false)], notesExplorer: [noteItem('/n')] }, { 'fractal.hasNotesRegistry': true });
        expect(Object.keys(s.icons)).toEqual(expect.arrayContaining(['file', 'notebook', 'go-to-file', 'close', 'new-folder', 'new-file', 'folder-opened', 'chevron-down']));
    });
});

test.describe('electron sidebar — the page: theme variables and CSP', () => {
    test('the sidebar page reads only --vscode-* variables the note views get, each defined for light and dark; its CSP runs only its own script and style', () => {
        const used = [...new Set([...SIDEBAR_PAGE_CSS.matchAll(/var\(--vscode-([A-Za-z0-9-]+)\)/g)].map((m) => m[1]))];
        expect(used.length).toBeGreaterThan(15);
        expect(used).toEqual(expect.arrayContaining(['sideBar-background', 'sideBar-foreground', 'list-activeSelectionBackground', 'focusBorder']));
        const css = webviewThemeCss();
        for (const v of used) {
            expect(v in COMMON || (v in LIGHT && v in DARK), `--vscode-${v} is not defined for both light and dark (theme-vars.ts)`).toBe(true);
            expect(css).toContain(`--vscode-${v}:`);
        }
        // light and dark differ where the side bar draws text and background
        expect([LIGHT['sideBar-background'], LIGHT['sideBar-foreground']]).not.toEqual([DARK['sideBar-background'], DARK['sideBar-foreground']]);
        // CSP: nothing but its own script / style; no inline code, no frames, no network
        for (const csp of [SIDEBAR_CSP, SIDEBAR_META_CSP]) {
            expect(csp).toContain("default-src 'none'");
            expect(csp).toContain("script-src 'self'");
            expect(csp).toContain("style-src 'self'");
            expect(csp).toContain("connect-src 'none'");
            expect(csp).toContain("frame-src 'none'");
            expect(csp).not.toMatch(/unsafe-|\*|https?:|data:|blob:/);
        }
        expect(SIDEBAR_CSP).toContain("frame-ancestors 'none'"); // header only (a meta element ignores it)
        expect(SIDEBAR_META_CSP).not.toContain('frame-ancestors');
        expect(SIDEBAR_PAGE_HTML).toContain(`content="${SIDEBAR_META_CSP}"`);
        expect([...SIDEBAR_PAGE_HTML.matchAll(/<script\b[^>]*>/g)].map((m) => m[0])).toEqual(['<script src="sidebar.js">']);
        expect(SIDEBAR_PAGE_HTML).not.toMatch(/<style|\sstyle=|\son[a-z]+=/i); // no inline style / event handler attributes
    });
});

test.describe('electron sidebar — AC-3 when-clauses (view / viewItem / setContext keys only)', () => {
    test('AC-3 evaluateWhen: ==, !=, !, &&, ||, parentheses, quoted values, VS Code loose equality; anything else is false', () => {
        const ctx = { view: 'notesExplorer', viewItem: 'notesFolder', 'fractal.hasNotesRegistry': true, count: 2, empty: '', zero: 0 };
        const cases: Array<[string | undefined, boolean]> = [
            [undefined, true],
            ['', true],
            ['   ', true],
            ['view == notesExplorer', true],
            ['view == notesLists', false],
            ['view != notesLists', true],
            ["view == 'notesExplorer'", true],
            ['view == "notesExplorer"', true],
            ['view === notesExplorer', true],
            ['view == notesExplorer && viewItem == notesFolder', true],
            ['view == notesExplorer && viewItem == notesList', false],
            ['view == notesLists || viewItem == notesFolder', true],
            ['view == notesExplorer && fractal.hasNotesRegistry', true],
            ['fractal.hasNotesRegistry', true],
            ['!fractal.hasNotesRegistry', false],
            ['!missing.key', true],
            ['missing.key', false],
            ['!(view == notesLists)', true],
            ['(view == notesLists || view == notesExplorer) && !empty', true],
            ['fractal.hasNotesRegistry == true', true],
            ['fractal.hasNotesRegistry == false', false],
            ['count == 2', true], // loose ==, like VS Code's ContextKeyEqualsExpr
            ['zero', false],
            ['true', true],
            ['false', false],
            ['!true', false],
            // outside the subset → false, whatever the context
            ['view =~ /notes/', false],
            ['count > 1', false],
            ['view in notesViews', false],
            ['view not in notesViews', false],
            ['view ==', false],
            ['(view == notesExplorer', false],
            ['view == notesExplorer)', false],
            ['&& view', false],
            ["view == 'unterminated", false],
        ];
        for (const [when, expected] of cases) {
            expect(evaluateWhen(when, ctx), String(when)).toBe(expected);
        }
        // own keys only (no prototype lookups)
        expect(evaluateWhen('constructor', {})).toBe(false);
        expect(evaluateWhen('toString', {})).toBe(false);
    });
});

test.describe('electron sidebar — AC-3 the command allowlist and the IPC rule (D4)', () => {
    test('AC-3 the page model carries no command ids; handles / tokens resolve only within their snapshot (and the one before it)', async () => {
        const note = '/notes/n1';
        const s1 = await snapshotOf({ notesLists: [listItem('/a.fractal', true)], notesExplorer: [noteItem(note)] }, { 'fractal.hasNotesRegistry': true }, 1);
        const json = JSON.stringify(s1.sections);
        expect(json).not.toMatch(/fractal\.(open|reveal|remove|new|add|create|activate|migrate)/);
        expect(json).not.toContain('"command"');
        const handle = section(s1, 'notesExplorer').items[0].handle;
        const token = section(s1, 'notesExplorer').actions[0].token;
        expect(resolveItem(s1, handle)?.command?.command).toBe('fractal.openNotesFolder');
        expect(commandOf(s1, token)?.command).toBe('fractal.newNote');
        // made-up, malformed and non-string values
        for (const bad of ['h1.9.9', 'a1.999', 'h2.1.0', 'fractal.newNote', '', 'h1', null, undefined, 42, { handle }, [handle]]) {
            expect(resolveItem(s1, bad), String(bad)).toBeUndefined();
            expect(resolveAction(s1, bad), String(bad)).toBeUndefined();
        }
        expect(resolveItem(undefined, handle)).toBeUndefined();
        // a later snapshot: the old handle is not its own
        const s2 = await snapshotOf({ notesExplorer: [noteItem(note)] }, { 'fractal.hasNotesRegistry': true }, 2);
        expect(resolveItem(s2, handle)).toBeUndefined();
        expect(resolveAction(s2, token)).toBeUndefined();
        // the history answers for the snapshot the user saw (one back), never older
        const h = new SnapshotHistory();
        h.push(s1);
        h.push(s2);
        expect(h.resolveItem(handle)?.noteFolder).toBe(note);
        expect(h.resolveAction(token)?.kind).toBe('command');
        const s3 = await snapshotOf({ notesExplorer: [noteItem(note)] }, { 'fractal.hasNotesRegistry': true }, 3);
        h.push(s3);
        expect(h.resolveItem(handle)).toBeUndefined();
        expect(h.resolveAction(token)).toBeUndefined();
        expect(h.current).toBe(s3);
        // sections (for "…" menus / expand state)
        expect(hasSection(s1, 'notesExplorer')).toBe(true);
        expect(hasSection(s1, 'explorer')).toBe(false);
        expect(hasSection(s1, 7)).toBe(false);
        // widths from the page are clamped to 180–480
        expect([clampSidebarWidth(100), clampSidebarWidth(300.4), clampSidebarWidth(9999), clampSidebarWidth(NaN), clampSidebarWidth('300')]).toEqual([180, 300, 480, undefined, undefined]);
    });

    test('AC-3 only the top frame of the window\'s own sidebar page may talk to the sidebar handlers', () => {
        const me = { webContentsId: 12, alive: true };
        const ok = { senderId: 12, frameUrl: SIDEBAR_PAGE_URL, isTopFrame: true };
        expect(acceptSidebarSender(ok, me)).toBe(true);
        expect(acceptSidebarSender({ ...ok, frameUrl: `${SIDEBAR_PAGE_URL}#x` }, me)).toBe(true);
        const refused: Array<[string, Parameters<typeof acceptSidebarSender>[0], Parameters<typeof acceptSidebarSender>[1]]> = [
            ['another webContents (a note page, another window)', { ...ok, senderId: 13 }, me],
            ['a subframe', { ...ok, isTopFrame: false }, me],
            ['the prompt page', { ...ok, frameUrl: 'fractal-ui://prompt/index.html' }, me],
            ['another path', { ...ok, frameUrl: 'fractal-ui://sidebar/other.html' }, me],
            ['a note page URL', { ...ok, frameUrl: 'fractal-res://panel-1/index.html' }, me],
            ['the initial empty document', { ...ok, frameUrl: 'about:blank' }, me],
            ['no frame URL', { ...ok, frameUrl: undefined }, me],
            ['a web page', { ...ok, frameUrl: 'https://sidebar/index.html' }, me],
            ['a closing window', ok, { ...me, alive: false }],
            ['no sidebar for the sender', ok, undefined],
        ];
        for (const [what, facts, identity] of refused) {
            expect(acceptSidebarSender(facts, identity), what).toBe(false);
        }
    });

    test('AC-3 per window: open notes get the ●, the shown one is marked, collapsed / width / sections and the empty view', async () => {
        const s = await snapshotOf({ notesExplorer: [noteItem('/n/a'), noteItem('/n/b'), noteItem('/n/c')] }, { 'fractal.hasNotesRegistry': true });
        const m = decorateSidebar(s, {
            collapsed: true,
            width: 333,
            sections: { notesExplorer: false },
            openNotes: new Set(['/n/a', '/n/b/']),
            shownNote: '/n/b',
            theme: 'dark',
            platform: 'darwin',
        });
        const rows = m.sections[0].items;
        expect(rows.map((r) => [r.label, !!r.open, !!r.shown])).toEqual([
            ['a', true, false],
            ['b', true, true],
            ['c', false, false],
        ]);
        expect(m).toMatchObject({ collapsed: true, width: 333, showEmpty: false, theme: 'dark', platform: 'darwin' });
        expect(m.sections[0].expanded).toBe(false);
        const none = decorateSidebar(s, { collapsed: false, width: 5000, sections: {}, openNotes: new Set(), theme: 'auto', platform: 'darwin' });
        expect(none).toMatchObject({ showEmpty: true, width: 480 });
        expect(none.sections[0].expanded).toBe(true);
        expect(none.sections[0].items.every((r) => !r.open && !r.shown)).toBe(true);
    });

    test('AC-3 the sidebar state in desktop-state.json is sanitized (width clamped, booleans only, absolute note paths by window)', () => {
        const dir = mkTmp();
        try {
            const file = path.join(dir, 'desktop-state.json');
            fs.writeFileSync(
                file,
                JSON.stringify({
                    sidebar: { collapsed: 'yes', width: 99999, sections: { notesExplorer: false, notesLists: 'no', ['x'.repeat(200)]: true } },
                    openWindows: [['/a', 'relative', 3], [], ['/b']],
                })
            );
            const st = new AppStateStore(file).get();
            expect(st.sidebar).toEqual({ collapsed: false, width: 480, sections: { notesExplorer: false } });
            expect(st.openWindows).toEqual([['/a'], ['/b']]);
            fs.writeFileSync(file, JSON.stringify({ sidebar: { collapsed: true, width: 222 } }));
            expect(new AppStateStore(file).get().sidebar).toEqual({ collapsed: true, width: 222, sections: {} });
            fs.writeFileSync(file, '{ broken');
            expect(new AppStateStore(file).get().sidebar).toBeUndefined();
        } finally {
            rmrf(dir);
        }
    });

    test('the notes reopened at start: openNoteFolders says which (older builds write only that), openWindows only groups them by window', () => {
        expect(notesToReopen({ version: 1 })).toEqual([]);
        expect(notesToReopen({ version: 1, lastNoteFolder: '/n/a' })).toEqual([['/n/a']]);
        expect(notesToReopen({ version: 1, openNoteFolders: ['/n/a', '/n/b'], lastNoteFolder: '/n/b' })).toEqual([['/n/a', '/n/b']]);
        expect(notesToReopen({ version: 1, openNoteFolders: ['/n/a', '/n/b', '/n/c'], openWindows: [['/n/c'], ['/n/a', '/n/b']] })).toEqual([['/n/c'], ['/n/a', '/n/b']]);
        // a group entry openNoteFolders does not list is ignored; a listed note no group names goes to the first window
        expect(notesToReopen({ version: 1, openNoteFolders: ['/app/media'], openWindows: [['/n/a']] })).toEqual([['/app/media']]);
        expect(notesToReopen({ version: 1, openNoteFolders: ['/n/a', '/n/x'], openWindows: [['/n/a'], ['/n/a']] })).toEqual([['/n/a', '/n/x']]);
    });
});

test.describe('electron vscode shim — createTreeView / setContext for the sidebar', () => {
    test('createTreeView registers { id, treeDataProvider, dragAndDropController } and returns a TreeView (title, description, message, visible, selection, reveal, events, dispose)', async () => {
        const ud = mkTmp();
        const host = createHeadlessHost();
        const shim = createVscodeShim({ extensionRoot: REPO_ROOT, userDataDir: ud, host });
        try {
            const vscode = shim.api as any;
            const changedViews: string[] = [];
            const registry: number[] = [];
            shim.controller.onDidChangeTreeView((id) => changedViews.push(id));
            shim.controller.onDidChangeTreeViews(() => registry.push(shim.controller.treeViews().size));
            const dataProvider = { getChildren: () => ['a', 'b'], getTreeItem: (e: string) => new vscode.TreeItem(e) };
            const dnd = { dragMimeTypes: ['x/y'], dropMimeTypes: ['x/y'] };
            const view = vscode.window.createTreeView('notesExplorer', { treeDataProvider: dataProvider, dragAndDropController: dnd, showCollapseAll: true });
            const rec = shim.controller.treeViews().get('notesExplorer')!;
            expect(rec.provider).toBe(dataProvider);
            expect(rec.dragAndDropController).toBe(dnd);
            expect(rec.options.showCollapseAll).toBe(true);
            expect(rec.view).toBe(view);
            expect(registry).toEqual([1]);
            // title defaults to the contributed name (VS Code); description / message notify the shell
            expect(view.title).toBe('Notes');
            view.description = 'default.fractal';
            view.description = 'default.fractal'; // unchanged: no event
            view.message = 'Loading…';
            view.title = 'My notes';
            expect([view.description, view.message, view.title]).toEqual(['default.fractal', 'Loading…', 'My notes']);
            expect(changedViews).toEqual(['notesExplorer', 'notesExplorer', 'notesExplorer']);
            // visible / selection are read-only for the extension and set by the shell
            const vis: boolean[] = [];
            const sel: unknown[][] = [];
            view.onDidChangeVisibility((e: { visible: boolean }) => vis.push(e.visible));
            view.onDidChangeSelection((e: { selection: unknown[] }) => sel.push([...e.selection]));
            expect(view.visible).toBe(false);
            view._setVisible(true);
            view._setVisible(true);
            expect(view.visible).toBe(true);
            expect(vis).toEqual([true]);
            await view.reveal('b');
            await view.reveal('a', { select: false });
            expect(view.selection).toEqual(['b']);
            view._setSelection(['a']);
            expect(sel).toEqual([['b'], ['a']]);
            expect(() => {
                view.selection = [];
            }).toThrow();
            // registerTreeDataProvider registers too; its Disposable unregisters
            const d = vscode.window.registerTreeDataProvider('notesLists', dataProvider);
            expect(shim.controller.treeViews().get('notesLists')?.provider).toBe(dataProvider);
            expect(shim.controller.treeViews().get('notesLists')?.view.title).toBe('Fractal List');
            d.dispose();
            expect(shim.controller.treeViews().has('notesLists')).toBe(false);
            view.dispose();
            view.dispose();
            expect(shim.controller.treeViews().size).toBe(0);
            view.description = 'after dispose';
            expect(changedViews.length).toBe(3);
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
    });

    test('setContext stores the key and tells the shell when a value changes', async () => {
        const ud = mkTmp();
        const shim = createVscodeShim({ extensionRoot: REPO_ROOT, userDataDir: ud, host: createHeadlessHost() });
        try {
            const vscode = shim.api as any;
            const changed: string[] = [];
            shim.controller.onDidChangeContextKeys((k) => changed.push(k));
            await vscode.commands.executeCommand('setContext', 'fractal.hasNotesRegistry', true);
            await vscode.commands.executeCommand('setContext', 'fractal.hasNotesRegistry', true);
            await vscode.commands.executeCommand('setContext', 'fractal.hasNotesRegistry', false);
            await vscode.commands.executeCommand('setContext', 'list', ['a']);
            await vscode.commands.executeCommand('setContext', 'list', ['a']);
            await vscode.commands.executeCommand('setContext', 42, true); // not a key
            expect(changed).toEqual(['fractal.hasNotesRegistry', 'fractal.hasNotesRegistry', 'list', 'list']);
            expect(shim.controller.contextKeys().get('fractal.hasNotesRegistry')).toBe(false);
        } finally {
            shim.controller.dispose();
            rmrf(ud);
        }
    });
});

test.describe('electron sidebar — AC-3 the extension\'s own tree views through the sidebar model', () => {
    test('the real bundle on the shim: its notesLists / notesExplorer providers, setContext and commands drive the sidebar (child process, temp HOME)', async () => {
        test.setTimeout(120000);
        const bundle = path.join(REPO_ROOT, 'out', 'extension.js');
        expect(fs.existsSync(bundle), 'out/extension.js is missing — run `npm run compile` at the repo root').toBe(true);
        const tmp = mkTmp('fx-sidebar-boot-');
        try {
            const home = path.join(tmp, 'home');
            const note = path.join(tmp, 'notes', 'n1');
            fs.mkdirSync(home, { recursive: true });
            fs.mkdirSync(note, { recursive: true });
            const entry = path.join(tmp, 'entry.ts');
            const shimDir = path.join(REPO_ROOT, 'electron', 'src', 'vscode-shim');
            const mainDir = path.join(REPO_ROOT, 'electron', 'src', 'main');
            fs.writeFileSync(
                entry,
                `export { bootExtension } from ${JSON.stringify(path.join(shimDir, 'boot'))};\n` +
                    `export { createHeadlessHost } from ${JSON.stringify(path.join(shimDir, 'adapters'))};\n` +
                    `export { readSidebarContributes } from ${JSON.stringify(path.join(mainDir, 'sidebar-contributes'))};\n` +
                    `export { buildSidebarSnapshot, resolveItem, resolveAction } from ${JSON.stringify(path.join(mainDir, 'sidebar-model'))};\n`
            );
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const esbuild = require('esbuild');
            esbuild.buildSync({
                entryPoints: [entry],
                outfile: path.join(tmp, 'bundle.js'),
                bundle: true,
                platform: 'node',
                format: 'cjs',
                target: 'node20',
                external: ['electron'],
                mainFields: ['module', 'main'],
                logLevel: 'silent',
            });
            const driver = path.join(tmp, 'driver.js');
            fs.writeFileSync(driver, DRIVER);
            const out = execFileSync(process.execPath, [driver, path.join(tmp, 'bundle.js'), REPO_ROOT, path.join(tmp, 'userData'), note], {
                env: { ...process.env, HOME: home },
                encoding: 'utf8',
                timeout: 90000,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            const line = out.split('\n').find((l) => l.startsWith('RESULT '));
            expect(line, `driver output:\n${out}`).toBeTruthy();
            const r = JSON.parse(line!.slice('RESULT '.length));
            expect(r.fatal).toBeUndefined();
            expect(r.errors).toEqual([]);
            // the first run: the extension's own default.fractal, active (● / check), setContext(fractal.hasNotesRegistry, true)
            expect(r.first.sections).toEqual(['notesLists', 'notesExplorer']);
            expect(r.first.lists).toEqual([{ label: 'default.fractal', description: '●', icon: 'check', inline: ['Reveal in Finder / Explorer', 'Remove from Fractal List (keeps the file)'] }]);
            expect(r.first.notesDescription).toBe('default.fractal');
            expect(r.first.notesWelcome).toEqual(['This .fractal has no notes yet. A note is a folder.', '[New Note]', '[Add Existing Note Folder]']);
            expect(r.first.notesActions).toEqual(['New Note…', 'Add Existing Note Folder…']);
            // the header button "Add Existing Note Folder…" ran the extension's command (folder picker answered): the note is a row
            expect(r.second.notes).toEqual([{ label: 'n1', tooltip: note, icon: 'notebook', note: true }]);
            expect(r.second.click).toEqual({ command: 'fractal.openNotesFolder', args: [note] });
            // running the row's TreeItem.command opened that note (a Notes panel for the folder)
            expect(r.second.panelFolder).toBe(note);
            // its inline × (Remove from Notes) took it off the .fractal; the list is empty again (welcome)
            expect(r.third.notes).toEqual([]);
            expect(r.third.registryNotes).toEqual([]);
            expect(r.third.welcomeButtons).toEqual(['New Note', 'Add Existing Note Folder']);
        } finally {
            rmrf(tmp);
        }
    });
});

/** Runs in a child process (HOME = temp): the real bundle on the shim, the sidebar model over its tree views. */
const DRIVER = String.raw`
const fs = require('fs'); const os = require('os'); const path = require('path');
const [bundlePath, repoRoot, userDataDir, note] = process.argv.slice(2);
const b = require(bundlePath);
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(50); } return fn(); }
(async () => {
  const host = b.createHeadlessHost({
    log: { info() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
    ui: { showMessage: async () => undefined, showOpenDialog: async () => [note], showSaveDialog: async () => undefined, showInputBox: async () => undefined, showQuickPick: async () => undefined },
  });
  const ext = await b.bootExtension({ extensionRoot: repoRoot, userDataDir, host });
  const contributes = b.readSidebarContributes(JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')));
  let rev = 0;
  const snap = async () => {
    const trees = new Map();
    for (const [id, rec] of ext.controller.treeViews()) trees.set(id, { provider: rec.provider, view: rec.view });
    return b.buildSidebarSnapshot({ rev: ++rev, contributes, trees, contextKeys: ext.controller.contextKeys() });
  };
  const sec = (s, id) => s.sections.find((x) => x.viewId === id);
  const welcomeText = (sct) => sct.welcome.map((l) => l.kind === 'button' ? '[' + l.title + ']' : l.parts.map((p) => p.text !== undefined ? p.text : p.title).join(''));
  // the extension creates ~/.fractal/default.fractal and activates it on its first run (asynchronously)
  const s1 = await waitFor(async () => { const s = await snap(); return sec(s, 'notesLists').items.length > 0 && ext.controller.contextKeys().get('fractal.hasNotesRegistry') === true ? s : null; }, 10000);
  const lists = sec(s1, 'notesLists'); const notes1 = sec(s1, 'notesExplorer');
  const first = {
    sections: s1.sections.map((x) => x.viewId),
    lists: lists.items.map((i) => ({ label: i.label, description: i.description, icon: i.icon, inline: i.inline.map((a) => a.title) })),
    notesDescription: notes1.description,
    notesWelcome: welcomeText(notes1),
    notesActions: notes1.actions.map((a) => a.title),
  };
  // the Notes header button "Add Existing Note Folder…" → its declared command, run as the shell does
  const add = notes1.actions.find((a) => a.title === 'Add Existing Note Folder…');
  const addCmd = b.resolveAction(s1, add.token).command;
  await ext.api.commands.executeCommand(addCmd.command, ...addCmd.args);
  const s2 = await waitFor(async () => { const s = await snap(); return sec(s, 'notesExplorer').items.length > 0 ? s : null; }, 10000);
  const notes2 = sec(s2, 'notesExplorer');
  const row = notes2.items[0];
  const click = b.resolveItem(s2, row.handle).command;
  const panel = await (async () => { const p = ext.controller.openNotesFolder(click.args[0], 20000); return p; })();
  const second = { notes: notes2.items.map((i) => ({ label: i.label, tooltip: i.tooltip, icon: i.icon, note: i.note })), click, panelFolder: panel ? panel.notesFolder() : null };
  // the row's inline "Remove from Notes" → fractal.removeNotesFolder(element)
  const remove = row.inline.find((a) => a.title.startsWith('Remove from Notes'));
  const removeCmd = b.resolveAction(s2, remove.token).command;
  await ext.api.commands.executeCommand(removeCmd.command, ...removeCmd.args);
  const s3 = await waitFor(async () => { const s = await snap(); return sec(s, 'notesExplorer').items.length === 0 ? s : null; }, 10000);
  const registry = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.fractal', 'default.fractal'), 'utf8'));
  const third = { notes: sec(s3, 'notesExplorer').items, registryNotes: registry.notes, welcomeButtons: sec(s3, 'notesExplorer').welcome.filter((l) => l.kind === 'button').map((l) => l.title) };
  for (const p of ext.controller.panels()) p.dispose();
  await ext.deactivate();
  process.stdout.write('RESULT ' + JSON.stringify({ errors, first, second, third }) + '\n');
  process.exit(0);
})().catch((e) => { process.stdout.write('RESULT ' + JSON.stringify({ fatal: String(e && e.stack || e), errors }) + '\n'); process.exit(0); });
`;
