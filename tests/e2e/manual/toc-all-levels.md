# Manual E2E Test: TOC All Heading Levels

## Overview

This test verifies that the side panel TOC displays all heading levels (h1-h6), including non-hierarchical structures where heading levels skip (e.g., h1 followed by h3).

## Prerequisites

1. Build the VSIX: `npm run package`
2. Install the VSIX in VSCode: Extensions > Install from VSIX...
3. Reload VSCode

## Test Fixture

File: `tests/e2e/fixtures/toc-non-hierarchical.md`

Contents:
- h1: Title
- h3: Sub A
- h3: Sub B
- h5: Deep
- h2: Regular H2
- h4: Another H4
- h6: Smallest H6

## Test Steps

### DOD-TOC-1: TOC displays all heading levels h1-h6

1. Open VSCode with the Fractal extension installed
2. Open the file `tests/e2e/fixtures/toc-non-hierarchical.md` with Fractal Editor
3. Open the side panel (if not already open)
4. Verify the TOC shows **7 items**:
   - Title (level 1)
   - Sub A (level 3)
   - Sub B (level 3)
   - Deep (level 5)
   - Regular H2 (level 2)
   - Another H4 (level 4)
   - Smallest H6 (level 6)

### DOD-TOC-2: TOC handles non-hierarchical heading structures

1. In the same TOC view, verify that:
   - "Sub A" and "Sub B" (h3) appear immediately after "Title" (h1)
   - "Deep" (h5) appears after "Sub B" without h2/h4 in between
   - The visual indentation corresponds to the heading level via `data-level` attribute

2. Inspect the DOM (DevTools > Elements):
   - Find `.side-panel-toc-item` elements
   - Verify `data-level` attributes:
     - Title: `data-level="1"`
     - Sub A: `data-level="3"`
     - Sub B: `data-level="3"`
     - Deep: `data-level="5"`
     - Regular H2: `data-level="2"`
     - Another H4: `data-level="4"`
     - Smallest H6: `data-level="6"`

3. Verify CSS indentation is applied per level (defined in styles.css):
   - Level 1: padding-left: 16px
   - Level 2: padding-left: 28px
   - Level 3: padding-left: 40px
   - Level 4: padding-left: 52px
   - Level 5: padding-left: 60px
   - Level 6: padding-left: 64px

## Expected Result

All 7 headings are displayed in the TOC with correct levels and visual indentation. No headings are missing regardless of the hierarchical structure.

## Related DoD Items

- DOD-TOC-1: TOC displays all heading levels h1-h6 in side panel
- DOD-TOC-2: TOC handles non-hierarchical heading structures (e.g., h1 followed directly by h3)

## Unit Test Coverage

The unit tests in `test/specs/unit-sidepanel-toc.spec.ts` verify the `extractToc()` function:
- `should extract all heading levels h1-h6` - extracts 6 items from h1-h6 markdown
- `should handle non-hierarchical structure (h1 then h3)` - extracts 3 items with levels [1, 3, 3]
