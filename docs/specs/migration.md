# Migration / Backward Compatibility

## Existing migrations

| Target | Old form | New form | Migration |
|---|---|---|---|
| `.out` `nodes` | Array | Object map | Auto-converted on load (`outliner-model.js:67-72`) |
| Note manifest filename | `.note` | `outline.note` | Auto-renamed on load (`notes-file-manager.ts:162-172`) |
| Directory layout | `./pages`, `./images`, `./files` (flat) | `./<basename>/`, `./<basename>/images`, `./<basename>/files` (self-contained) | Legacy fallback: if the old paths exist, those are used |

## Backward-compatibility contract

- A new Fractal must read old-format files (load-time conversion).
- Writes always produce the latest format (older Fractal versions may not be able to read them).
- Adding optional fields is backward-compatible (`undefined` is accepted).
