# DrawioWatcherRegistry

Component: [odk:component:host/drawio-watcher-registry]

## Responsibilities

- Watch `.drawio.svg` / `.drawio.png` files for external changes.
- Maintain a bidirectional map (drawio path ↔ MD path).
- Reference counting plus automatic disposal.
- Debounced (200 ms) change notifications.

## Tech stack

TypeScript, `fs.watchFile` and `vscode.FileSystemWatcher`.

## Dependencies

- [odk:ext:drawio/desktop] (optional, watched as an external editor).
