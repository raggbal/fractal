---
name: youtube-md
description: Retrieve YouTube video transcripts (subtitles) and save them to a Markdown file. Supports Japanese and English subtitles. Choose between timestamped output and a readable prose format.
argument-hint: <youtube_url_or_video_id> [--readable] [--no-timestamp] [--summarize] [--to-fractal-*]
---

# youtube-md

A CLI tool that retrieves YouTube video transcripts (subtitles).
Uses youtube-transcript-api to fetch subtitle data and save it as a Markdown file.

## Scripts

- [scripts/get_transcript.py](scripts/get_transcript.py) — Main transcript retrieval script
- [scripts/register-fractal.mjs](scripts/register-fractal.mjs) — Optional: register the transcript MD into a Fractal outliner under `date > title > md`

## Prerequisites

```bash
pip install -r <SKILL_DIR>/scripts/requirements.txt
```

**Note:** `<SKILL_DIR>` refers to this skill's base directory. Resolve it from the system-provided "Base directory for this skill" path. Do NOT hardcode `~/.claude/skills/youtube-md` — the skill may be installed in a project-local `.claude/skills/` directory instead.

## Basic Usage

```bash
# Specify a YouTube URL
python <SKILL_DIR>/scripts/get_transcript.py https://www.youtube.com/watch?v=VIDEO_ID

# Specify a video ID directly
python <SKILL_DIR>/scripts/get_transcript.py VIDEO_ID

# Output in readable prose format (merge subtitle fragments, line breaks at punctuation)
python <SKILL_DIR>/scripts/get_transcript.py VIDEO_ID --readable

# Output without timestamps
python <SKILL_DIR>/scripts/get_transcript.py VIDEO_ID --no-timestamp

# Combine options
python <SKILL_DIR>/scripts/get_transcript.py VIDEO_ID --readable --no-timestamp
```

## Options

| Option | Description |
|---|---|
| `--readable` | Merge subtitle fragments into readable prose format |
| `--no-timestamp` | Hide timestamps `[MM:SS]` |
| `--summarize` | After generating the transcript MD, create `SUMMARY.md` in the same folder |
| `--to-fractal-out` | Direct path to a target `.out` file (Fractal outliner) |
| `--to-fractal-notes` | Notes folder path (used with `--to-fractal-outline`) |
| `--to-fractal-outline` | Outline title; auto-creates if not found in the Notes folder |
| `--to-fractal-title` | Title node text under the date node (default: video title) |
| `--to-fractal-date` | Override date node text (default: today, `YYYY-MM-DD`) |

## Language Priority

By default, subtitles are retrieved in the following order:
1. Japanese (`ja`)
2. English (`en`)

## Execution Steps

When a YouTube URL or video ID is provided by the user, follow these steps:

1. Select options based on user requirements:
   - For LLM input → recommend `--readable --no-timestamp`
   - For reference/citation → recommend timestamped output (default)
2. Run `python <SKILL_DIR>/scripts/get_transcript.py <url_or_id> [options]`
3. Review the output file `transcript_<VIDEO_ID>.md` and report the results
4. **If `--summarize` was requested:** Read `transcript_<VIDEO_ID>.md` and create `SUMMARY.md` in the same folder (see Summarize section below)
5. **If `--to-fractal-*` was requested, OR `FRACTAL_DEFAULT_OUT` env is set (and `--no-fractal` was NOT given):** Run `register-fractal.mjs` to add the transcript to a Fractal outliner (see "Register to Fractal" section below). If env contains multiple paths, use `--list-default-outs` + `AskUserQuestion` to pick one before invoking.

## Summarize

When `--summarize` is specified, after the transcript MD is generated:

1. Read the transcript file in full
2. Create `SUMMARY.md` **in the same folder as the transcript** with the following structure:

```markdown
# Summary: <Video Title>

## Overview
<2–3 sentence description of what the video is about>

## Key Points
- <key point 1>
- <key point 2>
- ...

## Topics Covered
| Topic | Timestamp |
|---|---|
| <topic> | [MM:SS] |
| ... | ... |

## Notable Quotes
> "<quote>" — [MM:SS]

---
*Source: <YouTube URL>*
*Generated: <date>*
```

- If the transcript has no timestamps (--no-timestamp), omit the Timestamp column and Notable Quotes section.
- Aim for 300–500 words in the summary body.

## Register to Fractal

When any `--to-fractal-*` option is given, after the transcript MD is saved run:

```bash
node <SKILL_DIR>/scripts/register-fractal.mjs --mode single \
  --md <transcript_VIDEO_ID.md path> \
  --fractal-title "<title-node-text>" \
  [--fractal-out <path.out> | --fractal-notes <folder> --fractal-outline <title>] \
  [--fractal-date YYYY-MM-DD]
```

The script creates this structure in the target outliner:

```
<outline-root>
└── YYYY-MM-DD            ← reused if a root-level node with this exact text exists
    └── <fractal-title>   ← always newly created
        └── transcript MD ← page node containing the transcript
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

If `--to-fractal-title` is not provided, derive it from the YouTube video title (the H1 of the transcript MD, or fall back to the video URL/ID).

### Notes

- Auto-resolves `fractal-edit/scripts/fractal-md.mjs` via the sibling skill location or `~/.claude/skills/fractal-edit/scripts/fractal-md.mjs`. Override with `--fractal-md-script <path>`.
- The transcript MD's H1 is preserved as the page content; the node text shown in the outliner is `--fractal-title`.

## Output

- Displays transcript on the console
- Saves to file as `transcript_<VIDEO_ID>.md` (UTF-8)
- **With `--summarize`:** also saves `SUMMARY.md` in the same folder
- **With `--to-fractal-*`:** also updates the target `.out` (and `outline.note` if a new outline is created)

## Notes

- Retrieval will fail for videos without subtitles
- Auto-generated subtitles can also be retrieved (accuracy varies by video)
