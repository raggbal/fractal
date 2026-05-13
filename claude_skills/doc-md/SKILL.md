---
name: doc-md
description: Convert various document files (PDF, Word, PowerPoint, images, etc.) to Markdown. Uses Docling (AI-powered layout analysis) to accurately preserve table structures and heading hierarchies.
argument-hint: <file_path_or_url> [-o output_dir] [--summarize] [--to-fractal-*]
---

# doc-md

A CLI tool that converts various document files to Markdown.
Uses [Docling](https://github.com/docling-project/docling) (IBM / Linux Foundation) as the conversion engine, leveraging AI-powered layout analysis to accurately preserve table structures and heading hierarchies.

## Scripts

- [scripts/convert.py](scripts/convert.py) — Main conversion script
- [scripts/requirements.txt](scripts/requirements.txt) — Python dependencies
- [scripts/register-fractal.mjs](scripts/register-fractal.mjs) — Optional: register the converted MD into a Fractal outliner under `date > title > md`

## Prerequisites

```bash
pip install -r <SKILL_DIR>/scripts/requirements.txt
```

**Note:** `<SKILL_DIR>` refers to this skill's base directory. Resolve it from the system-provided "Base directory for this skill" path. Do NOT hardcode `~/.claude/skills/doc-md` — the skill may be installed in a project-local `.claude/skills/` directory instead.

On first run, AI models (DocLayNet, TableFormer, etc.) are automatically downloaded from HuggingFace.

### macOS (CPU-only)

```bash
pip install docling --extra-index-url https://download.pytorch.org/whl/cpu
```

## Basic Usage

```bash
# Convert a local file
python <SKILL_DIR>/scripts/convert.py /path/to/document.pdf
# → Outputs to /path/to/document.md

# Convert from a URL
python <SKILL_DIR>/scripts/convert.py https://example.com/report.pdf
# → Outputs report.md in the current directory

# Specify output directory
python <SKILL_DIR>/scripts/convert.py /path/to/document.pdf -o ./output/
```

## Supported Formats

| Category | Extensions |
|---|---|
| PDF | `.pdf` |
| MS Office | `.docx`, `.pptx`, `.xlsx` |
| Markup | `.html`, `.xhtml`, `.md`, `.adoc`, `.tex` |
| Data | `.csv` |
| Images | `.png`, `.jpg`, `.jpeg`, `.tiff`, `.tif`, `.bmp`, `.webp` |
| Audio | `.wav`, `.mp3` (requires `docling[asr]`) |
| Other | `.xml`, `.json`, `.vtt` |

## When to Use doc-md vs. Manual Conversion

There are two ways to convert documents to Markdown. Choose based on the document characteristics.

### Use doc-md (Docling)

- Office formats like `.docx`, `.pptx`, `.xlsx` (cannot be opened directly with the Read tool)
- Documents with complex layouts such as tables or multi-column text
- Scanned PDFs (image-only, no text layer)
- Large multi-page documents
- When OCR from images is needed

### Manual conversion (Read tool + hand-editing) is sufficient

- Simple text-based PDFs (CVs, resumes, text-heavy documents)
- Short documents of just a few pages
- Documents with headings and bullet points but no complex tables

Manual conversion provides more precise control over Markdown structure (heading hierarchy, bullet points, links) and avoids Docling-specific artifacts (duplicate bullets, section reordering, URL escaping, etc.).

## Options

| Option | Description |
|---|---|
| `-o`, `--output` | Output directory |
| `--summarize` | After conversion, create `SUMMARY.md` in the same folder |
| `--to-fractal-out` | Direct path to a target `.out` file (Fractal outliner) |
| `--to-fractal-notes` | Notes folder path (used with `--to-fractal-outline`) |
| `--to-fractal-outline` | Outline title; auto-creates if not found in the Notes folder |
| `--to-fractal-title` | Title node text under the date node (default: document title) |
| `--to-fractal-date` | Override date node text (default: today, `YYYY-MM-DD`) |

## Execution Steps

When a file path or URL is provided by the user, follow these steps:

1. Run `python <SKILL_DIR>/scripts/convert.py <source> [-o <output_dir>]`
2. After conversion, review the output Markdown file and report the results
3. **If `--summarize` was requested:** Read the output `.md` file and create `SUMMARY.md` in the same folder (see Summarize section below)
4. **If `--to-fractal-*` was requested, OR `FRACTAL_DEFAULT_OUT` env is set (and `--no-fractal` was NOT given):** Run `register-fractal.mjs` to add the converted MD to a Fractal outliner (see "Register to Fractal" section below). If env contains multiple paths, use `--list-default-outs` + `AskUserQuestion` to pick one before invoking.

## Summarize

When `--summarize` is specified, after the conversion is complete:

1. Read the converted Markdown file in full
2. Create `SUMMARY.md` **in the same folder as the converted MD** with the following structure:

```markdown
# Summary: <Document Title>

## Overview
<2–3 sentence description of the document's purpose and scope>

## Document Structure
| Section | Description |
|---|---|
| <heading> | <one-line summary> |
| ... | ... |

## Key Points
- <key point 1>
- <key point 2>
- ...

## Tables & Data
<Brief description of any notable tables, figures, or data found in the document>

---
*Source: <original file name or URL>*
*Generated: <date>*
```

- Omit "Tables & Data" section if the document contains no significant tables or figures.
- Aim for 300–500 words in the summary body.

## Register to Fractal

When any `--to-fractal-*` option is given, after the document MD is generated run:

```bash
node <SKILL_DIR>/scripts/register-fractal.mjs --mode single \
  --md <converted .md path> \
  --fractal-title "<title-node-text>" \
  [--fractal-out <path.out> | --fractal-notes <folder> --fractal-outline <title>] \
  [--fractal-date YYYY-MM-DD]
```

The script creates this structure in the target outliner:

```
<outline-root>
└── YYYY-MM-DD            ← reused if a root-level node with this exact text exists
    └── <fractal-title>   ← always newly created
        └── converted MD  ← page node containing the document
```

### Outline targeting

Pick one:

- `--fractal-out <path.out>` — write to an existing outliner directly
- `--fractal-notes <folder> --fractal-outline <title>` — look up `outline.note` for a file item with the given `title`; auto-creates the outline if none matches
- **`FRACTAL_DEFAULT_OUT` env var** — if neither CLI flag is given, falls back here. Single `.out` path → auto-used. Comma-separated multiple paths → script errors with a list; caller picks one via `--fractal-out`

### Choosing among multiple FRACTAL_DEFAULT_OUT paths

When `FRACTAL_DEFAULT_OUT` is a comma-separated list and no `--to-fractal-out` was given, the calling skill should:

1. Run `node <SKILL_DIR>/scripts/register-fractal.mjs --list-default-outs` → JSON of `[{path, title, exists}, ...]`
2. `AskUserQuestion` with each title as option label, path as description
3. Pass chosen path via `--fractal-out <path>`

`--no-fractal` (at the wrapper level) skips registration entirely, ignoring env.

### Title node default

If `--to-fractal-title` is not provided, derive it from the document title (the H1 of the converted MD) or the source file name without extension.

### Notes

- Auto-resolves `fractal-edit/scripts/fractal-md.mjs` via the sibling skill location or `~/.claude/skills/fractal-edit/scripts/fractal-md.mjs`. Override with `--fractal-md-script <path>`.

## Notes

- Performance: AI model page analysis takes several seconds to tens of seconds per file
- Install size: Approximately 1.7 GB even in CPU-only mode due to PyTorch dependency
- Output format is Markdown (`.md`) only
- **With `--to-fractal-*`:** also updates the target `.out` (and `outline.note` if a new outline is created)
