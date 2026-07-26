# State Management

## In-memory state

| Component | State | Lifecycle |
|---|---|---|
| [odk:component:webview/editor] | `markdown` string, `undoStack` / `redoStack` (MAX_STACK=200), `isEditing` flag, `editingIdleTimer` | Webview lifetime |
| [odk:component:webview/outliner] | OutlinerModel (tree), `undoStack` / `redoStack` (MAX_UNDO=200), `currentScope`, `navHistory` (MAX=50), `dragState` | Webview lifetime |
| [odk:component:host/any-markdown-editor-provider] | `activeWebviewPanel`, `editQueue`, sidePanelManager state | Until provider dispose |
| [odk:component:host/outliner-provider] | `activeWebviewPanel`, `outlinerPagePaths` (static Map), S3 sync coordinator | Until provider dispose |
| [odk:component:host/notes-editor-provider] | `openPanels` Map, `syncInProgressIds` Set | Extension lifetime |
| [odk:component:host/notes-folder-provider] | `notesFolders` (persisted via `globalState`) | Extension lifetime |

## Artefact / evidence store

| Path | Layout | Writer |
|---|---|---|
| `<basename>.out` | Single JSON file | outlinerProvider / notesEditorProvider |
| `<basename>/<pageId>.md` | Page Markdown | editorProvider / SidePanelManager |
| `<basename>/images/` | Image files | drop-import / paste handler |
| `<basename>/files/` | Attachment files | file-import / drop handler |
| `outline.note` | Note structure JSON | NotesFileManager |
| S3 bucket (optional) | Local mirror | s3-per-file-sync |

## Source of truth

The local file system is the single source of truth. S3 is a backup copy synchronized via mtime newer-wins.

## Write owner per layer

| Store | Single writer |
|---|---|
| `.out` JSON | outlinerProvider OR notesEditorProvider (cannot be open simultaneously — TextDocument is exclusive) |
| Page `.md` | editorProvider OR SidePanelManager (only one editor at a time) |
| `outline.note` | NotesFileManager (debounce 1000 ms, single instance) |
| images / files | drop-import / paste handler (creation only; no overwrite) |

## Backup / restore policy

- S3 Sync is opt-in and manually triggered. There is no automatic backup schedule.
- Restore is the reverse of S3 Sync (S3 → local, mtime newer-wins).

## Encryption at rest

N/A — local files; encryption is delegated to the user's OS / disk encryption. S3-side encryption is bucket-configuration dependent.
