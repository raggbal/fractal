/**
 * The sidebar page's own HTML / CSS / CSP (sidebar-view.ts serves them from the sidebar session). No
 * Electron import: the sidebar unit spec checks that every --vscode-* variable the CSS reads exists in
 * theme-vars.ts (light and dark) and what the CSP allows.
 *
 * The CSS reads only the --vscode-* variables the note views get too (theme-vars.ts), which
 * sidebar.css carries first; the page's script is the only script it may run.
 */
export const SIDEBAR_META_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'none'; connect-src 'none'; " +
    "media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
/** The response header adds frame-ancestors (ignored in a meta element). */
export const SIDEBAR_CSP = `${SIDEBAR_META_CSP}; frame-ancestors 'none'`;

export const SIDEBAR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SIDEBAR_META_CSP}">
<title>Fractal</title>
<link rel="stylesheet" href="sidebar.css">
</head>
<body><div id="app" class="app"></div><script src="sidebar.js"></script></body>
</html>
`;

/** Only the --vscode-* variables the note views get too (theme.ts), plus the page's own layout. */
export const SIDEBAR_PAGE_CSS = `
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; overflow: hidden; }
body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-sideBar-foreground);
  background: var(--vscode-sideBar-background); -webkit-user-select: none; user-select: none; cursor: default; }
body.resizing, body.resizing * { cursor: ew-resize !important; }
.app { display: flex; height: 100%; width: 100%; }
.sidebar { position: relative; flex: 1 1 auto; min-width: 0; height: 100%; display: flex; flex-direction: column;
  background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-sideBar-border); }
.app.empty-view .sidebar { flex: none; }
.topbar { flex: none; height: 35px; display: flex; align-items: center; gap: 2px; padding: 0 6px 0 16px; }
.topbar .title { flex: 1; min-width: 0; font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
  color: var(--vscode-sideBarTitle-foreground); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon-button { appearance: none; border: 0; background: transparent; color: var(--vscode-icon-foreground); width: 22px; height: 22px;
  padding: 3px; border-radius: 5px; display: inline-flex; align-items: center; justify-content: center; flex: none; cursor: pointer; }
.icon-button:hover { background: var(--vscode-toolbar-hoverBackground); }
.icon-button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
svg.icon { width: 16px; height: 16px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
svg.icon path.fill { fill: currentColor; stroke: none; }
.sections { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.pane { flex: none; display: flex; flex-direction: column; min-height: 0; border-top: 1px solid var(--vscode-sideBarSectionHeader-border); }
.pane.expanded.fit { flex: 0 1 auto; max-height: 45%; }
.pane.expanded.grow { flex: 1 1 auto; }
.pane-header { flex: none; height: 22px; display: flex; align-items: center; padding-right: 6px; font-size: 11px; font-weight: 700;
  text-transform: uppercase; color: var(--vscode-sideBarSectionHeader-foreground); background: var(--vscode-sideBarSectionHeader-background);
  cursor: pointer; outline: none; }
.pane-header:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
.pane-header .twistie { width: 20px; flex: none; display: inline-flex; justify-content: center; color: var(--vscode-icon-foreground); }
.pane-header .twistie svg.icon { width: 14px; height: 14px; }
.pane-header .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 0 auto; max-width: 70%; }
.pane-header .description { margin-left: 8px; font-weight: 400; text-transform: none; opacity: .7; white-space: nowrap; overflow: hidden;
  text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.spacer { flex: 1 1 auto; }
.pane-header .actions { display: flex; gap: 2px; opacity: 0; }
.pane:hover .pane-header .actions, .pane:focus-within .pane-header .actions { opacity: 1; }
.pane-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding-bottom: 4px; }
.row { height: 22px; display: flex; align-items: center; gap: 4px; padding: 0 6px 0 12px; cursor: pointer; outline: none; white-space: nowrap; }
.row:hover { background: var(--vscode-list-hoverBackground); }
.row.shown { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
.row:focus-visible { outline: 1px solid var(--vscode-list-focusOutline); outline-offset: -1px; }
.dot-slot { width: 16px; height: 16px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
.dot { appearance: none; border: 0; padding: 0; width: 16px; height: 16px; border-radius: 4px; background: transparent; color: inherit;
  display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.dot .close-glyph { display: none; }
.dot:hover .dot-glyph, .dot:focus-visible .dot-glyph { display: none; }
.dot:hover .close-glyph, .dot:focus-visible .close-glyph { display: inline; }
.dot:hover { background: var(--vscode-toolbar-hoverBackground); }
.item-icon { width: 16px; height: 16px; flex: none; display: inline-flex; color: var(--vscode-icon-foreground); }
.row.shown .item-icon { color: inherit; }
.row .label { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.row .description { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; opacity: .7; font-size: .92em; margin-left: 2px; }
.inline-actions { display: flex; flex: none; opacity: 0; }
.row:hover .inline-actions, .row:focus-within .inline-actions { opacity: 1; }
.row.shown .icon-button { color: inherit; }
.message { padding: 4px 20px; opacity: .85; white-space: normal; }
.welcome { padding: 4px 20px 8px; color: var(--vscode-foreground); line-height: 1.4; }
.welcome p { margin: 8px 0; white-space: normal; }
.welcome .button { display: block; width: 100%; max-width: 300px; margin: 8px auto; padding: 4px 8px; text-align: center; font: inherit;
  border: 1px solid var(--vscode-button-border); border-radius: 2px; background: var(--vscode-button-background); color: var(--vscode-button-foreground); cursor: pointer; }
.welcome .button:hover { background: var(--vscode-button-hoverBackground); }
.welcome .button:focus-visible { outline: 1px solid var(--vscode-focusBorder); outline-offset: 2px; }
.welcome .link { appearance: none; border: 0; padding: 0; background: none; font: inherit; color: var(--vscode-textLink-foreground); cursor: pointer; }
.sash { position: absolute; top: 0; right: 0; width: 4px; height: 100%; cursor: ew-resize; z-index: 5; }
.sash:hover, .sash.active { background: var(--vscode-sash-hoverBorder); }
.bar { flex: none; width: 28px; height: 100%; display: flex; flex-direction: column; align-items: center; padding-top: 7px;
  background: var(--vscode-sideBar-background); border-right: 1px solid var(--vscode-sideBar-border); }
.empty { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center;
  background: var(--vscode-editor-background); color: var(--vscode-descriptionForeground); }
`;
