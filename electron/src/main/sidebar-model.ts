/**
 * The sidebar's model (spec 20261107-0431-electron-sidebar D2 / D4 / D6). No Electron import:
 * unit-tested headless (test/unit/electron-sidebar.spec.ts, AC-3).
 *
 * buildSidebarSnapshot() asks the extension's own tree providers (the createTreeView registrations of
 * the shim) for their items and applies package.json contributes to them. The snapshot has two halves:
 * - `sections`: what the page draws (plain JSON, strings only — the page renders them as text);
 * - `items` / `actions` / menus: what the page may ask for, by opaque handle / token. The page never
 *   sends a command id: a click runs the TreeItem.command of an item it was given, a button / menu /
 *   welcome link runs a command package.json declares for that view (when-clause true). Handles and
 *   tokens carry the snapshot revision, so one from an older snapshot resolves to nothing.
 * decorateSidebar() adds the per-window part (open / shown note, collapsed, width, empty view).
 * acceptSidebarSender() is the IPC rule: only the top frame of that window's sidebar page.
 */
import * as path from 'path';
import {
    evaluateWhen,
    groupMenuEntries,
    parseCommandLink,
    parseWelcomeContents,
    codiconId,
    type MenuContribution,
    type SidebarContributes,
    type WhenContext,
} from './sidebar-contributes';
import { SIDEBAR_CHROME_ICONS, SIDEBAR_ICONS, type IconDef } from './sidebar-icons';

export const SIDEBAR_MIN_WIDTH = 180;
export const SIDEBAR_MAX_WIDTH = 480;
export const SIDEBAR_DEFAULT_WIDTH = 260;
/** The collapsed sidebar: a vertical bar with the expand button only (D3). */
export const SIDEBAR_COLLAPSED_WIDTH = 28;
/** The sidebar page (served by the sidebar session only). */
export const SIDEBAR_PAGE_URL = 'fractal-ui://sidebar/index.html';
/** The command whose TreeItem rows are notes (● / shown / Open in New Window / Close). */
export const NOTE_OPEN_COMMAND = 'fractal.openNotesFolder';

const MAX_ITEMS_PER_VIEW = 2000;
const MAX_LABEL = 400;
const MAX_DESCRIPTION = 400;
const MAX_TOOLTIP = 4000;

// --- page-facing model (keep in sync with src/renderer/sidebar-page.ts) ----------------------

export interface PageAction {
    token: string;
    title: string;
    icon?: string;
}

export interface PageItem {
    handle: string;
    /** stable across snapshots (focus / scroll restore in the page) */
    key: string;
    label: string;
    description?: string;
    tooltip?: string;
    icon?: string;
    inline: PageAction[];
    /** a right-click menu exists */
    menu: boolean;
    /** the row opens a note (it has the ● slot) */
    note: boolean;
    /** decorated: the note is open (kept alive) */
    open?: boolean;
    /** decorated: the note is the one this window shows */
    shown?: boolean;
}

export type PageWelcomePart = { text: string } | { token: string; title: string };
export type PageWelcomeLine = { kind: 'paragraph'; parts: PageWelcomePart[] } | { kind: 'button'; token: string; title: string };

export interface PageSection {
    viewId: string;
    title: string;
    description?: string;
    message?: string;
    /** the provider failed (shown instead of the items) */
    error?: string;
    actions: PageAction[];
    /** the header has a "…" menu (view/title entries outside `navigation`) */
    more: boolean;
    items: PageItem[];
    welcome: PageWelcomeLine[];
    /** decorated */
    expanded?: boolean;
}

export interface SidebarPageModel {
    rev: number;
    containerTitle: string;
    sections: PageSection[];
    icons: Record<string, IconDef>;
    collapsed: boolean;
    width: number;
    /** no note is shown: the page draws the empty view right of the sidebar */
    showEmpty: boolean;
    /** the window is still opening notes (start, Open in New Window): the empty view stays blank */
    opening: boolean;
    theme: 'light' | 'dark' | 'auto';
    /** 'darwin' | 'win32' | … (shortcut labels) */
    platform: string;
}

// --- main-only records -----------------------------------------------------------------------

export interface TreeSource {
    provider: unknown;
    view?: { title?: string; description?: string; message?: string };
}

export interface ResolvedCommand {
    command: string;
    args: unknown[];
}

export interface ItemRecord {
    viewId: string;
    element: unknown;
    contextValue?: string;
    /** TreeItem.command */
    command?: ResolvedCommand;
    /** the note folder the row opens (TreeItem.command = fractal.openNotesFolder(folder)) */
    noteFolder?: string;
    /** right-click entries (view/item/context outside `inline`), grouped */
    menu: Array<Array<{ title: string; command: ResolvedCommand }>>;
}

export type ActionRecord =
    | { kind: 'command'; viewId: string; command: ResolvedCommand }
    | { kind: 'external'; viewId: string; url: string };

export interface SidebarSnapshot {
    rev: number;
    containerTitle: string;
    sections: PageSection[];
    icons: Record<string, IconDef>;
    items: ReadonlyMap<string, ItemRecord>;
    actions: ReadonlyMap<string, ActionRecord>;
    /** view id → the header's "…" menu, grouped */
    titleMenus: ReadonlyMap<string, Array<Array<{ title: string; command: ResolvedCommand }>>>;
}

export interface SnapshotInput {
    rev: number;
    contributes: SidebarContributes;
    /** createTreeView registrations by view id */
    trees: ReadonlyMap<string, TreeSource>;
    contextKeys: ReadonlyMap<string, unknown>;
    log?: { warn(...a: unknown[]): void };
}

function clip(s: string, max: number): string {
    return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function labelOf(item: Record<string, unknown>): string {
    const l = item.label;
    if (typeof l === 'string') {
        return l;
    }
    if (l && typeof l === 'object' && typeof (l as { label?: unknown }).label === 'string') {
        return (l as { label: string }).label;
    }
    const uri = item.resourceUri as { fsPath?: unknown; path?: unknown } | undefined;
    const p = uri && (typeof uri.fsPath === 'string' ? uri.fsPath : typeof uri.path === 'string' ? uri.path : undefined);
    return p ? path.basename(p) : '';
}

function tooltipOf(t: unknown): string | undefined {
    if (typeof t === 'string') {
        return t;
    }
    if (t && typeof t === 'object' && typeof (t as { value?: unknown }).value === 'string') {
        return (t as { value: string }).value;
    }
    return undefined;
}

function iconOf(icon: unknown): string | undefined {
    if (icon && typeof icon === 'object' && typeof (icon as { id?: unknown }).id === 'string') {
        return codiconId(`$(${(icon as { id: string }).id})`);
    }
    return undefined;
}

function commandOf(c: unknown): ResolvedCommand | undefined {
    if (!c || typeof c !== 'object') {
        return undefined;
    }
    const { command, arguments: args } = c as { command?: unknown; arguments?: unknown };
    if (typeof command !== 'string' || !command) {
        return undefined;
    }
    return { command, args: Array.isArray(args) ? args.slice() : [] };
}

function contextOf(keys: ReadonlyMap<string, unknown>, extra: Record<string, unknown>): WhenContext {
    const ctx: Record<string, unknown> = {};
    for (const [k, v] of keys) {
        ctx[k] = v;
    }
    return Object.assign(ctx, extra);
}

/** Builds the snapshot of every contributed view that has a registered tree. Never throws. */
export async function buildSidebarSnapshot(input: SnapshotInput): Promise<SidebarSnapshot> {
    const { rev, contributes, trees, contextKeys } = input;
    const items = new Map<string, ItemRecord>();
    const actions = new Map<string, ActionRecord>();
    const titleMenus = new Map<string, Array<Array<{ title: string; command: ResolvedCommand }>>>();
    const usedIcons = new Set<string>(SIDEBAR_CHROME_ICONS);
    let tokenSeq = 0;
    const token = (rec: ActionRecord): string => {
        const t = `a${rev}.${++tokenSeq}`;
        actions.set(t, rec);
        return t;
    };
    const titleOfCommand = (id: string) => contributes.commands.get(id)?.title ?? id;
    const declared = (e: MenuContribution) => contributes.commands.has(e.command);

    const sections: PageSection[] = [];
    let sectionIndex = -1;
    for (const view of contributes.views) {
        const tree = trees.get(view.id);
        if (!tree) {
            continue;
        }
        sectionIndex++;
        const viewId = view.id;
        const ctx = contextOf(contextKeys, { view: viewId });
        // header buttons and "…" menu (view/title)
        const titleEntries = contributes.viewTitle.filter((e) => declared(e) && evaluateWhen(e.when, ctx));
        const pageActions: PageAction[] = [];
        const more: Array<Array<{ title: string; command: ResolvedCommand }>> = [];
        for (const group of groupMenuEntries(titleEntries, (e) => titleOfCommand(e.command))) {
            if (group[0].group === 'navigation') {
                for (const e of group) {
                    const icon = contributes.commands.get(e.command)?.icon;
                    if (icon) {
                        usedIcons.add(icon);
                    }
                    pageActions.push({ token: token({ kind: 'command', viewId, command: { command: e.command, args: [] } }), title: titleOfCommand(e.command), icon });
                }
            } else {
                more.push(group.map((e) => ({ title: titleOfCommand(e.command), command: { command: e.command, args: [] } })));
            }
        }
        if (more.length > 0) {
            titleMenus.set(viewId, more);
        }
        const section: PageSection = {
            viewId,
            title: tree.view?.title ?? view.name,
            description: typeof tree.view?.description === 'string' && tree.view.description ? tree.view.description : undefined,
            message: typeof tree.view?.message === 'string' && tree.view.message ? tree.view.message : undefined,
            actions: pageActions,
            more: more.length > 0,
            items: [],
            welcome: [],
        };
        sections.push(section);

        // items (getChildren of the root; the two Notes views are flat lists)
        const provider = tree.provider as { getChildren?: (e?: unknown) => unknown; getTreeItem?: (e: unknown) => unknown } | undefined;
        let children: unknown[] = [];
        try {
            const got = provider && typeof provider.getChildren === 'function' ? await Promise.resolve(provider.getChildren(undefined)) : [];
            children = Array.isArray(got) ? got.slice(0, MAX_ITEMS_PER_VIEW) : [];
        } catch (err) {
            input.log?.warn(`[sidebar] ${viewId}.getChildren failed:`, err);
            section.error = 'Could not read this list.';
            children = [];
        }
        const seenKeys = new Map<string, number>();
        for (let i = 0; i < children.length; i++) {
            const element = children[i];
            let treeItem: Record<string, unknown> | undefined;
            try {
                const ti = provider && typeof provider.getTreeItem === 'function' ? await Promise.resolve(provider.getTreeItem(element)) : element;
                treeItem = ti && typeof ti === 'object' ? (ti as Record<string, unknown>) : undefined;
            } catch (err) {
                input.log?.warn(`[sidebar] ${viewId}.getTreeItem failed:`, err);
                treeItem = undefined;
            }
            if (!treeItem) {
                continue;
            }
            const handle = `h${rev}.${sectionIndex}.${i}`;
            const label = clip(labelOf(treeItem), MAX_LABEL);
            const description = typeof treeItem.description === 'string' && treeItem.description ? clip(treeItem.description, MAX_DESCRIPTION) : undefined;
            const tooltipText = tooltipOf(treeItem.tooltip);
            const contextValue = typeof treeItem.contextValue === 'string' ? treeItem.contextValue : undefined;
            const command = commandOf(treeItem.command);
            const noteFolder = command && command.command === NOTE_OPEN_COMMAND && typeof command.args[0] === 'string' && command.args[0] ? (command.args[0] as string) : undefined;
            const itemCtx = contextOf(contextKeys, { view: viewId, viewItem: contextValue });
            const entries = contributes.viewItemContext.filter((e) => declared(e) && evaluateWhen(e.when, itemCtx));
            const inline: PageAction[] = [];
            const menu: ItemRecord['menu'] = [];
            for (const group of groupMenuEntries(entries, (e) => titleOfCommand(e.command))) {
                if (group[0].group === 'inline') {
                    for (const e of group) {
                        const icon = contributes.commands.get(e.command)?.icon;
                        if (icon) {
                            usedIcons.add(icon);
                        }
                        // VS Code passes the tree element to view/item/context commands
                        inline.push({ token: token({ kind: 'command', viewId, command: { command: e.command, args: [element] } }), title: titleOfCommand(e.command), icon });
                    }
                } else {
                    menu.push(group.map((e) => ({ title: titleOfCommand(e.command), command: { command: e.command, args: [element] } })));
                }
            }
            const icon = iconOf(treeItem.iconPath);
            if (icon) {
                usedIcons.add(icon);
            }
            const keyBase = `${viewId}\u0000${typeof treeItem.id === 'string' ? treeItem.id : `${label}\u0000${description ?? ''}`}`;
            const n = (seenKeys.get(keyBase) ?? 0) + 1;
            seenKeys.set(keyBase, n);
            items.set(handle, { viewId, element, contextValue, command, noteFolder, menu });
            section.items.push({
                handle,
                key: `${keyBase}\u0000${n}`,
                label,
                description,
                tooltip: tooltipText ? clip(tooltipText, MAX_TOOLTIP) : undefined,
                icon,
                inline,
                menu: menu.length > 0 || !!noteFolder,
                note: !!noteFolder,
            });
        }

        // the welcome content while the view is empty (viewsWelcome, when-clause true)
        if (section.items.length === 0 && !section.error) {
            for (const w of contributes.viewsWelcome) {
                if (w.view !== viewId || !evaluateWhen(w.when, ctx)) {
                    continue;
                }
                for (const line of parseWelcomeContents(w.contents)) {
                    const linkToken = (target: string): string | undefined => {
                        const c = parseCommandLink(target);
                        if (c) {
                            return token({ kind: 'command', viewId, command: c });
                        }
                        return /^https?:\/\//i.test(target) ? token({ kind: 'external', viewId, url: target }) : undefined;
                    };
                    if (line.kind === 'button') {
                        const t = linkToken(line.target);
                        section.welcome.push(t ? { kind: 'button', token: t, title: line.title } : { kind: 'paragraph', parts: [{ text: line.title }] });
                    } else {
                        section.welcome.push({
                            kind: 'paragraph',
                            parts: line.parts.map((p) => {
                                if (p.kind === 'text') {
                                    return { text: p.text };
                                }
                                const t = linkToken(p.target);
                                return t ? { token: t, title: p.title } : { text: p.title };
                            }),
                        });
                    }
                }
            }
        }
    }
    const icons: Record<string, IconDef> = {};
    for (const id of usedIcons) {
        const def = SIDEBAR_ICONS[id];
        if (def) {
            icons[id] = def;
        }
    }
    return { rev, containerTitle: contributes.containerTitle, sections, icons, items, actions, titleMenus };
}

// --- per window ------------------------------------------------------------------------------

export interface SidebarWindowState {
    collapsed: boolean;
    width: number;
    /** view id → expanded (missing = expanded) */
    sections: Readonly<Record<string, boolean>>;
    /** note folders that are open (kept alive) */
    openNotes: ReadonlySet<string>;
    /** the note folder this window shows */
    shownNote?: string;
    /** notes are being opened into this window */
    opening?: boolean;
    theme: 'light' | 'dark' | 'auto';
    platform: string;
}

function samePath(a: string, b: string): boolean {
    return path.resolve(a) === path.resolve(b);
}

export function decorateSidebar(snapshot: SidebarSnapshot, w: SidebarWindowState): SidebarPageModel {
    const open = new Set([...w.openNotes].map((p) => path.resolve(p)));
    return {
        rev: snapshot.rev,
        containerTitle: snapshot.containerTitle,
        icons: snapshot.icons,
        collapsed: w.collapsed,
        width: clampSidebarWidth(w.width) ?? SIDEBAR_DEFAULT_WIDTH,
        showEmpty: !w.shownNote,
        opening: !!w.opening,
        theme: w.theme,
        platform: w.platform,
        sections: snapshot.sections.map((s) => ({
            ...s,
            expanded: w.sections[s.viewId] !== false,
            items: s.items.map((it) => {
                const folder = snapshot.items.get(it.handle)?.noteFolder;
                if (!folder) {
                    return it;
                }
                return { ...it, open: open.has(path.resolve(folder)), shown: !!w.shownNote && samePath(w.shownNote, folder) };
            }),
        })),
    };
}

// --- what the page may ask for (D4: nothing else runs) ---------------------------------------

/** The item behind a handle of THIS snapshot (a stale or made-up handle → undefined). */
export function resolveItem(snapshot: SidebarSnapshot | undefined, handle: unknown): ItemRecord | undefined {
    if (!snapshot || typeof handle !== 'string' || !handle.startsWith(`h${snapshot.rev}.`)) {
        return undefined;
    }
    return snapshot.items.get(handle);
}

/** The command of a header button / row button / welcome link of THIS snapshot. */
export function resolveAction(snapshot: SidebarSnapshot | undefined, token: unknown): ActionRecord | undefined {
    if (!snapshot || typeof token !== 'string' || !token.startsWith(`a${snapshot.rev}.`)) {
        return undefined;
    }
    return snapshot.actions.get(token);
}

/**
 * The current snapshot and the one before it. A click can race a refresh (the page still shows the
 * previous snapshot for a moment): its handle / token resolves against the snapshot the user saw.
 * Anything older, or not from these two, resolves to nothing.
 */
export class SnapshotHistory {
    private cur: SidebarSnapshot | undefined;
    private prev: SidebarSnapshot | undefined;

    get current(): SidebarSnapshot | undefined {
        return this.cur;
    }

    push(s: SidebarSnapshot): void {
        this.prev = this.cur;
        this.cur = s;
    }

    resolveItem(handle: unknown): ItemRecord | undefined {
        return resolveItem(this.cur, handle) ?? resolveItem(this.prev, handle);
    }

    resolveAction(token: unknown): ActionRecord | undefined {
        return resolveAction(this.cur, token) ?? resolveAction(this.prev, token);
    }
}

/** The view ids the snapshot shows (a "…" menu / section toggle for anything else is refused). */
export function hasSection(snapshot: SidebarSnapshot | undefined, viewId: unknown): viewId is string {
    return !!snapshot && typeof viewId === 'string' && snapshot.sections.some((s) => s.viewId === viewId);
}

export function clampSidebarWidth(v: unknown): number | undefined {
    if (typeof v !== 'number' || !Number.isFinite(v)) {
        return undefined;
    }
    return Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, v)));
}

// --- IPC sender (D4, L-20261106-electron-shell-guards) ---------------------------------------

export interface IpcSenderFacts {
    /** e.sender.id */
    senderId: number;
    /** e.senderFrame.url ('' / undefined when the frame is gone) */
    frameUrl: string | undefined;
    /** e.senderFrame.parent === null */
    isTopFrame: boolean;
}

export interface SidebarIdentity {
    /** the sidebar view's webContents id */
    webContentsId: number;
    /** false once the window is closing / gone */
    alive: boolean;
}

/** Only the top frame of this window's own sidebar page may talk to the sidebar handlers. */
export function acceptSidebarSender(facts: IpcSenderFacts, sidebar: SidebarIdentity | undefined): boolean {
    if (!sidebar || !sidebar.alive || facts.senderId !== sidebar.webContentsId || !facts.isTopFrame) {
        return false;
    }
    try {
        const u = new URL(facts.frameUrl ?? '');
        const want = new URL(SIDEBAR_PAGE_URL);
        return u.protocol === want.protocol && u.host === want.host && u.pathname === want.pathname;
    } catch {
        return false;
    }
}
