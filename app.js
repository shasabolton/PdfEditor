(function () {
  "use strict";

  const fileInput = document.getElementById("fileInput");
  const mergeFileInput = document.getElementById("mergeFileInput");
  const saveBtn = document.getElementById("saveBtn");
  const closeFileBtn = document.getElementById("closeFileBtn");
  const topbar = document.querySelector(".topbar");
  const modeSelect = document.getElementById("modeSelect");
  const zoomSelect = document.getElementById("zoomSelect");
  const modeToolPanel = document.getElementById("modeToolPanel");
  const statusText = document.getElementById("statusText");
  const downloadFallback = document.getElementById("downloadFallback");
  const downloadFallbackLink = document.getElementById("downloadFallbackLink");
  const openSavedBtn = document.getElementById("openSavedBtn");
  const allPagesScroll = document.getElementById("allPagesScroll");
  const viewerContainer = document.getElementById("viewerContainer");
  const pdfCanvas = document.getElementById("pdfCanvas");
  const pdfCtx = pdfCanvas.getContext("2d");
  const overlayCanvas = document.getElementById("overlayCanvas");
  const overlayCtx = overlayCanvas.getContext("2d");

  const encoder = new TextEncoder();

  const state = {
    fileName: "",
    sourceBytes: null,
    sourceUrl: "",
    previewDoc: null,
    pdfJsReady: false,
    pdfLibReady: false,
    activeRenderTask: null,
    renderRequestId: 0,
    renderBox: {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    },
    parsed: null,
    canEdit: false,
    editMode: "",
    selectedPageId: "",
    allPagesRenderToken: 0,
    pageZoom: 1,
    toolColor: "#d02626",
    toolSize: 4,
    mergePlacementPrompt: false,
    mergeTargetPageId: "",
    pendingMergePlacement: "",
    lastSavedUrl: "",
    lastSavedName: "",
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

  configurePdfJs();
  configurePdfLib();
  bindEvents();
  resizeOverlayCanvas();
  renderEverything();

  function bindEvents() {
    fileInput.addEventListener("change", onFileSelected);
    mergeFileInput.addEventListener("change", onMergeFileSelected);
    saveBtn.addEventListener("click", onSaveClick);
    closeFileBtn.addEventListener("click", onCloseFileClick);
    openSavedBtn.addEventListener("click", onOpenSavedClick);
    modeSelect.addEventListener("change", () => {
      state.mode = modeSelect.value;
      renderEverything();
    });
    zoomSelect.addEventListener("change", () => {
      const zoom = Number(zoomSelect.value);
      if (Number.isFinite(zoom)) {
        state.pageZoom = Math.max(0.1, Math.min(5, zoom));
        renderEverything();
      }
    });

    modeToolPanel.addEventListener("click", onModeToolPanelClick);
    modeToolPanel.addEventListener("input", onModeToolPanelInput);
    allPagesScroll.addEventListener("click", onAllPagesScrollClick);
    viewerContainer.addEventListener("wheel", onViewerWheelZoom, { passive: false });

    overlayCanvas.addEventListener("pointerdown", onOverlayPointerDown);
    overlayCanvas.addEventListener("pointermove", onOverlayPointerMove);
    overlayCanvas.addEventListener("pointerup", onOverlayPointerUp);
    overlayCanvas.addEventListener("pointercancel", onOverlayPointerUp);

    window.addEventListener("resize", () => {
      syncTopbarOffset();
      resizeOverlayCanvas();
      renderAllPagesScroll();
    });
  }

  function configurePdfJs() {
    try {
      if (!window.pdfjsLib || !window.pdfjsLib.GlobalWorkerOptions) {
        state.pdfJsReady = false;
        return;
      }
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = "vendor/pdf.worker.min.js";
      state.pdfJsReady = true;
    } catch (error) {
      console.error(error);
      state.pdfJsReady = false;
    }
  }

  function configurePdfLib() {
    state.pdfLibReady = !!(
      window.PDFLib &&
      window.PDFLib.PDFDocument &&
      window.PDFLib.degrees &&
      window.PDFLib.rgb
    );
  }

  function onFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) {
      return;
    }

    const reader = new FileReader();
    reader.onload = async () => {
      try {
        const bytes = new Uint8Array(reader.result);
        await loadDocumentFromBytes(bytes, file.name);
      } catch (error) {
        console.error(error);
        setStatus("Failed to open this PDF for preview.", "error");
      } finally {
        fileInput.value = "";
      }
    };
    reader.onerror = () => {
      setStatus("Unable to open file.", "error");
    };
    reader.readAsArrayBuffer(file);
  }

  async function loadDocumentFromBytes(bytes, fileName) {
    resetLoadedDocument();
    state.fileName = fileName || "document.pdf";
    state.sourceBytes = bytes;
    state.sourceUrl = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" })
    );

    if (!state.pdfJsReady) {
      setStatus(
        "Preview renderer failed to initialize. Editing is still available if PDF writer loads.",
        "error"
      );
    } else {
      const loadingTask = window.pdfjsLib.getDocument({
        data: bytes,
        disableWorker: true,
      });
      state.previewDoc = await loadingTask.promise;
    }

    const editableInit = await initializeEditableModels(bytes);
    let activeInit = editableInit;
    if (!editableInit.ok) {
      const rasterInit = await initializeRasterFallbackModels();
      if (rasterInit.ok) {
        activeInit = rasterInit;
      } else {
        state.canEdit = false;
        state.editMode = "";
        state.parsed = null;
        setStatus(
          rasterInit.reason ||
            editableInit.reason ||
            "Loaded in view-only mode. Save is disabled for this PDF.",
          "error"
        );
        renderEverything();
        return false;
      }
    }

    state.canEdit = true;
    state.editMode = activeInit.mode || "pdf-lib";
    state.parsed = {
      pageCount: activeInit.pages.length,
    };
    initializePageModels(activeInit.pages);
    state.currentPageActiveIndex = 0;
    if (state.previewDoc) {
      if (state.editMode === "raster-fallback") {
        setStatus(
          "PDF loaded in compatibility edit mode. Save works, but output pages are rasterized.",
          "ok"
        );
      } else {
        setStatus(
          "PDF loaded. Live preview uses in-app canvas rendering.",
          "ok"
        );
      }
    } else {
      setStatus(
        "PDF loaded, but preview renderer is unavailable in this environment.",
        "error"
      );
    }
    renderEverything();
    return true;
  }

  async function initializeEditableModels(bytes) {
    if (!state.pdfLibReady) {
      return {
        ok: false,
        mode: "",
        reason: "Loaded in view-only mode. The local PDF editing engine is unavailable.",
      };
    }
    try {
      const pdfDoc = await window.PDFLib.PDFDocument.load(bytes, {
        updateMetadata: false,
        throwOnInvalidObject: false,
        ignoreEncryption: true,
      });
      const pages = pdfDoc.getPages().map((page, index) => ({
        sourcePageNumber: index + 1,
        baseRotate: normalizeRotation(page.getRotation().angle || 0),
      }));
      if (!pages.length) {
        return {
          ok: false,
          mode: "",
          reason: "Loaded in view-only mode. This PDF has no readable pages.",
        };
      }
      return {
        ok: true,
        mode: "pdf-lib",
        pages,
      };
    } catch (error) {
      return {
        ok: false,
        mode: "",
        reason: getEditableLoadErrorMessage(error),
      };
    }
  }

  async function initializeRasterFallbackModels() {
    if (!state.previewDoc || !Number.isFinite(state.previewDoc.numPages)) {
      return {
        ok: false,
        mode: "",
        reason:
          "Loaded in view-only mode. PDF writer parse failed and raster fallback is unavailable.",
      };
    }
    const pages = [];
    for (let pageNumber = 1; pageNumber <= state.previewDoc.numPages; pageNumber += 1) {
      let baseRotate = 0;
      try {
        const sourcePage = await state.previewDoc.getPage(pageNumber);
        baseRotate = normalizeRotation(sourcePage.rotate || 0);
      } catch (error) {
        baseRotate = 0;
      }
      pages.push({
        sourcePageNumber: pageNumber,
        baseRotate,
      });
    }
    return {
      ok: true,
      mode: "raster-fallback",
      pages,
    };
  }

  function getEditableLoadErrorMessage(error) {
    const rawMessage = String((error && error.message) || "");
    const message = rawMessage.toLowerCase();
    if (message.includes("encrypted") || message.includes("password")) {
      return "Loaded in view-only mode. This PDF is encrypted/password-protected.";
    }
    return (
      "Loaded in view-only mode. Direct writer parse failed; trying compatibility mode. " +
      (rawMessage ? `Details: ${rawMessage.slice(0, 140)}` : "")
    ).trim();
  }

  async function onSaveClick() {
    if (!state.canEdit || !state.parsed) {
      setStatus("Load an editable PDF first.", "error");
      return;
    }
    try {
      setStatus("Preparing saved PDF...", "ok");
      let bytes;
      if (state.editMode === "raster-fallback") {
        bytes = await buildEditedPdfFromRasterPreview();
      } else {
        try {
          bytes = await buildEditedPdfWithPdfLib();
        } catch (directSaveError) {
          if (!state.previewDoc) {
            throw directSaveError;
          }
          bytes = await buildEditedPdfFromRasterPreview();
          state.editMode = "raster-fallback";
          setStatus(
            "Direct save failed; used compatibility raster save mode for this file.",
            "error"
          );
        }
      }
      const downloadName = buildOutputFileName(state.fileName);
      const delivery = await deliverSavedPdf(bytes, downloadName);
      const saveModeLabel =
        state.editMode === "raster-fallback" ? " (compatibility mode)" : "";
      const deliveryLabel =
        delivery.method === "share"
          ? " via share sheet."
          : delivery.method === "download"
            ? "."
            : ". If download did not start automatically, use Download Saved PDF.";
      setStatus(`Saved ${downloadName}${saveModeLabel}${deliveryLabel}`, "ok");
      renderEverything();
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Save failed.", "error");
    }
  }

  function onCloseFileClick() {
    resetLoadedDocument();
    setStatus("Closed file.", "ok");
    renderEverything();
  }

  async function onMergeFileSelected(event) {
    const file = event.target.files && event.target.files[0];
    mergeFileInput.value = "";
    const placement = state.pendingMergePlacement;
    state.pendingMergePlacement = "";
    if (!file) {
      return;
    }
    if (!placement) {
      setStatus("Choose Before or After first.", "error");
      return;
    }
    if (!state.canEdit || !state.parsed) {
      setStatus("Load an editable PDF before merging.", "error");
      return;
    }
    const selectedPageId = state.mergeTargetPageId || getCurrentPageId();
    if (!selectedPageId) {
      setStatus("Select a page before merging.", "error");
      return;
    }
    const anchorIndex = getActiveIndexForPageId(selectedPageId);
    if (anchorIndex < 0) {
      setStatus("Current page is not available for merge placement.", "error");
      return;
    }

    try {
      setStatus("Merging file...", "ok");
      const mergeBytes = new Uint8Array(await file.arrayBuffer());
      const currentBytes = await buildCurrentWorkingBytesForMerge();
      const merged = await mergePdfAtPosition(currentBytes, mergeBytes, placement, anchorIndex);
      const loaded = await loadDocumentFromBytes(merged.bytes, state.fileName || "document.pdf");
      if (!loaded) {
        state.mergePlacementPrompt = false;
        state.mergeTargetPageId = "";
        return;
      }
      const selectIndex =
        placement === "before"
          ? anchorIndex
          : anchorIndex + merged.insertedCount;
      setCurrentPageActiveIndex(selectIndex);
      const activeIds = getActivePageIds();
      state.selectedPageId =
        activeIds[Math.max(0, Math.min(activeIds.length - 1, selectIndex))] || "";
      state.mergePlacementPrompt = false;
      state.mergeTargetPageId = "";
      renderEverything();
      setStatus(
        `Merged ${file.name} ${placement} current page (${merged.insertedCount} pages).`,
        "ok"
      );
    } catch (error) {
      console.error(error);
      setStatus(error.message || "Merge failed.", "error");
    }
  }

  function onOpenSavedClick() {
    openSavedPdf();
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
    renderModeToolPanel();
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

    const canvasSize = getRenderCssSize();
    const sizePx = Math.max(10, getToolSize() * 3);
    const textItem = {
      x: 0.5,
      y: 0.5,
      sizeNorm: sizePx / canvasSize.height,
      color: getToolColor(),
      text: content,
      widthNorm: estimateTextWidthNorm(content, sizePx, canvasSize.width),
      heightNorm: estimateTextHeightNorm(sizePx, canvasSize.height),
    };
    const marks = getOrCreatePageAnnotations(pageId);
    marks.texts.push(textItem);
    drawOverlay();
    renderModeToolPanel();
    setStatus("Added text annotation.", "ok");
  }

  function onPageListClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }

    const pageId = button.dataset.pageId || state.selectedPageId;
    const action = button.dataset.action;
    if (!pageId || !action) {
      return;
    }

    const page = state.pagesById.get(pageId);
    if (!page) {
      return;
    }

    if (action === "select") {
      state.selectedPageId = pageId;
      const idx = getActiveIndexForPageId(pageId);
      if (idx >= 0) {
        state.currentPageActiveIndex = idx;
      }
      renderEverything();
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
      state.selectedPageId = pageId;
      renderEverything();
      return;
    }

    if (action === "rotate-right") {
      page.rotateDelta = normalizeRotation(page.rotateDelta + 90);
      state.selectedPageId = pageId;
      renderEverything();
      return;
    }

    if (action === "scale-down" || action === "scale-up") {
      const delta = action === "scale-up" ? 0.1 : -0.1;
      page.scale = Math.max(0.25, Math.min(2, page.scale + delta));
      state.selectedPageId = pageId;
      renderEverything();
      return;
    }

    if (action === "delete-toggle") {
      if (!page.deleted && getActivePageIds().length <= 1) {
        setStatus("At least one page must remain.", "error");
        return;
      }
      page.deleted = !page.deleted;
      if (page.deleted) {
        const activeIds = getActivePageIds();
        state.selectedPageId = activeIds[0] || "";
      } else {
        state.selectedPageId = pageId;
      }
      const idx = getActiveIndexForPageId(state.selectedPageId);
      if (idx >= 0) {
        state.currentPageActiveIndex = idx;
      }
      normalizeCurrentPageIndex();
      renderEverything();
      return;
    }
  }

  function onAllPagesScrollClick(event) {
    const card = event.target.closest("[data-page-id]");
    if (!card) {
      return;
    }
    const pageId = card.dataset.pageId;
    if (!pageId) {
      return;
    }
    state.selectedPageId = pageId;
    const idx = getActiveIndexForPageId(pageId);
    if (idx >= 0) {
      state.currentPageActiveIndex = idx;
    }
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
      const canvasSize = getRenderCssSize();
      const sizePx = Math.max(8, textItem.sizeNorm * canvasSize.height);
      textItem.widthNorm = estimateTextWidthNorm(next, sizePx, canvasSize.width);
      drawOverlay();
      renderModeToolPanel();
      setStatus("Updated text.", "ok");
      return;
    }

    if (action === "text-delete") {
      marks.texts.splice(textIndex, 1);
      drawOverlay();
      renderModeToolPanel();
      setStatus("Deleted text item.", "ok");
      return;
    }

    if (action === "text-size-plus" || action === "text-size-minus") {
      const delta = action === "text-size-plus" ? 0.01 : -0.01;
      textItem.sizeNorm = Math.max(0.01, Math.min(0.3, textItem.sizeNorm + delta));
      const canvasSize = getRenderCssSize();
      const sizePx = textItem.sizeNorm * canvasSize.height;
      textItem.widthNorm = estimateTextWidthNorm(
        textItem.text,
        sizePx,
        canvasSize.width
      );
      textItem.heightNorm = estimateTextHeightNorm(sizePx, canvasSize.height);
      drawOverlay();
      renderModeToolPanel();
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
      const widthNorm = getToolSize() / Math.max(1, getRenderCssSize().width);
      state.drawing.pointerId = event.pointerId;
      state.drawing.currentStroke = {
        color: getToolColor(),
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
      const canvasSize = getRenderCssSize();
      const sizePx = Math.max(10, getToolSize() * 3);
      const marks = getOrCreatePageAnnotations(pageId);
      marks.texts.push({
        x: point.x,
        y: point.y,
        sizeNorm: sizePx / canvasSize.height,
        color: getToolColor(),
        text,
        widthNorm: estimateTextWidthNorm(text, sizePx, canvasSize.width),
        heightNorm: estimateTextHeightNorm(sizePx, canvasSize.height),
      });
      drawOverlay();
      renderModeToolPanel();
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
    const xPx = event.clientX - rect.left;
    const yPx = event.clientY - rect.top;
    const box = state.renderBox;
    if (!box || box.width <= 0 || box.height <= 0) {
      return null;
    }
    if (
      xPx < box.left ||
      xPx > box.left + box.width ||
      yPx < box.top ||
      yPx > box.top + box.height
    ) {
      return null;
    }
    const x = (xPx - box.left) / box.width;
    const y = (yPx - box.top) / box.height;
    return {
      x: Math.max(0, Math.min(1, x)),
      y: Math.max(0, Math.min(1, y)),
    };
  }

  function initializePageModels(pageDescriptors) {
    state.pageOrder = [];
    state.pagesById = new Map();
    state.annotationsByPage = new Map();
    state.currentPageActiveIndex = 0;

    for (let i = 0; i < pageDescriptors.length; i += 1) {
      const page = pageDescriptors[i];
      const id = `page_${i + 1}`;
      const model = {
        id,
        sourcePageNumber: page.sourcePageNumber || i + 1,
        baseRotate: normalizeRotation(page.baseRotate || 0),
        rotateDelta: 0,
        scale: 1,
        deleted: false,
      };
      state.pageOrder.push(id);
      state.pagesById.set(id, model);
      state.annotationsByPage.set(id, { strokes: [], texts: [] });
    }
    state.selectedPageId = state.pageOrder[0] || "";
  }

  function resetLoadedDocument() {
    if (state.activeRenderTask && typeof state.activeRenderTask.cancel === "function") {
      try {
        state.activeRenderTask.cancel();
      } catch (error) {
        console.warn("Failed to cancel previous PDF render task.", error);
      }
    }
    state.activeRenderTask = null;
    state.renderRequestId += 1;

    if (state.previewDoc && typeof state.previewDoc.destroy === "function") {
      try {
        state.previewDoc.destroy();
      } catch (error) {
        console.warn("Failed to destroy previous preview document.", error);
      }
    }

    if (state.sourceUrl) {
      URL.revokeObjectURL(state.sourceUrl);
    }
    clearSavedDownload();
    state.fileName = "";
    state.sourceBytes = null;
    state.sourceUrl = "";
    state.previewDoc = null;
    state.parsed = null;
    state.canEdit = false;
    state.editMode = "";
    state.selectedPageId = "";
    state.allPagesRenderToken += 1;
    state.pageZoom = 1;
    state.mergePlacementPrompt = false;
    state.mergeTargetPageId = "";
    state.pendingMergePlacement = "";
    state.pageOrder = [];
    state.pagesById = new Map();
    state.annotationsByPage = new Map();
    state.currentPageActiveIndex = 0;
    state.mode = "view";
    state.drawing.pointerId = null;
    state.drawing.currentStroke = null;
    state.renderBox = {
      left: 0,
      top: 0,
      width: 0,
      height: 0,
    };
    if (allPagesScroll) {
      allPagesScroll.innerHTML = "";
    }
    clearPdfCanvas();
    drawOverlay();
  }

  function renderEverything() {
    const editable = state.canEdit && !!state.parsed;
    if (!editable && state.mode !== "view") {
      state.mode = "view";
    }
    if (state.mode !== "pages") {
      state.mergePlacementPrompt = false;
      state.pendingMergePlacement = "";
      state.mergeTargetPageId = "";
    }
    normalizeCurrentPageIndex();
    ensureSelectedPageId();
    updateSavedDownloadUI();
    updatePageRadiusScale();

    saveBtn.disabled = !editable;
    closeFileBtn.disabled = !state.sourceUrl;
    openSavedBtn.disabled = !state.lastSavedUrl;
    modeSelect.disabled = !editable;
    zoomSelect.disabled = !state.previewDoc;
    modeSelect.value = state.mode;
    setZoomSelectValue(state.pageZoom);
    viewerContainer.classList.add("ui-hidden");
    modeToolPanel.classList.toggle("hidden", !editable || state.mode === "view");
    renderModeToolPanel();
    syncTopbarOffset();

    if (!state.sourceUrl) {
      allPagesScroll.innerHTML = "";
      updateOverlayInteractivity();
      clearPdfCanvas();
      drawOverlay();
      return;
    }

    if (!editable) {
      modeToolPanel.classList.add("hidden");
    }

    updateOverlayInteractivity();
    renderAllPagesScroll();
  }

  function updatePageRadiusScale() {
    const radius = Math.max(2, Math.min(24, state.pageZoom * 6));
    document.documentElement.style.setProperty("--page-radius", `${radius}px`);
  }

  function syncTopbarOffset() {
    if (!topbar) {
      return;
    }
    const height = Math.max(0, Math.ceil(topbar.getBoundingClientRect().height));
    document.documentElement.style.setProperty("--topbar-height", `${height}px`);
  }

  function setZoomSelectValue(zoom) {
    if (!zoomSelect) {
      return;
    }
    let closestValue = zoomSelect.options[0] ? Number(zoomSelect.options[0].value) : 1;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const option of zoomSelect.options) {
      const optionValue = Number(option.value);
      const distance = Math.abs(optionValue - zoom);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestValue = optionValue;
      }
    }
    zoomSelect.value = String(closestValue);
  }

  function renderModeToolPanel() {
    if (!modeToolPanel) {
      return;
    }
    if (!state.canEdit || !state.parsed || state.mode === "view") {
      modeToolPanel.innerHTML = "";
      syncTopbarOffset();
      return;
    }

    const selectedId = state.selectedPageId || getCurrentPageId();
    const pageId = state.mode === "pages" ? selectedId : getCurrentPageId();
    const page = pageId ? state.pagesById.get(pageId) : null;
    if (!page) {
      modeToolPanel.innerHTML =
        '<div class="pages-help">No active page available for this mode.</div>';
      syncTopbarOffset();
      return;
    }

    if (state.mode === "pages") {
      const idx = state.pageOrder.indexOf(pageId);
      const outputIdx = getActiveIndexForPageId(pageId);
      const canMoveUp = !page.deleted && idx > 0;
      const canMoveDown = !page.deleted && idx >= 0 && idx < state.pageOrder.length - 1;
      const canDelete = page.deleted || getActivePageIds().length > 1;
      const showMergeChoice =
        state.mergePlacementPrompt && state.mergeTargetPageId === pageId && !page.deleted;
      modeToolPanel.innerHTML = `
        <div class="mode-tools-row">
          <strong>${page.deleted ? "Deleted page" : `Page ${outputIdx + 1}`}</strong>
          <button type="button" data-action="up" data-page-id="${pageId}" ${
        canMoveUp ? "" : "disabled"
      }>Up</button>
          <button type="button" data-action="down" data-page-id="${pageId}" ${
        canMoveDown ? "" : "disabled"
      }>Down</button>
          <button type="button" data-action="rotate-right" data-page-id="${pageId}" ${
        page.deleted ? "disabled" : ""
      }>+90</button>
          <button type="button" data-action="scale-down" data-page-id="${pageId}" ${
        page.scale <= 0.25 ? "disabled" : ""
      }>Scale-</button>
          <button type="button" data-action="scale-up" data-page-id="${pageId}" ${
        page.scale >= 2 ? "disabled" : ""
      }>Scale+</button>
          <button type="button" class="danger" data-action="delete-toggle" data-page-id="${pageId}" ${
        canDelete ? "" : "disabled"
      }>${page.deleted ? "Restore" : "Delete"}</button>
          <button type="button" data-action="merge-file" data-page-id="${pageId}" ${
        page.deleted ? "disabled" : ""
      }>Merge File</button>
        </div>
        ${
          showMergeChoice
            ? `<div class="mode-tools-row">
          <span class="pages-help">Insert merge file:</span>
          <button type="button" data-action="merge-before" data-page-id="${pageId}">Before</button>
          <button type="button" data-action="merge-after" data-page-id="${pageId}">After</button>
          <button type="button" data-action="merge-cancel" data-page-id="${pageId}">Cancel</button>
        </div>`
            : ""
        }
      `;
      syncTopbarOffset();
      return;
    }

    if (state.mode === "draw") {
      modeToolPanel.innerHTML = `
        <div class="mode-tools-row">
          <label for="toolColorInput">Color</label>
          <input id="toolColorInput" type="color" value="${escapeHtml(getToolColor())}">
          <label for="toolSizeInput">Size</label>
          <input id="toolSizeInput" type="range" min="1" max="24" step="1" value="${getToolSize()}">
          <button type="button" data-action="clear-marks">Clear Page Draw/Text</button>
        </div>
      `;
      syncTopbarOffset();
      return;
    }

    if (state.mode === "text") {
      const marks = state.annotationsByPage.get(pageId);
      const textItems = marks && marks.texts ? marks.texts : [];
      const listHtml = textItems.length
        ? textItems
            .map((item, index) => {
              const preview = escapeHtml(item.text).slice(0, 80);
              return `
                <div class="text-item">
                  <div class="text-item-head">#${index + 1}: ${preview || "(empty)"}</div>
                  <div class="text-item-actions">
                    <button type="button" data-action="text-edit" data-page-id="${pageId}" data-text-index="${index}">Edit</button>
                    <button type="button" data-action="text-size-minus" data-page-id="${pageId}" data-text-index="${index}">A-</button>
                    <button type="button" data-action="text-size-plus" data-page-id="${pageId}" data-text-index="${index}">A+</button>
                    <button type="button" class="danger" data-action="text-delete" data-page-id="${pageId}" data-text-index="${index}">Delete</button>
                  </div>
                </div>
              `;
            })
            .join("")
        : '<div class="pages-help">No text items on this page.</div>';
      modeToolPanel.innerHTML = `
        <div class="mode-tools-row">
          <label for="toolColorInput">Color</label>
          <input id="toolColorInput" type="color" value="${escapeHtml(getToolColor())}">
          <label for="toolSizeInput">Size</label>
          <input id="toolSizeInput" type="range" min="1" max="24" step="1" value="${getToolSize()}">
          <button type="button" data-action="add-centered-text">Add Centered Text</button>
          <button type="button" data-action="clear-marks">Clear Page Draw/Text</button>
        </div>
        <div class="mode-tools-list">${listHtml}</div>
      `;
      syncTopbarOffset();
    }
  }

  function onModeToolPanelClick(event) {
    const button = event.target.closest("button[data-action]");
    if (!button) {
      return;
    }
    const action = button.dataset.action || "";
    const pageId = button.dataset.pageId || getCurrentPageId();
    if (action === "merge-file") {
      if (!state.canEdit || !state.parsed) {
        setStatus("Load an editable PDF before merging.", "error");
        return;
      }
      if (!pageId) {
        setStatus("Select a page before merging.", "error");
        return;
      }
      state.mergeTargetPageId = pageId;
      state.mergePlacementPrompt = true;
      renderModeToolPanel();
      return;
    }
    if (action === "merge-cancel") {
      state.mergePlacementPrompt = false;
      state.mergeTargetPageId = "";
      state.pendingMergePlacement = "";
      renderModeToolPanel();
      return;
    }
    if (action === "merge-before" || action === "merge-after") {
      if (!pageId) {
        setStatus("Select a page before merging.", "error");
        return;
      }
      state.mergeTargetPageId = pageId;
      state.pendingMergePlacement = action === "merge-before" ? "before" : "after";
      mergeFileInput.click();
      return;
    }
    if (action === "clear-marks") {
      clearCurrentPageMarks();
      return;
    }
    if (action === "add-centered-text") {
      addCenteredText();
      return;
    }
    if (action.startsWith("text-")) {
      onTextListClick(event);
      return;
    }
    onPageListClick(event);
  }

  function onModeToolPanelInput(event) {
    const colorEl = event.target.closest("#toolColorInput");
    if (colorEl) {
      state.toolColor = colorEl.value || "#d02626";
      drawOverlay();
      return;
    }
    const sizeEl = event.target.closest("#toolSizeInput");
    if (sizeEl) {
      const value = Number(sizeEl.value);
      state.toolSize = Number.isFinite(value) ? value : 4;
      drawOverlay();
    }
  }

  function onViewerWheelZoom(event) {
    if (!state.canEdit || !state.parsed || state.mode === "view") {
      return;
    }
    event.preventDefault();
    applyWheelZoom(event.deltaY);
  }

  function applyWheelZoom(deltaY) {
    const direction = deltaY > 0 ? -1 : 1;
    const next = state.pageZoom + direction * 0.08;
    state.pageZoom = Math.max(0.1, Math.min(5, Number(next.toFixed(2))));
    renderEverything();
  }

  async function renderCurrentPdfPage(targetWidth) {
    if (!state.previewDoc) {
      clearPdfCanvas();
      state.renderBox = {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      };
      drawOverlay();
      return;
    }

    const pageNumber = getCurrentPreviewSourcePageNumber();
    if (!pageNumber) {
      clearPdfCanvas();
      state.renderBox = {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      };
      drawOverlay();
      return;
    }

    if (state.activeRenderTask && typeof state.activeRenderTask.cancel === "function") {
      try {
        state.activeRenderTask.cancel();
      } catch (error) {
        console.warn("Unable to cancel prior PDF render task.", error);
      }
    }
    state.activeRenderTask = null;

    const requestId = ++state.renderRequestId;
    try {
      const page = await state.previewDoc.getPage(pageNumber);
      if (requestId !== state.renderRequestId) {
        return;
      }

      const currentId = getCurrentPageId();
      const model = currentId ? state.pagesById.get(currentId) : null;
      const extraRotation = model ? model.rotateDelta : 0;
      const scaleMultiplier = model ? model.scale : 1;
      const rotation = normalizeRotation(page.rotate + extraRotation);

      const baseViewport = page.getViewport({ scale: 1, rotation });
      const widthTarget = Number.isFinite(targetWidth)
        ? Math.max(24, targetWidth)
        : Math.max(24, baseViewport.width);
      const widthScale = widthTarget / Math.max(1, baseViewport.width);
      const finalScale = Math.max(0.02, widthScale * Math.max(0.25, scaleMultiplier));
      const viewport = page.getViewport({ scale: finalScale, rotation });
      viewerContainer.style.width = `${Math.ceil(viewport.width)}px`;
      viewerContainer.style.height = `${Math.ceil(viewport.height)}px`;
      resizeOverlayCanvas();
      resizePdfCanvas();

      clearPdfCanvas();
      state.renderBox = {
        left: 0,
        top: 0,
        width: viewport.width,
        height: viewport.height,
      };

      const renderTask = page.render({
        canvasContext: pdfCtx,
        viewport,
      });
      state.activeRenderTask = renderTask;
      await renderTask.promise;
      if (requestId !== state.renderRequestId) {
        return;
      }
      state.activeRenderTask = null;
      drawOverlay();
    } catch (error) {
      if (String(error && error.name) === "RenderingCancelledException") {
        return;
      }
      console.error(error);
      setStatus("Preview rendering failed for this page.", "error");
      clearPdfCanvas();
      drawOverlay();
    }
  }

  async function renderAllPagesScroll() {
    if (!allPagesScroll) {
      return;
    }
    const token = ++state.allPagesRenderToken;

    if (!state.previewDoc) {
      allPagesScroll.innerHTML = "";
      return;
    }

    const items = [];
    if (state.canEdit && state.parsed) {
      const activeIds = getActivePageIds();
      const activeIndexMap = new Map();
      for (let i = 0; i < activeIds.length; i += 1) {
        activeIndexMap.set(activeIds[i], i + 1);
      }
      for (let i = 0; i < state.pageOrder.length; i += 1) {
        const id = state.pageOrder[i];
        const page = state.pagesById.get(id);
        if (!page) {
          continue;
        }
        items.push({
          key: id,
          pageId: id,
          pageNumber: page.sourcePageNumber,
          rotateDelta: page.rotateDelta,
          scale: page.scale,
          deleted: !!page.deleted,
          label: page.deleted
            ? `Page ${i + 1} (Deleted)`
            : `Page ${activeIndexMap.get(id) || i + 1}`,
          selected: id === state.selectedPageId,
        });
      }
    } else {
      const count = Math.max(0, state.previewDoc.numPages || 0);
      for (let i = 1; i <= count; i += 1) {
        items.push({
          key: `preview_${i}`,
          pageId: "",
          pageNumber: i,
          rotateDelta: 0,
          scale: 1,
          label: `Page ${i}`,
          selected: false,
        });
      }
    }

    if (!items.length) {
      allPagesScroll.innerHTML =
        '<div class="pages-help">No pages to preview.</div>';
      viewerContainer.classList.add("ui-hidden");
      return;
    }

    const selectedPage = state.selectedPageId ? state.pagesById.get(state.selectedPageId) : null;
    const inlineEditPageId =
      state.canEdit &&
      state.parsed &&
      state.mode !== "view" &&
      selectedPage &&
      !selectedPage.deleted
        ? state.selectedPageId
        : "";

    allPagesScroll.innerHTML = items
      .map((item) => {
        const classes = ["all-page-card"];
        if (item.selected) {
          classes.push("selected");
        }
        if (item.deleted) {
          classes.push("deleted");
        }
        const hasInlineEditor = !!inlineEditPageId && item.pageId === inlineEditPageId;
        return `
          <article class="${classes.join(" ")}" data-page-id="${item.pageId}">
            <div class="all-page-head">${item.label}</div>
            ${
              hasInlineEditor
                ? `<div class="inline-editor-host" data-inline-editor-page-id="${item.pageId}"></div>`
                : `<canvas class="all-page-canvas" data-canvas-key="${item.key}"></canvas>`
            }
          </article>
        `;
      })
      .join("");

    const baseWidth = Math.max(220, Math.min(360, allPagesScroll.clientWidth * 0.32 || 320));
    const maxWidth = Math.max(24, baseWidth * state.pageZoom);

    if (inlineEditPageId) {
      const host = allPagesScroll.querySelector(
        `[data-inline-editor-page-id="${inlineEditPageId}"]`
      );
      if (host) {
        host.appendChild(viewerContainer);
        viewerContainer.classList.remove("ui-hidden");
        await renderCurrentPdfPage(maxWidth);
      }
    } else {
      viewerContainer.classList.add("ui-hidden");
      viewerContainer.style.width = "";
      viewerContainer.style.height = "";
      state.renderBox = {
        left: 0,
        top: 0,
        width: 0,
        height: 0,
      };
      drawOverlay();
    }
    for (const item of items) {
      if (token !== state.allPagesRenderToken) {
        return;
      }
      if (inlineEditPageId && item.pageId === inlineEditPageId) {
        continue;
      }
      const canvas = allPagesScroll.querySelector(
        `canvas[data-canvas-key="${item.key}"]`
      );
      if (!canvas) {
        continue;
      }
      try {
        await renderDocPageToCanvas(item, canvas, maxWidth);
      } catch (error) {
        console.warn("Unable to render all-pages preview canvas.", error);
      }
    }
  }

  async function renderDocPageToCanvas(item, canvas, targetWidth) {
    const page = await state.previewDoc.getPage(item.pageNumber);
    const rotation = normalizeRotation((page.rotate || 0) + (item.rotateDelta || 0));
    const baseViewport = page.getViewport({ scale: 1, rotation });
    const fitScale = targetWidth / Math.max(1, baseViewport.width);
    const finalScale = Math.max(0.08, fitScale * Math.max(0.25, item.scale || 1));
    const viewport = page.getViewport({ scale: finalScale, rotation });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelWidth = Math.max(1, Math.floor(viewport.width * dpr));
    const pixelHeight = Math.max(1, Math.floor(viewport.height * dpr));

    if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
      canvas.width = pixelWidth;
      canvas.height = pixelHeight;
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
    }

    const ctx = canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, viewport.width, viewport.height);
    const task = page.render({
      canvasContext: ctx,
      viewport,
    });
    await task.promise;
  }

  function clearPdfCanvas() {
    const rect = viewerContainer.getBoundingClientRect();
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    pdfCtx.clearRect(0, 0, width, height);
  }

  function resizePdfCanvas() {
    const rect = viewerContainer.getBoundingClientRect();
    const cssWidth = Math.max(1, Math.floor(rect.width));
    const cssHeight = Math.max(1, Math.floor(rect.height));
    const dpr = window.devicePixelRatio || 1;
    const pixelWidth = Math.max(1, Math.floor(cssWidth * dpr));
    const pixelHeight = Math.max(1, Math.floor(cssHeight * dpr));

    if (pdfCanvas.width !== pixelWidth || pdfCanvas.height !== pixelHeight) {
      pdfCanvas.width = pixelWidth;
      pdfCanvas.height = pixelHeight;
      pdfCanvas.style.width = `${cssWidth}px`;
      pdfCanvas.style.height = `${cssHeight}px`;
    }
    pdfCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function getCurrentPreviewSourcePageNumber() {
    if (!state.previewDoc) {
      return 0;
    }
    const maxPages = Math.max(1, state.previewDoc.numPages || 1);
    if (!state.canEdit || !state.parsed) {
      return Math.max(1, Math.min(maxPages, state.currentPageActiveIndex + 1));
    }
    const pageId = getCurrentPageId();
    const page = pageId ? state.pagesById.get(pageId) : null;
    if (!page) {
      return Math.max(1, Math.min(maxPages, state.currentPageActiveIndex + 1));
    }
    return Math.max(1, Math.min(maxPages, page.sourcePageNumber));
  }

  function getPreviewPageCount() {
    if (state.canEdit && state.parsed) {
      return getActivePageIds().length;
    }
    if (state.previewDoc && Number.isFinite(state.previewDoc.numPages)) {
      return Math.max(0, state.previewDoc.numPages);
    }
    return 0;
  }

  function drawOverlay() {
    resizeOverlayCanvas();
    const { width, height } = getCanvasCssSize();
    overlayCtx.clearRect(0, 0, width, height);

    if (!state.canEdit) {
      return;
    }
    if (!state.renderBox.width || !state.renderBox.height) {
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
      drawStrokePreview(stroke);
    }
    if (state.drawing.currentStroke) {
      drawStrokePreview(state.drawing.currentStroke);
    }
    for (const textItem of marks.texts) {
      drawTextPreview(textItem);
    }
  }

  function drawStrokePreview(stroke) {
    if (!stroke || !stroke.points || stroke.points.length < 2) {
      return;
    }
    const box = state.renderBox;
    if (!box || !box.width || !box.height) {
      return;
    }
    overlayCtx.save();
    overlayCtx.strokeStyle = stroke.color || "#ff0000";
    overlayCtx.lineCap = "round";
    overlayCtx.lineJoin = "round";
    overlayCtx.lineWidth = Math.max(1, stroke.widthNorm * box.width);
    overlayCtx.beginPath();
    overlayCtx.moveTo(
      box.left + stroke.points[0].x * box.width,
      box.top + stroke.points[0].y * box.height
    );
    for (let i = 1; i < stroke.points.length; i += 1) {
      overlayCtx.lineTo(
        box.left + stroke.points[i].x * box.width,
        box.top + stroke.points[i].y * box.height
      );
    }
    overlayCtx.stroke();
    overlayCtx.restore();
  }

  function drawTextPreview(textItem) {
    const box = state.renderBox;
    if (!box || !box.width || !box.height) {
      return;
    }
    overlayCtx.save();
    const fontPx = Math.max(8, Math.round(textItem.sizeNorm * box.height));
    overlayCtx.font = `${fontPx}px sans-serif`;
    overlayCtx.fillStyle = textItem.color || "#ffffff";
    overlayCtx.textBaseline = "top";
    overlayCtx.fillText(
      textItem.text || "",
      box.left + textItem.x * box.width,
      box.top + textItem.y * box.height
    );
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

  function getRenderCssSize() {
    if (state.renderBox && state.renderBox.width > 0 && state.renderBox.height > 0) {
      return {
        width: state.renderBox.width,
        height: state.renderBox.height,
      };
    }
    return getCanvasCssSize();
  }

  function getToolColor() {
    return state.toolColor || "#d02626";
  }

  function getToolSize() {
    const parsed = Number(state.toolSize);
    if (!Number.isFinite(parsed)) {
      return 4;
    }
    return Math.max(1, Math.min(24, parsed));
  }

  function setCurrentPageActiveIndex(next) {
    const count = getPreviewPageCount();
    if (!count) {
      state.currentPageActiveIndex = 0;
      return;
    }
    state.currentPageActiveIndex = Math.max(
      0,
      Math.min(count - 1, next)
    );
  }

  function normalizeCurrentPageIndex() {
    setCurrentPageActiveIndex(state.currentPageActiveIndex);
  }

  function ensureSelectedPageId() {
    if (state.selectedPageId && state.pagesById.has(state.selectedPageId)) {
      const page = state.pagesById.get(state.selectedPageId);
      if (page && !page.deleted) {
        return;
      }
    }
    const current = getCurrentPageId();
    if (current) {
      state.selectedPageId = current;
      return;
    }
    const active = getActivePageIds();
    state.selectedPageId = active[0] || "";
  }

  function getActivePageIds() {
    return state.pageOrder.filter((id) => {
      const page = state.pagesById.get(id);
      return page && !page.deleted;
    });
  }

  function getCurrentPageId() {
    if (!state.canEdit || !state.parsed) {
      return "";
    }
    if (state.selectedPageId) {
      const selected = state.pagesById.get(state.selectedPageId);
      if (selected && !selected.deleted) {
        return state.selectedPageId;
      }
    }
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

  async function buildEditedPdfWithPdfLib() {
    if (!state.canEdit || !state.sourceBytes) {
      throw new Error("No editable PDF loaded.");
    }
    if (!state.pdfLibReady) {
      throw new Error("Local PDF editing engine is unavailable.");
    }
    const activeIds = getActivePageIds();
    if (!activeIds.length) {
      throw new Error("No pages left to save.");
    }

    const pdfDoc = await window.PDFLib.PDFDocument.load(state.sourceBytes, {
      updateMetadata: false,
    });
    const outputDoc = await window.PDFLib.PDFDocument.create();

    const sourceIndices = [];
    const models = [];
    for (const pageId of activeIds) {
      const model = state.pagesById.get(pageId);
      if (!model) {
        continue;
      }
      sourceIndices.push(Math.max(0, model.sourcePageNumber - 1));
      models.push(model);
    }
    if (!sourceIndices.length) {
      throw new Error("No valid pages to save.");
    }

    const copiedPages = await outputDoc.copyPages(pdfDoc, sourceIndices);
    for (let i = 0; i < copiedPages.length; i += 1) {
      const page = copiedPages[i];
      const model = models[i];
      if (!model) {
        continue;
      }

      const baseRotation = normalizeRotation(page.getRotation().angle || model.baseRotate || 0);
      const targetRotation = normalizeRotation(baseRotation + model.rotateDelta);
      const scale = Math.max(0.25, Math.min(2, model.scale || 1));

      if (Math.abs(scale - 1) > 0.0001) {
        const originalWidth = page.getWidth();
        const originalHeight = page.getHeight();
        if (typeof page.scaleContent === "function") {
          page.scaleContent(scale, scale);
        }
        if (typeof page.scaleAnnotations === "function") {
          page.scaleAnnotations(scale, scale);
        }
        page.setSize(originalWidth * scale, originalHeight * scale);
      }

      applyOverlayMarksToPage(page, model.id, targetRotation);
      page.setRotation(window.PDFLib.degrees(targetRotation));
      outputDoc.addPage(page);
    }

    return outputDoc.save();
  }

  async function buildCurrentWorkingBytesForMerge() {
    if (!state.canEdit || !state.parsed || !state.sourceBytes) {
      throw new Error("No editable PDF is currently loaded.");
    }
    if (state.editMode === "raster-fallback") {
      return buildEditedPdfFromRasterPreview();
    }
    try {
      return await buildEditedPdfWithPdfLib();
    } catch (error) {
      if (!state.previewDoc) {
        throw error;
      }
      return buildEditedPdfFromRasterPreview();
    }
  }

  async function mergePdfAtPosition(baseBytes, incomingBytes, placement, anchorIndex) {
    if (!state.pdfLibReady) {
      throw new Error("Local PDF editing engine is unavailable.");
    }
    const baseDoc = await window.PDFLib.PDFDocument.load(baseBytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ignoreEncryption: true,
    });
    const incomingDoc = await window.PDFLib.PDFDocument.load(incomingBytes, {
      updateMetadata: false,
      throwOnInvalidObject: false,
      ignoreEncryption: true,
    });
    const incomingIndices = incomingDoc.getPageIndices();
    if (!incomingIndices.length) {
      throw new Error("Selected merge PDF has no pages.");
    }
    const copiedPages = await baseDoc.copyPages(incomingDoc, incomingIndices);
    let insertAt = placement === "before" ? anchorIndex : anchorIndex + 1;
    insertAt = Math.max(0, Math.min(baseDoc.getPageCount(), insertAt));
    for (const page of copiedPages) {
      baseDoc.insertPage(insertAt, page);
      insertAt += 1;
    }
    const bytes = await baseDoc.save();
    return {
      bytes,
      insertedCount: copiedPages.length,
    };
  }

  async function buildEditedPdfFromRasterPreview() {
    if (!state.previewDoc) {
      throw new Error("Preview document is unavailable for raster save mode.");
    }
    if (!state.pdfLibReady) {
      throw new Error("Local PDF editing engine is unavailable.");
    }

    const activeIds = getActivePageIds();
    if (!activeIds.length) {
      throw new Error("No pages left to save.");
    }

    const outputDoc = await window.PDFLib.PDFDocument.create();

    for (const pageId of activeIds) {
      const model = state.pagesById.get(pageId);
      if (!model) {
        continue;
      }
      const sourcePage = await state.previewDoc.getPage(model.sourcePageNumber);
      const sourceRotation = normalizeRotation(sourcePage.rotate || 0);
      const targetRotation = normalizeRotation(sourceRotation + model.rotateDelta);
      const scale = Math.max(0.25, Math.min(2, model.scale || 1));
      const baseViewport = sourcePage.getViewport({ scale: 1, rotation: targetRotation });
      const outputWidth = Math.max(1, baseViewport.width * scale);
      const outputHeight = Math.max(1, baseViewport.height * scale);

      const renderScale = Math.max(1, Math.min(2, 1800 / Math.max(outputWidth, outputHeight)));
      const renderViewport = sourcePage.getViewport({
        scale: renderScale * scale,
        rotation: targetRotation,
      });

      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      const renderTask = sourcePage.render({
        canvasContext: ctx,
        viewport: renderViewport,
      });
      await renderTask.promise;

      const pngDataUrl = canvas.toDataURL("image/png");
      const image = await outputDoc.embedPng(pngDataUrl);
      const outPage = outputDoc.addPage([outputWidth, outputHeight]);
      outPage.drawImage(image, {
        x: 0,
        y: 0,
        width: outputWidth,
        height: outputHeight,
      });

      applyOverlayMarksToPage(outPage, model.id, 0);
    }

    return outputDoc.save();
  }

  function applyOverlayMarksToPage(page, pageId, targetRotation) {
    const marks = state.annotationsByPage.get(pageId);
    if (!marks) {
      return;
    }
    const pageWidth = page.getWidth();
    const pageHeight = page.getHeight();
    const displaySize = getDisplaySizeForRotation(pageWidth, pageHeight, targetRotation);

    if (marks.strokes && marks.strokes.length) {
      for (const stroke of marks.strokes) {
        if (!stroke || !stroke.points || stroke.points.length < 2) {
          continue;
        }
        const rgb = hexToRgb01(stroke.color);
        const thickness = Math.max(0.5, stroke.widthNorm * displaySize.width);
        for (let i = 1; i < stroke.points.length; i += 1) {
          const prev = stroke.points[i - 1];
          const next = stroke.points[i];
          const start = mapPreviewNormPointToPdfPoint(
            prev.x,
            prev.y,
            pageWidth,
            pageHeight,
            targetRotation
          );
          const end = mapPreviewNormPointToPdfPoint(
            next.x,
            next.y,
            pageWidth,
            pageHeight,
            targetRotation
          );
          page.drawLine({
            start,
            end,
            thickness,
            color: window.PDFLib.rgb(rgb.r, rgb.g, rgb.b),
            opacity: 1,
          });
        }
      }
    }

    if (marks.texts && marks.texts.length) {
      for (const textItem of marks.texts) {
        const text = String((textItem && textItem.text) || "");
        if (!text.trim()) {
          continue;
        }
        const rgb = hexToRgb01(textItem.color);
        const fontSize = Math.max(6, (textItem.sizeNorm || 0.02) * displaySize.height);
        const maxWidth = Math.max(
          16,
          (textItem.widthNorm || 0.2) * displaySize.width
        );
        const point = mapPreviewNormPointToPdfPoint(
          textItem.x || 0,
          textItem.y || 0,
          pageWidth,
          pageHeight,
          targetRotation
        );
        page.drawText(text, {
          x: point.x,
          y: point.y - fontSize,
          size: fontSize,
          maxWidth,
          lineHeight: fontSize * 1.2,
          color: window.PDFLib.rgb(rgb.r, rgb.g, rgb.b),
        });
      }
    }
  }

  function getDisplaySizeForRotation(pageWidth, pageHeight, rotation) {
    const normalizedRotation = normalizeRotation(rotation);
    if (normalizedRotation === 90 || normalizedRotation === 270) {
      return { width: pageHeight, height: pageWidth };
    }
    return { width: pageWidth, height: pageHeight };
  }

  function mapPreviewNormPointToPdfPoint(normX, normY, pageWidth, pageHeight, rotation) {
    const safeX = Math.max(0, Math.min(1, Number(normX) || 0));
    const safeY = Math.max(0, Math.min(1, Number(normY) || 0));
    const display = getDisplaySizeForRotation(pageWidth, pageHeight, rotation);
    const dx = safeX * display.width;
    const dy = safeY * display.height;
    const normalizedRotation = normalizeRotation(rotation);

    if (normalizedRotation === 90) {
      return {
        x: dy,
        y: dx,
      };
    }
    if (normalizedRotation === 180) {
      return {
        x: pageWidth - dx,
        y: dy,
      };
    }
    if (normalizedRotation === 270) {
      return {
        x: pageWidth - dy,
        y: pageHeight - dx,
      };
    }
    return {
      x: dx,
      y: pageHeight - dy,
    };
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

  async function deliverSavedPdf(bytes, fileName) {
    const blob = new Blob([bytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    setSavedDownload(url, fileName);

    const shared = await tryShareSavedPdf(blob, fileName);
    if (shared) {
      return { method: "share" };
    }

    const triggered = triggerDownloadLink(url, fileName);
    if (triggered) {
      return { method: "download" };
    }
    return { method: "manual" };
  }

  async function tryShareSavedPdf(blob, fileName) {
    if (!navigator.share || typeof File === "undefined") {
      return false;
    }
    try {
      const file = new File([blob], fileName, { type: "application/pdf" });
      if (navigator.canShare && !navigator.canShare({ files: [file] })) {
        return false;
      }
      await navigator.share({
        files: [file],
        title: fileName,
        text: "Saved PDF",
      });
      return true;
    } catch (error) {
      if (error && error.name === "AbortError") {
        return false;
      }
      console.warn("Share API unavailable for this file.", error);
      return false;
    }
  }

  function triggerDownloadLink(url, fileName) {
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      return true;
    } catch (error) {
      console.warn("Automatic download trigger failed.", error);
      return false;
    }
  }

  function setSavedDownload(url, fileName) {
    if (state.lastSavedUrl && state.lastSavedUrl !== url) {
      URL.revokeObjectURL(state.lastSavedUrl);
    }
    state.lastSavedUrl = url;
    state.lastSavedName = fileName || "saved.pdf";
    updateSavedDownloadUI();
  }

  function clearSavedDownload() {
    if (state.lastSavedUrl) {
      URL.revokeObjectURL(state.lastSavedUrl);
    }
    state.lastSavedUrl = "";
    state.lastSavedName = "";
    updateSavedDownloadUI();
  }

  function updateSavedDownloadUI() {
    const hasSaved = !!state.lastSavedUrl;
    if (downloadFallback) {
      downloadFallback.classList.toggle("hidden", !hasSaved);
    }
    if (downloadFallbackLink) {
      if (hasSaved) {
        downloadFallbackLink.href = state.lastSavedUrl;
        downloadFallbackLink.download = state.lastSavedName || "saved.pdf";
        downloadFallbackLink.textContent = `Download Saved PDF (${state.lastSavedName})`;
      } else {
        downloadFallbackLink.removeAttribute("href");
        downloadFallbackLink.removeAttribute("download");
        downloadFallbackLink.textContent = "Download Saved PDF";
      }
    }
    if (openSavedBtn) {
      openSavedBtn.disabled = !hasSaved;
    }
  }

  function openSavedPdf() {
    if (!state.lastSavedUrl) {
      setStatus("No saved PDF is available yet. Save first.", "error");
      return;
    }
    const popup = window.open(state.lastSavedUrl, "_blank", "noopener,noreferrer");
    if (popup) {
      return;
    }
    // Fallback for restricted webviews where popups are blocked.
    window.location.href = state.lastSavedUrl;
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
