export const PREVIEW_ZOOM_MIN = 0.6;
export const PREVIEW_ZOOM_MAX = 3;
export const PREVIEW_ZOOM_STEP = 0.1;

export function normalizePreviewZoom(value) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return 1;
  return Math.min(PREVIEW_ZOOM_MAX, Math.max(PREVIEW_ZOOM_MIN, numericValue));
}

export function stepPreviewZoom(current, delta) {
  const next = normalizePreviewZoom(current) + Number(delta || 0);
  return normalizePreviewZoom(Math.round(next * 10) / 10);
}
