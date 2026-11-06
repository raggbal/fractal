/**
 * The desktop shell's own small state (not the extension's globalState): which notes were open (and in
 * which window), the last used one, the window bounds and the sidebar (collapsed / width / which
 * sections are expanded — spec 20261107-0431 D3). <userData>/desktop-state.json, written atomically
 * (tmp + rename), debounced; flushSync() on quit. A broken file or value is ignored (defaults).
 */
import * as fs from 'fs';
import * as path from 'path';
import { clampSidebarWidth, SIDEBAR_DEFAULT_WIDTH } from './sidebar-model';

export interface WindowBounds {
    x?: number;
    y?: number;
    width: number;
    height: number;
}

export interface SidebarState {
    collapsed: boolean;
    width: number;
    /** view id → expanded (missing = expanded) */
    sections: Record<string, boolean>;
}

export interface DesktopState {
    version: 1;
    /** The note folder of the most recently shown note. */
    lastNoteFolder?: string;
    /** Note folders open at the last quit (most recently used last). */
    openNoteFolders?: string[];
    /** The same notes by window (each least recently shown first; the last one is the window's shown note). */
    openWindows?: string[][];
    windowBounds?: WindowBounds;
    sidebar?: SidebarState;
}

const MAX_OPEN_NOTES = 8;
const MAX_WINDOWS = 4;

function absolutePaths(v: unknown, max: number): string[] {
    return Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(-max) : [];
}

function sanitizeSidebar(v: unknown): SidebarState | undefined {
    if (!v || typeof v !== 'object') {
        return undefined;
    }
    const o = v as Record<string, unknown>;
    const width = clampSidebarWidth(o.width);
    const sections: Record<string, boolean> = {};
    if (o.sections && typeof o.sections === 'object') {
        for (const [k, val] of Object.entries(o.sections as Record<string, unknown>).slice(0, 20)) {
            if (typeof val === 'boolean' && k.length > 0 && k.length <= 100) {
                sections[k] = val;
            }
        }
    }
    return { collapsed: o.collapsed === true, width: width ?? SIDEBAR_DEFAULT_WIDTH, sections };
}

function sanitize(raw: unknown): DesktopState {
    const s: DesktopState = { version: 1 };
    if (!raw || typeof raw !== 'object') {
        return s;
    }
    const o = raw as Record<string, unknown>;
    if (typeof o.lastNoteFolder === 'string' && path.isAbsolute(o.lastNoteFolder)) {
        s.lastNoteFolder = o.lastNoteFolder;
    }
    if (Array.isArray(o.openNoteFolders)) {
        s.openNoteFolders = absolutePaths(o.openNoteFolders, MAX_OPEN_NOTES);
    }
    if (Array.isArray(o.openWindows)) {
        const wins = o.openWindows.map((w) => absolutePaths(w, MAX_OPEN_NOTES)).filter((w) => w.length > 0);
        if (wins.length > 0) {
            s.openWindows = wins.slice(-MAX_WINDOWS);
        }
    }
    const sidebar = sanitizeSidebar(o.sidebar);
    if (sidebar) {
        s.sidebar = sidebar;
    }
    const b = o.windowBounds as Record<string, unknown> | undefined;
    if (b && typeof b.width === 'number' && typeof b.height === 'number' && b.width >= 300 && b.height >= 200) {
        s.windowBounds = {
            width: Math.round(b.width),
            height: Math.round(b.height),
            ...(typeof b.x === 'number' && typeof b.y === 'number' ? { x: Math.round(b.x), y: Math.round(b.y) } : {}),
        };
    }
    return s;
}

/**
 * The notes to reopen at start, by window. `openNoteFolders` (else `lastNoteFolder`) says WHICH notes —
 * it is what every build writes; `openWindows` only groups them by window (older builds drop it, and an
 * entry it has that openNoteFolders does not is ignored). Notes no group names go to the first window.
 */
export function notesToReopen(st: Readonly<DesktopState>): string[][] {
    const flat = (st.openNoteFolders && st.openNoteFolders.length > 0 ? st.openNoteFolders : st.lastNoteFolder ? [st.lastNoteFolder] : []).map((p) =>
        path.resolve(p)
    );
    const wanted = new Set(flat);
    const placed = new Set<string>();
    const groups: string[][] = [];
    for (const g of st.openWindows ?? []) {
        const group = g.map((p) => path.resolve(p)).filter((p) => wanted.has(p) && !placed.has(p) && (placed.add(p), true));
        if (group.length > 0) {
            groups.push(group);
        }
    }
    const rest = flat.filter((p) => !placed.has(p) && (placed.add(p), true));
    if (rest.length > 0) {
        if (groups.length > 0) {
            groups[0].push(...rest);
        } else {
            groups.push(rest);
        }
    }
    return groups;
}

export class AppStateStore {
    private state: DesktopState;
    private timer: NodeJS.Timeout | null = null;

    constructor(private readonly file: string, private readonly onError: (err: unknown) => void = () => undefined) {
        let raw: unknown;
        try {
            raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            raw = undefined;
        }
        this.state = sanitize(raw);
    }

    get(): Readonly<DesktopState> {
        return this.state;
    }

    update(patch: Partial<Omit<DesktopState, 'version'>>): void {
        this.state = { ...this.state, ...patch, version: 1 };
        if (this.timer) {
            clearTimeout(this.timer);
        }
        this.timer = setTimeout(() => {
            this.timer = null;
            this.flushSync();
        }, 400);
    }

    flushSync(): void {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = `${this.file}.${process.pid}.tmp`;
            fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, this.file);
        } catch (err) {
            this.onError(err);
        }
    }
}
