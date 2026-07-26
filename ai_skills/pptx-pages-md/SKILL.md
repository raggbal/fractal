---
name: pptx-pages-md
description: Convert a .pptx into per-slide artifacts — a rendered PNG image, a bullet list of texts, and presenter notes — one set per slide, plus a top-level index .md. Use when the user wants a readable Markdown view of slides without losing icons/diagrams (Docling tends to dump shapes as raw text). NOT for plain text extraction — use doc-md for that.
argument-hint: <pptx_file_path> [-o output_dir] [--dpi N] [--to-fractal-*]
---

# pptx-pages-md

Render each slide of a `.pptx` to a PNG and extract the text + presenter notes into a per-slide `.md`.

Solves the case where Docling produces hard-to-read text dumps because pptx contains many decorative shapes / icons. Here, the visual layout is preserved as an image and the text content is listed cleanly underneath.

## Output layout

Given `deck.pptx`, the script produces a single combined `.md` plus per-slide PNGs:

```
<output-dir>/
├── deck.md                    # all slides in one file
└── images/
    ├── slide-01.png
    ├── slide-02.png
    └── ...
```

`deck.md` content:

```markdown
# deck.pptx

N slides.

## Slide 1
![slide-01](images/slide-01.png)

### Texts
- bullet 1
- bullet 2

### Notes
presenter notes text

## Slide 2
...
```

## Pipeline

1. **python-pptx** — extracts texts (per-shape, per-paragraph) and presenter notes
2. **LibreOffice headless** (`soffice --convert-to pdf`) — renders pptx to PDF preserving layout
3. **pdf2image (poppler)** — splits PDF into per-page PNG

## Prerequisites

```bash
# Python deps
pip install -r <SKILL_DIR>/scripts/requirements.txt

# System deps
# macOS
brew install --cask libreoffice
brew install poppler
# Linux (Debian/Ubuntu)
apt install libreoffice poppler-utils
```

`<SKILL_DIR>` resolves from this skill's base directory — do NOT hardcode `~/.claude/skills/pptx-pages-md`.

## Usage

```bash
# Default: writes to <pptx-dir>/<stem>/
python <SKILL_DIR>/scripts/convert.py /path/to/deck.pptx

# Specify output directory
python <SKILL_DIR>/scripts/convert.py /path/to/deck.pptx -o ./out/

# Higher-resolution slide images (default 150)
python <SKILL_DIR>/scripts/convert.py /path/to/deck.pptx --dpi 200
```

## Options

| Option | Description |
|---|---|
| `-o`, `--output-dir` | Output directory (default: `<source-dir>/<stem>/`) |
| `--dpi` | Render DPI for slide PNGs (default 150; 200–300 for print-quality) |
| `--to-fractal-out` | Direct path to a target `.out` file (Fractal outliner) |
| `--to-fractal-notes` | Notes folder path (used with `--to-fractal-outline`) |
| `--to-fractal-outline` | Outline title; auto-creates if not found in the Notes folder |
| `--to-fractal-title` | Title node text under the date node (default: `.pptx` stem) |
| `--to-fractal-date` | Override date node text (default: today, `YYYY-MM-DD`) |

## Execution Steps

When a `.pptx` path is provided by the user, follow these steps:

1. Run `python <SKILL_DIR>/scripts/convert.py <pptx> [-o <output_dir>] [--dpi N]`
2. After conversion, verify the produced `<stem>.md` and `images/slide-NN.png` files exist; report the slide count and output location.
3. **If `--to-fractal-out` OR (`--to-fractal-notes` + `--to-fractal-outline`) was given:** Run `register-fractal.mjs` to add the combined `.md` to a Fractal outliner (see "Register to Fractal" section below).
   - **NOTE:** This skill does NOT consult the `FRACTAL_DEFAULT_OUT` environment variable on its own. The caller (typically `/collect`) is responsible for resolving env defaults and passing an explicit `--to-fractal-out <path>` (or notes/outline pair).

## Register to Fractal

When any `--to-fractal-*` option is given, after the combined `.md` is generated run:

```bash
node <SKILL_DIR>/scripts/register-fractal.mjs --mode single \
  --md <combined .md path> \
  --fractal-title "<title-node-text>" \
  [--fractal-out <path.out> | --fractal-notes <folder> --fractal-outline <title>] \
  [--fractal-date YYYY-MM-DD]
```

The script creates this structure in the target outliner:

```
<outline-root>
└── YYYY-MM-DD            ← reused if a root-level node with this exact text exists
    └── <fractal-title>   ← always newly created (default: .pptx stem)
        └── slides MD     ← page node containing the slides + texts + notes
```

### Image references in the registered MD

The combined MD references slide images via relative paths like `images/slide-01.png`. When the MD is loaded as a Fractal page node these relative references continue to point at the on-disk `images/` directory next to the original `.md`, so **do not move or delete the `images/` folder** — moving the source folder will break the embedded image links inside the outliner page.

### Outline targeting

Pick exactly one (otherwise the script errors):

- `--fractal-out <path.out>` — write to an existing outliner directly
- `--fractal-notes <folder> --fractal-outline <title>` — look up `outline.note` for a file item with the given `title`; auto-creates the outline if none matches

This script does NOT read `FRACTAL_DEFAULT_OUT`. The caller (`/collect` or the user) must resolve any env-driven default and pass `--fractal-out` explicitly.

### Title node default

If `--to-fractal-title` is not provided, derive it from the `.pptx` filename stem (the H1 of the combined MD).

### Notes

- Auto-resolves `fractal-edit/scripts/fractal-md.mjs` via the sibling skill location or `~/.claude/skills/fractal-edit/scripts/fractal-md.mjs`. Override with `--fractal-md-script <path>`.

## When to use

- The pptx has many icons / decorative shapes / SmartArt that Docling dumps as raw text bullets, making the markdown unreadable
- The user wants to scan slides visually while still having searchable text + presenter notes
- Want presenter notes alongside slide content (Docling discards notes via PDF intermediate)

## When NOT to use

- Slide text alone is enough → use **doc-md** (much faster, no image rendering)
- Source is a `.pdf` / `.docx` (not `.pptx`) → use **doc-md**
- Need OCR on scanned/image-only PDFs → use **doc-md** (Docling has built-in OCR)

## Notes

- LibreOffice rendering may use fallback fonts if the original pptx's fonts aren't installed locally; visual fidelity drops slightly but the text/structure is preserved
- Slide order is preserved 1:1 between PNG and python-pptx slide list
- Group shapes are recursed; text frames inside groups are extracted
