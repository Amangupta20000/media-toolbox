function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function normalizedBox(value) {
  if (!value || typeof value !== "object") return null;
  const box = { x0: Number(value.x0), y0: Number(value.y0), x1: Number(value.x1), y1: Number(value.y1) };
  return [box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) && box.x1 > box.x0 && box.y1 > box.y0 ? box : null;
}

function expandedBox(box, width, height, contentWidth = box.x1 - box.x0) {
  const textHeight = Math.max(1, box.y1 - box.y0);
  // OCR boxes are normally tight around the glyphs. A small mask around the
  // box removes antialiased edge pixels without erasing neighbouring runs.
  const xPadding = Math.max(2, Math.round(textHeight * 0.08));
  const yPadding = Math.max(2, Math.round(textHeight * 0.16));
  return {
    x0: clamp(Math.floor(box.x0 - xPadding), 0, width - 1),
    y0: clamp(Math.floor(box.y0 - yPadding), 0, height - 1),
    x1: clamp(Math.ceil(Math.max(box.x1, box.x0 + contentWidth) + xPadding), 1, width),
    y1: clamp(Math.ceil(box.y1 + yPadding), 1, height),
  };
}

function pixelOffset(x, y, width) {
  return (clamp(Math.round(x), 0, width - 1) + clamp(Math.round(y), 0, Infinity) * width) * 4;
}

function readPixel(data, x, y, width, height) {
  const offset = pixelOffset(x, y, width);
  const safeOffset = Math.min(data.length - 4, Math.max(0, offset));
  return [data[safeOffset], data[safeOffset + 1], data[safeOffset + 2], data[safeOffset + 3]];
}

function blend(left, right, amount) {
  return [0, 1, 2, 3].map((channel) => Math.round(left[channel] + (right[channel] - left[channel]) * amount));
}

function estimateBackground(data, box, x, y, width, height) {
  const topY = clamp(box.y0 - Math.max(2, Math.round((box.y1 - box.y0) * 0.35)), 0, height - 1);
  const bottomY = clamp(box.y1 + Math.max(2, Math.round((box.y1 - box.y0) * 0.35)), 0, height - 1);
  const leftX = clamp(box.x0 - Math.max(2, Math.round((box.x1 - box.x0) * 0.18)), 0, width - 1);
  const rightX = clamp(box.x1 + Math.max(2, Math.round((box.x1 - box.x0) * 0.18)), 0, width - 1);
  const horizontalAmount = (x - box.x0) / Math.max(1, box.x1 - box.x0);
  const verticalAmount = (y - box.y0) / Math.max(1, box.y1 - box.y0);
  const top = blend(readPixel(data, leftX, topY, width, height), readPixel(data, rightX, topY, width, height), horizontalAmount);
  const bottom = blend(readPixel(data, leftX, bottomY, width, height), readPixel(data, rightX, bottomY, width, height), horizontalAmount);
  return blend(top, bottom, verticalAmount);
}

function distance(left, right) {
  return Math.abs(left[0] - right[0]) + Math.abs(left[1] - right[1]) + Math.abs(left[2] - right[2]);
}

function foregroundColor(data, original, mask, width, height) {
  const samples = [];
  const x0 = Math.max(0, Math.floor(original.x0));
  const y0 = Math.max(0, Math.floor(original.y0));
  const x1 = Math.min(width, Math.ceil(original.x1));
  const y1 = Math.min(height, Math.ceil(original.y1));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixel = readPixel(data, x, y, width, height);
      if (pixel[3] === 0) continue;
      const background = estimateBackground(data, mask, x, y, width, height);
      const pixelDistance = distance(pixel, background);
      if (pixelDistance > 35) samples.push({ pixel, pixelDistance });
    }
  }
  if (!samples.length) return [0, 0, 0, 255];
  samples.sort((left, right) => right.pixelDistance - left.pixelDistance);
  const strongest = samples.slice(0, Math.max(1, Math.ceil(samples.length * 0.2)));
  return [0, 1, 2].map((channel) => Math.round(strongest.reduce((sum, item) => sum + item.pixel[channel], 0) / strongest.length)).concat(255);
}

function textStyle(context, data, original, mask, replacement, width, height) {
  let inkPixels = 0;
  const x0 = Math.max(0, Math.floor(original.x0));
  const y0 = Math.max(0, Math.floor(original.y0));
  const x1 = Math.min(width, Math.ceil(original.x1));
  const y1 = Math.min(height, Math.ceil(original.y1));
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const pixel = readPixel(data, x, y, width, height);
      if (pixel[3] > 0 && distance(pixel, estimateBackground(data, mask, x, y, width, height)) > 45) inkPixels += 1;
    }
  }
  const inkRatio = inkPixels / Math.max(1, (x1 - x0) * (y1 - y0));
  const weight = inkRatio >= 0.12 ? 700 : inkRatio >= 0.06 ? 500 : 400;
  let fontSize = Math.max(8, original.y1 - original.y0);
  const sample = replacement || "Hg";
  for (let iteration = 0; iteration < 4; iteration += 1) {
    context.font = `${weight} ${Math.max(8, Math.round(fontSize))}px sans-serif`;
    const metrics = context.measureText(sample);
    const glyphHeight = Number(metrics.actualBoundingBoxAscent || 0) + Number(metrics.actualBoundingBoxDescent || 0);
    if (glyphHeight > 0) fontSize *= (original.y1 - original.y0) / glyphHeight;
  }
  context.font = `${weight} ${Math.max(8, Math.round(fontSize))}px sans-serif`;
  const metrics = context.measureText(sample);
  return {
    weight,
    fontSize: Math.max(8, Math.round(fontSize)),
    ascent: Number(metrics.actualBoundingBoxAscent || fontSize * 0.8),
    descent: Number(metrics.actualBoundingBoxDescent || fontSize * 0.2),
  };
}

function rgbaString(color) {
  return `rgba(${color[0]}, ${color[1]}, ${color[2]}, ${(color[3] ?? 255) / 255})`;
}

/**
 * Replace OCR regions on an already-rendered page. This module intentionally
 * has no Node or PDF dependencies so the browser preview and the worker can
 * use exactly the same mask, background reconstruction, colour, weight, and
 * baseline calculations.
 */
export function applyRasterTextEdits(canvas, edits) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const source = context.getImageData(0, 0, width, height);
  const warnings = [];
  const prepared = [];
  for (const edit of edits || []) {
    const original = normalizedBox(edit?.bbox);
    if (!original) throw new Error("An OCR text edit has an invalid page region.");
    if (original.x0 < 0 || original.y0 < 0 || original.x1 > width || original.y1 > height) throw new Error("An OCR text edit is outside the rendered page.");
    const baseMask = expandedBox(original, width, height);
    const replacement = String(edit?.replacementText ?? "");
    const style = replacement ? textStyle(context, source.data, original, baseMask, replacement, width, height) : null;
    const replacementWidth = replacement ? context.measureText(replacement).width : 0;
    // When a replacement is wider than the selected OCR run, clear its full
    // painted width as well. Otherwise a neighbouring original OCR run can
    // remain visible underneath the replacement and look duplicated.
    const mask = expandedBox(original, width, height, Math.max(original.x1 - original.x0, replacementWidth));
    const foreground = foregroundColor(source.data, original, mask, width, height);
    prepared.push({ edit, original, mask, replacement, style, foreground });
  }
  for (const { mask } of prepared) {
    const image = context.createImageData(Math.max(1, mask.x1 - mask.x0), Math.max(1, mask.y1 - mask.y0));
    for (let y = mask.y0; y < mask.y1; y += 1) {
      for (let x = mask.x0; x < mask.x1; x += 1) {
        const background = estimateBackground(source.data, mask, x, y, width, height);
        const offset = ((y - mask.y0) * image.width + (x - mask.x0)) * 4;
        image.data[offset] = background[0];
        image.data[offset + 1] = background[1];
        image.data[offset + 2] = background[2];
        image.data[offset + 3] = background[3];
      }
    }
    context.putImageData(image, mask.x0, mask.y0);
  }
  // Paint replacements only after every mask is applied. If two OCR regions
  // are close together, a later mask must not erase an earlier replacement.
  for (const { edit, original, replacement, style, foreground } of prepared) {
    if (replacement) {
      context.save();
      context.font = `${style.weight} ${style.fontSize}px sans-serif`;
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      const glyphHeight = style.ascent + style.descent;
      const baseline = original.y0 + Math.max(0, (original.y1 - original.y0 - glyphHeight) / 2) + style.ascent;
      context.fillStyle = rgbaString(foreground);
      context.fillText(replacement, original.x0, baseline);
      const renderedWidth = context.measureText(replacement).width;
      const originalWidth = Math.max(1, original.x1 - original.x0);
      if (renderedWidth > originalWidth) warnings.push(`OCR replacement for “${String(edit?.originalText || "text").slice(0, 80)}” is wider than the original text region and was allowed to overflow without reflow.`);
      if (original.x0 + renderedWidth > width) warnings.push(`OCR replacement for “${String(edit?.originalText || "text").slice(0, 80)}” reaches the page edge and may be clipped there.`);
      context.restore();
    }
    if (Number(edit?.confidence) && Number(edit.confidence) < 70) warnings.push(`OCR confidence was low for “${String(edit?.originalText || "text").slice(0, 80)}”. Review the exported page.`);
  }
  return warnings;
}
