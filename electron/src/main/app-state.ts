/**
 * The desktop shell's own small state (not the extension's globalState): which notes were open, the
 * last used one, and the window bounds. <userData>/desktop-state.json, written atomically
 * (tmp + rename), debounced; flushSync() on quit. A broken file is ignored (defaults).
 */
import * as fs from 'fs';
import * as path from 'path';

export interface WindowBounds {
    x?: number;
    y?: number;
    width: number;
    height: number;
}

export interface DesktopState {
    version: 1;
    /** The note folder of the most recently focused Notes window. */
    lastNoteFolder?: string;
    /** Note folders open at the last quit (most recently used last). */
    openNoteFolders?: string[];
    windowBounds?: WindowBounds;
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
        s.openNoteFolders = o.openNoteFolders.filter((p): p is string => typeof p === 'string' && path.isAbsolute(p)).slice(-8);
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
