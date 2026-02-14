# Vanilla Client-Side PDF Editor

## Project Rules (must remain true)

1. **Vanilla JavaScript app code** (no framework, no build step, no server).
2. **Locally vendored PDF libraries** are included in-repo (`vendor/pdf.min.js`, `vendor/pdf-lib.min.js`).
3. **No server required** (fully client-side, runs from static files).
4. **No JS modules/build tooling** (`app.js` loaded as a plain script).
5. **Open directly in browser** by loading `index.html`.
6. **Mobile + desktop friendly UI** via responsive CSS.
7. **All processing happens locally in browser memory**; files are not uploaded.

---

## Intended Functional Requirements

The editor is intended to support this workflow:

1. Open a PDF file in browser.
2. View PDF pages.
3. Shuffle/reorder pages.
4. Rotate pages.
5. Resize pages.
6. Delete/restore pages.
7. Draw on pages.
8. Edit text annotations.
9. Save/export edited PDF.
10. Use on both mobile and desktop.

---

## Current Functionality (implemented now)

### File + viewing

- Open local PDF with file picker.
- PDF preview is rendered directly in app on a `<canvas>` (not dependent on browser native PDF iframe support).
- File actions are grouped in a **File** dropdown (`Open PDF`, `Save PDF`, `Close File`).
- Vertical all-pages preview stack is rendered below the main viewer so you can scroll through pages.

### Page operations

- **Single Mode selector:** choose `View`, `Pages`, `Draw`, or `Text` from top toolbar.
- **Mode tool panel:** when a non-view mode is selected, dedicated controls appear directly under the mode dropdown in the top sticky toolbar.
- **Select page:** click a page in the all-pages stack.
- **Shuffle pages:** move selected page up/down in output order.
- **Resize:** selected page `Scale-` / `Scale+` controls (`25%` to `200%`).
- **Rotate:** selected page `+90`.
- **Delete/restore:** toggle page inclusion in output.
- **Merge file:** in Pages mode, merge another PDF before or after current page (prompted).
- In any edit mode, the editable page window is shown **inline in place of that page card** (not in a separate top panel).
- Active editable page is highlighted with a **red border**.
- Structural edits are always applied in saved output PDF.

### Drawing + text

- **Draw mode:** freehand strokes stored per page.
- **Text mode:** tap/click to place text.
- Add centered text quickly.
- Edit text content, change text size, delete text entries.
- Clear all draw/text marks for current page.

### Save

- Save exports a new `*-edited.pdf`.
- Output PDF generation is done entirely in-browser using a local PDF editing library (no server).
- If direct structural editing is not possible, app falls back to **compatibility raster mode** so editing/saving still works.
- After save, app shows a persistent **Download Saved PDF** link/button fallback for mobile/webview environments that block automatic downloads.

### Layout + navigation UX

- Top controls are sticky so tools remain visible while scrolling.
- Zoom can be set from the top zoom picker and adjusted via mouse wheel over the inline edit window.

---

## Compatibility / Limitations (important)

Because this is a strict client-side static implementation (with locally bundled renderer code):

- Most standard PDFs are editable, including many modern xref/object-stream files.
- Encrypted/password-protected PDFs can still open for preview but may remain **view-only**.
- Extremely large/corrupt PDFs may fail preview.
- Compatibility raster mode flattens original page content into images before saving (text is no longer selectable in flattened page layers).
- Existing complex annotation structures may not always be fully preserved.
- Draw/text placement is annotation-based and may vary slightly across PDF viewers.

If a PDF cannot be parsed for editing, the app still lets you view it.

---

## Run Instructions

1. Download/clone the project.
2. Open `index.html` directly in a browser  
   (or serve statically if your environment requires it, but no backend logic is needed).
3. Open a PDF and edit.
4. Click **Save PDF** to download output.

---

## File Structure

- `index.html` - UI markup
- `styles.css` - responsive styling
- `app.js` - all editor logic (parser, UI, interactions, export)
- `vendor/pdf.min.js` - bundled PDF canvas renderer for cross-browser preview
- `vendor/pdf.worker.min.js` - bundled worker file (kept locally; app currently uses `disableWorker: true` for compatibility)
- `vendor/pdf-lib.min.js` - bundled PDF editing/writing library for broader save/edit support