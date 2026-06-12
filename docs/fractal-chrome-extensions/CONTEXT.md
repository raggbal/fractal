# Fractal Chrome Extensions — Domain Language

## Language

### Web Clipper
The Chrome Extension's core function. Captures the current web page, converts it to Markdown, and saves it as a new top-level Node + Page in a selected Outliner. Two trigger methods:
- **Popup clip** — Click extension icon → select folder + outliner → clip button.
- **Quick clip** (`Alt+Shift+F`) — Uses the last selection (folder + outliner) stored in IDB.

### Clip Pipeline
The sequence of operations when a page is clipped:
1. Inject `Readability.js` + `html-md-converter.js` into the active tab.
2. SVG pre-processing: inline computed styles, unwrap heading anchors, convert `<svg>` to `<img src="data:image/svg+xml;base64,...">` (prevents Readability from stripping SVG attributes).
3. Extract article content via `HtmlMdConverter.articleToMarkdown()` (Readability + turndown).
4. Build page Markdown (title, source URL, byline, site name + body).
5. Extract inline `data:` images to files in `<pageDir>/images/`.
6. Prepend a new Node (with pageId) to the `.out` file's `rootIds`.
7. Write `<pageId>.md` to the page directory.

### Folder Registry
Manages multiple Notes folders registered by the user. Uses the File System Access API (`showDirectoryPicker`, `FileSystemDirectoryHandle`) to get persistent read/write access to local Note folders from the browser. Stored in IndexedDB.

### Last Selection
The most recently used folder + outliner pair, persisted in IDB (`lastSelection: { folderId, outId }`). Used by Quick Clip to skip the popup selection step.

### File System Access API
The browser API that allows the Chrome Extension to read/write the user's local Note folders directly (without a native messaging host or server). Requires explicit user permission grant; permissions can expire and need re-authorization.

### Readability
Mozilla's content extraction library (`lib/Readability.js`). Strips navigation, ads, and boilerplate from web pages to extract the main article content. Used as the first step before HTML→MD conversion.

### Data URL Image Extractor
Post-processing step (`lib/data-url-image-extractor.js`) that finds `data:image/...` URLs in the clipped Markdown, saves them as actual image files in `<pageDir>/images/`, and rewrites the Markdown links to relative paths.

### Options Page
Extension settings page (`options.html` / `options.js`). Allows users to add/remove Notes folders via `showDirectoryPicker`. Shows permission status for each folder.

### Banner
An in-page floating notification injected into the active tab via `chrome.scripting.executeScript`. Shows clip progress, success, or error status. Auto-dismisses after 4s (success) or 8s (error).

### outline.note (cross-reference)
Same format as fractal's `outline.note`. The Chrome Extension reads it to present the Outliner tree in the popup's folder/outliner selector. Falls back to listing `*.out` files flat if `outline.note` is missing.

## Flagged ambiguities

(none)
