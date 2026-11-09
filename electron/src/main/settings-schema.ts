/**
 * The settings screen's model (settings-window.ts): the extension's contributed settings
 * (package.json contributes.configuration, its categories in order) as fields, their labels from
 * package.nls(.<lang>).json — the same text as VS Code's Settings editor — and the check of a value
 * before it is written. Deprecated settings (kept only so the extension can move them, ADRL-0141)
 * are not shown. Pure: no Electron, no fs.
 */

export type SettingKind = 'boolean' | 'enum' | 'number' | 'string' | 'secret' | 'list';
/** what the field's "Choose…" button picks */
export type SettingPick = 'folder' | 'css' | 'terminology' | 'browser';

export interface SettingField {
    /** the key under "fractal." (theme, awsRegion, …) */
    key: string;
    title: string;
    description: string;
    kind: SettingKind;
    options?: Array<{ value: string; label: string }>;
    min?: number;
    max?: number;
    pick?: SettingPick;
    defaultValue: unknown;
}

export interface SettingSection {
    title: string;
    fields: SettingField[];
}

type Json = Record<string, unknown>;

/** Fields shown as a password box */
const SECRET_KEYS = new Set(['awsSecretAccessKey']);
/** Fields with a "Choose…" button */
const PICKS: Record<string, SettingPick> = {
    resourceRoots: 'folder',
    pdfStyles: 'css',
    translateTerminology: 'terminology',
    pdfBrowserPath: 'browser',
};
const MAX_STRING = 4096;
const MAX_LIST = 100;

/** "%key%" → the text of nls (else the English one, else the key) */
export function localize(value: unknown, nls: Record<string, string>, fallback: Record<string, string>): string {
    const s = typeof value === 'string' ? value : '';
    const m = /^%(.+)%$/.exec(s);
    if (!m) {
        return s;
    }
    return nls[m[1]] ?? fallback[m[1]] ?? m[1];
}

/** "fractal.showTranslateButtons" → "Show Translate Buttons" (when a setting has no title) */
function titleFromKey(key: string): string {
    const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
    return words.charAt(0).toUpperCase() + words.slice(1);
}

function asCategories(configuration: unknown): Json[] {
    if (Array.isArray(configuration)) {
        return configuration.filter((c): c is Json => !!c && typeof c === 'object');
    }
    return configuration && typeof configuration === 'object' ? [configuration as Json] : [];
}

function fieldOf(fullKey: string, schema: Json, nls: Record<string, string>, en: Record<string, string>): SettingField | undefined {
    if (!fullKey.startsWith('fractal.') || schema.deprecationMessage !== undefined || schema.markdownDeprecationMessage !== undefined) {
        return undefined;
    }
    const key = fullKey.slice('fractal.'.length);
    const type = schema.type;
    const title = schema.title !== undefined ? localize(schema.title, nls, en) : titleFromKey(key);
    const description = localize(schema.description ?? schema.markdownDescription ?? '', nls, en);
    const base = { key, title, description, defaultValue: schema.default };
    if (type === 'boolean') {
        return { ...base, kind: 'boolean' };
    }
    if (type === 'number' || type === 'integer') {
        return {
            ...base,
            kind: 'number',
            min: typeof schema.minimum === 'number' ? schema.minimum : undefined,
            max: typeof schema.maximum === 'number' ? schema.maximum : undefined,
        };
    }
    if (type === 'string' && Array.isArray(schema.enum)) {
        const labels = Array.isArray(schema.enumItemLabels) ? schema.enumItemLabels : [];
        const options = schema.enum.map((v, i) => ({ value: String(v), label: labels[i] !== undefined ? localize(labels[i], nls, en) : String(v) }));
        return { ...base, kind: 'enum', options };
    }
    if (type === 'string') {
        return { ...base, kind: SECRET_KEYS.has(key) ? 'secret' : 'string', pick: PICKS[key] };
    }
    const items = schema.items as Json | undefined;
    if (type === 'array' && items && items.type === 'string') {
        return { ...base, kind: 'list', pick: PICKS[key] };
    }
    return undefined; // a type the screen does not edit: settings.json only
}

/** The categories with their shown settings, in package.json's order (category "order", then property "order"). */
export function buildSettingsSchema(packageJson: unknown, nls: Record<string, string>, en: Record<string, string>): SettingSection[] {
    const contributes = (packageJson as Json | undefined)?.contributes as Json | undefined;
    const categories = asCategories(contributes?.configuration)
        .map((c, i) => ({ c, i, order: typeof c.order === 'number' ? c.order : Number.MAX_SAFE_INTEGER }))
        .sort((a, b) => a.order - b.order || a.i - b.i);
    const sections: SettingSection[] = [];
    for (const { c } of categories) {
        const props = (c.properties && typeof c.properties === 'object' ? c.properties : {}) as Record<string, Json>;
        const fields = Object.entries(props)
            .map(([k, s], i) => ({ f: fieldOf(k, s, nls, en), i, order: typeof s.order === 'number' ? s.order : Number.MAX_SAFE_INTEGER }))
            .filter((x): x is { f: SettingField; i: number; order: number } => !!x.f)
            .sort((a, b) => a.order - b.order || a.i - b.i)
            .map((x) => x.f);
        if (fields.length > 0) {
            sections.push({ title: localize(c.title ?? '', nls, en), fields });
        }
    }
    return sections;
}

export function findField(sections: SettingSection[], key: string): SettingField | undefined {
    for (const s of sections) {
        const f = s.fields.find((x) => x.key === key);
        if (f) {
            return f;
        }
    }
    return undefined;
}

/** The value to write for a field, or why it is refused. Strings are trimmed; a number is kept in min..max. */
export function checkSettingValue(field: SettingField, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
    switch (field.kind) {
        case 'boolean':
            return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: 'expected true or false' };
        case 'number': {
            const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN;
            if (!Number.isFinite(n)) {
                return { ok: false, error: 'expected a number' };
            }
            const lo = field.min ?? -Infinity;
            const hi = field.max ?? Infinity;
            return { ok: true, value: Math.min(hi, Math.max(lo, n)) };
        }
        case 'enum': {
            const v = typeof value === 'string' ? value : '';
            return field.options?.some((o) => o.value === v) ? { ok: true, value: v } : { ok: false, error: 'not one of the choices' };
        }
        case 'string':
        case 'secret': {
            if (typeof value !== 'string') {
                return { ok: false, error: 'expected text' };
            }
            const v = value.trim();
            return v.length > MAX_STRING ? { ok: false, error: 'too long' } : { ok: true, value: v };
        }
        case 'list': {
            if (!Array.isArray(value) || value.length > MAX_LIST || value.some((x) => typeof x !== 'string' || x.length > MAX_STRING)) {
                return { ok: false, error: 'expected a list of paths' };
            }
            const seen = new Set<string>();
            const out: string[] = [];
            for (const x of value as string[]) {
                const v = x.trim();
                if (v && !seen.has(v)) {
                    seen.add(v);
                    out.push(v);
                }
            }
            return { ok: true, value: out };
        }
        default:
            return { ok: false, error: 'not editable here' };
    }
}

/** The app's language → the package.nls file's suffix ('' = package.nls.json) */
export function nlsSuffix(lang: string): string {
    const l = String(lang || '').toLowerCase();
    if (l.startsWith('zh')) {
        return /tw|hk|hant/.test(l) ? 'zh-tw' : 'zh-cn';
    }
    for (const s of ['ja', 'ko', 'es', 'fr']) {
        if (l === s || l.startsWith(s + '-') || l.startsWith(s + '_')) {
            return s;
        }
    }
    return '';
}
