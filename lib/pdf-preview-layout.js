const MOBILE_PREVIEW_BREAKPOINT = 760;

export function previewViewportLimits({ viewportWidth = 1024, viewportHeight = 768 } = {}) {
  const mobile = Number(viewportWidth) <= MOBILE_PREVIEW_BREAKPOINT;
  const rawHeight = Math.min(
    Number(viewportHeight) * (mobile ? 0.68 : 0.7),
    mobile ? 520 : 760,
  );
  return {
    mobile,
    maxPreviewHeight: Math.max(mobile ? 300 : 420, Number.isFinite(rawHeight) ? rawHeight : (mobile ? 300 : 420)),
  };
}

export function calculatePreviewPageLayout({ pageWidth, pageHeight, availableWidth, maxPreviewHeight, zoom = 1 } = {}) {
  const width = Math.max(1, Number(pageWidth) || 1);
  const height = Math.max(1, Number(pageHeight) || 1);
  const containerWidth = Math.max(1, Number(availableWidth) || 1);
  const containerHeight = Math.max(1, Number(maxPreviewHeight) || 1);
  const requestedZoom = Number.isFinite(Number(zoom)) ? Math.max(0.6, Math.min(3, Number(zoom))) : 1;
  const fitScale = Math.min(containerWidth / width, containerHeight / height);
  const scale = Math.max(0.01, fitScale * requestedZoom);
  return {
    width: width * scale,
    height: height * scale,
    scale,
    fitScale,
    zoom: requestedZoom,
    isZoomed: requestedZoom > 1.001,
  };
}

export function estimatePreviewPageCardHeight({ pageWidth, pageHeight, availableWidth, maxPreviewHeight, zoom = 1 } = {}) {
  const layout = calculatePreviewPageLayout({ pageWidth, pageHeight, availableWidth, maxPreviewHeight, zoom });
  // Page card: page surface + frame padding/border + heading/gaps/card padding.
  return Math.ceil(layout.height + 87);
}

export function buildPreviewOffsets(sizes, gap = 17) {
  const offsets = [];
  let totalSize = 0;
  for (const size of sizes) {
    offsets.push(totalSize);
    totalSize += Math.max(1, Number(size) || 1) + gap;
  }
  return { offsets, totalSize: Math.max(0, totalSize - (sizes.length ? gap : 0)) };
}

export function previewIndexAtOffset(offset, offsets, sizes, gap = 17) {
  if (!offsets.length) return 0;
  const target = Math.max(0, Number(offset) || 0);
  let low = 0;
  let high = offsets.length - 1;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const start = offsets[middle];
    const end = start + Math.max(1, Number(sizes[middle]) || 1) + gap;
    if (target < start) high = middle - 1;
    else if (target >= end && middle < offsets.length - 1) low = middle + 1;
    else return middle;
  }
  return Math.max(0, Math.min(offsets.length - 1, low));
}
