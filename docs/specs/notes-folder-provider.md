# NotesFolderProvider

Component: [odk:component:host/notes-folder-provider]

## Responsibilities

- Implement VS Code `TreeDataProvider` for the "Notes Folders" Activity Bar view.
- Persist the registered folder list in `globalState`.
- Provide `TreeItem`s for folder rows (rename, remove, open).

## Tech stack

TypeScript, VS Code `TreeDataProvider` API.
