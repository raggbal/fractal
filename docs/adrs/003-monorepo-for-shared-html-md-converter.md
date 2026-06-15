# ADR-003: Monorepo for Shared HtmlMdConverter

## Status: Accepted

## Context

Three products exist:
1. **fractal** — VS Code extension (main product)
2. **fractal-chrome-extensions** — Chrome extension (web clip → MD → Note)
3. **fractal-claude-skills** — Claude Code skills (`collect`, `web-crawler-md`, etc.)

All three consume `html-md-converter/`, a sub-package that converts HTML to Markdown with Fractal-specific rules (turndown + GFM + custom).

## Decision

Keep all three products in a single repository (monorepo). The shared `html-md-converter/` sub-package is built once and distributed to each consumer via `scripts/update-*.sh`.

Rationale:

- `html-md-converter` is the critical shared dependency. Keeping it in the same repo ensures all consumers stay in sync with one build artifact and one set of tests.
- Separate repos would require a package registry or git submodule for a single JS file — overhead disproportionate to the benefit.

## Alternatives

- **Separate repos + npm package**: Publishing overhead for a single-file library used by 3 consumers in the same org. Version drift risk.
- **Git submodule**: Adds checkout complexity for a sub-package that changes frequently alongside the main product.

## Consequences

- Product boundaries do not match repository boundaries. Each product has its own directory (`src/` + `electron/` for fractal, `chrome-extension/` for chrome-extensions, `claude_skills/` for claude-skills).
- Changes to `html-md-converter/` must run `scripts/update-*.sh` to propagate the built artifact to all consumers.
- `package.json` at root is for the VS Code extension (fractal); chrome-extension and claude-skills have no npm package of their own.
