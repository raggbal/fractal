/**
 * workspace.getConfiguration / onDidChangeConfiguration.
 *
 * Values = the extension's contributed defaults (package.json contributes.configuration) overlaid
 * with the user's settings (userData/settings.json, JSONC like VS Code's settings.json, flat
 * "fractal.x" keys or nested objects). Semantics follow ExtHostConfiguration:
 * - get(key, d): the user value, else the contributed default (which wins over the caller's `d`),
 *   else `d`. Objects / arrays are returned as copies. The object is a snapshot taken at
 *   getConfiguration() time.
 * - update(key, value, target): Global (or undefined → Global, there is no workspace) writes
 *   settings.json in place with jsonc-parser (comments and formatting kept), atomically; `undefined`
 *   removes the key. Workspace targets reject like VS Code without a workspace. The change event
 *   fires before the returned promise resolves.
 * - External edits of settings.json are picked up by a watcher and fire the change event for the
 *   keys whose user value changed. A file with syntax errors keeps the last good values and refuses
 *   writes (VS Code: "Unable to write into user settings…").
 */
import * as fs from 'fs';
import { applyEdits, modify, parse, ParseError, printParseErrorCode } from 'jsonc-parser';
import { EventEmitter, Disposable } from './events';
import { WriteQueue, writeFileAtomic } from './json-store';
import { ConfigurationTarget } from './types';
import type { ShimLogger } from './adapters';

type Tree = Record<string, unknown>;

function isPlainObject(v: unknown): v is Tree {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function deepClone<T>(v: T): T {
    if (v === null || typeof v !== 'object') {
        return v;
    }
    return JSON.parse(JSON.stringify(v));
}

function deepEqual(a: unknown, b: unknown): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

/** VS Code's addToValueTree: dotted keys become nested objects; conflicts are ignored (logged). */
function addToValueTree(root: Tree, key: string, value: unknown, log: ShimLogger): void {
    const segments = key.split('.');
    const last = segments.pop() as string;
    let curr: Tree = root;
    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        let obj = curr[s];
        if (obj === undefined) {
            obj = curr[s] = Object.create(null);
        } else if (!isPlainObject(obj)) {
            log.warn(`[vscode-shim] settings: ignoring ${key} as ${segments.slice(0, i + 1).join('.')} is ${JSON.stringify(obj)}`);
            return;
        }
        curr = obj as Tree;
    }
    curr[last] = value;
}

function toValueTree(raw: Tree, log: ShimLogger): Tree {
    const root: Tree = Object.create(null);
    for (const key of Object.keys(raw)) {
        addToValueTree(root, key, deepClone(raw[key]), log);
    }
    return root;
}

/** deep merge: objects merge recursively, everything else replaces (VS Code ConfigurationModel.merge). */
function mergeInto(target: Tree, source: Tree): void {
    for (const key of Object.keys(source)) {
        if (isPlainObject(target[key]) && isPlainObject(source[key])) {
            mergeInto(target[key] as Tree, source[key] as Tree);
            continue;
        }
        target[key] = deepClone(source[key]);
    }
}

function lookUp(tree: unknown, key: string): unknown {
    if (!key) {
        return undefined;
    }
    let node: unknown = tree;
    for (const part of key.split('.')) {
        if (!node || typeof node !== 'object') {
            return undefined;
        }
        node = (node as Tree)[part];
    }
    return node;
}

/** Leaves of a value tree as dotted keys (arrays and primitives are leaves). */
function flattenLeaves(tree: Tree, prefix = '', out = new Map<string, unknown>()): Map<string, unknown> {
    for (const key of Object.keys(tree)) {
        const full = prefix ? `${prefix}.${key}` : key;
        const v = tree[key];
        if (isPlainObject(v) && Object.keys(v).length > 0) {
            flattenLeaves(v, full, out);
        } else {
            out.set(full, v);
        }
    }
    return out;
}

/** Contributed defaults: package.json contributes.configuration (object or array of objects). */
export function readContributedDefaults(packageJsonPath: string | undefined, log: ShimLogger): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (!packageJsonPath) {
        return out;
    }
    try {
        const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
        const conf = pkg?.contributes?.configuration;
        const blocks = Array.isArray(conf) ? conf : conf ? [conf] : [];
        for (const block of blocks) {
            const props = block?.properties;
            if (!isPlainObject(props)) {
                continue;
            }
            for (const [key, schema] of Object.entries(props)) {
                if (isPlainObject(schema) && 'default' in schema) {
                    out[key] = deepClone(schema.default);
                }
            }
        }
    } catch (err) {
        log.warn(`[vscode-shim] could not read contributed configuration from ${packageJsonPath}:`, err);
    }
    return out;
}

export interface ConfigurationChangeEvent {
    affectsConfiguration(section: string, scope?: unknown): boolean;
}

export function createConfigurationChangeEvent(changedKeys: readonly string[]): ConfigurationChangeEvent {
    const keys = Array.from(new Set(changedKeys));
    return {
        // VS Code: true when `section` is a changed key or one of its ancestors ("fractal" for "fractal.theme")
        affectsConfiguration(section: string): boolean {
            if (typeof section !== 'string' || !section) {
                return false;
            }
            return keys.some((k) => k === section || k.startsWith(section + '.'));
        },
    };
}

export interface WorkspaceConfiguration {
    get<T>(section: string, defaultValue?: T): T | undefined;
    has(section: string): boolean;
    inspect<T>(section: string): { key: string; defaultValue?: T; globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined;
    update(section: string, value: unknown, configurationTarget?: number | boolean | null, overrideInLanguage?: boolean): Promise<void>;
    readonly [key: string]: unknown;
}

export interface ConfigurationStoreOptions {
    packageJsonPath?: string;
    settingsPath?: string;
    log: ShimLogger;
}

const FORMATTING = { tabSize: 4, insertSpaces: true, eol: '\n' } as const;

export class ConfigurationStore {
    private readonly emitter = new EventEmitter<ConfigurationChangeEvent>();
    readonly onDidChangeConfiguration = this.emitter.event;

    private readonly defaultsTree: Tree;
    private userTree: Tree = Object.create(null);
    private userLeaves = new Map<string, unknown>();
    /** Parse error of the current settings.json (writes are refused while set). */
    private brokenReason: string | undefined;
    private readonly queue = new WriteQueue();
    private watcher: Disposable | undefined;
    private reloadTimer: NodeJS.Timeout | undefined;

    constructor(private readonly opts: ConfigurationStoreOptions) {
        this.defaultsTree = toValueTree(readContributedDefaults(opts.packageJsonPath, opts.log), opts.log);
        this.loadUserSync(false);
    }

    /** Starts watching settings.json for external edits (watch(path, onEvent) returns a Disposable). */
    watchExternalEdits(watch: (filePath: string, onEvent: () => void) => Disposable): void {
        if (!this.opts.settingsPath || this.watcher) {
            return;
        }
        this.watcher = watch(this.opts.settingsPath, () => {
            if (this.reloadTimer) {
                clearTimeout(this.reloadTimer);
            }
            this.reloadTimer = setTimeout(() => {
                this.reloadTimer = undefined;
                this.loadUserSync(true);
            }, 100);
        });
    }

    dispose(): void {
        if (this.reloadTimer) {
            clearTimeout(this.reloadTimer);
        }
        this.watcher?.dispose();
        this.watcher = undefined;
        this.emitter.dispose();
    }

    flush(): Promise<void> {
        return this.queue.flush();
    }

    /** The user settings file currently has errors (writes refused). */
    get settingsError(): string | undefined {
        return this.brokenReason;
    }

    getConfiguration(section?: string): WorkspaceConfiguration {
        const merged: Tree = Object.create(null);
        mergeInto(merged, this.defaultsTree);
        mergeInto(merged, this.userTree);
        const config = section ? lookUp(merged, section) : merged;
        const userConfig = section ? lookUp(this.userTree, section) : this.userTree;
        const defaultConfig = section ? lookUp(this.defaultsTree, section) : this.defaultsTree;
        const fullKey = (key: string) => (section ? `${section}.${key}` : key);

        const api = {
            get: <T>(key: string, defaultValue?: T): T | undefined => {
                const result = lookUp(config, key);
                return (result === undefined ? defaultValue : deepClone(result)) as T | undefined;
            },
            has: (key: string): boolean => lookUp(config, key) !== undefined,
            inspect: <T>(key: string) => ({
                key: fullKey(key),
                defaultValue: deepClone(lookUp(defaultConfig, key)) as T | undefined,
                globalValue: deepClone(lookUp(userConfig, key)) as T | undefined,
                workspaceValue: undefined as T | undefined,
                workspaceFolderValue: undefined as T | undefined,
            }),
            update: (key: string, value: unknown, configurationTarget?: number | boolean | null): Promise<void> =>
                this.update(fullKey(key), value, configurationTarget),
        };
        const values = isPlainObject(config) ? deepClone(config) : {};
        return Object.freeze(Object.assign(values, api)) as unknown as WorkspaceConfiguration;
    }

    update(key: string, value: unknown, target?: number | boolean | null): Promise<void> {
        const isGlobal = target === undefined || target === null || target === true || target === ConfigurationTarget.Global;
        if (!isGlobal) {
            return Promise.reject(new Error('Unable to write to Workspace Settings because no workspace is opened. Please open a workspace first and try again.'));
        }
        const settingsPath = this.opts.settingsPath;
        if (!settingsPath) {
            return Promise.reject(new Error('Unable to write into user settings: no settings file is configured.'));
        }
        return this.queue.enqueue(async () => {
            let text = '';
            try {
                text = await fs.promises.readFile(settingsPath, 'utf8');
            } catch (err) {
                if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                    throw err;
                }
            }
            if (text.charCodeAt(0) === 0xfeff) {
                text = text.slice(1);
            }
            const parsed = this.parseSettings(text);
            if (!parsed.ok) {
                this.brokenReason = parsed.error;
                throw new Error('Unable to write into user settings. Please open the user settings to correct errors/warnings in it and try again.');
            }
            const base = text.trim() === '' ? '{}' : text;
            // jsonc-parser edits the text in place: comments and formatting of the user's file are kept
            const edits = modify(base, [key], value === undefined ? undefined : deepClone(value), { formattingOptions: FORMATTING });
            const next = applyEdits(base, edits);
            await writeFileAtomic(settingsPath, next.endsWith('\n') ? next : next + '\n');
            this.applyUserText(next, true);
        });
    }

    private parseSettings(text: string): { ok: true; value: Tree } | { ok: false; error: string } {
        if (text.trim() === '') {
            return { ok: true, value: Object.create(null) };
        }
        const errors: ParseError[] = [];
        const value = parse(text, errors, { allowTrailingComma: true, disallowComments: false });
        if (errors.length > 0) {
            const e = errors[0];
            return { ok: false, error: `${printParseErrorCode(e.error)} at offset ${e.offset}` };
        }
        if (!isPlainObject(value)) {
            return { ok: false, error: 'settings.json must contain a JSON object' };
        }
        return { ok: true, value };
    }

    private loadUserSync(fireEvents: boolean): void {
        const settingsPath = this.opts.settingsPath;
        if (!settingsPath) {
            return;
        }
        let text = '';
        try {
            text = fs.readFileSync(settingsPath, 'utf8');
        } catch (err) {
            if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
                this.opts.log.warn(`[vscode-shim] could not read ${settingsPath}:`, err);
                return;
            }
        }
        if (text.charCodeAt(0) === 0xfeff) {
            text = text.slice(1);
        }
        this.applyUserText(text, fireEvents);
    }

    private applyUserText(text: string, fireEvents: boolean): void {
        const parsed = this.parseSettings(text);
        if (!parsed.ok) {
            if (this.brokenReason !== parsed.error) {
                this.opts.log.warn(`[vscode-shim] ${this.opts.settingsPath}: ${parsed.error} — keeping the last good settings until it is fixed`);
            }
            this.brokenReason = parsed.error;
            return;
        }
        this.brokenReason = undefined;
        const nextTree = toValueTree(parsed.value, this.opts.log);
        const nextLeaves = flattenLeaves(nextTree);
        const changed: string[] = [];
        for (const [k, v] of nextLeaves) {
            if (!this.userLeaves.has(k) || !deepEqual(this.userLeaves.get(k), v)) {
                changed.push(k);
            }
        }
        for (const k of this.userLeaves.keys()) {
            if (!nextLeaves.has(k)) {
                changed.push(k);
            }
        }
        this.userTree = nextTree;
        this.userLeaves = nextLeaves;
        if (fireEvents && changed.length > 0) {
            this.emitter.fire(createConfigurationChangeEvent(changed));
        }
    }
}
