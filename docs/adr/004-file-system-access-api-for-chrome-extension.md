---
status: accepted
scope: fractal-chrome-extensions
date: 2026-06-02
---

# ADR-004: File System Access API for Chrome Extension

## Context

The Chrome Extension needs to read/write local `.out` files and page `.md` files in the user's Notes folder. Three approaches were considered:

1. **File System Access API** (`showDirectoryPicker` / `FileSystemDirectoryHandle`)
2. **Native Messaging Host** (a Node.js process installed locally that the extension communicates with via stdin/stdout)
3. **HTTP/WebSocket server** (the VS Code extension or a daemon exposes an endpoint)

## Decision

Use the File System Access API exclusively.

## Rationale

- **Zero additional installation** — no native host binary, no server process, no VS Code dependency at runtime.
- **Browser-only operation** — clip works even when VS Code is closed.
- **Handle persistence** — `FileSystemDirectoryHandle` can be stored directly in IndexedDB; permissions survive browser restarts (until Chrome revokes them).
- **Direct file I/O** — reads `.out` JSON, writes `.md` pages, creates directories, all via standard Web API without an intermediary.

## Consequences

- **Chromium-only** — File System Access API is not supported in Firefox or Safari. The extension only works in Chrome, Edge, and Opera.
- **Permission UX** — Users must grant folder access once via a picker dialog. Permissions can expire (e.g., after Chrome updates), requiring re-authorization from the Options page.
- **No real-time sync with VS Code** — after clipping, the user must reload the `.out` file in VS Code to see the new node. There is no push notification to the extension.

## Rejected Alternatives

- **Native Messaging Host**: Requires users to install a separate binary and configure a manifest JSON. Adds maintenance burden (cross-platform builds). Overkill for simple file read/write.
- **HTTP/WebSocket server in VS Code extension**: Requires VS Code to be running during clip. Introduces networking complexity (port conflicts, auth). Defeats the goal of browser-only operation.
