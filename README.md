# Vanilla Client-Side PDF Editor

## Project Rules (must remain true)

1. **Vanilla JavaScript app code** (no framework, no build step, no server).
2. **Locally vendored PDF renderer** (`vendor/pdf.min.js`) is included in-repo for reliable canvas preview.
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
- Includes **Open In Browser** fallback button.
- Page-by-page navigation (`Prev` / `Next`).

### Page operations

- **Shuffle pages:** move page up/down in output order.
- **Rotate:** per-page `-90` / `+90`.
- **Resize:** per-page scale slider (`25%` to `200%`).
- **Delete/restore:** toggle page inclusion in output.
- Structural edits are always applied in saved output PDF.

### Drawing + text

- **Draw mode:** freehand strokes stored per page.
- **Text mode:** tap/click to place text.
- Add centered text quickly.
- Edit text content, change text size, delete text entries.
- Clear all draw/text marks for current page.

### Save

- Save exports a new `*-edited.pdf`.
- Output PDF generation is done entirely in-browser by appending an incremental PDF update.

---

## Compatibility / Limitations (important)

Because this is a strict client-side static implementation (with locally bundled renderer code):

- Editing works best on **non-encrypted PDFs using classic xref tables**.
- Some PDFs (especially xref streams/object streams/encrypted PDFs) may open in **view-only mode**.
- Extremely large/corrupt PDFs may fail preview and should be opened with **Open In Browser** fallback.
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