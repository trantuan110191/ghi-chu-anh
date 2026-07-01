const DB_NAME = "image-note-table";
const DB_VERSION = 1;
const STORE_NAME = "kv";
const ROWS_KEY = "rows";
const STATUS_OPTIONS = new Set(["todo", "doing", "done"]);
const DEFAULT_STATUS = "todo";
const STATUS_LABELS = {
  todo: "Chưa làm",
  doing: "Đang làm",
  done: "Hoàn thành",
};

const els = {
  rows: document.querySelector("#rows"),
  rowTemplate: document.querySelector("#rowTemplate"),
  statusText: document.querySelector("#statusText"),
  addRowBtn: document.querySelector("#addRowBtn"),
  exportBtn: document.querySelector("#exportBtn"),
  importBtn: document.querySelector("#importBtn"),
  importFile: document.querySelector("#importFile"),
  searchInput: document.querySelector("#searchInput"),
  dialog: document.querySelector("#imageDialog"),
  dialogTitle: document.querySelector("#dialogTitle"),
  previewStage: document.querySelector(".preview-stage"),
  previewImage: document.querySelector("#previewImage"),
  closeDialogBtn: document.querySelector("#closeDialogBtn"),
  downloadImageBtn: document.querySelector("#downloadImageBtn"),
  deleteImageBtn: document.querySelector("#deleteImageBtn"),
};

let rows = [];
let activeImageRowId = null;
let previewRowId = null;
let previewZoomed = false;
let previewSpacePressed = false;
let previewPanLocked = false;
let previewDragging = false;
let previewSpaceDragHappened = false;
let suppressPreviewClick = false;
let previewDragStartX = 0;
let previewDragStartY = 0;
let previewDragScrollLeft = 0;
let previewDragScrollTop = 0;
let openStatusRowId = null;
let saveTimer = null;
let dbPromise = null;

init();

async function init() {
  rows = await loadRows();
  if (!rows.length) {
    rows = [createRow()];
    await saveRows();
  }

  renderRows();
  wireEvents();
  updateStatus();
}

function wireEvents() {
  els.addRowBtn.addEventListener("click", () => {
    const row = createRow();
    rows.push(row);
    renderRows();
    queueSave();
    focusText(row.id);
  });

  els.searchInput.addEventListener("input", renderRows);
  els.exportBtn.addEventListener("click", exportRows);
  els.importBtn.addEventListener("click", () => els.importFile.click());
  els.importFile.addEventListener("change", importRows);

  els.rows.addEventListener("input", (event) => {
    const textarea = event.target.closest("textarea");
    if (!textarea) return;

    const row = findRow(getRowId(textarea));
    if (!row) return;

    row.text = textarea.value;
    row.updatedAt = new Date().toISOString();
    queueSave();
    updateStatus();
  });

  els.rows.addEventListener("focusin", (event) => {
    const slot = event.target.closest(".image-slot");
    if (slot) {
      setActiveImageRow(getRowId(slot));
      return;
    }

    if (event.target.closest("textarea")) {
      setActiveImageRow(null);
    }
  });

  els.rows.addEventListener("click", (event) => {
    const viewButton = event.target.closest(".view-image");
    const deleteRowButton = event.target.closest(".delete-row");
    const imageSlot = event.target.closest(".image-slot");
    const pickImageButton = event.target.closest(".pick-image");
    const statusTrigger = event.target.closest(".status-trigger");
    const statusChoice = event.target.closest(".status-choice");

    if (viewButton) {
      openPreview(getRowId(viewButton));
      return;
    }

    if (deleteRowButton) {
      deleteRow(getRowId(deleteRowButton));
      return;
    }

    if (statusChoice) {
      event.stopPropagation();
      setRowStatus(getRowId(statusChoice), statusChoice.dataset.status);
      return;
    }

    if (statusTrigger) {
      event.stopPropagation();
      toggleStatusMenu(getRowId(statusTrigger));
      return;
    }

    if (pickImageButton) {
      const rowEl = pickImageButton.closest(".data-row");
      rowEl.querySelector(".row-file").click();
      return;
    }

    if (imageSlot) {
      imageSlot.focus();
      setActiveImageRow(getRowId(imageSlot));
    }
  });

  els.rows.addEventListener("change", async (event) => {
    const input = event.target.closest(".row-file");
    if (!input || !input.files?.length) return;

    await attachImage(getRowId(input), input.files[0]);
    input.value = "";
  });

  els.rows.addEventListener("paste", async (event) => {
    const slot = event.target.closest(".image-slot");
    if (!slot) return;

    const imageFile = getImageFromClipboard(event.clipboardData);
    if (!imageFile) return;

    event.preventDefault();
    event.stopPropagation();
    await attachImage(getRowId(slot), imageFile);
  });

  document.addEventListener("paste", async (event) => {
    if (event.defaultPrevented) return;
    if (!activeImageRowId) return;
    if (event.target.closest("textarea")) return;

    const imageFile = getImageFromClipboard(event.clipboardData);
    if (!imageFile) return;

    event.preventDefault();
    await attachImage(activeImageRowId, imageFile);
  });

  els.rows.addEventListener("dragover", (event) => {
    const slot = event.target.closest(".image-slot");
    if (!slot) return;
    event.preventDefault();
    slot.classList.add("drag-over");
  });

  els.rows.addEventListener("dragleave", (event) => {
    const slot = event.target.closest(".image-slot");
    if (slot) slot.classList.remove("drag-over");
  });

  els.rows.addEventListener("drop", async (event) => {
    const slot = event.target.closest(".image-slot");
    if (!slot) return;

    const file = [...event.dataTransfer.files].find((item) => item.type.startsWith("image/"));
    if (!file) return;

    event.preventDefault();
    slot.classList.remove("drag-over");
    await attachImage(getRowId(slot), file);
  });

  els.closeDialogBtn.addEventListener("click", closePreview);
  els.previewImage.addEventListener("click", togglePreviewZoom);
  els.previewImage.addEventListener("dragstart", (event) => event.preventDefault());
  els.previewStage.addEventListener("pointerdown", startPreviewPan);
  document.addEventListener("pointermove", movePreviewPan);
  document.addEventListener("pointerup", endPreviewPan);
  document.addEventListener("keydown", handlePreviewKeyDown);
  document.addEventListener("keyup", handlePreviewKeyUp);
  document.addEventListener("click", closeAllStatusMenus);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeAllStatusMenus();
  });
  els.dialog.addEventListener("click", (event) => {
    if (event.target === els.dialog) closePreview();
  });
  els.downloadImageBtn.addEventListener("click", downloadPreviewImage);
  els.deleteImageBtn.addEventListener("click", deletePreviewImage);
}

function renderRows() {
  const query = normalizeText(els.searchInput.value);
  const visibleRows = rows.filter((row) => normalizeText(row.text).includes(query));

  els.rows.replaceChildren();

  if (!visibleRows.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = query ? "Không có dòng phù hợp" : "Chưa có dữ liệu";
    els.rows.append(empty);
    updateStatus(visibleRows.length);
    return;
  }

  const fragment = document.createDocumentFragment();
  visibleRows.forEach((row) => {
    const index = rows.findIndex((item) => item.id === row.id) + 1;
    fragment.append(createRowElement(row, index));
  });

  els.rows.append(fragment);
  markActiveRow();
  updateStatus(visibleRows.length);
}

function createRowElement(row, index) {
  const node = els.rowTemplate.content.firstElementChild.cloneNode(true);
  node.dataset.id = row.id;
  node.querySelector(".index-cell").textContent = index;

  const textarea = node.querySelector("textarea");
  textarea.value = row.text || "";
  textarea.dataset.id = row.id;
  textarea.setAttribute("aria-label", `Nội dung dòng ${index}`);

  const slot = node.querySelector(".image-slot");
  slot.dataset.id = row.id;
  slot.setAttribute("aria-label", `Ảnh dòng ${index}`);

  const pick = node.querySelector(".pick-image");
  pick.dataset.id = row.id;

  const file = node.querySelector(".row-file");
  file.dataset.id = row.id;

  const view = node.querySelector(".view-image");
  view.dataset.id = row.id;
  view.disabled = !row.image;

  const deleteButton = node.querySelector(".delete-row");
  deleteButton.dataset.id = row.id;

  if (row.image) {
    slot.classList.add("has-image");
    const thumb = node.querySelector(".thumb-image");
    thumb.src = row.image;
    thumb.alt = row.text ? `Ảnh: ${row.text.slice(0, 80)}` : "Ảnh đã dán";
  }

  const status = normalizeStatus(row.status);
  const statusControl = node.querySelector(".status-control");
  const statusTrigger = node.querySelector(".status-trigger");
  const statusLabel = node.querySelector(".status-label");
  statusControl.dataset.status = status;
  statusControl.classList.toggle("is-open", openStatusRowId === row.id);
  statusTrigger.dataset.id = row.id;
  statusTrigger.dataset.status = status;
  statusTrigger.setAttribute("aria-expanded", openStatusRowId === row.id ? "true" : "false");
  statusLabel.textContent = getStatusLabel(status);
  node.querySelectorAll(".status-choice").forEach((button) => {
    const selected = button.dataset.status === status;
    button.dataset.id = row.id;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });

  return node;
}

async function attachImage(rowId, file) {
  const row = findRow(rowId);
  if (!row) return;

  row.image = await readFileAsDataUrl(file);
  row.imageName = file.name || `screenshot-${new Date().toISOString()}.png`;
  row.imageType = file.type || "image/png";
  row.updatedAt = new Date().toISOString();
  activeImageRowId = rowId;

  renderRows();
  queueSave();
}

function deleteRow(rowId) {
  if (rows.length === 1) {
    const row = rows[0];
    row.text = "";
    row.image = null;
    row.imageName = "";
    row.imageType = "";
    row.status = DEFAULT_STATUS;
    row.updatedAt = new Date().toISOString();
    renderRows();
    queueSave();
    return;
  }

  if (!window.confirm("Xóa dòng này?")) return;

  rows = rows.filter((row) => row.id !== rowId);
  if (activeImageRowId === rowId) activeImageRowId = null;
  renderRows();
  queueSave();
}

function setRowStatus(rowId, status) {
  const row = findRow(rowId);
  if (!row) return;

  row.status = normalizeStatus(status);
  row.updatedAt = new Date().toISOString();
  openStatusRowId = null;
  renderRows();
  queueSave();
}

function toggleStatusMenu(rowId) {
  openStatusRowId = openStatusRowId === rowId ? null : rowId;
  renderRows();
}

function closeAllStatusMenus() {
  if (!openStatusRowId) return;

  openStatusRowId = null;
  els.rows.querySelectorAll(".status-control.is-open").forEach((control) => {
    control.classList.remove("is-open");
    control.querySelector(".status-trigger")?.setAttribute("aria-expanded", "false");
  });
}

function openPreview(rowId) {
  const row = findRow(rowId);
  if (!row?.image) return;

  previewRowId = rowId;
  els.previewImage.src = row.image;
  els.previewImage.title = "Click để phóng to";
  els.dialogTitle.textContent = row.text?.trim() || "Ảnh";
  resetPreviewZoom();

  if (typeof els.dialog.showModal === "function") {
    els.dialog.showModal();
  } else {
    window.open(row.image, "_blank", "noopener");
  }
}

function closePreview() {
  resetPreviewZoom();
  els.dialog.close();
}

function togglePreviewZoom(event) {
  if (suppressPreviewClick || previewSpacePressed) {
    suppressPreviewClick = false;
    event.preventDefault();
    return;
  }

  if (previewZoomed) {
    resetPreviewZoom();
    return;
  }

  const imageRect = els.previewImage.getBoundingClientRect();
  const zoomRatio = 2.4;
  const clickX = clamp(event.clientX - imageRect.left, 0, imageRect.width);
  const clickY = clamp(event.clientY - imageRect.top, 0, imageRect.height);
  const ratioX = imageRect.width ? clickX / imageRect.width : 0.5;
  const ratioY = imageRect.height ? clickY / imageRect.height : 0.5;

  previewZoomed = true;
  els.previewStage.classList.add("is-zoomed");
  els.previewImage.classList.add("is-zoomed");
  els.previewImage.title = "Click để thu nhỏ. Bấm Space để kéo ảnh.";
  els.previewImage.style.width = `${Math.round(imageRect.width * zoomRatio)}px`;
  els.previewImage.style.height = `${Math.round(imageRect.height * zoomRatio)}px`;
  els.previewImage.style.maxWidth = "none";
  els.previewImage.style.maxHeight = "none";

  requestAnimationFrame(() => {
    els.previewStage.scrollLeft =
      els.previewImage.offsetWidth * ratioX - els.previewStage.clientWidth / 2;
    els.previewStage.scrollTop =
      els.previewImage.offsetHeight * ratioY - els.previewStage.clientHeight / 2;
  });
}

function handlePreviewKeyDown(event) {
  if (event.code !== "Space") return;
  if (!els.dialog.open || !previewZoomed) return;
  if (isTextInput(event.target)) return;

  event.preventDefault();
  if (event.repeat) return;

  previewSpacePressed = true;
  previewSpaceDragHappened = false;
  updatePreviewPanMode();
}

function handlePreviewKeyUp(event) {
  if (event.code !== "Space") return;

  if (els.dialog.open && previewZoomed && !isTextInput(event.target)) {
    event.preventDefault();
    if (!previewDragging && !previewSpaceDragHappened) {
      previewPanLocked = !previewPanLocked;
    }
  }

  previewSpacePressed = false;
  endPreviewPan();
  updatePreviewPanMode();
}

function startPreviewPan(event) {
  if (!canPanPreview()) return;

  event.preventDefault();
  suppressPreviewClick = true;
  previewDragging = true;
  previewSpaceDragHappened = false;
  previewDragStartX = event.clientX;
  previewDragStartY = event.clientY;
  previewDragScrollLeft = els.previewStage.scrollLeft;
  previewDragScrollTop = els.previewStage.scrollTop;
  els.previewStage.classList.add("is-panning");
}

function movePreviewPan(event) {
  if (!previewDragging) return;

  event.preventDefault();
  const deltaX = event.clientX - previewDragStartX;
  const deltaY = event.clientY - previewDragStartY;
  if (Math.abs(deltaX) > 2 || Math.abs(deltaY) > 2) {
    previewSpaceDragHappened = true;
  }
  els.previewStage.scrollLeft = previewDragScrollLeft - deltaX;
  els.previewStage.scrollTop = previewDragScrollTop - deltaY;
}

function endPreviewPan() {
  if (!previewDragging) return;

  previewDragging = false;
  els.previewStage.classList.remove("is-panning");
}

function canPanPreview() {
  return els.dialog.open && previewZoomed && (previewSpacePressed || previewPanLocked);
}

function updatePreviewPanMode() {
  const canPan = canPanPreview();
  els.previewStage.classList.toggle("is-pan-ready", canPan);
  if (previewZoomed) {
    els.previewImage.title = canPan
      ? "Kéo để xem ảnh. Bấm Space để tắt kéo."
      : "Click để thu nhỏ. Bấm Space để kéo ảnh.";
  }
}

function resetPreviewZoom() {
  previewZoomed = false;
  previewSpacePressed = false;
  previewPanLocked = false;
  previewDragging = false;
  previewSpaceDragHappened = false;
  suppressPreviewClick = false;
  els.previewStage.classList.remove("is-zoomed");
  els.previewStage.classList.remove("is-pan-ready");
  els.previewStage.classList.remove("is-panning");
  els.previewImage.classList.remove("is-zoomed");
  els.previewImage.title = "Click để phóng to";
  els.previewImage.style.width = "";
  els.previewImage.style.height = "";
  els.previewImage.style.maxWidth = "";
  els.previewImage.style.maxHeight = "";
  els.previewStage.scrollLeft = 0;
  els.previewStage.scrollTop = 0;
}

function downloadPreviewImage() {
  const row = findRow(previewRowId);
  if (!row?.image) return;

  const link = document.createElement("a");
  link.href = row.image;
  link.download = safeFileName(row.imageName || "anh.png");
  link.click();
}

function deletePreviewImage() {
  const row = findRow(previewRowId);
  if (!row?.image) return;
  if (!window.confirm("Xóa ảnh khỏi dòng này?")) return;

  row.image = null;
  row.imageName = "";
  row.imageType = "";
  row.updatedAt = new Date().toISOString();
  closePreview();
  renderRows();
  queueSave();
}

function exportRows() {
  const payload = {
    app: "image-note-table",
    version: 1,
    exportedAt: new Date().toISOString(),
    rows,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `bang-ghi-chu-anh-${dateStamp()}.json`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

async function importRows(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  try {
    const text = await file.text();
    const payload = JSON.parse(text);
    const nextRows = Array.isArray(payload) ? payload : payload.rows;

    if (!Array.isArray(nextRows)) {
      throw new Error("Invalid file");
    }

    if (!window.confirm("Nhập file này sẽ thay thế dữ liệu hiện tại?")) return;

    rows = nextRows.map((row) => ({
      id: row.id || createId(),
      text: row.text || "",
      image: row.image || null,
      imageName: row.imageName || "",
      imageType: row.imageType || "",
      status: normalizeStatus(row.status),
      createdAt: row.createdAt || new Date().toISOString(),
      updatedAt: row.updatedAt || new Date().toISOString(),
    }));

    if (!rows.length) rows = [createRow()];
    activeImageRowId = null;
    await saveRows();
    renderRows();
  } catch (error) {
    window.alert("File nhập không hợp lệ.");
  } finally {
    event.target.value = "";
  }
}

function createRow() {
  const now = new Date().toISOString();
  return {
    id: createId(),
    text: "",
    image: null,
    imageName: "",
    imageType: "",
    status: DEFAULT_STATUS,
    createdAt: now,
    updatedAt: now,
  };
}

function getImageFromClipboard(clipboardData) {
  if (!clipboardData?.items?.length) return null;

  for (const item of clipboardData.items) {
    if (item.type.startsWith("image/")) {
      return item.getAsFile();
    }
  }

  return null;
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(reader.result));
    reader.addEventListener("error", reject);
    reader.readAsDataURL(file);
  });
}

function findRow(rowId) {
  return rows.find((row) => row.id === rowId);
}

function getRowId(element) {
  return element.dataset.id || element.closest(".data-row")?.dataset.id;
}

function setActiveImageRow(rowId) {
  activeImageRowId = rowId;
  markActiveRow();
}

function markActiveRow() {
  els.rows.querySelectorAll(".data-row").forEach((rowEl) => {
    rowEl.classList.toggle("is-active", rowEl.dataset.id === activeImageRowId);
  });
}

function focusText(rowId) {
  requestAnimationFrame(() => {
    const textarea = els.rows.querySelector(`.data-row[data-id="${cssEscape(rowId)}"] textarea`);
    textarea?.focus();
  });
}

function updateStatus(visibleCount = rows.length) {
  const imageCount = rows.filter((row) => row.image).length;
  const filtered = visibleCount !== rows.length ? `, đang hiện ${visibleCount}` : "";
  els.statusText.textContent = `${rows.length} dòng, ${imageCount} ảnh${filtered}`;
}

function queueSave() {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(saveRows, 180);
}

async function loadRows() {
  const stored = await storageGet(ROWS_KEY);
  if (!Array.isArray(stored)) return [];
  return stored.map(normalizeRow);
}

async function saveRows() {
  await storageSet(ROWS_KEY, rows);
}

async function openDb() {
  if (!("indexedDB" in window)) throw new Error("IndexedDB unavailable");
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
  });

  return dbPromise;
}

async function storageGet(key) {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readonly");
      const request = tx.objectStore(STORE_NAME).get(key);
      request.addEventListener("success", () => resolve(request.result?.value));
      request.addEventListener("error", () => reject(request.error));
    });
  } catch (error) {
    const raw = localStorage.getItem(`${DB_NAME}:${key}`);
    return raw ? JSON.parse(raw) : null;
  }
}

async function storageSet(key, value) {
  try {
    const db = await openDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, "readwrite");
      tx.objectStore(STORE_NAME).put({ key, value });
      tx.addEventListener("complete", resolve);
      tx.addEventListener("error", () => reject(tx.error));
    });
  } catch (error) {
    localStorage.setItem(`${DB_NAME}:${key}`, JSON.stringify(value));
  }
}

function normalizeText(value) {
  return (value || "")
    .toString()
    .toLocaleLowerCase("vi-VN")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function safeFileName(value) {
  return value.replace(/[\\/:*?"<>|]+/g, "-") || "anh.png";
}

function dateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function createId() {
  if (window.crypto?.randomUUID) return window.crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function cssEscape(value) {
  if (window.CSS?.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, "\\$&");
}

function normalizeRow(row) {
  const now = new Date().toISOString();
  return {
    id: row.id || createId(),
    text: row.text || "",
    image: row.image || null,
    imageName: row.imageName || "",
    imageType: row.imageType || "",
    status: normalizeStatus(row.status),
    createdAt: row.createdAt || now,
    updatedAt: row.updatedAt || now,
  };
}

function normalizeStatus(status) {
  return STATUS_OPTIONS.has(status) ? status : DEFAULT_STATUS;
}

function getStatusLabel(status) {
  return STATUS_LABELS[normalizeStatus(status)];
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function isTextInput(element) {
  return Boolean(element?.closest?.("input, textarea, [contenteditable='true']"));
}
