# ADR-007: ODK Git Hooks Neutralized in Fractal

## Status: Accepted

Scope: fractal (`.odk/hooks/pre-commit`, `.odk/hooks/commit-msg`, `.odk/hooks/pre-push`)

## Context

`odk init` installs three Git hooks via `core.hooksPath = .odk/hooks`:

1. **pre-commit** — runs verification plugins from `.odk/config.yaml#verification.enabled`. The bundled plugins (`lint-ruff`, `python-quality`, `python-tdd-guard`, `types-ty`) target Python projects.
2. **commit-msg** — enforces Conventional Commits format.
3. **pre-push** — runs the pre-push verification trigger.

Fractal is a TypeScript + JavaScript VS Code extension; it has no Python source. Running the bundled Python plugins yields:

- `python-quality` shells out to `ruff` + `ty` against the repo, the subprocess fails (no Python files to lint), stdout is empty, and the wrapper raises a JSON parse error that aborts the commit with an opaque traceback.
- The Conventional Commits checker rejects the existing Fractal commit history style (which uses freeform descriptive messages) on every commit.
- `pre-push` runs `odk verify run --trigger pre-push`, which fires plugins like `pr-body-validation` (requires `## Summary`/`## Test Plan` sections, console blocks, screenshots), `python-tdd-guard`, and various Next.js / Terraform / FastAPI checks. None of these are relevant to a TypeScript+JavaScript VS Code extension and `pr-body-validation` blocks every push because Fractal does not enforce a PR body template.

The user explicitly opted out of Conventional Commits enforcement after the second hook failure, and opted out of `pre-push` validation after the first push was blocked by `pr-body-validation`.

## Decision

Replace `.odk/hooks/pre-commit`, `.odk/hooks/commit-msg`, and `.odk/hooks/pre-push` with `exit 0` stubs that include a one-line comment explaining why. The hook files remain in place (so `odk init` does not silently re-enable them on the next run) but become no-ops.

## Alternatives

- **Set `verification.enabled: []` in `.odk/config.yaml`.** Rejected: the wrapper interprets `enabled or None` such that an empty list is normalized back to "run all", so this does not actually disable plugins.
- **Set `core.hooksPath` back to `.git/hooks`.** Rejected: this removes the integration entirely. The intent is to keep ODK installed (CLI, components, narratives) and only suppress the misbehaving hooks until project-appropriate plugins are configured.
- **Write Fractal-specific plugins** (TypeScript lint / typecheck) and enable them. Deferred: this is the right long-term direction, but the immediate need is unblocking commits.

## Consequences

- Commits succeed regardless of message format. Developers must self-police commit hygiene.
- No automated lint / typecheck runs at commit time, and no PR body / push-time gating runs at push time. CI (or `npm run check` / `tsc --noEmit` invoked by hand) is the line of defense.
- A future re-enable should write Fractal-specific verification plugins (e.g. `eslint`, `tsc --noEmit`) and register them under `.odk/config.yaml#verification.enabled`, then restore the hooks to delegate to `odk verify run`.
