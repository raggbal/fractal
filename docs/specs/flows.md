# Flows / Control Flow

Fractal is event-driven: there is no pipeline DAG, only user-action → event → handler response flows.

## Branching rules

The branching/dispatching rules live in [docs/specs/architecture.md](architecture.md#classification-axes). Major axes:

- File extension → Provider routing
- Drop classification → md / image / file / drawio handler
- Mode (Single / Note / SidePanel) → directory-resolution policy

## Sequence diagrams

### Flow 1 — Markdown Editor edit → save

```mermaid
sequenceDiagram
    participant U as User
    participant WV as editor.js (Webview)
    participant EH as editorProvider (Extension Host)
    participant FS as File System

    U->>WV: type into contenteditable
    WV->>WV: htmlToMarkdown() (DOM → MD serialize)
    WV->>WV: debouncedSync (1000 ms + requestIdleCallback)
    WV->>EH: postMessage({type: "edit", content})
    EH->>EH: edit queue (debounce 100 ms)
    EH->>FS: TextDocument.applyEdit (WorkspaceEdit)
    FS-->>EH: onDidChangeTextDocument
```

### Flow 2 — External Change Sync (AI tool rewrites file)

```mermaid
sequenceDiagram
    participant AI as External Process (Claude/Cursor)
    participant FS as File System
    participant EH as editorProvider (Extension Host)
    participant WV as editor.js (Webview)

    AI->>FS: write .md file
    FS-->>EH: onDidChangeTextDocument (fs watch)
    EH->>EH: filter out our own edits
    EH->>WV: postMessage({type: "externalChange", markdown})
    WV->>WV: block-level DOM diff
    WV->>WV: keep cursor position; update only changed blocks
```

### Flow 3 — Outliner D&D file import

```mermaid
sequenceDiagram
    participant U as User
    participant WV as outliner.js (Webview)
    participant EH as outlinerProvider (Extension Host)
    participant FS as File System

    U->>WV: drop files
    WV->>WV: classifyDroppedFile (md/image/file)
    WV->>WV: FileReader (50 MB guard)
    WV->>EH: postMessage({type: "dropFilesImport", items})
    EH->>EH: processDropFilesImport (classify by kind)
    alt kind = md
        EH->>FS: importMdFilesCore (extract H1, copy images)
        EH->>WV: postMessage({type: "importMdFilesResult", nodes})
    else kind = image
        EH->>FS: saveImageFromDataUrl
        EH->>WV: postMessage({type: "updateNodeImages"})
    else kind = file
        EH->>FS: importFilesCore (copy with collision suffix)
        EH->>WV: postMessage({type: "importFilesResult", nodes})
    end
    WV->>WV: model.addNodes (insert into tree)
    WV->>EH: postMessage({type: "syncData", content}) → save
```

## Retry strategy

N/A — local operations have no retry. S3 Sync delegates retries to the AWS CLI's internal logic. Translate fails the request immediately when a 10 KB chunk fails.

## State schema

There is no `GraphState` / `RunState`; each component carries its own state — see [docs/specs/state.md](state.md).

## Run lifecycle

```mermaid
stateDiagram-v2
    [*] --> Idle: Extension activated
    Idle --> Editing: User input
    Editing --> Syncing: debounce elapsed (1000 ms)
    Syncing --> Idle: TextDocument saved
    Editing --> Idle: idle timeout (1500 ms, no further input)

    state "S3 Sync" as S3 {
        [*] --> InProgress: Sync button pressed
        InProgress --> Done: AWS CLI completes
        InProgress --> Error: AWS CLI fails
    }
```

## Idempotency keys

N/A — there are no external writes that need idempotency. S3 Sync is idempotent via mtime comparison. File imports avoid duplicates via collision-suffix naming.
