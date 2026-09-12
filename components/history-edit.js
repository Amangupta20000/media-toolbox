const HISTORY_EDIT_KEY = "media-toolbox-history-edit";

export function rememberHistoryEdit(value) {
  if (typeof window === "undefined" || !value?.tool || !value?.downloadUrl) return;
  window.sessionStorage.setItem(HISTORY_EDIT_KEY, JSON.stringify({
    tool: value.tool,
    downloadUrl: value.downloadUrl,
    filename: value.filename || "saved-result",
    mime: value.mime || "",
  }));
}

export function takeHistoryEdit(tool) {
  if (typeof window === "undefined") return null;
  const raw = window.sessionStorage.getItem(HISTORY_EDIT_KEY);
  if (!raw) return null;
  window.sessionStorage.removeItem(HISTORY_EDIT_KEY);
  try {
    const value = JSON.parse(raw);
    return value?.tool === tool && value?.downloadUrl ? value : null;
  } catch {
    return null;
  }
}
