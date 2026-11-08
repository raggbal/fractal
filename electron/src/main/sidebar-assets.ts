/**
 * The sidebar page's own HTML / CSS / CSP (sidebar-view.ts serves them from the sidebar session). No
 * Electron import: the sidebar unit spec checks that every --fr-* token the CSS reads is defined in
 * tokens.css (the colors for light and dark), that it reads no --vscode-* variable, and what the CSP allows.
 *
 * The look is the Fractal design (docs/design/modern-2026.md §7.1 / §7.2 / §7.4, the same as the note's
 * own left panel): sidebar.css starts with the extension's tokens.css and fr-base.css (design-tokens.ts),
 * so the CSS below reads only their tokens — never VS Code's (P7). The page's script is the only script
 * it may run.
 */
export const SIDEBAR_META_CSP =
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'none'; font-src 'none'; connect-src 'none'; " +
    "media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; form-action 'none'; base-uri 'none'";
/** The response header adds frame-ancestors (ignored in a meta element). */
export const SIDEBAR_CSP = `${SIDEBAR_META_CSP}; frame-ancestors 'none'`;

/** data-fr-theme: "auto" until the model brings fractal.theme (tokens.css follows the OS meanwhile). */
export const SIDEBAR_PAGE_HTML = `<!DOCTYPE html>
<html lang="en" data-fr-theme="auto">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${SIDEBAR_META_CSP}">
<title>Fractal</title>
<link rel="stylesheet" href="sidebar.css">
</head>
<body><div id="app" class="app"></div><script src="sidebar.js"></script></body>
</html>
`;

/**
 * After tokens.css + fr-base.css (reset, scrollbars, the buttons' focus ring). Surfaces: the sidebar on
 * bg-panel with a 1px divider on its right; the empty view on bg-app. Rows: 26px, the fill 6px in from
 * the panel's edges (transparent borders + background-clip, so the whole width is the row), corners 6px;
 * hover fill-hover, the shown note fill-active + 500, the keyboard focus row selection-bg (no ring —
 * FR-TKN-01/06). Section headers: 28px, 12px / 600 secondary, not uppercased, the name at 17px (the
 * rows' first column), buttons always shown, the chevron at the right end (as Recent in the note's
 * panel). The top row is 36px with its middle at 19px, like the note panel's header row next to it
 * (the collapsed bar's button sits at the same height).
 */
export const SIDEBAR_PAGE_CSS = `
html, body { margin: 0; height: 100%; overflow: hidden; }
body { font-family: var(--fr-font-sans); font-size: var(--fr-text-base); color: var(--fr-color-text-primary);
  background: var(--fr-color-bg-panel); -webkit-user-select: none; user-select: none; cursor: default; }
body.resizing, body.resizing * { cursor: ew-resize !important; }
.app { display: flex; height: 100%; width: 100%; }
.sidebar { position: relative; flex: 1 1 auto; min-width: 0; height: 100%; display: flex; flex-direction: column;
  background: var(--fr-color-bg-panel); border-right: 1px solid var(--fr-color-divider); }
.app.empty-view .sidebar { flex: none; }
.topbar { flex: none; height: 36px; display: flex; align-items: center; gap: 2px; padding: 2px 5px 0 17px; }
.topbar .title { flex: 1; min-width: 0; font-weight: 600; color: var(--fr-color-text-primary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon-button { appearance: none; border: 0; margin: 0; padding: 0; width: 24px; height: 24px; border-radius: var(--fr-radius-sm);
  background: transparent; color: var(--fr-color-text-secondary); display: inline-flex; align-items: center; justify-content: center;
  flex: none; cursor: pointer; transition: background-color var(--fr-duration-fast) ease, color var(--fr-duration-fast) ease; }
.icon-button:hover { background: var(--fr-color-fill-hover); color: var(--fr-color-text-primary); }
.icon-button:active { background: var(--fr-color-fill-active); }
.topbar .icon-button, .bar .icon-button { width: 26px; height: 25px; }
svg.icon { width: 14px; height: 14px; flex: none; fill: none; stroke: currentColor; stroke-width: 1.2; stroke-linecap: round; stroke-linejoin: round; }
svg.icon path.fill { fill: currentColor; stroke: none; }
.sections { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.pane { flex: none; display: flex; flex-direction: column; min-height: 0; }
.pane + .pane { border-top: 1px solid var(--fr-color-divider); }
.pane.expanded.fit { flex: 0 1 auto; max-height: 45%; }
.pane.expanded.grow { flex: 1 1 auto; }
.pane-header { flex: none; height: 28px; display: flex; align-items: center; gap: 2px; padding: 0 5px 0 17px; font-size: var(--fr-text-sm);
  font-weight: 600; color: var(--fr-color-text-secondary); border-radius: var(--fr-radius-sm); cursor: pointer; outline: none; }
.pane-header:focus-visible { box-shadow: inset 0 0 0 2px var(--fr-color-focus-ring); }
.pane-header .twistie { order: 1; width: 24px; height: 24px; flex: none; display: inline-flex; align-items: center; justify-content: center;
  border-radius: var(--fr-radius-sm); color: var(--fr-color-text-tertiary);
  transition: background-color var(--fr-duration-fast) ease, color var(--fr-duration-fast) ease; }
.pane-header:hover .twistie { background: var(--fr-color-fill-hover); color: var(--fr-color-text-primary); }
.pane-header .twistie svg.icon { width: 12px; height: 12px; stroke-width: 1.4; }
.pane-header .name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 2em; }
.pane-header .description { margin-left: 4px; font-size: var(--fr-text-xs); font-weight: 400; color: var(--fr-color-text-tertiary);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.spacer { flex: 1 1 auto; }
.pane-header .actions { display: flex; flex: none; }
.pane-body { flex: 1 1 auto; min-height: 0; overflow-y: auto; overflow-x: hidden; padding: 0 0 8px; }
.row { min-height: 26px; display: flex; align-items: center; gap: 6px; margin: 1px 0; padding: 0 2px 0 11px;
  border-left: 6px solid transparent; border-right: 6px solid transparent; background-clip: padding-box;
  border-radius: calc(var(--fr-radius-sm) + 6px) / var(--fr-radius-sm); color: var(--fr-color-text-primary);
  cursor: pointer; outline: none; white-space: nowrap; transition: background-color var(--fr-duration-fast) ease; }
.row:hover { background-color: var(--fr-color-fill-hover); }
.row.shown { background-color: var(--fr-color-fill-active); font-weight: 500; }
.row:focus-visible { background-color: var(--fr-color-selection-bg); }
.dot-slot { width: 14px; height: 14px; flex: none; display: inline-flex; align-items: center; justify-content: center; }
.dot { appearance: none; border: 0; margin: -2px; padding: 0; width: 18px; height: 18px; border-radius: var(--fr-radius-xs); background: transparent;
  color: var(--fr-color-primary-strong); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; }
.dot .close-glyph { display: none; }
.dot:hover .dot-glyph, .dot:focus-visible .dot-glyph { display: none; }
.dot:hover .close-glyph, .dot:focus-visible .close-glyph { display: inline; }
.dot:hover, .dot:focus-visible { background: var(--fr-color-fill-hover); color: var(--fr-color-text-primary); }
.item-icon { width: 14px; height: 14px; flex: none; display: inline-flex; color: var(--fr-color-text-secondary); }
.row .label { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; }
.row .description { overflow: hidden; text-overflow: ellipsis; flex: 0 1 auto; min-width: 0; margin-left: 2px; font-size: var(--fr-text-sm);
  font-weight: 400; color: var(--fr-color-text-tertiary); }
.row.shown .description, .row:focus-visible .description { color: var(--fr-color-text-secondary); }
.inline-actions { display: flex; flex: none; opacity: 0; }
.row:hover .inline-actions, .row:focus-within .inline-actions { opacity: 1; }
.inline-actions .icon-button { width: 22px; height: 22px; }
.message { padding: 4px 17px; font-size: var(--fr-text-sm); color: var(--fr-color-text-tertiary); white-space: normal; }
.welcome { padding: 2px 17px 8px; line-height: 1.5; color: var(--fr-color-text-secondary); }
.welcome p { margin: 6px 0; white-space: normal; }
.welcome .button { display: block; width: 100%; max-width: 300px; height: 28px; margin: 8px auto 0; padding: 0 12px; font: inherit;
  font-weight: 500; line-height: 26px; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer;
  border: 1px solid var(--fr-color-border-strong); border-radius: var(--fr-radius-sm); background: var(--fr-color-bg-elevated);
  color: var(--fr-color-text-primary); }
.welcome .button:hover { background-image: linear-gradient(var(--fr-color-fill-hover), var(--fr-color-fill-hover)); }
.welcome .button:active { background-image: linear-gradient(var(--fr-color-fill-active), var(--fr-color-fill-active)); }
.welcome > .button:first-of-type { border-color: transparent; background: var(--fr-color-primary); color: var(--fr-color-primary-fg); }
.welcome > .button:first-of-type:hover { background: var(--fr-color-primary-hover); }
.welcome > .button:first-of-type:active { background: var(--fr-color-primary-active); }
.welcome .link { appearance: none; border: 0; padding: 0; background: none; font: inherit; color: var(--fr-color-primary-strong); cursor: pointer; }
.welcome .link:hover { text-decoration: underline; }
.sash { position: absolute; top: 0; right: -1px; width: 5px; height: 100%; cursor: ew-resize; z-index: 5; }
.sash:hover, .sash.active { box-shadow: inset -2px 0 0 var(--fr-color-primary); }
.bar { flex: none; width: 28px; height: 100%; display: flex; flex-direction: column; align-items: center; padding-top: 6.5px;
  background: var(--fr-color-bg-panel); border-right: 1px solid var(--fr-color-divider); }
.empty { flex: 1 1 auto; min-width: 0; height: 100%; display: flex; align-items: center; justify-content: center; padding: 24px; text-align: center;
  background: var(--fr-color-bg-app); color: var(--fr-color-text-tertiary); }
`;
