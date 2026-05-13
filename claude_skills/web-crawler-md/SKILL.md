---
name: web-crawler-md
description: A JavaScript-capable web crawler. Supports two modes — (1) BFS crawl that renders pages and follows links, and (2) llms.txt mode that fetches a site's curated llms.txt index and downloads each page as Markdown. Use for bulk retrieval of web documentation or site structure collection.
argument-hint: <URL> [-o output_dir] [options] [--summarize] [--to-fractal-*]
---

# web-crawler-md

Two collection modes:

| Mode | When to use | Script |
|---|---|---|
| **BFS crawl** | Site has no llms.txt; need to crawl link graph | `crawl.py` (Playwright + turndown) |
| **llms.txt mode** | Site publishes `/llms.txt` (AWS, Anthropic, Stripe, Vercel 等) | `llms_collect.py` (httpx async) |

llms.txt mode is **dramatically faster and cleaner** when available — single HTTP request to fetch the curated index, then parallel `.md` downloads with the site's own hierarchy preserved (no Playwright, no nav-element noise, no duplicate-extension quirks). Always prefer it when an llms.txt exists.

## Scripts

- [scripts/crawl.py](scripts/crawl.py) — BFS crawler (Playwright + readability + turndown)
- [scripts/llms_collect.py](scripts/llms_collect.py) — llms.txt mode collector (httpx async, hierarchical fetch from a site's llms.txt index)
- [scripts/readability.js](scripts/readability.js) — Main content extraction (injected into browser, used by both modes)
- [scripts/html-md-converter.js](scripts/html-md-converter.js) — HTML→Markdown converter bundle (turndown + GFM + Fractal-derived custom rules)。https://github.com/raggbal/html-md-converter — 更新は `~/html-md-converter/scripts/update-web-crawler-md.sh` で取得
- [scripts/register-fractal.mjs](scripts/register-fractal.mjs) — Optional: register collected pages into a Fractal outliner as a sitemap tree under `date > title > tree`

## Prerequisites

```bash
pip install -r <SKILL_DIR>/scripts/requirements.txt
playwright install chromium
```

**Note:** `<SKILL_DIR>` refers to this skill's base directory. Resolve it from the system-provided "Base directory for this skill" path. Do NOT hardcode `~/.claude/skills/web-crawler-md` — the skill may be installed in a project-local `.claude/skills/` directory instead.

## Mode selection

**`crawl.py` auto-probes for `llms.txt` at startup** (built into the script — no extra logic required from the agent):

1. If the input URL itself ends with `/llms.txt` or `/llms-full.txt` → route directly to `llms_collect.py`.
2. Otherwise probe these candidates (HEAD, fall back to GET with `Range: bytes=0-0` if HEAD is 405):
   - `<URL's directory>/llms.txt`
   - walk up the path: parent dir, grandparent, … site root
3. First candidate that returns `200`/`206` with `text/plain` or `text/markdown` wins → `os.execv` into `llms_collect.py`.
4. None found → continue with BFS crawl.

To force BFS even if llms.txt exists, pass `--no-llms-txt`.

The agent simply runs `python crawl.py <URL>` and the script picks the right mode. There is no need for the agent to probe manually.

## Basic Usage — BFS crawl

```bash
# Basic (crawl all pages under the starting URL's directory)
python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir>

# Limit number of pages
python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir> --limit 50

# Specify scope (glob pattern, multiple allowed)
python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir> --scope "https://example.com/docs/*"

# Change concurrency (default: 10)
python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir> --concurrency 5

# Resume interrupted crawl (skip scraping existing files)
python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir> --resume

# Append paginated content to the same file
python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir> --paginate-append
```

## Basic Usage — llms.txt mode

```bash
# Direct: user pasted an llms.txt URL
python <SKILL_DIR>/scripts/llms_collect.py "https://docs.example.com/llms.txt" -o <output_dir>

# Higher concurrency for faster fetches
python <SKILL_DIR>/scripts/llms_collect.py "<llms.txt URL>" -o <output_dir> --concurrency 20

# Disable HTML fallback (purist mode — skip rather than reconstruct from HTML)
python <SKILL_DIR>/scripts/llms_collect.py "<llms.txt URL>" -o <output_dir> --no-html-fallback

# Local llms.txt file (must specify a base URL to resolve relative links)
python <SKILL_DIR>/scripts/llms_collect.py ./llms.txt -o <output_dir> --base-url "https://docs.example.com/"
```

## Options — BFS crawl (`crawl.py`)

| Option | Short | Default | Description |
| --- | --- | --- | --- |
| `url` | — | (required) | Starting URL |
| `--output` | `-o` | `output` | Output directory |
| `--limit` | `-l` | `0` (unlimited) | Maximum number of pages |
| `--scope` | `-s` | auto-detected | URL pattern for crawl scope (glob, multiple allowed) |
| `--concurrency` | `-c` | `10` | Number of concurrent pages |
| `--resume` | `-r` | `false` | Resume mode |
| `--paginate-append` | `-p` | `false` | Append paginated content to the same file |
| `--no-llms-txt` | — | `false` | Skip the llms.txt probe and force BFS crawl |
| `--summarize` | — | `false` | After crawling, create `SUMMARY.md` in the output directory |
| `--to-fractal-out` | — | (none) | Direct path to a target `.out` file (Fractal outliner) |
| `--to-fractal-notes` | — | (none) | Notes folder path (used with `--to-fractal-outline`) |
| `--to-fractal-outline` | — | (none) | Outline title; auto-creates if not found in the Notes folder |
| `--to-fractal-title` | — | crawl root page title | Title node text under the date node |
| `--to-fractal-date` | — | today (`YYYY-MM-DD`) | Override date node text |

## Options — llms.txt mode (`llms_collect.py`)

| Option | Short | Default | Description |
| --- | --- | --- | --- |
| `llms_url` | — | (required) | URL to an `llms.txt` (or a local file path) |
| `--output` | `-o` | `output` | Output directory |
| `--concurrency` | `-c` | `10` | Concurrent downloads |
| `--no-html-fallback` | — | `false` | Skip Playwright HTML→MD retry when a link returns non-markdown/404 |
| `--base-url` | — | `""` | Base URL for resolving relative links (required only when `llms_url` is a local file) |

Fractal registration uses the same downstream flow as BFS mode — pass `--to-fractal-*` to the wrapping skill/agent, and after collection the agent runs `register-fractal.mjs --mode tree` against the produced `map.json`. The llms.txt-derived `map.json` has the **exact same schema** as the BFS output, so registration is identical.

## Execution Steps

When a URL and output destination are provided by the user, follow these steps:

1. **Create a dedicated folder for each URL (mandatory)**
   - Each URL must be collected into its own subfolder with an identifiable name via `-o`
   - Example: `https://docs.example.com/guide/` → `-o <base_dir>/example-guide/`
   - Never mix results from different runs into the same folder
   - **Multiple URLs in a single request:** Create a parent folder for the overall topic first, then create per-URL subfolders under it and run all collections in parallel
     - Example: user asks to crawl 3 AWS-related URLs → create `aws-research/`, then run in parallel:
       - `-o aws-research/aws-docs/`
       - `-o aws-research/example-guide/`
       - `-o aws-research/blog-post/`
2. Assemble options based on user requirements
3. Run `python <SKILL_DIR>/scripts/crawl.py "<URL>" -o <output_dir>` — the script auto-probes for llms.txt and delegates to `llms_collect.py` if found (typically completes in seconds for llms.txt sites). For BFS-only sites the crawl may take several minutes, so consider running in the background.
   - To force BFS even when an llms.txt is present, add `--no-llms-txt`.
   - To run llms.txt mode without the probe overhead (when you already have an llms.txt URL), call `python <SKILL_DIR>/scripts/llms_collect.py "<llms.txt URL>" -o <output_dir>` directly.
5. After completion, check the output directory contents and `map.json`, then report the results
6. **If `--summarize` was requested:** Generate `SUMMARY.md` in the output directory using the hierarchical sampling strategy described in the Summarize section below
7. **If `--to-fractal-*` was requested, OR `FRACTAL_DEFAULT_OUT` env is set (and `--no-fractal` was NOT given):** Run `register-fractal.mjs` to add the collected tree to a Fractal outliner (see "Register to Fractal" section below) — works identically for both modes since `map.json` shares the same schema. If env contains multiple paths, use `--list-default-outs` + `AskUserQuestion` to pick one before invoking.

## Summarize

When `--summarize` is specified, the challenge is that crawls can produce hundreds of MD files — far too many to read in full. Use the following **hierarchical sampling strategy** to create one coherent `SUMMARY.md`:

### Strategy: Hierarchical Sampling

**Step 1 — Read `map.json` (always)**
- Parse `map.json` to understand the full site structure (page count, depth, top-level sections)
- This gives you breadth without reading individual files

**Step 2 — Read high-priority pages**
Read these pages in full (they cover the most ground per token):
1. The root/index page (top of the hierarchy)
2. Each top-level section's index page (depth 1 in map.json)
3. Any page whose title suggests it's an overview, getting started, or introduction

**Step 3 — Sample within large sections**
For any top-level section with more than 10 child pages:
- Read 2–3 representative child pages (spread across the section, not just the first)
- Note recurring patterns (e.g., "each page covers one API method")

**Step 4 — Write `SUMMARY.md`**

Create `SUMMARY.md` in the output directory with the following structure:

```markdown
# Summary: <Site / Documentation Name>

## Overview
<2–4 sentence description of what this site/documentation covers and who it's for>

## Statistics
- **Total pages crawled:** <N>
- **Top-level sections:** <N>
- **Crawl source:** <starting URL>

## Site Structure

### <Section 1 Name> (<N> pages)
<1–2 sentence summary of what this section covers>
Key topics: <topic A>, <topic B>, <topic C>

### <Section 2 Name> (<N> pages)
<1–2 sentence summary>
Key topics: ...

...

## Key Concepts
<Bullet list of the most important concepts, features, or APIs discovered across all sampled pages>

## Notable Pages
| Page | Description |
|---|---|
| [<title>](<relative path>) | <one-line description> |
| ... | ... |

---
*Source: <starting URL>*
*Pages crawled: <N> | Sampled for summary: <M>*
*Generated: <date>*
```

### Guidelines

- **Do not attempt to read all files.** The sampling strategy above is intentional — a SUMMARY.md that accurately covers 20% of pages is more useful than an incomplete attempt to read 100%.
- If `map.json` is unavailable, use `ls` on the output directory and infer structure from file paths.
- For sites with fewer than 20 pages, read all files in full before writing the summary.
- Keep each section summary to 2–3 sentences maximum to ensure the SUMMARY.md remains concise and scannable.

## Register to Fractal

When any `--to-fractal-*` option is given, after crawling completes run:

```bash
node <SKILL_DIR>/scripts/register-fractal.mjs --mode tree \
  --tree-json <output_dir>/map.json \
  --md-base <output_dir> \
  --fractal-title "<title-node-text>" \
  [--fractal-out <path.out> | --fractal-notes <folder> --fractal-outline <title>] \
  [--fractal-date YYYY-MM-DD]
```

The script creates this structure in the target outliner:

```
<outline-root>
└── YYYY-MM-DD            ← reused if a root-level node with this exact text exists
    └── <fractal-title>   ← always newly created
        └── <map.json root, replicated as sitemap tree>
            ├── page node (when tree entry has `file`)
            └── plain node (intermediate section without `file`)
```

### Outline targeting

Pick one:

- `--fractal-out <path.out>` — write to an existing outliner directly
- `--fractal-notes <folder> --fractal-outline <title>` — look up `outline.note` for a file item with the given `title`; auto-creates the outline (via `fractal-md.mjs --create-outliner`) if none matches
- **`FRACTAL_DEFAULT_OUT` env var** — if neither CLI flag above is given, the script falls back to this env var. Single `.out` path → used automatically. Comma-separated multiple paths → script errors with a list of titles (caller must pick one and pass via `--fractal-out`)

### Choosing among multiple FRACTAL_DEFAULT_OUT paths

When `FRACTAL_DEFAULT_OUT` is a comma-separated list and the user did **not** pass `--to-fractal-out`, the calling skill should:

1. Run `node <SKILL_DIR>/scripts/register-fractal.mjs --list-default-outs` — prints `[{path, title, exists}, ...]` as JSON
2. Use `AskUserQuestion` to show each `.out`'s title (as option label) and path (as description)
3. Pass the chosen path via `--fractal-out <path>` to override the env

A `--no-fractal` flag at the wrapper level should skip Fractal registration entirely (env ignored).

### Title node default

If `--to-fractal-title` is not provided, derive it from the crawl root page title (the `title` of `map.json`'s root) or fall back to the starting URL. The title node is **always created fresh** — re-crawling the same site on the same date produces a new sibling title under the date node.

### Notes

- The script shells out to `fractal-edit/scripts/fractal-md.mjs` for each node insert. Auto-resolves the path via the sibling skill location (`<SKILL_DIR>/../fractal-edit/scripts/fractal-md.mjs`) or `~/.claude/skills/fractal-edit/scripts/fractal-md.mjs`. Override with `--fractal-md-script <path>`.
- Sitemap order is preserved by chaining `--position after` inserts; do not run this concurrently against the same `.out`.
- Per Fractal hygiene, ensure the target `.out` is not open in the Fractal app/extension during write.

## Output

- Each page is saved as an individual `.md` file (with front matter)
- `map.json` — A JSON tree representing the hierarchical structure between pages
- **With `--summarize`:** also saves `SUMMARY.md` in the output directory
- **With `--to-fractal-*`:** also updates the target `.out` (and `outline.note` if a new outline is created)

## Notes

### BFS crawl (`crawl.py`)
- When scope is not specified, the starting URL's directory is used as the automatic scope
- External links are always ignored
- Execution time depends on site size (may take several minutes to tens of minutes)
- crawl.py loads readability.js and html-md-converter.js from the same directory, so all 3 files must be present in scripts/

### llms.txt mode (`llms_collect.py`)
- Parser is heading-depth driven (generic): `# / ## / ### …` are converted to a tree where heading level == tree depth. Section headings with embedded links (`## [Name](url)`) are kept as page nodes that also have children
- List items use the `- [name](url): desc` pattern. Indented (nested) list items become deeper tree children
- Cross-host links from llms.txt are **kept** (the site author curated them) but a warning is logged
- HTML fallback (Playwright) only triggers when an MD fetch returns non-markdown content-type or HTTP 4xx/5xx. Disable with `--no-html-fallback` if you want strict llms-txt mode
- No `--limit` / `--scope` / `--resume` — the llms.txt **is** the scope; rerun overwrites existing files
- Filename slugs strip the directory prefix containing the llms.txt (e.g. `/svc/userguide/llms.txt` → strip `/svc/userguide/` so files are named `<page>.md` instead of `<svc>_userguide_<page>.md`)
