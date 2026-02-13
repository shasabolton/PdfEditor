(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const saveBtn = document.getElementById("saveBtn");
  const prevPageBtn = document.getElementById("prevPageBtn");
  const nextPageBtn = document.getElementById("nextPageBtn");
  const modeSelect = document.getElementById("modeSelect");
  const colorInput = document.getElementById("colorInput");
  const sizeInput = document.getElementById("sizeInput");
  const clearMarksBtn = document.getElementById("clearMarksBtn");
  const addCenteredTextBtn = document.getElementById("addCenteredTextBtn");
  const pageIndicator = document.getElementById("pageIndicator");
  const statusText = document.getElementById("statusText");
  const pageList = document.getElementById("pageList");
  const textList = document.getElementById("textList");
  const viewerContainer = document.getElementById("viewerContainer");
  const pdfFrame = document.getElementById("pdfFrame");
  const overlayCanvas = document.getElementById("overlayCanvas");
  const overlayCtx = overlayCanvas.getContext("2d");

  const encoder = new TextEncoder();

  const state = {
    fileName: "",
    sourceBytes: null,
    sourceUrl: "",
    previewBytes: null,
    previewUrl: "",
    parsed: null,
    canEdit: false,
    pageOrder: [],
    pagesById: new Map(),
    annotationsByPage: new Map(),
    currentPageActiveIndex: 0,
    mode: "view",
    drawing: {
      pointerId: null,
      currentStroke: null,
    },
  };

  bindEvents();
  resizeOverlayCanvas();
  renderEverything();

  function bindEvents() {
    fileInput.addEventListener("change", onFileSelected);
    saveBtn.addEventListener("click", onSaveClick);
    prevPageBtn.addEventListener("click", () => {
      setCurrentPageActiveIndex(state.currentPageActiveIndex - 1);
      renderEverything();
    });
    nextPageBtn.addEventListener("click", () => {
      setCurrentPageActiveIndex(state.currentPageActiveIndex + 1);
      renderEverything();
    });
    modeSelect.addEventListener("change", () => {
      state.mode = modeSelect.value;
      updateOverlayInteractivity();
      drawOverlay();
    });
    clearMarksBtn.addEventListener("click", clearCurrentPageMarks);
    addCenteredTextBtn.addEventListener("click", addCenteredText);

    pageList.addEventListener("click", onPageListClick);
    pageList.addEventListener("input", onPageListInput);

    textList.addEventListener("click", onTextListClick);

    overlayCanvas.addEventListener("pointerdown", onOverlayPointerDown);
    overlayCanvas.addEventListener("pointermove", onOverlayPointerMove);
    overlayCanvas.addEventListener("pointerup", onOverlayPointerUp);
    overlayCanvas.addEventListener("pointercancel", onOverlayPointerUp);

    window.addEventListener("resize", () => {
      resizeOverlayCanvas();
      drawOverlay();
    });
  }

  function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    resetLoadedDocument();
    state.fileName = file.name;

    const reader = new FileReader();
    reader.onload = () => {
      try {
        const bytes = new Uint8Array(reader.result);
        state.sourceBytes = bytes;
        state.sourceUrl = URL.createObjectURL(
          new Blob([bytes], { type: "application/pdf" })
        );

        pdfFrame.src = state.sourceUrl;

        let parsed = null;
        try {
          parsed = parsePdfForEditing(bytes);
        } catch (parseError) {
          state.canEdit = false;
          state.parsed = null;
          setStatus(
            "Loaded in view-only mode. Editing requires a non-encrypted PDF with classic xref tables.",
            "error"
          );
          renderEverything();
          return;
        }

        state.canEdit = true;
        state.parsed = parsed;
        initializePageModels(parsed);
        rebuildEditedPreview(false);
        setStatus(
          "PDF loaded. You can reorder pages, rotate/scale/delete, draw, add/edit text, and save.",
          "ok"
        );
        renderEverything();
      } catch (error) {
        console.error(error);
        setStatus("Failed to read this file as PDF.", "error");
      } finally {
        fileInput.value = "";
      }
    };
    reader.onerror = () => {
      setStatus("Unable to open file.", "error");
    };
    reader.readAsArrayBuffer(file);
  }

  function onSaveClick() {
    if (!state.canEdit || !state.parsed) {
      setStatus("Load an editable PDF first.", "error");
      return;
    }
    try {
      const bytes = buildEditedPdf(true);
      updatePreviewBlob(bytes);
      const downloadName = buildOutputFileName(state.fileName);
      downloadBytes(bytes, downloadName);
      setStatus(`Saved ${downloadName}`, "ok");
      renderEverything();
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Save failed.", "error");
    }
  }

  function clearCurrentPageMarks() {
    const pageId = getCurrentPageId();
    if (!pageId) {
      return;
    }
    state.annotationsByPage.set(pageId, {
      strokes: [],
      texts: [],
    });
    drawOverlay();
    renderTextList();
    setStatus("Cleared drawing/text marks on current page.", "ok");
  }

  function addCenteredText() {
    const pageId = getCurrentPageId();
    if (!pageId) {
      return;
    }
    const content = window.prompt("Enter text to place on current page:");
    if (!content) {
      return;
    }

    const canvasSize = getCanvasCssSize();
    const sizePx = Math.max(10, Number(sizeInput.value) * 3);
    const textItem = {
      x: 0.5,
      y: 0.5,
      sizeNorm: sizePx / canvasSize.height,
      color: colorInput.value,
      text: content,
      widthNorm: estimateTextWidthNorm(content, sizePx, canvasSize.width),
      heightNorm: estimateTextHeightNorm(sizePx, canvasSize.height),
    };
    const marks = getOrCreatePageAnnotations(pageId);
    marks.texts.push(textItem);
    drawOverlay();
    renderTextList();
    setStatus("Added text annotation.", "ok");
  }

  function onPageListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const pageId = button.dataset.pageId;
    const action = button.dataset.action;
    if (!pageId || !action) {
      return;
    }

    const page = state.pagesById.get(pageId);
    if (!page) {
      return;
    }

    if (action === "select") {
      if (page.deleted) {
        setStatus("Restore this page before selecting it.", "error");
        return;
      }
      const idx = getActiveIndexForPageId(pageId);
      if (idx >= 0) {
        state.currentPageActiveIndex = idx;
        renderEverything();
      }
      return;
    }

    if (action === "up" || action === "down") {
      const fromIndex = state.pageOrder.indexOf(pageId);
      if (fromIndex === -1) {
        return;
      }
      const toIndex = action === "up" ? fromIndex - 1 : fromIndex + 1;
      if (toIndex < 0 || toIndex >= state.pageOrder.length) {
        return;
      }
      const temp = state.pageOrder[toIndex];
      state.pageOrder[toIndex] = state.pageOrder[fromIndex];
      state.pageOrder[fromIndex] = temp;
      normalizeCurrentPageIndex();
      rebuildEditedPreview(false);
      renderEverything();
      return;
    }

    if (action === "rotate-left") {
      page.rotateDelta = normalizeRotation(page.rotateDelta - 90);
      rebuildEditedPreview(false);
      renderEverything();
      return;
    }

    if (action === "rotate-right") {
      page.rotateDelta = normalizeRotation(page.rotateDelta + 90);
      rebuildEditedPreview(false);
      renderEverything();
      return;
    }

    if (action === "delete-toggle") {
      if (!page.deleted && getActivePageIds().length <= 1) {
        setStatus("At least one page must remain.", "error");
        return;
      }
      page.deleted = !page.deleted;
      normalizeCurrentPageIndex();
      rebuildEditedPreview(false);
      renderEverything();
      return;
    }
  }

  function onPageListInput(event) {
    const scaleInput = event.target.closest("input[data-action='scale']");
    if (!scaleInput) {
      return;
    }
    const pageId = scaleInput.dataset.pageId;
    const page = state.pagesById.get(pageId);
    if (!page) {
      return;
    }
    const scalePercent = Number(scaleInput.value);
    page.scale = Math.max(0.25, Math.min(2, scalePercent / 100));
    rebuildEditedPreview(false);
    renderEverything();
  }

  function onTextListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const pageId = button.dataset.pageId;
    const textIndex = Number(button.dataset.textIndex);
    if (!pageId || !Number.isInteger(textIndex)) {
      return;
    }
    const marks = state.annotationsByPage.get(pageId);
    if (!marks || textIndex < 0 || textIndex >= marks.texts.length) {
      return;
    }
    const textItem = marks.texts[textIndex];
    const action = button.dataset.action;

    if (action === "text-edit") {
      const next = window.prompt("Edit text:", textItem.text);
      if (next === null) {
        return;
      }
      textItem.text = next;
      const canvasSize = getCanvasCssSize();
      const sizePx = Math.max(8, textItem.sizeNorm * canvasSize.height);
      textItem.widthNorm = estimateTextWidthNorm(next, sizePx, canvasSize.width);
      drawOverlay();
      renderTextList();
      setStatus("Updated text.", "ok");
      return;
    }

    if (action === "text-delete") {
      marks.texts.splice(textIndex, 1);
      drawOverlay();
      renderTextList();
      setStatus("Deleted text item.", "ok");
      return;
    }

    if (action === "text-size-plus" || action === "text-size-minus") {
      const delta = action === "text-size-plus" ? 0.01 : -0.01;
      textItem.sizeNorm = Math.max(0.01, Math.min(0.3, textItem.sizeNorm + delta));
      const canvasSize = getCanvasCssSize();
      const sizePx = textItem.sizeNorm * canvasSize.height;
      textItem.widthNorm = estimateTextWidthNorm(
        textItem.text,
        sizePx,
        canvasSize.width
      );
      textItem.heightNorm = estimateTextHeightNorm(sizePx, canvasSize.height);
      drawOverlay();
      renderTextList();
      return;
    }
  }

  function onOverlayPointerDown(event) {
    if (!state.canEdit) {
      return;
    }
    const pageId = getCurrentPageId();
    if (!pageId) {
      return;
    }
    if (state.mode === "draw") {
      const point = getNormalizedPointerPoint(event);
      if (!point) {
        return;
      }
      const widthNorm = Number(sizeInput.value) / Math.max(1, getCanvasCssSize().width);
      state.drawing.pointerId = event.pointerId;
      state.drawing.currentStroke = {
        color: colorInput.value,
        widthNorm: Math.max(0.001, widthNorm),
        points: [point],
      };
      overlayCanvas.setPointerCapture(event.pointerId);
      drawOverlay();
      return;
    }

    if (state.mode === "text") {
      const point = getNormalizedPointerPoint(event);
      if (!point) {
        return;
      }
      const text = window.prompt("Enter text:");
      if (!text) {
        return;
      }
      const canvasSize = getCanvasCssSize();
      const sizePx = Math.max(10, Number(sizeInput.value) * 3);
      const marks = getOrCreatePageAnnotations(pageId);
      marks.texts.push({
        x: point.x,
        y: point.y,
        sizeNorm: sizePx / canvasSize.height,
        color: colorInput.value,
        text,
        widthNorm: estimateTextWidthNorm(text, sizePx, canvasSize.width),
        heightNorm: estimateTextHeightNorm(sizePx, canvasSize.height),
      });
      drawOverlay();
      renderTextList();
      setStatus("Placed text annotation.", "ok");
    }
  }

  function onOverlayPointerMove(event) {
    if (state.mode !== "draw") {
      return;
    }
    if (state.drawing.pointerId !== event.pointerId || !state.drawing.currentStroke) {
      return;
    }
    const point = getNormalizedPointerPoint(event);
    if (!point) {
      return;
    }
    state.drawing.currentStroke.points.push(point);
    drawOverlay();
  }

  function onOverlayPointerUp(event) {
    if (state.mode !== "draw") {
      return;
    }
    if (state.drawing.pointerId !== event.pointerId || !state.drawing.currentStroke) {
      return;
    }

    const pageId = getCurrentPageId();
    if (pageId) {
      const marks = getOrCreatePageAnnotations(pageId);
      const stroke = state.drawing.currentStroke;
      if (stroke.points.length === 1) {
        stroke.points.push({
          x: stroke.points[0].x + 0.0005,
          y: stroke.points[0].y + 0.0005,
        });
      }
      marks.strokes.push(stroke);
    }

    state.drawing.pointerId = null;
    state.drawing.currentStroke = null;
    drawOverlay();
  }

  function getNormalizedPointerPoint(event) {
    const rect = overlayCanvas.getBoundingClientRect();
    if (!rect.width || !rect.height) {
      return null;
    }
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  function initializePageModels(parsed) {
    state.pageOrder = [];
    state.pagesById = new Map();
    state.annotationsByPage = new Map();
    state.currentPageActiveIndex = 0;

    for (let i = 0; i < parsed.pages.length; i += 1) {
      const page = parsed.pages[i];
      const id = `${page.ref.num}_${page.ref.gen}_${i + 1}`;
      const model = {
        id,
        ref: page.ref,
        dictEntries: page.dictEntries,
        effectiveMediaBox: page.effectiveMediaBox,
        effectiveRotate: page.effectiveRotate,
        effectiveResources: page.effectiveResources,
        existingAnnotRefs: page.existingAnnotRefs,
        annotsResolved: page.annotsResolved,
        rotateDelta: 0,
        scale: 1,
        deleted: false,
      };
      state.pageOrder.push(id);
      state.pagesById.set(id, model);
      state.annotationsByPage.set(id, { strokes: [], texts: [] });
    }
  }

  function rebuildEditedPreview(includeAnnotations) {
    if (!state.canEdit || !state.parsed) {
      return;
    }
    try {
      const bytes = buildEditedPdf(includeAnnotations);
      updatePreviewBlob(bytes);
      setStatus(
        includeAnnotations
          ? "Preview updated with drawing/text."
          : "Preview updated.",
        "ok"
      );
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Failed to rebuild preview.", "error");
    }
  }

  function updatePreviewBlob(bytes) {
    state.previewBytes = bytes;
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
    }
    state.previewUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
  }

  function resetLoadedDocument() {
    if (state.sourceUrl) {
      URL.revokeObjectURL(state.sourceUrl);
    }
    if (state.previewUrl) {
      URL.revokeObjectURL(state.previewUrl);
    }
    state.fileName = "";
    state.sourceBytes = null;
    state.sourceUrl = "";
    state.previewBytes = null;
    state.previewUrl = "";
    state.parsed = null;
    state.canEdit = false;
    state.pageOrder = [];
    state.pagesById = new Map();
    state.annotationsByPage = new Map();
    state.currentPageActiveIndex = 0;
    state.mode = "view";
    state.drawing.pointerId = null;
    state.drawing.currentStroke = null;
    pdfFrame.removeAttribute("src");
  }

  function renderEverything() {
    const editable = state.canEdit && !!state.parsed;
    saveBtn.disabled = !editable;
    prevPageBtn.disabled = !editable || state.currentPageActiveIndex <= 0;
    nextPageBtn.disabled =
      !editable || state.currentPageActiveIndex >= getActivePageIds().length - 1;
    modeSelect.disabled = !editable;
    colorInput.disabled = !editable;
    sizeInput.disabled = !editable;
    clearMarksBtn.disabled = !editable;
    addCenteredTextBtn.disabled = !editable;
    modeSelect.value = state.mode;

    if (!state.sourceUrl) {
      pageIndicator.textContent = "No file loaded";
      pageList.innerHTML = "";
      textList.innerHTML = "";
      updateOverlayInteractivity();
      drawOverlay();
      return;
    }

    if (!editable) {
      pageIndicator.textContent = "View-only mode";
      pageList.innerHTML =
        '<div class="pages-help">This file can be viewed but not edited by this dependency-free editor.</div>';
      textList.innerHTML = "";
      pdfFrame.src = state.sourceUrl;
      updateOverlayInteractivity();
      drawOverlay();
      return;
    }

    normalizeCurrentPageIndex();
    renderPageList();
    renderTextList();
    renderPageIndicator();
    updatePdfFrameSource();
    updateOverlayInteractivity();
    drawOverlay();
  }

  function renderPageIndicator() {
    const active = getActivePageIds();
    if (!active.length) {
      pageIndicator.textContent = "No pages";
      return;
    }
    const pageNumber = state.currentPageActiveIndex + 1;
    pageIndicator.textContent = `Page ${pageNumber} / ${active.length}`;
  }

  function renderPageList() {
    const currentId = getCurrentPageId();
    const activeIds = getActivePageIds();
    const activeIndexMap = new Map();
    for (let i = 0; i < activeIds.length; i += 1) {
      activeIndexMap.set(activeIds[i], i + 1);
    }

    const html = state.pageOrder
      .map((id, orderIndex) => {
        const page = state.pagesById.get(id);
        if (!page) {
          return "";
        }
        const isSelected = id === currentId;
        const classes = ["page-row"];
        if (isSelected) {
          classes.push("selected");
        }
        if (page.deleted) {
          classes.push("deleted");
        }

        const activeLabel = page.deleted
          ? "deleted"
          : `output #${activeIndexMap.get(id) || "-"}`;
        const rotateTotal = normalizeRotation(page.effectiveRotate + page.rotateDelta);
        const scalePercent = Math.round(page.scale * 100);

        return `
          <article class="${classes.join(" ")}">
            <div class="page-row-head">
              <strong>Source page ${orderIndex + 1}</strong>
              <span class="page-row-meta">${activeLabel}</span>
            </div>
            <div class="page-row-meta">rotate: ${rotateTotal}° | scale: ${scalePercent}%</div>
            <div class="page-row-controls">
              <button type="button" data-action="select" data-page-id="${id}" ${
          page.deleted ? "disabled" : ""
        }>Open</button>
              <button type="button" data-action="up" data-page-id="${id}" ${
          orderIndex === 0 ? "disabled" : ""
        }>Up</button>
              <button type="button" data-action="down" data-page-id="${id}" ${
          orderIndex === state.pageOrder.length - 1 ? "disabled" : ""
        }>Down</button>
              <button type="button" data-action="rotate-left" data-page-id="${id}">Rotate -90</button>
              <button type="button" data-action="rotate-right" data-page-id="${id}">Rotate +90</button>
              <button type="button" class="danger" data-action="delete-toggle" data-page-id="${id}">
                ${page.deleted ? "Restore" : "Delete"}
              </button>
            </div>
            <label class="page-row-meta" for="scale_${id}">Scale</label>
            <input
              id="scale_${id}"
              type="range"
              min="25"
              max="200"
              step="5"
              value="${scalePercent}"
              data-action="scale"
              data-page-id="${id}"
            >
          </article>
        `;
      })
      .join("");

    pageList.innerHTML = html;
  }

  function renderTextList() {
    const pageId = getCurrentPageId();
    if (!pageId) {
      textList.innerHTML = "";
      return;
    }
    const marks = state.annotationsByPage.get(pageId);
    if (!marks || !marks.texts.length) {
      textList.innerHTML =
        '<div class="pages-help">No text items on this page. Use text mode or "Add Centered Text".</div>';
      return;
    }

    textList.innerHTML = marks.texts
      .map((item, index) => {
        const preview = escapeHtml(item.text).slice(0, 120);
        const sizePx = Math.round(item.sizeNorm * getCanvasCssSize().height);
        return `
          <div class="text-item">
            <div class="text-item-head">#${index + 1}: ${preview || "(empty)"} | ${sizePx}px</div>
            <div class="text-item-actions">
              <button type="button" data-action="text-edit" data-page-id="${pageId}" data-text-index="${index}">Edit</button>
              <button type="button" data-action="text-size-minus" data-page-id="${pageId}" data-text-index="${index}">A-</button>
              <button type="button" data-action="text-size-plus" data-page-id="${pageId}" data-text-index="${index}">A+</button>
              <button type="button" class="danger" data-action="text-delete" data-page-id="${pageId}" data-text-index="${index}">Delete</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  function updatePdfFrameSource() {
    const activeCount = getActivePageIds().length;
    if (!activeCount) {
      pdfFrame.removeAttribute("src");
      return;
    }
    const baseUrl = state.previewUrl || state.sourceUrl;
    const page = state.currentPageActiveIndex + 1;
    const nextSrc = `${baseUrl}#page=${page}&view=FitH&toolbar=0&navpanes=0&scrollbar=0`;
    if (pdfFrame.src !== nextSrc) {
      pdfFrame.src = nextSrc;
    }
  }

  function drawOverlay() {
    resizeOverlayCanvas();
    const { width, height } = getCanvasCssSize();
    overlayCtx.clearRect(0, 0, width, height);

    if (!state.canEdit) {
      return;
    }
    const pageId = getCurrentPageId();
    if (!pageId) {
      return;
    }
    const marks = state.annotationsByPage.get(pageId);
    if (!marks) {
      return;
    }

    for (const stroke of marks.strokes) {
      drawStrokePreview(stroke, width, height);
    }
    if (state.drawing.currentStroke) {
      drawStrokePreview(state.drawing.currentStroke, width, height);
    }
    for (const textItem of marks.texts) {
      drawTextPreview(textItem, width, height);
    }
  }

  function drawStrokePreview(stroke, width, height) {
    if (!stroke || !stroke.points || stroke.points.length < 2) {
      return;
    }
    overlayCtx.save();
    overlayCtx.strokeStyle = stroke.color || "#ff0000";
    overlayCtx.lineCap = "round";
    overlayCtx.lineJoin = "round";
    overlayCtx.lineWidth = Math.max(1, stroke.widthNorm * width);
    overlayCtx.beginPath();
    overlayCtx.moveTo(stroke.points[0].x * width, stroke.points[0].y * height);
    for (let i = 1; i < stroke.points.length; i += 1) {
      overlayCtx.lineTo(stroke.points[i].x * width, stroke.points[i].y * height);
    }
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function drawTextPreview(textItem, width, height) {
    overlayCtx.save();
    const fontPx = Math.max(8, Math.round(textItem.sizeNorm * height));
    overlayCtx.font = `${fontPx}px sans-serif`;
    overlayCtx.fillStyle = textItem.color || "#ffffff";
    overlayCtx.textBaseline = "top";
    overlayCtx.fillText(textItem.text || "", textItem.x * width, textItem.y * height);
    overlayCtx.restore();
  }

  function updateOverlayInteractivity() {
    if (!state.canEdit) {
      overlayCanvas.style.pointerEvents = "none";
      return;
    }
    if (state.mode === "draw" || state.mode === "text") {
      overlayCanvas.style.pointerEvents = "auto";
      overlayCanvas.style.cursor = state.mode === "draw" ? "crosshair" : "text";
      overlayCanvas.style.touchAction = "none";
      return;
    }
    overlayCanvas.style.pointerEvents = "none";
    overlayCanvas.style.cursor = "default";
    overlayCanvas.style.touchAction = "auto";
  }

  function resizeOverlayCanvas() {
    const rect = viewerContainer.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (overlayCanvas.width !== pixelWidth || overlayCanvas.height !== pixelHeight) {
      overlayCanvas.width = pixelWidth;
      overlayCanvas.height = pixelHeight;
      overlayCanvas.style.width = `${cssWidth}px`;
      overlayCanvas.style.height = `${cssHeight}px`;
    }
    overlayCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getCanvasCssSize() {
    const rect = overlayCanvas.getBoundingClientRect();
    return {
      width: Math.max(1, rect.width),
      height: Math.max(1, rect.height),
    };
  }

  function setCurrentPageActiveIndex(next) {
    const activeIds = getActivePageIds();
    if (!activeIds.length) {
      state.currentPageActiveIndex = 0;
      return;
    }
    state.currentPageActiveIndex = Math.max(
      0,
      Math.min(activeIds.length - 1, next)
    );
  }

  function normalizeCurrentPageIndex() {
    setCurrentPageActiveIndex(state.currentPageActiveIndex);
  }

  function getActivePageIds() {
    return state.pageOrder.filter((id) => {
      const page = state.pagesById.get(id);
      return page && !page.deleted;
    });
  }

  function getCurrentPageId() {
    const activeIds = getActivePageIds();
    if (!activeIds.length) {
      return "";
    }
    const idx = Math.max(
      0,
      Math.min(activeIds.length - 1, state.currentPageActiveIndex)
    );
    return activeIds[idx];
  }

  function getActiveIndexForPageId(pageId) {
    const activeIds = getActivePageIds();
    return activeIds.indexOf(pageId);
  }

  function getOrCreatePageAnnotations(pageId) {
    if (!state.annotationsByPage.has(pageId)) {
      state.annotationsByPage.set(pageId, { strokes: [], texts: [] });
    }
    return state.annotationsByPage.get(pageId);
  }

  function buildEditedPdf(includeAnnotations) {
    if (!state.parsed || !state.sourceBytes) {
      throw new Error("No editable PDF loaded.");
    }
    const activeIds = getActivePageIds();
    if (!activeIds.length) {
      throw new Error("No pages left to save.");
    }

    const newObjects = [];
    let nextObjNum = state.parsed.maxObjectNumber + 1;
    const pagesRootObjNum = nextObjNum;
    nextObjNum += 1;
    const catalogObjNum = nextObjNum;
    nextObjNum += 1;

    const newPageRefs = [];

    for (const pageId of activeIds) {
      const model = state.pagesById.get(pageId);
      if (!model) {
        continue;
      }

      const pageObjNum = nextObjNum;
      nextObjNum += 1;

      const finalMediaBox = scaleMediaBox(model.effectiveMediaBox, model.scale);
      const finalRotate = normalizeRotation(model.effectiveRotate + model.rotateDelta);
      const annotationRefs = [];

      if (includeAnnotations) {
        const marks = state.annotationsByPage.get(pageId);
        if (marks) {
          if (marks.strokes.length) {
            for (const stroke of marks.strokes) {
              const objNum = nextObjNum;
              nextObjNum += 1;
              const annotDict = buildInkAnnotationDict(
                stroke,
                finalMediaBox,
                `${pageObjNum} 0 R`
              );
              if (annotDict) {
                newObjects.push({ num: objNum, content: annotDict });
                annotationRefs.push(`${objNum} 0 R`);
              }
            }
          }
          if (marks.texts.length) {
            for (const textItem of marks.texts) {
              const objNum = nextObjNum;
              nextObjNum += 1;
              const annotDict = buildFreeTextAnnotationDict(
                textItem,
                finalMediaBox,
                `${pageObjNum} 0 R`
              );
              if (annotDict) {
                newObjects.push({ num: objNum, content: annotDict });
                annotationRefs.push(`${objNum} 0 R`);
              }
            }
          }
        }
      }

      const dict = new Map(model.dictEntries);
      dict.set("Type", "/Page");
      dict.set("Parent", `${pagesRootObjNum} 0 R`);
      dict.set("MediaBox", formatMediaBox(finalMediaBox));
      dict.set("Rotate", String(finalRotate));
      if (!dict.has("Resources") && model.effectiveResources) {
        dict.set("Resources", model.effectiveResources);
      }

      const existingAnnotRefs = model.annotsResolved
        ? model.existingAnnotRefs.slice()
        : [];
      if (annotationRefs.length || existingAnnotRefs.length) {
        const merged = existingAnnotRefs.concat(annotationRefs).join(" ");
        dict.set("Annots", `[${merged}]`);
      } else if (model.annotsResolved) {
        dict.delete("Annots");
      }

      const pageDictRaw = serializeDictionary(dict);
      newObjects.push({
        num: pageObjNum,
        content: pageDictRaw,
      });
      newPageRefs.push(`${pageObjNum} 0 R`);
    }

    const pagesRootDict = serializeDictionary(
      new Map([
        ["Type", "/Pages"],
        ["Count", String(newPageRefs.length)],
        ["Kids", `[${newPageRefs.join(" ")}]`],
      ])
    );
    newObjects.push({
      num: pagesRootObjNum,
      content: pagesRootDict,
    });

    const catalogDict = new Map(state.parsed.catalogEntries);
    catalogDict.set("Type", "/Catalog");
    catalogDict.set("Pages", `${pagesRootObjNum} 0 R`);
    newObjects.push({
      num: catalogObjNum,
      content: serializeDictionary(catalogDict),
    });

    return appendIncrementalUpdate(
      state.sourceBytes,
      newObjects,
      {
        rootObjNum: catalogObjNum,
        prevXref: state.parsed.startXrefOffset,
        sizeHint: state.parsed.trailerSize,
        infoRaw: state.parsed.trailerInfoRaw,
        idRaw: state.parsed.trailerIdRaw,
      }
    );
  }

  function buildInkAnnotationDict(stroke, mediaBox, pageRef) {
    if (!stroke || !stroke.points || stroke.points.length < 2) {
      return "";
    }
    const width = Math.max(1e-5, mediaBox[2] - mediaBox[0]);
    const height = Math.max(1e-5, mediaBox[3] - mediaBox[1]);

    const pdfPoints = stroke.points.map((point) => {
      const x = mediaBox[0] + point.x * width;
      const y = mediaBox[1] + (1 - point.y) * height;
      return { x, y };
    });

    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    const coordParts = [];

    for (const point of pdfPoints) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      coordParts.push(formatPdfNumber(point.x), formatPdfNumber(point.y));
    }

    const lineWidth = Math.max(0.5, stroke.widthNorm * width);
    const pad = lineWidth * 2;
    const rect = [
      formatPdfNumber(minX - pad),
      formatPdfNumber(minY - pad),
      formatPdfNumber(maxX + pad),
      formatPdfNumber(maxY + pad),
    ];
    const color = hexToRgb01(stroke.color);
    const colorArray = `[${formatPdfNumber(color.r)} ${formatPdfNumber(
      color.g
    )} ${formatPdfNumber(color.b)}]`;

    return serializeDictionary(
      new Map([
        ["Type", "/Annot"],
        ["Subtype", "/Ink"],
        ["Rect", `[${rect.join(" ")}]`],
        ["Border", `[0 0 ${formatPdfNumber(lineWidth)}]`],
        ["C", colorArray],
        ["F", "4"],
        ["P", pageRef],
        ["InkList", `[[${coordParts.join(" ")}]]`],
      ])
    );
  }

  function buildFreeTextAnnotationDict(textItem, mediaBox, pageRef) {
    const text = (textItem && textItem.text) || "";
    if (!text.trim()) {
      return "";
    }
    const width = Math.max(1e-5, mediaBox[2] - mediaBox[0]);
    const height = Math.max(1e-5, mediaBox[3] - mediaBox[1]);

    const boxWidth = Math.max(12, (textItem.widthNorm || 0.2) * width);
    const boxHeight = Math.max(8, (textItem.heightNorm || 0.04) * height);

    const left = mediaBox[0] + textItem.x * width;
    const top = mediaBox[1] + (1 - textItem.y) * height;
    const right = left + boxWidth;
    const bottom = top - boxHeight;

    const color = hexToRgb01(textItem.color);
    const fontSize = Math.max(6, (textItem.sizeNorm || 0.02) * height);
    const daRaw = `/Helvetica ${formatPdfNumber(fontSize)} Tf ${formatPdfNumber(
      color.r
    )} ${formatPdfNumber(color.g)} ${formatPdfNumber(color.b)} rg`;

    return serializeDictionary(
      new Map([
        ["Type", "/Annot"],
        ["Subtype", "/FreeText"],
        [
          "Rect",
          `[${formatPdfNumber(left)} ${formatPdfNumber(bottom)} ${formatPdfNumber(
            right
          )} ${formatPdfNumber(top)}]`,
        ],
        ["Contents", toPdfUtf16HexString(text)],
        ["DA", `(${escapePdfLiteral(daRaw)})`],
        ["C", `[${formatPdfNumber(color.r)} ${formatPdfNumber(color.g)} ${formatPdfNumber(color.b)}]`],
        ["F", "4"],
        ["Q", "0"],
        ["P", pageRef],
      ])
    );
  }

  function appendIncrementalUpdate(sourceBytes, newObjects, trailerData) {
    if (!newObjects.length) {
      throw new Error("Nothing to write.");
    }

    const objects = newObjects
      .slice()
      .sort((a, b) => a.num - b.num);
    const firstObj = objects[0].num;
    const lastObj = objects[objects.length - 1].num;

    let append = "\n";
    const offsets = new Map();

    for (const object of objects) {
      const offset = sourceBytes.length + append.length;
      offsets.set(object.num, offset);
      append += `${object.num} 0 obj\n${object.content}\nendobj\n`;
    }

    const xrefOffset = sourceBytes.length + append.length;
    append += `xref\n${firstObj} ${lastObj - firstObj + 1}\n`;
    for (let number = firstObj; number <= lastObj; number += 1) {
      if (offsets.has(number)) {
        append += `${String(offsets.get(number)).padStart(10, "0")} 00000 n \n`;
      } else {
        append += "0000000000 65535 f \n";
      }
    }

    const trailerParts = [];
    trailerParts.push(
      `/Size ${Math.max(trailerData.sizeHint || 0, lastObj + 1)}`
    );
    trailerParts.push(`/Root ${trailerData.rootObjNum} 0 R`);
    trailerParts.push(`/Prev ${trailerData.prevXref}`);
    if (trailerData.infoRaw) {
      trailerParts.push(`/Info ${trailerData.infoRaw}`);
    }
    if (trailerData.idRaw) {
      trailerParts.push(`/ID ${trailerData.idRaw}`);
    }

    append += `trailer\n<<\n${trailerParts.join("\n")}\n>>\nstartxref\n${xrefOffset}\n%%EOF\n`;

    const appendBytes = encoder.encode(append);
    const output = new Uint8Array(sourceBytes.length + appendBytes.length);
    output.set(sourceBytes, 0);
    output.set(appendBytes, sourceBytes.length);
    return output;
  }

  function parsePdfForEditing(bytes) {
    const pdfText = bytesToLatin1(bytes);
    if (!pdfText.startsWith("%PDF-")) {
      throw new Error("Not a PDF.");
    }

    const startXrefOffset = findStartXrefOffset(pdfText);
    const xrefData = parseClassicXrefChain(pdfText, startXrefOffset);
    if (!xrefData.rootRef) {
      throw new Error("Missing Root reference.");
    }

    const objects = buildObjectMapFromXref(pdfText, xrefData.objectEntries, startXrefOffset);
    const maxObjectNumber = getMaxObjectNumber(xrefData.objectEntries);
    const rootObject = objects.get(xrefData.rootRef.num);
    if (!rootObject) {
      throw new Error("Unable to read catalog object.");
    }

    const catalogDictRaw = extractFirstDictionary(rootObject.body);
    if (!catalogDictRaw) {
      throw new Error("Catalog dictionary not found.");
    }
    const catalogEntries = parseDictionaryEntries(catalogDictRaw);
    const pagesRef = parseRef(catalogEntries.get("Pages"));
    if (!pagesRef) {
      throw new Error("Catalog has no Pages reference.");
    }

    const pages = [];
    const walkVisited = new Set();
    walkPageTree(objects, pagesRef, {}, walkVisited, pages);
    if (!pages.length) {
      throw new Error("No pages found.");
    }

    return {
      startXrefOffset,
      trailerSize: xrefData.trailerSize,
      trailerInfoRaw: xrefData.trailerInfoRaw,
      trailerIdRaw: xrefData.trailerIdRaw,
      rootRef: xrefData.rootRef,
      objects,
      maxObjectNumber,
      catalogEntries,
      pages,
    };
  }

  function walkPageTree(objects, nodeRef, inherited, visited, pagesOut) {
    const key = `${nodeRef.num}_${nodeRef.gen}`;
    if (visited.has(key)) {
      return;
    }
    visited.add(key);

    const object = objects.get(nodeRef.num);
    if (!object) {
      throw new Error(`Missing page tree object ${nodeRef.num} ${nodeRef.gen} R`);
    }
    const dictRaw = extractFirstDictionary(object.body);
    if (!dictRaw) {
      throw new Error(`Missing dictionary for object ${nodeRef.num}`);
    }
    const dictEntries = parseDictionaryEntries(dictRaw);
    const type = (dictEntries.get("Type") || "").trim();

    const inheritedNext = Object.assign({}, inherited);
    for (const name of ["MediaBox", "Rotate", "Resources", "CropBox"]) {
      if (dictEntries.has(name)) {
        inheritedNext[name] = dictEntries.get(name);
      }
    }

    if (type === "/Pages" || dictEntries.has("Kids")) {
      const kidsRaw = dictEntries.get("Kids");
      const kids = extractRefs(kidsRaw);
      for (const kid of kids) {
        walkPageTree(objects, kid, inheritedNext, visited, pagesOut);
      }
      return;
    }

    const effectiveMediaRaw =
      dictEntries.get("MediaBox") || inheritedNext.MediaBox || "[0 0 612 792]";
    const effectiveRotateRaw = dictEntries.get("Rotate") || inheritedNext.Rotate || "0";
    const effectiveResources = dictEntries.get("Resources") || inheritedNext.Resources || "";
    const media = parseMediaBox(effectiveMediaRaw) || [0, 0, 612, 792];
    const rotate = parseNumberOrZero(effectiveRotateRaw);
    const annotsRaw = dictEntries.get("Annots") || "";
    const annots = resolveAnnotationRefs(annotsRaw, objects);

    pagesOut.push({
      ref: nodeRef,
      dictEntries,
      effectiveMediaBox: media,
      effectiveRotate: normalizeRotation(rotate),
      effectiveResources,
      existingAnnotRefs: annots.refs,
      annotsResolved: annots.resolved,
    });
  }

  function resolveAnnotationRefs(annotsRaw, objects) {
    if (!annotsRaw) {
      return { refs: [], resolved: true };
    }
    const trimmed = annotsRaw.trim();
    if (trimmed.startsWith("[")) {
      return { refs: extractRefs(trimmed).map((ref) => `${ref.num} ${ref.gen} R`), resolved: true };
    }
    const annotsRef = parseRef(trimmed);
    if (!annotsRef) {
      return { refs: [], resolved: false };
    }
    const annotsObj = objects.get(annotsRef.num);
    if (!annotsObj) {
      return { refs: [], resolved: false };
    }
    const arrayRaw = extractFirstArray(annotsObj.body);
    if (!arrayRaw) {
      return { refs: [], resolved: false };
    }
    const refs = extractRefs(arrayRaw).map((ref) => `${ref.num} ${ref.gen} R`);
    return { refs, resolved: true };
  }

  function parseClassicXrefChain(pdfText, startXrefOffset) {
    let nextOffset = startXrefOffset;
    const visited = new Set();
    const objectEntries = new Map();
    let latestTrailer = null;

    while (nextOffset > 0 && !visited.has(nextOffset)) {
      visited.add(nextOffset);
      const section = parseSingleXrefSection(pdfText, nextOffset);
      if (!latestTrailer) {
        latestTrailer = section.trailerMap;
      }
      for (const entry of section.entries) {
        if (entry.inUse && !objectEntries.has(entry.number)) {
          objectEntries.set(entry.number, {
            number: entry.number,
            generation: entry.generation,
            offset: entry.offset,
          });
        }
      }
      const prevValue = section.trailerMap.get("Prev");
      nextOffset = prevValue ? parseNumberOrZero(prevValue) : 0;
    }

    if (!latestTrailer) {
      throw new Error("Unable to parse trailer.");
    }
    if (latestTrailer.has("Encrypt")) {
      throw new Error("Encrypted PDFs are not supported.");
    }

    return {
      objectEntries,
      rootRef: parseRef(latestTrailer.get("Root")),
      trailerSize: parseNumberOrZero(latestTrailer.get("Size")),
      trailerInfoRaw: latestTrailer.get("Info") || "",
      trailerIdRaw: latestTrailer.get("ID") || "",
    };
  }

  function parseSingleXrefSection(pdfText, offset) {
    let index = skipPdfWhitespace(pdfText, offset);
    if (!pdfText.startsWith("xref", index)) {
      throw new Error("XRef stream PDFs are not supported by this editor.");
    }
    index += 4;
    index = skipLineBreaks(pdfText, index);

    const entries = [];
    while (index < pdfText.length) {
      index = skipPdfWhitespace(pdfText, index);
      if (pdfText.startsWith("trailer", index)) {
        index += "trailer".length;
        break;
      }
      const headerLine = readLine(pdfText, index);
      index = headerLine.next;
      const headerMatch = headerLine.line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!headerMatch) {
        throw new Error("Malformed xref subsection header.");
      }
      const startNum = Number(headerMatch[1]);
      const count = Number(headerMatch[2]);
      for (let i = 0; i < count; i += 1) {
        const entryLine = readLine(pdfText, index);
        index = entryLine.next;
        const match = entryLine.line.match(/^(\d{10})\s+(\d{5})\s+([nf])/);
        if (!match) {
          continue;
        }
        entries.push({
          number: startNum + i,
          offset: Number(match[1]),
          generation: Number(match[2]),
          inUse: match[3] === "n",
        });
      }
    }

    index = skipPdfWhitespace(pdfText, index);
    if (pdfText.slice(index, index + 2) !== "<<") {
      throw new Error("Trailer dictionary missing.");
    }
    const trailerObj = readPdfObject(pdfText, index);
    if (!trailerObj || !trailerObj.raw.startsWith("<<")) {
      throw new Error("Invalid trailer dictionary.");
    }
    return {
      entries,
      trailerMap: parseDictionaryEntries(trailerObj.raw),
    };
  }

  function buildObjectMapFromXref(pdfText, objectEntries, startXrefOffset) {
    const entries = Array.from(objectEntries.values()).sort(
      (a, b) => a.offset - b.offset
    );
    const objects = new Map();

    for (let i = 0; i < entries.length; i += 1) {
      const entry = entries[i];
      const next = entries[i + 1];
      const endOffset = next ? next.offset : startXrefOffset;
      if (entry.offset <= 0 || endOffset <= entry.offset) {
        continue;
      }
      const segment = pdfText.slice(entry.offset, endOffset);
      const headerMatch = segment.match(/^\s*(\d+)\s+(\d+)\s+obj\b/);
      if (!headerMatch) {
        continue;
      }
      const bodyStart = (headerMatch.index || 0) + headerMatch[0].length;
      let bodyEnd = segment.lastIndexOf("endobj");
      if (bodyEnd < bodyStart) {
        bodyEnd = segment.length;
      }
      const body = segment.slice(bodyStart, bodyEnd).trim();
      objects.set(entry.number, {
        number: entry.number,
        generation: entry.generation,
        body,
      });
    }
    return objects;
  }

  function getMaxObjectNumber(objectEntries) {
    let max = 0;
    for (const entry of objectEntries.values()) {
      if (entry.number > max) {
        max = entry.number;
      }
    }
    return max;
  }

  function findStartXrefOffset(pdfText) {
    const regex = /startxref\s+(\d+)\s+%%EOF/g;
    let match;
    let last = null;
    while ((match = regex.exec(pdfText)) !== null) {
      last = match;
    }
    if (!last) {
      throw new Error("startxref not found.");
    }
    return Number(last[1]);
  }

  function extractFirstDictionary(text) {
    if (!text) {
      return "";
    }
    const start = text.indexOf("<<");
    if (start === -1) {
      return "";
    }
    const obj = readPdfObject(text, start);
    if (!obj || !obj.raw.startsWith("<<")) {
      return "";
    }
    return obj.raw;
  }

  function extractFirstArray(text) {
    if (!text) {
      return "";
    }
    const start = text.indexOf("[");
    if (start === -1) {
      return "";
    }
    const obj = readPdfObject(text, start);
    if (!obj || !obj.raw.startsWith("[")) {
      return "";
    }
    return obj.raw;
  }

  function parseDictionaryEntries(dictRaw) {
    const result = new Map();
    if (!dictRaw || !dictRaw.startsWith("<<")) {
      return result;
    }
    let index = 2;
    while (index < dictRaw.length) {
      index = skipPdfWhitespace(dictRaw, index);
      if (dictRaw.startsWith(">>", index)) {
        break;
      }
      if (dictRaw[index] !== "/") {
        const junk = readPdfObject(dictRaw, index);
        if (!junk) {
          break;
        }
        index = junk.end;
        continue;
      }
      const keyObj = readPdfName(dictRaw, index);
      const key = keyObj.raw.slice(1);
      index = skipPdfWhitespace(dictRaw, keyObj.end);
      const valueObj = readPdfObject(dictRaw, index);
      if (!valueObj) {
        break;
      }
      result.set(key, valueObj.raw.trim());
      index = valueObj.end;
    }
    return result;
  }

  function serializeDictionary(entries) {
    const lines = ["<<"];
    for (const [key, value] of entries) {
      if (value === undefined || value === null || String(value).trim() === "") {
        continue;
      }
      lines.push(`/${key} ${String(value).trim()}`);
    }
    lines.push(">>");
    return lines.join("\n");
  }

  function readPdfObject(text, start) {
    let index = skipPdfWhitespace(text, start);
    if (index >= text.length) {
      return null;
    }
    const char = text[index];

    if (char === "<" && text[index + 1] === "<") {
      return readPdfDictionary(text, index);
    }
    if (char === "[") {
      return readPdfArray(text, index);
    }
    if (char === "(") {
      return readPdfLiteralString(text, index);
    }
    if (char === "<") {
      return readPdfHexString(text, index);
    }
    if (char === "/") {
      return readPdfName(text, index);
    }

    const refMatch = text
      .slice(index)
      .match(/^([+-]?\d+(?:\.\d+)?)\s+([+-]?\d+)\s+R\b/);
    if (refMatch) {
      const end = index + refMatch[0].length;
      return { raw: text.slice(index, end), end };
    }

    let end = index;
    while (end < text.length && !isPdfDelimiter(text[end])) {
      end += 1;
    }
    return { raw: text.slice(index, end), end };
  }

  function readPdfDictionary(text, start) {
    let index = start + 2;
    while (index < text.length) {
      index = skipPdfWhitespace(text, index);
      if (text[index] === ">" && text[index + 1] === ">") {
        index += 2;
        return { raw: text.slice(start, index), end: index };
      }
      if (text[index] !== "/") {
        const stray = readPdfObject(text, index);
        if (!stray) {
          break;
        }
        index = stray.end;
        continue;
      }
      const key = readPdfName(text, index);
      index = skipPdfWhitespace(text, key.end);
      const value = readPdfObject(text, index);
      if (!value) {
        break;
      }
      index = value.end;
    }
    throw new Error("Unterminated PDF dictionary.");
  }

  function readPdfArray(text, start) {
    let index = start + 1;
    while (index < text.length) {
      index = skipPdfWhitespace(text, index);
      if (text[index] === "]") {
        index += 1;
        return { raw: text.slice(start, index), end: index };
      }
      const value = readPdfObject(text, index);
      if (!value) {
        break;
      }
      index = value.end;
    }
    throw new Error("Unterminated PDF array.");
  }

  function readPdfLiteralString(text, start) {
    let index = start + 1;
    let depth = 1;
    let escaped = false;
    while (index < text.length) {
      const char = text[index];
      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        index += 1;
        continue;
      }
      if (char === "(") {
        depth += 1;
      } else if (char === ")") {
        depth -= 1;
        if (depth === 0) {
          index += 1;
          return { raw: text.slice(start, index), end: index };
        }
      }
      index += 1;
    }
    throw new Error("Unterminated PDF literal string.");
  }

  function readPdfHexString(text, start) {
    let index = start + 1;
    while (index < text.length) {
      if (text[index] === ">") {
        index += 1;
        return { raw: text.slice(start, index), end: index };
      }
      index += 1;
    }
    throw new Error("Unterminated PDF hex string.");
  }

  function readPdfName(text, start) {
    let index = start + 1;
    while (index < text.length && !isPdfDelimiter(text[index])) {
      index += 1;
    }
    return { raw: text.slice(start, index), end: index };
  }

  function isPdfDelimiter(char) {
    return (
      char === " " ||
      char === "\n" ||
      char === "\r" ||
      char === "\t" ||
      char === "\f" ||
      char === "\0" ||
      char === "(" ||
      char === ")" ||
      char === "<" ||
      char === ">" ||
      char === "[" ||
      char === "]" ||
      char === "{" ||
      char === "}" ||
      char === "/" ||
      char === "%"
    );
  }

  function skipPdfWhitespace(text, start) {
    let index = start;
    while (index < text.length) {
      const char = text[index];
      if (
        char === " " ||
        char === "\n" ||
        char === "\r" ||
        char === "\t" ||
        char === "\f" ||
        char === "\0"
      ) {
        index += 1;
        continue;
      }
      if (char === "%") {
        while (index < text.length && text[index] !== "\n" && text[index] !== "\r") {
          index += 1;
        }
        continue;
      }
      break;
    }
    return index;
  }

  function skipLineBreaks(text, start) {
    let index = start;
    while (index < text.length && (text[index] === "\n" || text[index] === "\r")) {
      index += 1;
    }
    return index;
  }

  function readLine(text, start) {
    let end = start;
    while (end < text.length && text[end] !== "\n" && text[end] !== "\r") {
      end += 1;
    }
    let next = end;
    if (text[next] === "\r" && text[next + 1] === "\n") {
      next += 2;
    } else if (text[next] === "\n" || text[next] === "\r") {
      next += 1;
    }
    return {
      line: text.slice(start, end),
      next,
    };
  }

  function parseRef(valueRaw) {
    const raw = (valueRaw || "").trim();
    const match = raw.match(/^(\d+)\s+(\d+)\s+R$/);
    if (!match) {
      return null;
    }
    return {
      num: Number(match[1]),
      gen: Number(match[2]),
    };
  }

  function extractRefs(rawValue) {
    const refs = [];
    const raw = rawValue || "";
    const regex = /(\d+)\s+(\d+)\s+R/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      refs.push({ num: Number(match[1]), gen: Number(match[2]) });
    }
    return refs;
  }

  function parseMediaBox(rawValue) {
    const raw = rawValue || "";
    const numbers = raw.match(/[+-]?\d+(?:\.\d+)?/g);
    if (!numbers || numbers.length < 4) {
      return null;
    }
    const values = numbers.slice(0, 4).map(Number);
    if (values.some((value) => Number.isNaN(value))) {
      return null;
    }
    return values;
  }

  function scaleMediaBox(mediaBox, scale) {
    const factor = Number.isFinite(scale) ? scale : 1;
    const x0 = mediaBox[0];
    const y0 = mediaBox[1];
    const width = (mediaBox[2] - mediaBox[0]) * factor;
    const height = (mediaBox[3] - mediaBox[1]) * factor;
    return [x0, y0, x0 + width, y0 + height];
  }

  function formatMediaBox(mediaBox) {
    return `[${formatPdfNumber(mediaBox[0])} ${formatPdfNumber(
      mediaBox[1]
    )} ${formatPdfNumber(mediaBox[2])} ${formatPdfNumber(mediaBox[3])}]`;
  }

  function normalizeRotation(value) {
    const normalized = ((Math.round(value / 90) * 90) % 360 + 360) % 360;
    return normalized;
  }

  function parseNumberOrZero(raw) {
    const text = String(raw || "");
    const match = text.match(/[+-]?\d+(?:\.\d+)?/);
    if (!match) {
      return 0;
    }
    const parsed = Number(match[0]);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  function formatPdfNumber(value) {
    if (!Number.isFinite(value)) {
      return "0";
    }
    const fixed = Number(value).toFixed(4);
    return fixed.replace(/\.?0+$/, "");
  }

  function hexToRgb01(hex) {
    const normalized = (hex || "#000000").trim();
    const value = normalized.startsWith("#") ? normalized.slice(1) : normalized;
    const safe = value.length === 3
      ? value
          .split("")
          .map((c) => c + c)
          .join("")
      : value.padEnd(6, "0").slice(0, 6);
    const r = Number.parseInt(safe.slice(0, 2), 16) / 255;
    const g = Number.parseInt(safe.slice(2, 4), 16) / 255;
    const b = Number.parseInt(safe.slice(4, 6), 16) / 255;
    return {
      r: Number.isFinite(r) ? r : 0,
      g: Number.isFinite(g) ? g : 0,
      b: Number.isFinite(b) ? b : 0,
    };
  }

  function toPdfUtf16HexString(input) {
    const text = String(input || "");
    let hex = "FEFF";
    for (const char of text) {
      const codePoint = char.codePointAt(0);
      if (codePoint <= 0xffff) {
        hex += codePoint.toString(16).toUpperCase().padStart(4, "0");
      } else {
        const cp = codePoint - 0x10000;
        const high = 0xd800 + ((cp >> 10) & 0x3ff);
        const low = 0xdc00 + (cp & 0x3ff);
        hex += high.toString(16).toUpperCase().padStart(4, "0");
        hex += low.toString(16).toUpperCase().padStart(4, "0");
      }
    }
    return `<${hex}>`;
  }

  function escapePdfLiteral(input) {
    return String(input || "")
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
  }

  function estimateTextWidthNorm(text, sizePx, canvasWidth) {
    overlayCtx.save();
    overlayCtx.font = `${Math.max(8, sizePx)}px sans-serif`;
    const measured = overlayCtx.measureText(text || "");
    overlayCtx.restore();
    return Math.max(0.04, Math.min(0.9, measured.width / Math.max(1, canvasWidth)));
  }

  function estimateTextHeightNorm(sizePx, canvasHeight) {
    return Math.max(0.015, Math.min(0.4, (sizePx * 1.35) / Math.max(1, canvasHeight)));
  }

  function bytesToLatin1(bytes) {
    let out = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return out;
  }

  function downloadBytes(bytes, fileName) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function buildOutputFileName(originalName) {
    const base = originalName && originalName.trim() ? originalName.trim() : "document.pdf";
    const lower = base.toLowerCase();
    if (lower.endsWith(".pdf")) {
      return `${base.slice(0, -4)}-edited.pdf`;
    }
    return `${base}-edited.pdf`;
  }

  function setStatus(message, kind) {
    statusText.textContent = message;
    statusText.classList.remove("ok", "error");
    if (kind === "ok" || kind === "error") {
      statusText.classList.add(kind);
    }
  }

  function escapeHtml(text) {
    return String(text || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }
})();
