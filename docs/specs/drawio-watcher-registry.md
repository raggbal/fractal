# DrawioWatcherRegistry

Component: [odk:component:host/drawio-watcher-registry]

## Responsibilities

- Watch `.drawio.svg` / `.drawio.png` files for external changes.
- Maintain a bidirectional map: `drawioPath → Set<mdPath>` and `mdPath → Set<drawioPath>`. `setReferences(mdPath, drawioPaths[])` diffs against the previous reference set and calls `_addReference` / `_removeReference` per delta.
- Reference counting plus automatic disposal: a watcher is created the first time any md references a drawio path, and disposed when the last md drops it.
- Debounced (default 200 ms) change notifications via `onChange(drawioPath, mdPaths)`.

## Tech stack

TypeScript. Each watcher is built by the `createDrawioFileWatcher(path, vscode, fs)` factory which combines `vscode.workspace.createFileSystemWatcher` (with `RelativePattern`) and `fs.watchFile` (polling); both `onDidChange` and `onDidCreate` are subscribed because drawio Desktop's atomic-rename saves are missed by the VS Code watcher alone.

## Dependencies

- [odk:ext:drawio/desktop] (optional, watched as an external editor).
