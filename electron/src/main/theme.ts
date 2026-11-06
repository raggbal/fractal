/**
 * The theme of the desktop app: the --vscode-* variables (theme-vars.ts, shared by the note views and
 * the sidebar page) and which set applies (the extension's fractal.theme, else the OS appearance).
 */
import { nativeTheme } from 'electron';

export { webviewThemeCss } from './theme-vars';

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

/** Window background before the page paints (no white flash in dark mode). */
export function windowBackground(dark: boolean): string {
    return dark ? '#1f1f1f' : '#ffffff';
}
