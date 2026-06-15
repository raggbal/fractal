# NotesFileManager

Component: [odk:component:host/notes-file-manager]

## Responsibilities

- CRUD on `outline.note` ([odk:entity:notes/OutlineNote]) — read, write, structural changes.
- Sync the on-disk `.out` files with the structure (`syncStructureWithDisk`).
- Create / delete / move files and folders.
- Full-text search (Outliner node text + page Markdown).
- Resolve directories (`pageDir` / `fileDir` / `imageDir`).
- Auto-generate Daily Notes.

## Tech stack

TypeScript, `fs` / `path`.
