# HtmlMdConverter

Component: [odk:component:webview/html-md-converter]

## Responsibilities

- Convert external HTML to Markdown (clipboard paste, Chrome Extension, ai-skills).
- SVG pre-processing (inline computed styles → `<img>`).
- GFM tables, strikethrough, task lists.
- Fractal-specific custom rules.

## Tech stack

JavaScript, [odk:ext:npm/turndown] (^7.2.2), `turndown-plugin-gfm`.

## I/O contract

- Input: HTML string.
- Output: Markdown string.

## Dependencies

None (leaf UNIT).
