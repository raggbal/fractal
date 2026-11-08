/**
 * The theme of the desktop app: which set applies (the extension's fractal.theme, else the OS
 * appearance), the --vscode-* variables VS Code would inject into the note views (theme-vars.ts), and
 * the surface colors of the Fractal design (design-tokens.ts: the extension's tokens.css) that the
 * native views paint before their page does.
 */
import { nativeTheme } from 'electron';
import { FALLBACK_SURFACES, parseDesignSurfaces, type DesignSurfaces, type Surfaces } from './design-tokens';

export { webviewThemeCss } from './theme-vars';

let surfaces: DesignSurfaces = FALLBACK_SURFACES;

/** 'light' | 'dark' | 'auto' (the extension's fractal.theme) → whether the window is dark. */
export function isDarkTheme(fractalTheme: unknown): boolean {
    if (fractalTheme === 'dark') {
        return true;
    }
    if (fractalTheme === 'light') {
        return false;
    }
    return nativeTheme.shouldUseDarkColors;
}

/** Takes the surface colors from the extension's tokens.css (the shell, once at start). */
export function useDesignTokens(tokensCss: string): void {
    surfaces = parseDesignSurfaces(tokensCss);
}

/** The colors a view paints before its page does (no flash of another color). */
export function surfaceColors(dark: boolean): Surfaces {
    return dark ? surfaces.dark : surfaces.light;
}
