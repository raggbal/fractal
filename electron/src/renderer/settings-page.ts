/**
 * The settings page (fractal-ui://settings/index.html): the extension's settings as fields, grouped like
 * VS Code's Settings editor. A change is written at once (text fields when they lose focus or on Enter);
 * the main process checks it and pushes the new state, which updates the fields in place (a field being
 * typed in is left alone). Text is always set with textContent. A plain script (no imports) so tsc emits
 * no module wrapper; everything lives in one IIFE.
 */
(function () {
    interface Field {
        key: string;
        title: string;
        description: string;
        kind: 'boolean' | 'enum' | 'number' | 'string' | 'secret' | 'list';
        options?: Array<{ value: string; label: string }>;
        min?: number;
        max?: number;
        pick?: string;
        defaultValue: unknown;
    }
    interface Section {
        title: string;
        fields: Field[];
    }
    interface Texts {
        title: string;
        reset: string;
        choose: string;
        add: string;
        remove: string;
        show: string;
        hide: string;
        openFile: string;
        brokenFile: string;
        none: string;
        addPlaceholder: string;
    }
    interface State {
        dark: boolean;
        texts: Texts;
        sections: Section[];
        values: Record<string, unknown>;
        modified: string[];
        error?: string;
    }
    interface Result {
        ok: boolean;
        error?: string;
    }
    interface Bridge {
        getState(): Promise<State | null>;
        set(key: string, value: unknown): Promise<Result>;
        reset(key: string): Promise<Result>;
        pick(key: string): Promise<string | null>;
        openFile(): void;
        onState(listener: (state: State) => void): void;
        onFocus(listener: (key: string) => void): void;
    }
    interface Control {
        update(value: unknown, modified: boolean, disabled: boolean): void;
    }

    const bridge = (window as unknown as { fractalSettings?: Bridge }).fractalSettings;
    const rootEl = document.getElementById('root');
    if (!bridge || !rootEl) {
        return;
    }
    const api: Bridge = bridge;
    const root: HTMLElement = rootEl;
    const controls = new Map<string, Control>();
    let signature = '';
    let banner: HTMLElement | null = null;

    function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
        const e = document.createElement(tag);
        if (cls) {
            e.className = cls;
        }
        if (text !== undefined) {
            e.textContent = text;
        }
        return e;
    }

    function button(text: string, cls: string, onClick: () => void): HTMLButtonElement {
        const b = el('button', cls, text);
        b.type = 'button';
        b.addEventListener('click', onClick);
        return b;
    }

    async function apply(p: Promise<Result>, errEl: HTMLElement): Promise<void> {
        let r: Result | undefined;
        try {
            r = await p;
        } catch (err) {
            r = { ok: false, error: String(err) };
        }
        errEl.textContent = r && r.ok ? '' : (r && r.error) || '';
    }

    function asList(v: unknown): string[] {
        return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
    }

    /** A text field that writes when it loses focus or on Enter (not on every key) */
    function textInput(f: Field, type: string, errEl: HTMLElement): HTMLInputElement {
        const input = el('input', f.kind === 'number' ? 'field number' : 'field');
        input.type = type;
        input.spellcheck = false;
        input.autocomplete = 'off';
        if (f.kind === 'number') {
            if (f.min !== undefined) {
                input.min = String(f.min);
            }
            if (f.max !== undefined) {
                input.max = String(f.max);
            }
        }
        input.addEventListener('change', () => void apply(api.set(f.key, input.value), errEl));
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                input.blur();
            }
        });
        return input;
    }

    function rowFor(f: Field, t: Texts): HTMLElement {
        const row = el('div', 'row');
        row.dataset.key = f.key;
        const head = el('div', 'head');
        head.appendChild(el('span', 'title', f.title));
        const errEl = el('div', 'error');
        const resetBtn = button(t.reset, 'link reset', () => void apply(api.reset(f.key), errEl));
        head.appendChild(resetBtn);
        row.appendChild(head);
        const line = el('div', 'line');
        let control: { set(value: unknown): void; disable(d: boolean): void; focused(): boolean };

        if (f.kind === 'boolean') {
            const label = el('label', 'check');
            const box = el('input');
            box.type = 'checkbox';
            box.addEventListener('change', () => void apply(api.set(f.key, box.checked), errEl));
            label.appendChild(box);
            label.appendChild(el('span', 'description', f.description));
            line.appendChild(label);
            row.appendChild(line);
            control = {
                set: (v) => { box.checked = v === true; },
                disable: (d) => { box.disabled = d; },
                focused: () => false,
            };
        } else {
            if (f.description) {
                row.appendChild(el('div', 'description', f.description));
            }
            row.appendChild(line);
            if (f.kind === 'enum') {
                const select = el('select', 'field');
                for (const o of f.options ?? []) {
                    const opt = el('option', undefined, o.label);
                    opt.value = o.value;
                    select.appendChild(opt);
                }
                select.addEventListener('change', () => void apply(api.set(f.key, select.value), errEl));
                line.appendChild(select);
                control = {
                    set: (v) => { select.value = typeof v === 'string' ? v : String(f.defaultValue ?? ''); },
                    disable: (d) => { select.disabled = d; },
                    focused: () => false,
                };
            } else if (f.kind === 'list') {
                const list = el('div', 'list');
                const add = el('input', 'field');
                add.type = 'text';
                add.placeholder = t.addPlaceholder;
                add.spellcheck = false;
                let current: string[] = [];
                let disabled = false;
                const write = (items: string[]) => void apply(api.set(f.key, items), errEl);
                add.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter' && add.value.trim()) {
                        write(current.concat(add.value.trim()));
                        add.value = '';
                    }
                });
                const render = () => {
                    list.replaceChildren();
                    if (current.length === 0) {
                        list.appendChild(el('div', 'empty', t.none));
                    }
                    current.forEach((item, i) => {
                        const it = el('div', 'item');
                        const p = el('span', 'path', item);
                        p.title = item;
                        it.appendChild(p);
                        const rm = button(t.remove, 'link', () => write(current.filter((_x, j) => j !== i)));
                        rm.disabled = disabled;
                        it.appendChild(rm);
                        list.appendChild(it);
                    });
                };
                row.insertBefore(list, line);
                line.appendChild(add);
                let pickBtn: HTMLButtonElement | null = null;
                if (f.pick) {
                    pickBtn = button(t.add, '', async () => {
                        const chosen = await api.pick(f.key);
                        if (chosen) {
                            write(current.concat(chosen));
                        }
                    });
                    line.appendChild(pickBtn);
                }
                control = {
                    set: (v) => { current = asList(v); render(); },
                    disable: (d) => {
                        disabled = d;
                        add.disabled = d;
                        if (pickBtn) {
                            pickBtn.disabled = d;
                        }
                        render();
                    },
                    focused: () => document.activeElement === add,
                };
            } else {
                const input = textInput(f, f.kind === 'secret' ? 'password' : f.kind === 'number' ? 'number' : 'text', errEl);
                line.appendChild(input);
                const extra: HTMLButtonElement[] = [];
                if (f.kind === 'secret') {
                    const toggle = button(t.show, '', () => {
                        const hidden = input.type === 'password';
                        input.type = hidden ? 'text' : 'password';
                        toggle.textContent = hidden ? t.hide : t.show;
                    });
                    extra.push(toggle);
                }
                if (f.pick) {
                    extra.push(button(t.choose, '', async () => {
                        const chosen = await api.pick(f.key);
                        if (chosen) {
                            void apply(api.set(f.key, chosen), errEl);
                        }
                    }));
                }
                for (const b of extra) {
                    line.appendChild(b);
                }
                control = {
                    set: (v) => { input.value = v === undefined || v === null ? '' : String(v); },
                    disable: (d) => {
                        input.disabled = d;
                        for (const b of extra) {
                            b.disabled = d;
                        }
                    },
                    focused: () => document.activeElement === input,
                };
            }
        }
        row.appendChild(errEl);
        controls.set(f.key, {
            update: (value, modified, disabled) => {
                if (!control.focused()) {
                    control.set(value);
                }
                control.disable(disabled);
                resetBtn.style.visibility = modified ? 'visible' : 'hidden';
                resetBtn.disabled = disabled;
            },
        });
        return row;
    }

    function build(state: State): void {
        controls.clear();
        root.replaceChildren();
        root.appendChild(el('h1', undefined, state.texts.title));
        banner = el('div', 'banner');
        root.appendChild(banner);
        for (const s of state.sections) {
            root.appendChild(el('h2', undefined, s.title));
            for (const f of s.fields) {
                root.appendChild(rowFor(f, state.texts));
            }
        }
        const footer = el('div', 'footer');
        footer.appendChild(button(state.texts.openFile, '', () => api.openFile()));
        root.appendChild(footer);
    }

    function render(state: State | null): void {
        if (!state) {
            return;
        }
        document.documentElement.setAttribute('data-fr-theme', state.dark ? 'dark' : 'light');
        document.title = state.texts.title;
        const sig = JSON.stringify([state.texts, state.sections]);
        if (sig !== signature) {
            signature = sig;
            build(state);
        }
        if (banner) {
            banner.textContent = state.error ? state.texts.brokenFile + state.error : '';
            banner.style.display = state.error ? '' : 'none';
        }
        const readOnly = !!state.error;
        for (const [key, c] of controls) {
            c.update(state.values[key], state.modified.includes(key), readOnly);
        }
    }

    /** openSettings('fractal.x'): bring that setting into view and put the cursor in it */
    let pendingFocus = '';
    function focusRow(key: string): void {
        const row = Array.from(root.querySelectorAll<HTMLElement>('.row')).find((r) => r.dataset.key === key);
        if (!row) {
            pendingFocus = key;
            return;
        }
        pendingFocus = '';
        row.scrollIntoView({ block: 'center' });
        row.querySelector<HTMLElement>('input, select, button:not(.reset)')?.focus();
    }

    api.onState((s) => {
        render(s);
        if (pendingFocus) {
            focusRow(pendingFocus);
        }
    });
    api.onFocus((key) => focusRow(key));
    void api.getState().then((s) => {
        render(s);
        if (pendingFocus) {
            focusRow(pendingFocus);
        }
    });
})();
