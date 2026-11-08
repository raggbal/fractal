/**
 * The sidebar page (fractal-ui://sidebar/index.html, spec 20261107-0431-electron-sidebar): VS Code's
 * Fractal List / Notes views drawn from the model the main process builds out of the extension's own
 * tree providers and package.json contributes. Left of the note views of the same window; when the
 * window shows no note, this page also draws the empty view to the right of the sidebar.
 *
 * - sections with a header (name, TreeView.description, the view/title buttons, "…"), collapsible
 * - rows: ● for open notes (× on hover of the ● closes the note — D6), icon, label, description,
 *   tooltip, the inline buttons on hover; click = the TreeItem.command; right-click = the native menu
 * - welcome content when a view is empty (one-link lines are buttons)
 * - collapse to a 28px bar with only the expand button; drag the right edge to resize (180–480px)
 * - keyboard: ↑↓ Home End move between rows, Enter / Space run, Shift+F10 / the menu key = right-click
 *
 * Every string from the model is set with textContent / attributes (labels and tooltips come from the
 * user's notes). The page only holds handles / tokens; the main process decides what they run.
 * A plain script (no imports) so tsc emits no module wrapper; everything lives in one IIFE.
 * The model types repeat electron/src/main/sidebar-model.ts — change both together.
 */
(function () {
    interface IconPath {
        d: string;
        fill?: boolean;
    }
    interface PageAction {
        token: string;
        title: string;
        icon?: string;
    }
    interface PageItem {
        handle: string;
        key: string;
        label: string;
        description?: string;
        tooltip?: string;
        icon?: string;
        inline: PageAction[];
        menu: boolean;
        note: boolean;
        open?: boolean;
        shown?: boolean;
    }
    type PageWelcomePart = { text: string } | { token: string; title: string };
    type PageWelcomeLine = { kind: 'paragraph'; parts: PageWelcomePart[] } | { kind: 'button'; token: string; title: string };
    interface PageSection {
        viewId: string;
        title: string;
        description?: string;
        message?: string;
        error?: string;
        actions: PageAction[];
        more: boolean;
        items: PageItem[];
        welcome: PageWelcomeLine[];
        expanded?: boolean;
    }
    interface Model {
        rev: number;
        containerTitle: string;
        sections: PageSection[];
        icons: Record<string, { paths: IconPath[] }>;
        collapsed: boolean;
        width: number;
        showEmpty: boolean;
        opening: boolean;
        theme: 'light' | 'dark' | 'auto';
        platform: string;
    }
    interface Bridge {
        getModel(): Promise<Model | null>;
        onModel(cb: (m: Model) => void): void;
        runItem(handle: string): void;
        runAction(token: string): void;
        showItemMenu(handle: string): void;
        showTitleMenu(viewId: string): void;
        closeNote(handle: string): void;
        setCollapsed(collapsed: boolean): void;
        setWidth(width: number, done: boolean): void;
        setSectionExpanded(viewId: string, expanded: boolean): void;
    }

    const bridge = (window as unknown as { fractalSidebar?: Bridge }).fractalSidebar;
    if (!bridge) {
        return;
    }
    const api: Bridge = bridge;
    const MIN_WIDTH = 180;
    const MAX_WIDTH = 480;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    let model: Model | null = null;
    /** key of the row that has (or last had) the keyboard focus */
    let focusKey: string | null = null;
    /** a drag of the edge in progress: its width wins over the model's */
    let dragWidth: number | null = null;
    /**
     * During a drag nothing is redrawn (a redraw replaces the sash, and with it the pointer capture and the
     * drag's listeners): a model pushed meanwhile waits here, any other redraw is flagged, both run at its end.
     */
    let pendingModel: Model | null = null;
    let redrawAfterDrag = false;
    const localExpanded = new Map<string, boolean>();
    const root = document.getElementById('app') as HTMLElement;

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

    function icon(id: string | undefined): SVGSVGElement | null {
        const def = id && model ? model.icons[id] : undefined;
        if (!def) {
            return null;
        }
        const svg = document.createElementNS(SVG_NS, 'svg');
        svg.setAttribute('viewBox', '0 0 16 16');
        svg.setAttribute('class', 'icon');
        svg.setAttribute('aria-hidden', 'true');
        for (const p of def.paths) {
            const path = document.createElementNS(SVG_NS, 'path');
            path.setAttribute('d', p.d);
            if (p.fill) {
                path.setAttribute('class', 'fill');
            }
            svg.appendChild(path);
        }
        return svg;
    }

    function shortcut(): string {
        return model && model.platform === 'darwin' ? '⌥⌘B' : 'Ctrl+Alt+B';
    }

    function iconButton(iconId: string, title: string, cls: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
        const b = el('button', `icon-button ${cls}`);
        b.type = 'button';
        b.title = title;
        b.setAttribute('aria-label', title);
        const svg = icon(iconId);
        if (svg) {
            b.appendChild(svg);
        } else {
            b.textContent = title.slice(0, 1);
        }
        b.addEventListener('click', (e) => {
            e.stopPropagation();
            onClick(e);
        });
        // a click on a button must not move the row focus first
        b.addEventListener('mousedown', (e) => e.stopPropagation());
        return b;
    }

    function isExpanded(s: PageSection): boolean {
        const local = localExpanded.get(s.viewId);
        return local !== undefined ? local : s.expanded !== false;
    }

    // tokens.css: "auto" follows the OS (its auto-dark block needs the attribute)
    function applyTheme(theme: Model['theme']): void {
        document.documentElement.setAttribute('data-fr-theme', theme === 'light' || theme === 'dark' ? theme : 'auto');
    }

    function clampWidth(w: number): number {
        return Math.round(Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, w)));
    }

    // --- rendering ---------------------------------------------------------------------------

    function renderRow(s: PageSection, it: PageItem): HTMLElement {
        const row = el('div', `row${it.shown ? ' shown' : ''}${it.open ? ' open' : ''}`);
        row.setAttribute('role', 'treeitem');
        row.setAttribute('aria-selected', it.shown ? 'true' : 'false');
        row.tabIndex = -1;
        row.dataset.handle = it.handle;
        row.dataset.key = it.key;
        row.dataset.view = s.viewId;
        if (it.tooltip) {
            row.title = it.tooltip;
        }
        if (it.note) {
            // D6: the ● of an open note; on hover of the ● it is a × that closes the note
            const slot = el('span', 'dot-slot');
            if (it.open) {
                const dot = el('button', 'dot');
                dot.type = 'button';
                dot.tabIndex = -1;
                dot.title = 'Close Note';
                dot.setAttribute('aria-label', `Close ${it.label}`);
                const glyph = icon('circle-filled');
                const x = icon('close');
                if (glyph) {
                    glyph.classList.add('dot-glyph');
                    dot.appendChild(glyph);
                }
                if (x) {
                    x.classList.add('close-glyph');
                    dot.appendChild(x);
                }
                dot.addEventListener('mousedown', (e) => e.stopPropagation());
                dot.addEventListener('click', (e) => {
                    e.stopPropagation();
                    api.closeNote(it.handle);
                });
                slot.appendChild(dot);
            }
            row.appendChild(slot);
        }
        const ic = icon(it.icon);
        const iconSlot = el('span', 'item-icon');
        if (ic) {
            iconSlot.appendChild(ic);
        }
        row.appendChild(iconSlot);
        row.appendChild(el('span', 'label', it.label));
        if (it.description) {
            row.appendChild(el('span', 'description', it.description));
        }
        row.appendChild(el('span', 'spacer'));
        if (it.inline.length > 0) {
            const actions = el('span', 'inline-actions');
            for (const a of it.inline) {
                // like VS Code's tree row actions: not Tab stops (the row is; Shift+F10 / Cmd+W reach the rest)
                const b = iconButton(a.icon || '', a.title, 'inline-action', () => api.runAction(a.token));
                b.tabIndex = -1;
                actions.appendChild(b);
            }
            row.appendChild(actions);
        }
        row.addEventListener('mousedown', () => {
            focusKey = it.key;
        });
        row.addEventListener('click', () => {
            focusKey = it.key;
            api.runItem(it.handle);
        });
        row.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            e.stopPropagation();
            focusKey = it.key;
            row.focus();
            if (it.menu) {
                api.showItemMenu(it.handle);
            }
        });
        row.addEventListener('focus', () => {
            focusKey = it.key;
            for (const r of Array.from(root.querySelectorAll<HTMLElement>('.row'))) {
                r.tabIndex = r === row ? 0 : -1;
            }
        });
        return row;
    }

    function renderWelcome(s: PageSection, body: HTMLElement): void {
        const box = el('div', 'welcome');
        for (const line of s.welcome) {
            if (line.kind === 'button') {
                const b = el('button', 'button', line.title);
                b.type = 'button';
                b.addEventListener('click', () => api.runAction(line.token));
                box.appendChild(b);
                continue;
            }
            const p = el('p');
            for (const part of line.parts) {
                if ('token' in part) {
                    const a = el('button', 'link', part.title);
                    a.type = 'button';
                    const t = part.token;
                    a.addEventListener('click', () => api.runAction(t));
                    p.appendChild(a);
                } else {
                    p.appendChild(document.createTextNode(part.text));
                }
            }
            box.appendChild(p);
        }
        body.appendChild(box);
    }

    function renderSection(s: PageSection, grow: boolean): HTMLElement {
        const expanded = isExpanded(s);
        const pane = el('section', `pane${expanded ? ' expanded' : ''}${expanded ? (grow ? ' grow' : ' fit') : ''}`);
        pane.dataset.view = s.viewId;
        const header = el('div', 'pane-header');
        header.tabIndex = 0;
        header.setAttribute('role', 'button');
        header.setAttribute('aria-expanded', expanded ? 'true' : 'false');
        const twistie = el('span', 'twistie');
        const chevron = icon(expanded ? 'chevron-down' : 'chevron-right');
        if (chevron) {
            twistie.appendChild(chevron);
        }
        header.appendChild(twistie);
        header.appendChild(el('span', 'name', s.title));
        if (s.description) {
            header.appendChild(el('span', 'description', s.description));
        }
        header.appendChild(el('span', 'spacer'));
        const actions = el('span', 'actions');
        for (const a of s.actions) {
            actions.appendChild(iconButton(a.icon || '', a.title, 'title-action', () => api.runAction(a.token)));
        }
        if (s.more) {
            actions.appendChild(iconButton('ellipsis', 'More Actions…', 'title-more', () => api.showTitleMenu(s.viewId)));
        }
        if (expanded) {
            header.appendChild(actions);
        }
        const toggle = () => {
            const next = !isExpanded(s);
            localExpanded.set(s.viewId, next);
            api.setSectionExpanded(s.viewId, next);
            render();
        };
        header.addEventListener('click', toggle);
        header.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggle();
            }
        });
        header.addEventListener('contextmenu', (e) => e.preventDefault());
        pane.appendChild(header);
        if (expanded) {
            const body = el('div', 'pane-body');
            body.setAttribute('role', 'tree');
            body.setAttribute('aria-label', s.title);
            const message = s.error || s.message;
            if (message) {
                body.appendChild(el('div', 'message', message));
            }
            if (s.items.length > 0) {
                for (const it of s.items) {
                    body.appendChild(renderRow(s, it));
                }
            } else if (!s.error) {
                renderWelcome(s, body);
            }
            pane.appendChild(body);
        }
        return pane;
    }

    function startDrag(sash: HTMLElement, e: PointerEvent): void {
        if (!model || e.button !== 0 || dragWidth !== null) {
            return;
        }
        e.preventDefault();
        const startX = e.clientX;
        // from the width on screen: a window too narrow for the saved width draws less (the note keeps 320px)
        const shownAside = root.querySelector<HTMLElement>('.sidebar');
        const startW = clampWidth(shownAside ? shownAside.getBoundingClientRect().width : model.width);
        let frame = 0;
        let latest = startW;
        let moved = false;
        let ended = false;
        try {
            sash.setPointerCapture(e.pointerId);
        } catch {
            return; // not a live pointer: no drag (and no redraw held back)
        }
        dragWidth = startW;
        sash.classList.add('active');
        document.body.classList.add('resizing');
        const move = (ev: PointerEvent) => {
            latest = clampWidth(startW + (ev.clientX - startX));
            moved = moved || latest !== startW;
            dragWidth = latest;
            const aside = root.querySelector<HTMLElement>('.sidebar');
            if (aside && model && model.showEmpty) {
                aside.style.width = `${latest}px`;
            }
            if (!frame) {
                frame = requestAnimationFrame(() => {
                    frame = 0;
                    api.setWidth(latest, false);
                });
            }
        };
        // pointerup / pointercancel, or the capture lost any other way: the drag ends once
        const up = () => {
            if (ended) {
                return;
            }
            ended = true;
            sash.removeEventListener('pointermove', move);
            sash.removeEventListener('pointerup', up);
            sash.removeEventListener('pointercancel', up);
            sash.removeEventListener('lostpointercapture', up);
            if (frame) {
                cancelAnimationFrame(frame);
                frame = 0;
            }
            sash.classList.remove('active');
            document.body.classList.remove('resizing');
            dragWidth = null;
            const next = pendingModel;
            pendingModel = null;
            if (next) {
                localExpanded.clear();
                model = next;
            }
            if (moved) {
                if (model) {
                    model.width = latest;
                }
                api.setWidth(latest, true);
            }
            if (next || redrawAfterDrag) {
                redrawAfterDrag = false;
                render();
            }
        };
        sash.addEventListener('pointermove', move);
        sash.addEventListener('pointerup', up);
        sash.addEventListener('pointercancel', up);
        sash.addEventListener('lostpointercapture', up);
    }

    function render(): void {
        if (!model) {
            return;
        }
        if (dragWidth !== null) {
            redrawAfterDrag = true;
            return;
        }
        const m = model;
        applyTheme(m.theme);
        // keep the scroll positions of the lists across a redraw
        const scroll = new Map<string, number>();
        for (const b of Array.from(root.querySelectorAll<HTMLElement>('.pane'))) {
            const body = b.querySelector<HTMLElement>('.pane-body');
            if (b.dataset.view && body) {
                scroll.set(b.dataset.view, body.scrollTop);
            }
        }
        const hadFocus = !!document.activeElement && document.activeElement.classList.contains('row');
        root.textContent = '';
        root.className = `app${m.collapsed ? ' collapsed' : ''}${m.showEmpty ? ' empty-view' : ''}`;

        if (m.collapsed) {
            const bar = el('div', 'bar');
            bar.appendChild(iconButton('layout-sidebar-left-off', `Show Sidebar (${shortcut()})`, 'expand', () => {
                if (model) {
                    model.collapsed = false;
                }
                api.setCollapsed(false);
                render();
            }));
            root.appendChild(bar);
        } else {
            const aside = el('aside', 'sidebar');
            aside.setAttribute('aria-label', m.containerTitle || 'Sidebar');
            if (m.showEmpty) {
                aside.style.width = `${dragWidth ?? m.width}px`;
            }
            const top = el('div', 'topbar');
            top.appendChild(el('span', 'title', m.containerTitle));
            top.appendChild(iconButton('layout-sidebar-left', `Hide Sidebar (${shortcut()})`, 'collapse', () => {
                if (model) {
                    model.collapsed = true;
                }
                api.setCollapsed(true);
                render();
            }));
            aside.appendChild(top);
            const sections = el('div', 'sections');
            const expandedIds = m.sections.filter((s) => isExpanded(s)).map((s) => s.viewId);
            const growId = expandedIds[expandedIds.length - 1];
            for (const s of m.sections) {
                sections.appendChild(renderSection(s, s.viewId === growId));
            }
            aside.appendChild(sections);
            const sash = el('div', 'sash');
            sash.title = 'Drag to resize';
            sash.addEventListener('pointerdown', (e) => startDrag(sash, e));
            aside.appendChild(sash);
            root.appendChild(aside);
        }
        if (m.showEmpty) {
            // blank while the window is still opening its notes (no "select a note" flash at start)
            const empty = el('main', `empty${m.opening ? ' opening' : ''}`);
            if (!m.opening) {
                empty.appendChild(el('div', 'empty-text', 'Select a note from the list on the left.'));
            }
            root.appendChild(empty);
        }

        for (const b of Array.from(root.querySelectorAll<HTMLElement>('.pane'))) {
            const body = b.querySelector<HTMLElement>('.pane-body');
            const top = b.dataset.view ? scroll.get(b.dataset.view) : undefined;
            if (body && top !== undefined) {
                body.scrollTop = top;
            }
        }
        // roving tab stop: the focused (or shown, or first) row
        const rows = Array.from(root.querySelectorAll<HTMLElement>('.row'));
        const target = rows.find((r) => r.dataset.key === focusKey) ?? rows.find((r) => r.classList.contains('shown')) ?? rows[0];
        if (target) {
            target.tabIndex = 0;
            if (hadFocus) {
                target.focus({ preventScroll: true });
            }
        }
    }

    // --- keyboard ----------------------------------------------------------------------------

    root.addEventListener('keydown', (e) => {
        const active = document.activeElement as HTMLElement | null;
        if (!active || !active.classList.contains('row')) {
            return;
        }
        const rows = Array.from(root.querySelectorAll<HTMLElement>('.row'));
        const i = rows.indexOf(active);
        const go = (j: number) => {
            const r = rows[Math.max(0, Math.min(rows.length - 1, j))];
            if (r) {
                r.focus();
                r.scrollIntoView({ block: 'nearest' });
            }
        };
        const handle = active.dataset.handle || '';
        switch (e.key) {
            case 'ArrowDown':
                e.preventDefault();
                go(i + 1);
                break;
            case 'ArrowUp':
                e.preventDefault();
                go(i - 1);
                break;
            case 'Home':
                e.preventDefault();
                go(0);
                break;
            case 'End':
                e.preventDefault();
                go(rows.length - 1);
                break;
            case 'Enter':
            case ' ':
                e.preventDefault();
                if (handle) {
                    api.runItem(handle);
                }
                break;
            case 'ContextMenu':
                e.preventDefault();
                if (handle) {
                    api.showItemMenu(handle);
                }
                break;
            case 'F10':
                if (e.shiftKey && handle) {
                    e.preventDefault();
                    api.showItemMenu(handle);
                }
                break;
            default:
                break;
        }
    });

    // no browser menu anywhere in the sidebar (rows open their own native menu)
    document.addEventListener('contextmenu', (e) => e.preventDefault());

    api.onModel((m) => {
        if (!m || typeof m !== 'object') {
            return;
        }
        if (dragWidth !== null) {
            pendingModel = m; // drawn when the drag ends
            return;
        }
        // the main process now knows these: drop the optimistic local values
        localExpanded.clear();
        model = m;
        render();
    });
    void api.getModel().then((m) => {
        if (m && !model) {
            model = m;
            render();
        }
    });
})();
