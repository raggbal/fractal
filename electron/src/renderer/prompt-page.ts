/**
 * The prompt page (fractal-ui://prompt/index.html): VS Code's showInputBox / showQuickPick as a small
 * sheet on the Notes window. Text is always set with textContent (labels come from the extension).
 * Enter accepts, Esc cancels, ↑↓ move in a quick pick, Space toggles in a multi-select pick.
 * A plain script (no imports) so tsc emits no module wrapper; everything lives in one IIFE.
 */
(function () {
    interface PromptItem {
        label: string;
        description?: string;
        detail?: string;
        separator: boolean;
        picked: boolean;
    }
    interface PromptPayload {
        kind: 'input' | 'pick';
        title?: string;
        prompt?: string;
        placeHolder?: string;
        value?: string;
        valueSelection?: [number, number];
        password?: boolean;
        items?: PromptItem[];
        canPickMany?: boolean;
        dark?: boolean;
    }
    interface PromptBridge {
        getRequest(): Promise<PromptPayload>;
        validate(value: string): Promise<string | undefined>;
        done(result: unknown): void;
    }

    const bridge = (window as unknown as { fractalPrompt?: PromptBridge }).fractalPrompt;
    if (!bridge) {
        return;
    }
    const api: PromptBridge = bridge;
    let finished = false;

    function finish(result: unknown): void {
        if (finished) {
            return;
        }
        finished = true;
        api.done(result);
    }

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

    function header(root: HTMLElement, req: PromptPayload): void {
        if (req.title) {
            root.appendChild(el('div', 'title', req.title));
        }
    }

    function buttonsRow(okLabel: string, onOk: () => void): { row: HTMLElement; ok: HTMLButtonElement } {
        const row = el('div', 'buttons');
        const cancel = el('button', 'secondary', 'Cancel');
        cancel.type = 'button';
        cancel.addEventListener('click', () => finish(null));
        const ok = el('button', 'primary', okLabel);
        ok.type = 'button';
        ok.addEventListener('click', onOk);
        row.appendChild(cancel);
        row.appendChild(ok);
        return { row, ok };
    }

    function renderInput(root: HTMLElement, req: PromptPayload): void {
        header(root, req);
        if (req.prompt) {
            root.appendChild(el('div', 'prompt', req.prompt));
        }
        const input = el('input', 'field');
        input.type = req.password ? 'password' : 'text';
        input.spellcheck = false;
        input.autocomplete = 'off';
        input.placeholder = req.placeHolder || '';
        input.value = req.value || '';
        root.appendChild(input);
        const message = el('div', 'validation');
        root.appendChild(message);

        let seq = 0;
        async function validate(): Promise<string | undefined> {
            const mine = ++seq;
            let m: string | undefined;
            try {
                m = await api.validate(input.value);
            } catch {
                m = undefined;
            }
            if (mine === seq) {
                message.textContent = m || '';
                message.style.display = m ? 'block' : 'none';
                input.classList.toggle('invalid', !!m);
            }
            return m;
        }
        async function accept(): Promise<void> {
            const m = await validate();
            if (!m) {
                finish({ value: input.value });
            }
        }
        const { row } = buttonsRow('OK', () => void accept());
        root.appendChild(row);
        message.style.display = 'none';
        let timer: ReturnType<typeof setTimeout> | null = null;
        input.addEventListener('input', () => {
            if (timer) {
                clearTimeout(timer);
            }
            timer = setTimeout(() => void validate(), 120);
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.isComposing) {
                e.preventDefault();
                void accept();
            }
        });
        input.focus();
        if (req.valueSelection && req.valueSelection.length === 2) {
            input.setSelectionRange(req.valueSelection[0], req.valueSelection[1]);
        } else {
            input.select();
        }
        if (input.value) {
            void validate();
        }
    }

    function renderPick(root: HTMLElement, req: PromptPayload): void {
        header(root, req);
        const items = req.items || [];
        const many = !!req.canPickMany;
        const filter = el('input', 'field');
        filter.type = 'text';
        filter.spellcheck = false;
        filter.autocomplete = 'off';
        filter.placeholder = req.placeHolder || (many ? 'Filter…' : 'Type to filter…');
        root.appendChild(filter);
        const list = el('div', 'list');
        list.setAttribute('role', 'listbox');
        root.appendChild(list);
        const picked = new Set<number>(items.map((it, i) => (it.picked ? i : -1)).filter((i) => i >= 0));
        let visible: number[] = [];
        let active = -1;

        function matches(it: PromptItem, q: string): boolean {
            if (!q) {
                return true;
            }
            const hay = `${it.label} ${it.description || ''} ${it.detail || ''}`.toLowerCase();
            return q.split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
        }

        function render(): void {
            const q = filter.value.trim().toLowerCase();
            list.textContent = '';
            visible = [];
            items.forEach((it, i) => {
                if (it.separator) {
                    if (!q && it.label) {
                        list.appendChild(el('div', 'separator', it.label));
                    } else if (!q) {
                        list.appendChild(el('div', 'separator rule'));
                    }
                    return;
                }
                if (!matches(it, q)) {
                    return;
                }
                const row = el('div', 'row');
                row.setAttribute('role', 'option');
                row.dataset.index = String(i);
                if (many) {
                    const box = el('input', 'check');
                    box.type = 'checkbox';
                    box.checked = picked.has(i);
                    box.tabIndex = -1;
                    row.appendChild(box);
                }
                const text = el('div', 'text');
                const line = el('div', 'line');
                line.appendChild(el('span', 'label', it.label));
                if (it.description) {
                    line.appendChild(el('span', 'description', it.description));
                }
                text.appendChild(line);
                if (it.detail) {
                    text.appendChild(el('div', 'detail', it.detail));
                }
                row.appendChild(text);
                row.addEventListener('mousemove', () => setActive(visible.indexOf(i)));
                row.addEventListener('click', () => {
                    if (many) {
                        toggle(i);
                    } else {
                        finish({ indices: [i] });
                    }
                });
                list.appendChild(row);
                visible.push(i);
            });
            if (visible.length === 0) {
                list.appendChild(el('div', 'empty', 'No matching items'));
            }
            setActive(visible.length > 0 ? 0 : -1);
        }

        function setActive(pos: number): void {
            active = pos;
            list.querySelectorAll('.row').forEach((r, k) => {
                r.classList.toggle('active', k === pos);
                if (k === pos) {
                    (r as HTMLElement).scrollIntoView({ block: 'nearest' });
                }
            });
        }

        function toggle(i: number): void {
            if (picked.has(i)) {
                picked.delete(i);
            } else {
                picked.add(i);
            }
            const row = list.querySelector(`.row[data-index="${i}"] input.check`) as HTMLInputElement | null;
            if (row) {
                row.checked = picked.has(i);
            }
        }

        function accept(): void {
            if (many) {
                finish({ indices: Array.from(picked).sort((a, b) => a - b) });
                return;
            }
            if (active >= 0 && active < visible.length) {
                finish({ indices: [visible[active]] });
            }
        }

        filter.addEventListener('input', render);
        filter.addEventListener('keydown', (e) => {
            if (e.isComposing) {
                return;
            }
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (visible.length > 0) {
                    setActive((active + 1) % visible.length);
                }
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (visible.length > 0) {
                    setActive((active - 1 + visible.length) % visible.length);
                }
            } else if (e.key === 'Enter') {
                e.preventDefault();
                accept();
            } else if (e.key === ' ' && many && filter.value === '' && active >= 0) {
                e.preventDefault();
                toggle(visible[active]);
            }
        });
        if (many) {
            const { row } = buttonsRow('OK', accept);
            root.appendChild(row);
        }
        render();
        filter.focus();
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            finish(null);
        }
    });

    api.getRequest().then(
        (req) => {
            document.documentElement.classList.toggle('dark', !!(req && req.dark));
            const root = document.getElementById('root') || document.body;
            if (!req || (req.kind !== 'input' && req.kind !== 'pick')) {
                finish(null);
                return;
            }
            if (req.kind === 'input') {
                renderInput(root, req);
            } else {
                renderPick(root, req);
            }
        },
        () => finish(null)
    );
})();
