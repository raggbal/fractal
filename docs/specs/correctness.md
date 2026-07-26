# Correctness Properties

## Output-shape invariants

- `.out` `nodes` is always written as an object map. Legacy array form is converted on load and is never emitted by writes.
- A Node's `isPage` / `filePath` / `images` are mutually exclusive. See [odk:req:correctness/exclusive-node-types].

## Safety invariants

- **No data loss** ([odk:req:safety/no-data-loss]). S3 Sync runs without `--delete`. File deletion is only triggered by explicit user action.
- **No path traversal** ([odk:req:security/path-traversal-guard]). `safeResolveUnderDir` must wrap every path concatenation that includes external input.

## Schema-contract invariants

- `outline.note` writes are preceded by `syncStructureWithDisk` (verifies the on-disk files match the structure).
- `.out` saves go through the VS Code TextDocument API (integrates with the editor's dirty / undo system).

## Boundary invariants

- The webview cannot access files outside `localResourceRoots` (enforced by VS Code CSP).
- `aws` CLI subprocesses inherit only the user's OS-level permissions.
