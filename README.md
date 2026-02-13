# Vanilla Client-Side PDF Editor

## Project Rules (must remain true)

1. **Vanilla JavaScript only** (no npm packages, no external JS libraries, no framework).
2. **No server required** (fully client-side, runs from static files).
3. **No JS modules/build tooling** (single `app.js` loaded by `<script src="app.js">`).
4. **Open directly in browser** by loading `index.html`.
5. **Mobile + desktop friendly UI** via responsive CSS.
6. **All processing happens locally in browser memory**; files are not uploaded.

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
- PDF displays in embedded browser PDF viewer.
- Page-by-page navigation (`Prev` / `Next`).

### Page operations

- **Shuffle pages:** move page up/down in output order.
- **Rotate:** per-page `-90` / `+90`.
- **Resize:** per-page scale slider (`25%` to `200%`).
- **Delete/restore:** toggle page inclusion in output.

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

Because this is a strict no-dependency vanilla implementation:

- Editing works best on **non-encrypted PDFs using classic xref tables**.
- Some PDFs (especially xref streams/object streams/encrypted PDFs) may open in **view-only mode**.
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