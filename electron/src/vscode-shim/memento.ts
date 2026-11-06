/**
 * ExtensionContext.globalState / workspaceState (vscode.Memento) backed by a JSON file.
 * Semantics follow VS Code's ExtensionMemento:
 * - get(key, default) returns the stored value, or `default` when the key is unset.
 * - update(key, value) stores a JSON copy of object values (VS Code JSON round-trips them), `undefined`
 *   removes the key; the returned promise resolves after the value is on disk.
 * - keys() lists the keys that have a value. setKeysForSync() is a no-op (no settings sync).
 * The file is read synchronously once at startup and replaced atomically on every write.
 * A corrupt file is kept as `<file>.corrupt-<ms>` and the store starts empty.
 */
import * as fs from 'fs';
import { readJsonFileSync, writeFileAtomic, writeFileAtomicSync, WriteQueue } from './json-store';
import type { ShimLogger } from './adapters';

export class FileMemento {
    private values: Record<string, unknown> = Object.create(null);
    private readonly queue = new WriteQueue();
    private scheduled: Promise<void> | undefined;
    private dirty = false;

    constructor(private readonly filePath: string | undefined, private readonly log: ShimLogger) {
        if (!filePath) {
            return;
        }
        const r = readJsonFileSync(filePath);
        if (r.kind === 'ok' && r.value && typeof r.value === 'object' && !Array.isArray(r.value)) {
            for (const [k, v] of Object.entries(r.value as Record<string, unknown>)) {
                this.values[k] = v;
            }
        } else if (r.kind !== 'missing') {
            const backup = `${filePath}.corrupt-${Date.now()}`;
            try {
                fs.renameSync(filePath, backup);
            } catch {
                /* keep going with an empty store */
            }
            this.log.warn(`[vscode-shim] ${filePath} could not be read (${r.kind === 'invalid' ? r.error : 'not an object'}); kept as ${backup}, starting empty`);
        }
    }

    keys(): readonly string[] {
        return Object.keys(this.values).filter((k) => this.values[k] !== undefined);
    }

    get<T>(key: string, defaultValue?: T): T | undefined {
        const value = this.values[key];
        return (value === undefined ? defaultValue : value) as T | undefined;
    }

    update(key: string, value: unknown): Promise<void> {
        if (value === undefined) {
            delete this.values[key];
        } else if (value !== null && typeof value === 'object') {
            this.values[key] = JSON.parse(JSON.stringify(value));
        } else {
            this.values[key] = value;
        }
        this.dirty = true;
        return this.persist();
    }

    setKeysForSync(_keys: readonly string[]): void {
        /* no settings sync in the desktop app */
    }

    /** Resolves when every pending write is on disk. */
    flush(): Promise<void> {
        return this.queue.flush();
    }

    /** Synchronous last-chance write (process exit paths). */
    flushSync(): void {
        if (!this.filePath || !this.dirty) {
            return;
        }
        writeFileAtomicSync(this.filePath, this.serialize());
        this.dirty = false;
    }

    private serialize(): string {
        return JSON.stringify(this.values, null, 2) + '\n';
    }

    private persist(): Promise<void> {
        if (!this.filePath) {
            return Promise.resolve();
        }
        if (this.scheduled) {
            return this.scheduled;
        }
        const filePath = this.filePath;
        const job = this.queue.enqueue(async () => {
            this.scheduled = undefined;
            this.dirty = false;
            try {
                await writeFileAtomic(filePath, this.serialize());
            } catch (err) {
                this.dirty = true;
                this.log.error(`[vscode-shim] failed to write ${filePath}:`, err);
                throw err;
            }
        });
        this.scheduled = job;
        return job;
    }
}

/** In-memory Memento (for callers that do not want a file). */
export function createMemoryMemento(log: ShimLogger): FileMemento {
    return new FileMemento(undefined, log);
}
