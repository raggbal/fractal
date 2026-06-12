# Fractal Claude Skills — Domain Language

## Language

### Skill
A Claude Code extension (installed via `install.sh`) that provides a slash command (`/skill-name`) with a `SKILL.md` definition and optional `scripts/` directory. Each skill is self-contained in `claude_skills/<name>/`.

### collect
The top-level routing skill. Classifies input (URL pattern or file extension) and delegates to the appropriate sub-skill. Sole owner of `FRACTAL_DEFAULT_OUT` env resolution — sub-skills never read env directly. Ensures Fractal registration target is resolved *before* any conversion begins (PRE-FLIGHT CHECK).

_Avoid_: "crawler" (only one of its sub-skills), "downloader" (too generic).

### Sub-skill
A skill invoked by `collect` (or directly by the user) that performs a single conversion type:
- **web-crawler-md** — Web pages (BFS crawl or llms.txt mode)
- **youtube-md** — YouTube transcript extraction
- **arxiv-md** — arXiv paper download + metadata front matter
- **doc-md** — PDF/Word/Excel/image → MD via Docling
- **pptx-pages-md** — PowerPoint → per-slide PNG + text MD

### fractal-edit
The write-path skill for Fractal data. Two scripts:
- `fractal-md.mjs` — Node/Page creation, bulk MD import, new `.out` creation + `outline.note` registration.
- `fractal-attach.mjs` — Image node / file attachment node creation, append to existing node.

All sub-skills delegate Fractal registration to their own `register-fractal.mjs`, which shells out to `fractal-edit`'s `fractal-md.mjs`.

### fractal-search
Read-path skill. Auto-detects registered Notes folders (from VSCode/Cursor/Kiro/Electron globalState/config), then searches across Outline nodes, Page MD, and loose MD files. Also provides `--list-folders`, `--list-notes`, `--find-outline`.

### fractal-structure
Reference-only skill (no scripts). Documents Fractal's data model (`.out` / `outline.note` / Node types / path resolution rules). Must be consulted before `fractal-edit` or `fractal-search` to avoid path errors.

### aws-doc-maker
Post-collection skill. Takes already-downloaded AWS documentation (`.collected/web/<service>/`) and reorganizes it into 12-axis structured MD files. Optionally registers the result into a Fractal Outliner as a tree.

### .collected/
The output directory convention for all collection skills. Subdirectories by source type: `web/`, `youtube/`, `arxiv/`, `docs/`, `pptx/`. Files here are automatically discoverable by Glob/Grep for downstream analysis.

### llms.txt Mode
A fast-path in `web-crawler-md`. If a site publishes an `/llms.txt` index (curated Markdown page list), the crawler skips BFS and fetches pages directly from the index. Dramatically faster and cleaner than BFS crawl. Auto-probed by `crawl.py` at startup; can be forced off with `--no-llms-txt`.

### BFS Crawl
The default mode of `web-crawler-md` when no llms.txt is found. Uses Playwright to render pages (JavaScript-capable), extracts content via Readability + HtmlMdConverter, and follows links breadth-first within scope.

### register-fractal.mjs
A per-sub-skill script that registers collected output into a Fractal Outliner. Creates a `date > title > content` tree structure. Does NOT read `FRACTAL_DEFAULT_OUT` env — relies on explicit `--fractal-out` or `--fractal-notes + --fractal-outline` flags forwarded by `collect`.

### FRACTAL_DEFAULT_OUT
Environment variable specifying default `.out` path(s) for Fractal registration. Comma-separated for multiple. Only `collect` reads and resolves this env (via `list-default-outs.mjs`); sub-skills receive the resolved path as an explicit CLI flag.

### Fractal Registration Tree
The node structure created when a collected item is registered in an Outliner:
```
<outline-root>
└── YYYY-MM-DD          ← reuses existing date node if present
    └── <title>         ← always new
        └── page(s)     ← single MD or sitemap tree
```

### Skill Installation
`install.sh` places skills into each AI IDE's user-level skill directory:
- **Symlink** (Claude Code, Cursor, Antigravity): `~/.{ide}/skills/<name>` → `claude_skills/<name>/`. Source-linked, updates reflect immediately.
- **Copy** (Kiro): Full directory copy (Kiro cannot follow symlinks for skill discovery).

Supports `--dry-run`, `--uninstall`, `--force`, `--only <ide>`.

### Supported IDEs
Claude Code (`~/.claude/`), Cursor (`~/.cursor/`), Kiro (`~/.kiro/`), Antigravity (`~/.antigravity/`). Skills are cross-IDE compatible — same SKILL.md format works in all.

## Flagged ambiguities

(none)
