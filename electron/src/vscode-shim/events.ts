/**
 * Event plumbing with VS Code semantics (vs/base/common/event.ts + extHostTypes Disposable).
 *
 * - `emitter.event(listener, thisArgs?, disposables?)` returns a Disposable and, when an array is
 *   given, pushes it there too.
 * - `fire()` calls the listeners synchronously in registration order. A listener added during a fire
 *   is not called for that event; a listener removed during a fire is skipped. A throwing listener
 *   is logged and does not stop the others (VS Code's onUnexpectedError).
 * - After `dispose()` the emitter drops every listener and ignores new ones.
 */

export interface DisposableLike {
    dispose(): unknown;
}

export class Disposable {
    static from(...disposableLikes: Array<DisposableLike | undefined | null>): Disposable {
        let items: Array<DisposableLike | undefined | null> | undefined = disposableLikes;
        return new Disposable(() => {
            if (!items) {
                return;
            }
            for (const d of items) {
                if (d && typeof d.dispose === 'function') {
                    try {
                        d.dispose();
                    } catch (err) {
                        reportListenerError(err);
                    }
                }
            }
            items = undefined;
        });
    }

    private _callOnDispose: (() => unknown) | undefined;

    constructor(callOnDispose: () => unknown) {
        this._callOnDispose = callOnDispose;
    }

    dispose(): unknown {
        const fn = this._callOnDispose;
        this._callOnDispose = undefined;
        return typeof fn === 'function' ? fn() : undefined;
    }
}

export type Listener<T> = (e: T) => unknown;

export interface Event<T> {
    (listener: Listener<T>, thisArgs?: unknown, disposables?: DisposableLike[]): Disposable;
}

let errorReporter: (err: unknown) => void = (err) => {
    // eslint-disable-next-line no-console
    console.error('[vscode-shim] event listener threw:', err);
};

/** Lets the shell route listener errors to its log (default: console.error). */
export function setListenerErrorReporter(fn: (err: unknown) => void): void {
    errorReporter = fn;
}

export function reportListenerError(err: unknown): void {
    try {
        errorReporter(err);
    } catch {
        /* never let logging break event delivery */
    }
}

interface ListenerEntry<T> {
    fn: Listener<T>;
    thisArgs: unknown;
    removed: boolean;
}

export class EventEmitter<T = void> {
    private _listeners: Array<ListenerEntry<T>> = [];
    private _disposed = false;
    private _event: Event<T> | undefined;

    get event(): Event<T> {
        if (!this._event) {
            this._event = (listener: Listener<T>, thisArgs?: unknown, disposables?: DisposableLike[]) => {
                if (this._disposed) {
                    return new Disposable(() => undefined);
                }
                const entry: ListenerEntry<T> = { fn: listener, thisArgs, removed: false };
                this._listeners.push(entry);
                const result = new Disposable(() => {
                    if (entry.removed) {
                        return;
                    }
                    entry.removed = true;
                    const i = this._listeners.indexOf(entry);
                    if (i >= 0) {
                        this._listeners.splice(i, 1);
                    }
                });
                if (Array.isArray(disposables)) {
                    disposables.push(result);
                }
                return result;
            };
        }
        return this._event;
    }

    fire(data: T): void {
        this.fireCollect(data);
    }

    /**
     * Shim-internal: fire and return what each listener returned (used to track the promises of
     * async onDidReceiveMessage handlers so that quit can wait for them).
     */
    fireCollect(data: T): unknown[] {
        if (this._disposed || this._listeners.length === 0) {
            return [];
        }
        const snapshot = this._listeners.slice();
        const results: unknown[] = [];
        for (const entry of snapshot) {
            if (entry.removed) {
                continue;
            }
            try {
                results.push(entry.fn.call(entry.thisArgs, data));
            } catch (err) {
                reportListenerError(err);
            }
        }
        return results;
    }

    /** Shim-internal: number of live listeners (tests / diagnostics). */
    get listenerCount(): number {
        return this._listeners.length;
    }

    dispose(): void {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        for (const entry of this._listeners) {
            entry.removed = true;
        }
        this._listeners = [];
    }
}

/** An event that never fires (VS Code's Event.None). */
export const NoneEvent: Event<any> = () => new Disposable(() => undefined);

export interface CancellationToken {
    readonly isCancellationRequested: boolean;
    readonly onCancellationRequested: Event<void>;
}

class MutableToken implements CancellationToken {
    private _isCancelled = false;
    private _emitter: EventEmitter<void> | undefined;

    cancel(): void {
        if (this._isCancelled) {
            return;
        }
        this._isCancelled = true;
        if (this._emitter) {
            this._emitter.fire(undefined);
            this._emitter.dispose();
            this._emitter = undefined;
        }
    }

    get isCancellationRequested(): boolean {
        return this._isCancelled;
    }

    get onCancellationRequested(): Event<void> {
        if (this._isCancelled) {
            // VS Code's shortcutEvent: a listener added after cancellation is called asynchronously once.
            return (listener: Listener<void>, thisArgs?: unknown, disposables?: DisposableLike[]) => {
                const handle = setTimeout(() => listener.call(thisArgs, undefined), 0);
                const d = new Disposable(() => clearTimeout(handle));
                if (Array.isArray(disposables)) {
                    disposables.push(d);
                }
                return d;
            };
        }
        if (!this._emitter) {
            this._emitter = new EventEmitter<void>();
        }
        return this._emitter.event;
    }

    dispose(): void {
        if (this._emitter) {
            this._emitter.dispose();
            this._emitter = undefined;
        }
    }
}

export class CancellationTokenSource {
    private _token: MutableToken | undefined;

    get token(): CancellationToken {
        if (!this._token) {
            this._token = new MutableToken();
        }
        return this._token;
    }

    cancel(): void {
        if (!this._token) {
            this._token = new MutableToken();
        }
        this._token.cancel();
    }

    dispose(cancel = false): void {
        if (cancel) {
            this.cancel();
        }
        if (this._token) {
            this._token.dispose();
        }
    }
}

export class CancellationError extends Error {
    constructor() {
        super('Canceled');
        this.name = 'Canceled';
    }
}
