const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".heic", ".heif", ".tif", ".tiff", ".gif", ".bmp"]);
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
  "image/tiff",
  "image/gif",
  "image/bmp",
]);

export function isSupportedImageFile(file) {
  if (!file) return false;
  const type = String(file.type || "").toLowerCase().split(";", 1)[0];
  const name = String(file.name || "").toLowerCase();
  const extension = name.includes(".") ? name.slice(name.lastIndexOf(".")) : "";
  return IMAGE_MIME_TYPES.has(type) || IMAGE_EXTENSIONS.has(extension);
}

export function imageExtensionForMime(type) {
  const normalized = String(type || "").toLowerCase().split(";", 1)[0];
  return {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/heic": "heic",
    "image/heif": "heif",
    "image/tiff": "tiff",
    "image/gif": "gif",
    "image/bmp": "bmp",
  }[normalized] || "png";
}

export function clipboardImageFile(clipboardData, now = Date.now()) {
  const files = Array.from(clipboardData?.files || []).filter(isSupportedImageFile);
  const item = files[0] || Array.from(clipboardData?.items || []).find((candidate) => String(candidate?.type || "").toLowerCase().startsWith("image/"));
  if (!item) return null;

  if (typeof item.getAsFile === "function") {
    const file = item.getAsFile();
    if (!file) return null;
    const type = String(file.type || item.type || "image/png").toLowerCase();
    return new File([file], `pasted-image-${now}.${imageExtensionForMime(type)}`, { type });
  }

  return item;
}
