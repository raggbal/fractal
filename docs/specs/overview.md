# Fractal — Overview

> Status: GA (v0.207.59)
> Owner: Imaizumi, Kensuke
> Primary language: TypeScript (Extension Host) + JavaScript (Webview)

## Product Summary

Fractal is a VS Code extension. It is a Dynalist-like outliner combined with a Typora-like WYSIWYG Markdown editor, integrated as a single note tool. The product is published on the VS Code Marketplace and Open VSIX.

## Goals

1. **Integrate outliner and WYSIWYG Markdown editor** — A single tool that supports structured thinking (tree) and long-form writing (page) seamlessly.
2. **Cooperate with external AI tools** — External Change Sync plus `Cmd+L` bridge to the IDE's native AI features.
3. **Local-file-based with optional cloud backup** — Data lives in local files (`.out`, `.md`, `outline.note`); S3 Sync is opt-in.

## Non-goals

1. **Real-time collaborative editing** — External Change Sync detects external changes only; it is not multi-cursor collaboration.
2. **Direct integration with proprietary AI services** — AI cooperation is via bridges to the IDE-native AI (`Cmd+L`).
3. **Server-side components** — No backend; all processing is local.

## Hard MUST conditions

1. **No data loss** — User local files (`.out` / `.md` / `outline.note`) must never be destroyed or lost. S3 Sync runs without `--delete` (files only on one side are preserved). See [odk:req:safety/no-data-loss].
2. **Mode coverage** — Any feature addition or fix must function correctly across all four modes: Outliner Single, Outliner Note, Markdown Single, Markdown Side Panel. Missing modes are not acceptable. See [odk:req:safety/mode-coverage].

## Acceptance Bar (release gate for the GA product)

1. E2E tests (Playwright) all pass.
2. Manual confirmation across the four modes (Outliner Single / Outliner Note / Markdown Single / Markdown Side Panel).
3. Successful publish to VS Code Marketplace and Open VSIX.

## User Stories

1. As a user, I want to organize ideas in a tree (outliner) and expand any item that needs depth into a Page (Markdown). I also want to attach images, files, and Markdown to nodes for unified management.
2. As a user, I want to write Markdown in WYSIWYG with inline preview for every element (headings, lists, tables, code blocks, math, Mermaid, drawio, etc.).
3. As a user, I want my IDE's AI feature (Cursor / Copilot) to edit the Markdown file with results reflected in the editor in real time (External Change Sync).
4. As a user, I want to back up and synchronize a Note folder across multiple devices via S3.
5. As a user, I want to translate Markdown into other languages (AWS Translate).
6. As a user, I want to export an Outliner subtree as `llms.txt` to hand context to AI tools.

## Non-functional Requirements (summary)

| Category | Target | Source |
|---|---|---|
| Performance | UI never blocks during input | [odk:nfr:performance/no-ui-block] |
| Reliability | Zero data loss | [odk:nfr:reliability/no-data-loss] |
| File size | 50 MB per dropped file (webview drop guard) | [odk:nfr:capacity/drop-file-size] |
| Undo capacity | 200 snapshots (Outliner / Editor each) | [odk:nfr:capacity/undo-stack] |
| S3 Sync scale | ~10,000 files; 500 files per batch | [odk:nfr:capacity/s3-sync-scale] |
| Tests | Playwright E2E all green | [odk:nfr:reliability/e2e-green] |
| Mode coverage | 4 modes guaranteed | [odk:nfr:reliability/mode-coverage] |

## Success Criteria

1. E2E tests stay green.
2. Zero S3 Sync data loss.
3. No regressions across the four modes (Outliner Single / Note, Markdown Single / Side Panel).

## Acceptance Conditions

1. E2E tests all pass.
2. Manual confirmation across the four modes passes.
3. `vsce publish` and Open VSIX `ovsx publish` succeed.
4. No known bugs that violate the Hard MUST conditions.

## System Overview

### Core value

Combines outliner-style structured thinking with WYSIWYG Markdown long-form writing in a single VS Code extension. Local-file-based, with seamless cooperation with AI tooling.

### Position in the larger system

**Upstream (data input sources):**
- User direct input (WYSIWYG / Outliner)
- Clipboard paste (HTML → Markdown via [odk:component:webview/html-md-converter])
- Drag and drop: Finder / OS files (`.md` / image / arbitrary file, 50 MB cap)
- Drag and drop: VS Code Explorer (via `file://` URI, no size cap)
- Drag and drop: Web image URLs (`http(s)` images inserted directly)
- File-import dialog: Markdown import (also resolves and copies relative images)
- File-import dialog: arbitrary attachments
- External processes writing to files (AI tools, drawio Desktop, etc.) — detected via fs watch
- The Chrome Extension (Web Clipper) writes directly to `.out`
- S3 Sync (restoring from / syncing with the remote)

**Downstream (consumers):**
- IDE AI (`Cmd+L` hands the `.md` to the IDE AI)
- S3 (backup)
- claude-skills (`fractal-search` / `fractal-edit` reading and writing)
- llms.txt export (clipboard handoff to AI tools)

**Ownership:** All data is on the user's local file system. Fractal is an editor; it does not own the data.

### Outputs

| Output | Trigger |
|---|---|
| `.out` file (JSON) | Outliner edit → debounce 1000 ms → disk write |
| `.md` file | Markdown Editor edit → debounce → disk write |
| `outline.note` (JSON) | Note structure change → debounce 1000 ms → disk write |
| Image files (including `.drawio.svg` / `.drawio.png`) | Drag and drop / paste / import / drawio Desktop external save |
| Attachment files | File-import / drag and drop into the file folder |
| S3 upload | S3 Sync button → AWS CLI spawn |
| Clipboard (llms.txt) | Right-click → llms.txt Export |
| VS Code text-editor open | `Cmd+L` → opens `.md` in the native editor with the line selection |

### System type tags

- **domain-heavy**: yes (Node / Page / Outliner / Note domain models, exclusive node-type rules, etc.)
- ai/ml: N/A (no direct AI communication; only bridges to the IDE-native AI)
- iot / physical-ai / saas / data-lake / microservices: N/A
- web-app: N/A (VS Code extension, no HTTP endpoints)
- lambda-like / containerized: N/A

### Language and framework summary

| Component | Language | Framework | Key libraries | Reason |
|---|---|---|---|---|
| Extension Host | TypeScript | VS Code Extension API | — | Standard for VS Code extensions |
| Webview (Editor / Outliner) | JavaScript (plain) | contenteditable DOM | marked, KaTeX, Mermaid | Historical reasons (no design intent) |
| HtmlMdConverter | JavaScript | — | turndown, turndown-plugin-gfm | HTML→MD conversion |
| E2E Test | TypeScript | Playwright | @playwright/test | VS Code webview testing |
| S3 Sync / Translate | — | AWS CLI spawn | — | Reuses the user's CLI auth |

### Testing strategy

| Component | Test framework | Test path | Naming | CI command |
|---|---|---|---|---|
| Editor / Outliner / Notes (E2E) | Playwright | `test/specs/` | `<feature>.spec.ts` | `npm run test:parallel` |

- Spec count: ~178 files
- Build: `test/build-standalone.js` builds the webview as standalone HTML, then runs Playwright
- Parallel execution: `test/run-parallel-tests.sh`
- Coverage target: not configured (E2E covers feature surface)
- Mock boundary: none (E2E drives the real webview)
- Unit tests: not yet introduced (desired)
- Test layout: centralized (`test/specs/`)

## Performance prose

Quantified targets are tracked in [odk:nfr:performance/no-ui-block], [odk:nfr:capacity/drop-file-size], [odk:nfr:capacity/undo-stack], [odk:nfr:capacity/s3-sync-scale], [odk:nfr:capacity/translate-chunk], and [odk:nfr:capacity/nav-history].

The design goal is "do not block the UI while the user is typing": editor sync is debounced via `requestIdleCallback` and the typing debounce window. Idle detection ends a typing session after a quiet period.

### Scalability bottlenecks

1. **editor.js DOM** — A single ~18,400-line JS file. With extremely large Markdown files (tens of thousands of lines), DOM node count may approach browser limits.
2. **outliner.js tree rendering** — Every node is rendered into the DOM (~8,500-line `outliner.js`), so very large `.out` files (tens of thousands of nodes) increase render cost.
3. **S3 Sync** — Beyond ~10,000 files the CLI spawn count begins to dominate.
