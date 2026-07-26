# Out of Scope / Future Work

## Functional scope expansion

- Introduce unit tests (currently E2E only; the glossary notes "desired but not yet introduced").
- Revive the Electron build (currently inactive).
- Support `vscode.dev` (web build of VS Code).

## Architecture expansion

- Convert webview code to TypeScript (currently plain JS for historical reasons; technical debt).
- Split `editor.js` into smaller files (currently a single ~17,000-line file).
- Virtual scroll / lazy rendering for very large `.out` files.

## Observability hardening

- Telemetry infrastructure (visibility into usage).
- Automated CI for E2E (e.g., GitHub Actions).

## Open Questions

(none — there are currently no `DECISION-PENDING` markers in the design.)
