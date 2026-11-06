/**
 * Who may load what inside a Notes panel's session (ADR-0014, spec D3). No Electron import: the rule
 * is unit-tested headless (test/unit/electron-vscode-shim.spec.ts, AC-3); panel-host.ts applies it in
 * the session's webRequest.onBeforeRequest.
 *
 * Why there: answers of protocol.handle get no CORS check and the handler sees no Origin /
 * Sec-Fetch-* header, so it cannot tell who is asking. onBeforeRequest runs first and knows the
 * requesting frame. Two URL kinds are guarded:
 *
 * - the panel's document, fractal-res://<panel>/index.html. It embeds the opened note: the initial
 *   outline (base64) and md text, the file list / structure with absolute paths, the history, the
 *   nonce. Only this panel's window may load it: its own top-level navigation (the frame still has
 *   the opaque initial origin at that point, so the origin cannot be checked there) or a frame that
 *   already has the panel's origin. A sandboxed viewer iframe (origin 'null') may not, although the
 *   CSP it inherits (connect-src 'self') names the panel origin. In VS Code the same 'self' serves
 *   only VS Code's generic host page, never the note.
 * - webview resources, https://*.vscode-cdn.net/*: only frames with the panel's origin (the page and
 *   its same-origin frames and workers). VS Code's service worker answers only its own clients.
 *
 * Everything else in these URL patterns is refused, including requests without a frame.
 */
import { PANEL_SCHEME } from './ipc';

export const WEBVIEW_RESOURCE_BASE_HOST = 'vscode-cdn.net';

/** The URL patterns the panel session's onBeforeRequest guard sees. */
export const GUARDED_URL_PATTERNS: readonly string[] = [`https://*.${WEBVIEW_RESOURCE_BASE_HOST}/*`, `${PANEL_SCHEME}://*/*`];

export interface PanelRequestFacts {
    url: string;
    /** Electron's details.resourceType ('mainFrame', 'subFrame', 'xhr', 'image', …) */
    resourceType?: string;
    webContentsId?: number;
    /** Origin of the frame that makes the request; null when there is no frame (or it is gone). */
    frameOrigin?: string | null;
}

export interface PanelIdentity {
    /** fractal-res://<host> */
    origin: string;
    /** The panel window's webContents id. */
    webContentsId: number;
    /** false once the panel was disposed or its window is gone */
    alive: boolean;
}

/** True when the request may go on to the panel session's handlers. */
export function mayLoadInPanelSession(req: PanelRequestFacts, panel: PanelIdentity | undefined): boolean {
    if (!panel || !panel.alive) {
        return false;
    }
    let protocol: string;
    try {
        protocol = new URL(req.url).protocol;
    } catch {
        return false;
    }
    if (protocol === `${PANEL_SCHEME}:`) {
        if (req.webContentsId !== panel.webContentsId) {
            return false;
        }
        return req.resourceType === 'mainFrame' || (!!req.frameOrigin && req.frameOrigin === panel.origin);
    }
    if (typeof req.webContentsId === 'number' && req.webContentsId !== panel.webContentsId) {
        return false;
    }
    return !!req.frameOrigin && req.frameOrigin === panel.origin;
}
