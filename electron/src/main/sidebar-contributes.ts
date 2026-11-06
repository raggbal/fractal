/**
 * What the desktop sidebar reads from the extension's package.json `contributes` (spec
 * 20261107-0431-electron-sidebar D2) — the same entries VS Code's workbench draws for these views —
 * and the subset of VS Code's when-clauses it evaluates. No Electron import: unit-tested headless
 * (test/unit/electron-sidebar.spec.ts, AC-3).
 *
 * - views: those of the extension's first activity-bar container (viewsContainers.activitybar[0] →
 *   views[<container id>]), in order, with their names (Fractal List / Notes)
 * - view/title: group `navigation` → header buttons, any other group → the header's "…" menu
 * - view/item/context: group `inline` → row buttons, any other group → the row's right-click menu
 * - viewsWelcome: shown while a view has no items; a line that is one link is a button
 * - commands: titles and `$(codicon)` icons
 *
 * when: only `view`, `viewItem` and setContext keys are known; `!`, `&&`, `||`, `( )`, `==`, `!=`
 * (VS Code's loose equality). Anything else (`=~`, `<`, `in`, …) makes the clause false, so an entry
 * this subset cannot judge is hidden rather than shown.
 */

export interface ContributedView {
    id: string;
    name: string;
}

export interface ContributedCommand {
    id: string;
    title: string;
    /** codicon id of `"icon": "$(name)"` (object / path icons are not drawn) */
    icon?: string;
}

export interface MenuContribution {
    command: string;
    when?: string;
    /** group name without the `@order` suffix ('' = none) */
    group: string;
    order: number;
    /** position in package.json (stable tie-break) */
    index: number;
}

export interface WelcomeContribution {
    view: string;
    contents: string;
    when?: string;
}

export interface SidebarContributes {
    /** The activity-bar container's title (VS Code's side bar title), '' when there is none. */
    containerTitle: string;
    views: ContributedView[];
    commands: ReadonlyMap<string, ContributedCommand>;
    viewTitle: MenuContribution[];
    viewItemContext: MenuContribution[];
    viewsWelcome: WelcomeContribution[];
}

function isObject(v: unknown): v is Record<string, unknown> {
    return !!v && typeof v === 'object' && !Array.isArray(v);
}

function arrayOf(v: unknown): unknown[] {
    return Array.isArray(v) ? v : [];
}

/** `$(name)` / `$(name~spin)` → 'name'; anything else → undefined. */
export function codiconId(icon: unknown): string | undefined {
    if (typeof icon !== 'string') {
        return undefined;
    }
    const m = /^\$\(([A-Za-z0-9-]+)(?:~[A-Za-z]+)?\)$/.exec(icon.trim());
    return m ? m[1] : undefined;
}

/** 'navigation@2' → { group: 'navigation', order: 2 }; '1_modification' → order Infinity. */
export function parseMenuGroup(group: unknown): { group: string; order: number } {
    if (typeof group !== 'string' || group === '') {
        return { group: '', order: Number.POSITIVE_INFINITY };
    }
    const at = group.lastIndexOf('@');
    if (at > 0) {
        const n = Number(group.slice(at + 1));
        if (group.slice(at + 1) !== '' && Number.isFinite(n)) {
            return { group: group.slice(0, at), order: n };
        }
    }
    return { group, order: Number.POSITIVE_INFINITY };
}

function readMenu(entries: unknown): MenuContribution[] {
    const out: MenuContribution[] = [];
    arrayOf(entries).forEach((e, index) => {
        if (!isObject(e) || typeof e.command !== 'string' || !e.command) {
            return;
        }
        const { group, order } = parseMenuGroup(e.group);
        out.push({ command: e.command, when: typeof e.when === 'string' ? e.when : undefined, group, order, index });
    });
    return out;
}

export function readSidebarContributes(pkg: unknown): SidebarContributes {
    const contributes = isObject(pkg) && isObject(pkg.contributes) ? pkg.contributes : {};
    const containers = isObject(contributes.viewsContainers) ? arrayOf(contributes.viewsContainers.activitybar) : [];
    const container = containers.find((c): c is Record<string, unknown> => isObject(c) && typeof c.id === 'string');
    const containerId = container ? (container.id as string) : undefined;
    const viewsByContainer = isObject(contributes.views) ? contributes.views : {};
    const views: ContributedView[] = [];
    if (containerId) {
        for (const v of arrayOf(viewsByContainer[containerId])) {
            if (isObject(v) && typeof v.id === 'string' && v.id && !views.some((x) => x.id === v.id)) {
                views.push({ id: v.id, name: typeof v.name === 'string' ? v.name : v.id });
            }
        }
    }
    const commands = new Map<string, ContributedCommand>();
    for (const c of arrayOf(contributes.commands)) {
        if (isObject(c) && typeof c.command === 'string' && c.command) {
            commands.set(c.command, { id: c.command, title: typeof c.title === 'string' ? c.title : c.command, icon: codiconId(c.icon) });
        }
    }
    const menus = isObject(contributes.menus) ? contributes.menus : {};
    const viewsWelcome: WelcomeContribution[] = [];
    for (const w of arrayOf(contributes.viewsWelcome)) {
        if (isObject(w) && typeof w.view === 'string' && typeof w.contents === 'string') {
            viewsWelcome.push({ view: w.view, contents: w.contents, when: typeof w.when === 'string' ? w.when : undefined });
        }
    }
    return {
        containerTitle: container && typeof container.title === 'string' ? container.title : '',
        views,
        commands,
        viewTitle: readMenu(menus['view/title']),
        viewItemContext: readMenu(menus['view/item/context']),
        viewsWelcome,
    };
}

/**
 * VS Code's menu order: the `navigation` group first, then groups by name, entries without a group
 * last; inside a group by `@order`, then by title. Returns the groups in that order.
 */
export function groupMenuEntries<T extends MenuContribution>(entries: readonly T[], titleOf: (e: T) => string): T[][] {
    const groups = new Map<string, T[]>();
    for (const e of entries) {
        const list = groups.get(e.group) ?? [];
        list.push(e);
        groups.set(e.group, list);
    }
    const names = [...groups.keys()].sort((a, b) => {
        if (a === b) {
            return 0;
        }
        if (a === 'navigation') {
            return -1;
        }
        if (b === 'navigation') {
            return 1;
        }
        if (a === '') {
            return 1;
        }
        if (b === '') {
            return -1;
        }
        return a < b ? -1 : 1;
    });
    return names.map((n) =>
        (groups.get(n) as T[]).slice().sort((a, b) => a.order - b.order || titleOf(a).localeCompare(titleOf(b)) || a.index - b.index)
    );
}

// ---------------------------------------------------------------------------------------------
// when-clauses (the subset above)
// ---------------------------------------------------------------------------------------------

export type WhenContext = Readonly<Record<string, unknown>>;

type WhenNode =
    | { kind: 'and' | 'or'; left: WhenNode; right: WhenNode }
    | { kind: 'not'; operand: WhenNode }
    | { kind: 'key'; key: string }
    | { kind: 'literal'; value: unknown }
    | { kind: 'eq' | 'neq'; key: string; value: unknown };

type Token = { t: 'op'; v: string } | { t: 'word'; v: string } | { t: 'string'; v: string };

function tokenize(src: string): Token[] | null {
    const tokens: Token[] = [];
    let i = 0;
    while (i < src.length) {
        const ch = src[i];
        if (/\s/.test(ch)) {
            i++;
            continue;
        }
        const two = src.slice(i, i + 2);
        const three = src.slice(i, i + 3);
        if (three === '===' || three === '!==') {
            tokens.push({ t: 'op', v: three === '===' ? '==' : '!=' });
            i += 3;
        } else if (two === '&&' || two === '||' || two === '==' || two === '!=') {
            tokens.push({ t: 'op', v: two });
            i += 2;
        } else if (ch === '!' || ch === '(' || ch === ')') {
            tokens.push({ t: 'op', v: ch });
            i++;
        } else if (ch === "'" || ch === '"') {
            const end = src.indexOf(ch, i + 1);
            if (end < 0) {
                return null;
            }
            tokens.push({ t: 'string', v: src.slice(i + 1, end) });
            i = end + 1;
        } else {
            const m = /^[A-Za-z0-9_.\-:/$#@]+/.exec(src.slice(i));
            if (!m) {
                return null; // =~ < > … : not in the subset
            }
            tokens.push({ t: 'word', v: m[0] });
            i += m[0].length;
        }
    }
    return tokens;
}

function literalOf(tok: Token): unknown {
    if (tok.t === 'word' && tok.v === 'true') {
        return true;
    }
    if (tok.t === 'word' && tok.v === 'false') {
        return false;
    }
    return tok.v;
}

function parseWhen(src: string): WhenNode | null {
    const tokens = tokenize(src);
    if (!tokens || tokens.length === 0) {
        return null;
    }
    let pos = 0;
    const peek = (): Token | undefined => tokens[pos];
    const isOp = (v: string) => peek()?.t === 'op' && peek()?.v === v;
    const fail = (): never => {
        throw new Error('unsupported when-clause');
    };
    const parseOr = (): WhenNode => {
        let left = parseAnd();
        while (isOp('||')) {
            pos++;
            left = { kind: 'or', left, right: parseAnd() };
        }
        return left;
    };
    const parseAnd = (): WhenNode => {
        let left = parseUnary();
        while (isOp('&&')) {
            pos++;
            left = { kind: 'and', left, right: parseUnary() };
        }
        return left;
    };
    const parseUnary = (): WhenNode => {
        if (isOp('!')) {
            pos++;
            return { kind: 'not', operand: parseUnary() };
        }
        if (isOp('(')) {
            pos++;
            const inner = parseOr();
            if (!isOp(')')) {
                fail();
            }
            pos++;
            return inner;
        }
        const tok = peek();
        if (!tok || tok.t === 'op') {
            return fail();
        }
        pos++;
        if (isOp('==') || isOp('!=')) {
            const op = (peek() as Token).v;
            pos++;
            const rhs = peek();
            if (!rhs || rhs.t === 'op' || tok.t !== 'word') {
                return fail();
            }
            pos++;
            return { kind: op === '==' ? 'eq' : 'neq', key: tok.v, value: literalOf(rhs) };
        }
        if (tok.t === 'string' || tok.v === 'true' || tok.v === 'false') {
            return { kind: 'literal', value: literalOf(tok) };
        }
        return { kind: 'key', key: tok.v };
    };
    try {
        const node = parseOr();
        return pos === tokens.length ? node : null;
    } catch {
        return null;
    }
}

function lookup(ctx: WhenContext, key: string): unknown {
    return Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key] : undefined;
}

function evalNode(n: WhenNode, ctx: WhenContext): boolean {
    switch (n.kind) {
        case 'and':
            return evalNode(n.left, ctx) && evalNode(n.right, ctx);
        case 'or':
            return evalNode(n.left, ctx) || evalNode(n.right, ctx);
        case 'not':
            return !evalNode(n.operand, ctx);
        case 'key':
            return !!lookup(ctx, n.key);
        case 'literal':
            return !!n.value;
        case 'eq':
            // eslint-disable-next-line eqeqeq
            return lookup(ctx, n.key) == n.value; // VS Code's ContextKeyEqualsExpr is a loose ==
        case 'neq':
            // eslint-disable-next-line eqeqeq
            return lookup(ctx, n.key) != n.value;
        default:
            return false;
    }
}

/** True when the clause holds; an empty / missing clause holds; one outside the subset does not. */
export function evaluateWhen(when: string | undefined, ctx: WhenContext): boolean {
    if (when === undefined || when.trim() === '') {
        return true;
    }
    const node = parseWhen(when);
    return node ? evalNode(node, ctx) : false;
}

// ---------------------------------------------------------------------------------------------
// viewsWelcome contents (VS Code's parseLinkedText: [title](https:… | command:… | file:… "tooltip"))
// ---------------------------------------------------------------------------------------------

export type WelcomePart = { kind: 'text'; text: string } | { kind: 'link'; title: string; target: string };
export type WelcomeLine = { kind: 'paragraph'; parts: WelcomePart[] } | { kind: 'button'; title: string; target: string };

const LINK_RE = /\[([^\]]+)\]\(((?:https?:\/\/|command:|file:)[^)\s]+)(?: (["'])(.+?)(\3))?\)/gi;

export function parseWelcomeContents(contents: string): WelcomeLine[] {
    const lines: WelcomeLine[] = [];
    for (const raw of contents.split('\n')) {
        const line = raw.trim();
        if (!line) {
            continue;
        }
        const parts: WelcomePart[] = [];
        let last = 0;
        for (const m of line.matchAll(LINK_RE)) {
            const at = m.index ?? 0;
            if (at > last) {
                parts.push({ kind: 'text', text: line.slice(last, at) });
            }
            parts.push({ kind: 'link', title: m[1], target: m[2] });
            last = at + m[0].length;
        }
        if (last < line.length) {
            parts.push({ kind: 'text', text: line.slice(last) });
        }
        if (parts.length === 1 && parts[0].kind === 'link') {
            lines.push({ kind: 'button', title: parts[0].title, target: parts[0].target });
        } else {
            lines.push({ kind: 'paragraph', parts });
        }
    }
    return lines;
}

/**
 * `command:<id>` or `command:<id>?<encoded JSON args>` (VS Code's command links) → the command and its
 * arguments; undefined for anything else or args that do not parse.
 */
export function parseCommandLink(target: string): { command: string; args: unknown[] } | undefined {
    const m = /^command:([A-Za-z0-9_.\-]+)(?:\?(.*))?$/.exec(target);
    if (!m) {
        return undefined;
    }
    if (m[2] === undefined || m[2] === '') {
        return { command: m[1], args: [] };
    }
    try {
        const value = JSON.parse(decodeURIComponent(m[2])) as unknown;
        return { command: m[1], args: Array.isArray(value) ? value : [value] };
    } catch {
        return undefined;
    }
}
