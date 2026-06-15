# ADR-005: collect Owns FRACTAL_DEFAULT_OUT Env Resolution

## Status: Accepted

Scope: fractal-claude-skills

## Context

When a user runs `/collect <URL>`, the collected material may be registered into a Fractal Outliner. The registration target can come from:
1. Explicit CLI flags (`--to-fractal-out`, `--to-fractal-notes + --to-fractal-outline`)
2. The `FRACTAL_DEFAULT_OUT` environment variable (comma-separated, may contain multiple paths)

Sub-skills (`web-crawler-md`, `youtube-md`, `arxiv-md`, `doc-md`, `pptx-pages-md`) each have their own `register-fractal.mjs` that performs the actual `.out` write.

The question: who resolves the env variable — `collect` (centralized) or each sub-skill (distributed)?

## Decision

Only `collect` reads and resolves `FRACTAL_DEFAULT_OUT`. Sub-skills never read env directly. `collect` resolves the env (prompting the user to choose when multiple paths exist), then forwards the result as explicit `--fractal-out <path>` to each sub-skill's invocation.

Rationale:

1. **Single point of user interaction** — When env contains multiple paths, the user must be asked to choose. If each sub-skill resolved env independently, a multi-input `/collect` (e.g., 3 URLs in parallel) would prompt the user 3 times for the same choice.
2. **Ordering guarantee** — The registration target must be known *before* conversion starts (multiple writes to the same `.out` must be serialized). Centralized resolution in `collect` enforces this ordering naturally.
3. **Simpler sub-skills** — Sub-skills are pure converters + writers. They don't need IDB/env/prompt logic. Their `register-fractal.mjs` is a stateless function: "given this path, write these nodes."
4. **Failure prevention** — Multiple past incidents where sub-skills silently skipped Fractal registration because env wasn't forwarded. The PRE-FLIGHT CHECK pattern (resolve before any Skill invocation) was introduced to eliminate this class of bug.

## Alternatives

- **Each sub-skill reads env independently**: Causes duplicate user prompts on parallel execution, race conditions on same `.out` writes, and silent registration failures when env resolution is forgotten in a new sub-skill.
- **Shared library that all sub-skills import for env resolution**: Still doesn't solve the ordering problem (must resolve before conversion, not during). Adds a coupling layer between otherwise-independent scripts.

## Consequences

- `collect` must always run its PRE-FLIGHT CHECK before delegating, even for cache-hit (already-converted) cases.
- Sub-skills invoked directly by users (not via `collect`) require explicit `--to-fractal-out` if registration is desired — env is ignored.
- Adding a new sub-skill requires implementing `register-fractal.mjs` that accepts `--fractal-out` (not env).
