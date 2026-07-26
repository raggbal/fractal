# NotesFileManager

Component: [odk:component:host/notes-file-manager]

## Responsibilities

- CRUD on `outline.note` ([odk:entity:notes/OutlineNote]) — read, write, structural changes.
- Sync the on-disk `.out` and `.md` files with the structure (`syncStructureWithDisk`).
- Create / delete / move files and folders (both Outliner and Markdown — see ADR-008).
- Full-text search (Outliner node text + page Markdown + standalone `.md` body).
- Resolve directories (`pageDir` / `fileDir` / `imageDir`) — Outliner items only; Markdown items have no per-file directory.
- Auto-generate Daily Notes.

## File-extension dispatch

Each [odk:entity:notes/NoteTreeFile] carries an optional `ext: "out" | "md"` discriminant (default `"out"`). All disk-touching operations branch on `ext`:

| Operation | `ext === "out"` | `ext === "md"` |
|---|---|---|
| Create | Write `<id>.out` (empty `OutFile`), create `<id>/` page dir | Write `<id>.md` (empty body), no page dir |
| Read content | Parse `.out` JSON | Read `.md` raw text |
| Rename title | Update `outline.note` `items[id].title` | Same — title is metadata only; H1 inside the `.md` is not auto-rewritten |
| Delete | Remove `.out`, recursively remove `<id>/` page dir | Remove `.md` only |
| Move (D&D) | Reorder `rootIds` / `childIds` | Same — disk file does not move (flat layout preserved) |
| Search | Existing Outliner + page-MD scan | Plain-text scan of the `.md` body |

## Tech stack

TypeScript, `fs` / `path`.
