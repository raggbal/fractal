/**
 * The Fractal design (docs/design/modern-2026.md) for the shell's own pages — the sidebar, the prompt
 * sheet — and for the native views before their page paints. The pages load the extension's own
 * out/webview/tokens.css and fr-base.css, the files the note views load: nothing is copied here, so a
 * change of tokens.css (another left-panel variant, docs/design/modern-2026.md §13) reaches the
 * desktop app with the next build. No Electron import (unit-tested).
 */
import * as fs from 'fs';
import * as path from 'path';

/** The surface colors (#RRGGBB) a native view paints before its page does. */
export interface Surfaces {
    /** --fr-color-bg-app: the note's body, the window behind the views, the empty view */
    app: string;
    /** --fr-color-bg-panel: the sidebar */
    panel: string;
    /** --fr-color-bg-elevated: the prompt sheet */
    elevated: string;
}

export interface DesignSurfaces {
    light: Surfaces;
    dark: Surfaces;
}

/** Only for a tokens.css that cannot be read or lacks a value (the modern-2026 values, left panel A5). */
export const FALLBACK_SURFACES: Readonly<DesignSurfaces> = {
    light: { app: '#FFFFFF', panel: '#F5F4FB', elevated: '#FFFFFF' },
    dark: { app: '#1F1F22', panel: '#18181B', elevated: '#2A2A2E' },
};

/** In the order the note views load them (tokens first). */
export const DESIGN_FILES: readonly string[] = ['tokens.css', 'fr-base.css'];

/** tokens.css + fr-base.css of the extension (a file that cannot be read is left out and reported). */
export function readDesignCss(extensionRoot: string, onError?: (file: string, err: unknown) => void): string {
    const parts: string[] = [];
    for (const name of DESIGN_FILES) {
        const file = path.join(extensionRoot, 'out', 'webview', name);
        try {
            parts.push(fs.readFileSync(file, 'utf8'));
        } catch (err) {
            onError?.(file, err);
        }
    }
    return parts.join('\n');
}

/**
 * The declarations of tokens.css's light or dark block (§3.14: `:root[data-fr-theme="light"]` is in the
 * light block's selector list, `:root[data-fr-theme="dark"]` is the dark block; a theme block holds
 * declarations only, so its body ends at the next `}`). undefined when there is no such block.
 */
export function themeBlock(tokensCss: string, theme: 'light' | 'dark'): string | undefined {
    const css = tokensCss.replace(/\/\*[\s\S]*?\*\//g, '');
    const selector = `:root[data-fr-theme="${theme}"]`;
    let from = 0;
    for (;;) {
        const at = css.indexOf(selector, from);
        if (at < 0) {
            return undefined;
        }
        from = at + selector.length;
        const open = css.indexOf('{', from);
        // a selector of a rule: only more selectors (`, …`) between it and its `{`
        if (open >= 0 && /^[\s,:\w[\]="-]*$/.test(css.slice(from, open))) {
            const close = css.indexOf('}', open);
            return close < 0 ? undefined : css.slice(open + 1, close);
        }
    }
}

function surfacesOf(block: string | undefined, fallback: Surfaces): Surfaces {
    const value = (token: string, fb: string): string => {
        const m = block ? new RegExp(`--fr-color-${token}\\s*:\\s*([^;]*);`).exec(block) : null;
        const v = m ? m[1].trim() : '';
        return /^#[0-9a-fA-F]{6}$/.test(v) ? v : fb;
    };
    return { app: value('bg-app', fallback.app), panel: value('bg-panel', fallback.panel), elevated: value('bg-elevated', fallback.elevated) };
}

/** The surface colors of tokens.css's light and dark blocks (each value falls back on its own). */
export function parseDesignSurfaces(tokensCss: string): DesignSurfaces {
    return {
        light: surfacesOf(themeBlock(tokensCss, 'light'), FALLBACK_SURFACES.light),
        dark: surfacesOf(themeBlock(tokensCss, 'dark'), FALLBACK_SURFACES.dark),
    };
}
