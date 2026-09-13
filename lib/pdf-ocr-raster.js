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
  // Sample immediately outside the mask. Looking far away can pick up a
  // nearby title rule, border, or coloured illustration and turn the cleared
  // text area into a visible red/yellow rectangle.
  const edgeGap = Math.max(2, Math.min(8, Math.round((box.y1 - box.y0) * 0.08)));
  const topY = clamp(box.y0 - edgeGap, 0, height - 1);
  const bottomY = clamp(box.y1 + edgeGap, 0, height - 1);
  const verticalAmount = (y - box.y0) / Math.max(1, box.y1 - box.y0);
  const top = readPixel(data, x, topY, width, height);
  const bottom = readPixel(data, x, bottomY, width, height);
  // Use the same x-coordinate above and below the mask. Sampling the sides
  // can pull in a neighbouring red rule, border, or illustration and spread
  // that colour across the cleared text region.
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

const FONT_CANDIDATES = [
  { family: "Arial", group: "sans" },
  { family: "Arial Rounded MT Bold", group: "rounded" },
  { family: "Helvetica Neue", group: "sans" },
  { family: "Helvetica", group: "sans" },
  { family: "Avenir Next", group: "sans" },
  { family: "Gill Sans", group: "sans" },
  { family: "Futura", group: "sans" },
  { family: "Trebuchet MS", group: "sans" },
  { family: "Verdana", group: "sans" },
  { family: "Tahoma", group: "sans" },
  { family: "Calibri", group: "sans" },
  { family: "Segoe UI", group: "sans" },
  { family: "Noto Sans", group: "sans" },
  { family: "Liberation Sans", group: "sans" },
  { family: "DejaVu Sans", group: "sans" },
  { family: "Times New Roman", group: "serif" },
  { family: "Georgia", group: "serif" },
  { family: "Baskerville", group: "serif" },
  { family: "Cambria", group: "serif" },
  { family: "Courier New", group: "mono" },
  { family: "Consolas", group: "mono" },
  { family: "Impact", group: "display" },
  { family: "Comic Sans MS", group: "hand" },
  { family: "Chalkboard SE", group: "hand" },
  { family: "Chalkboard", group: "hand" },
  { family: "Marker Felt", group: "hand" },
  { family: "Bradley Hand", group: "hand" },
  { family: "Noteworthy", group: "hand" },
  { family: "Brush Script MT", group: "hand" },
  { family: "Kalam", group: "hand" },
  { family: "Patrick Hand", group: "hand" },
];

function inferredFontGroup(family) {
  const name = String(family).toLowerCase();
  if (/emoji|symbol|dingbat|braille|ornament|math|lastresort|cuneiform|hieroglyph|musical|wingdings/.test(name)) return "unsupported";
  if (/script|hand|chalk|comic|marker|noteworthy|kalam|brush|cursive|chancery|roundhand|zapfino|snell/.test(name)) return "hand";
  if (/serif|times|georgia|baskerville|garamond|palatino|bodoni|caslon|charter|didot|cochin|athelas|bookman/.test(name)) return "serif";
  if (/mono|courier|consolas|menlo|monaco|terminal|fixed/.test(name)) return "mono";
  if (/impact|condensed|narrow|display|poster|gothic/.test(name)) return "display";
  if (/rounded/.test(name)) return "rounded";
  return "sans";
}

function scriptGroupForText(value) {
  const counts = new Map();
  const scripts = [
    ["latin", /\p{Script=Latin}/u],
    ["devanagari", /\p{Script=Devanagari}/u],
    ["bengali", /\p{Script=Bengali}/u],
    ["gurmukhi", /\p{Script=Gurmukhi}/u],
    ["gujarati", /\p{Script=Gujarati}/u],
    ["oriya", /\p{Script=Oriya}/u],
    ["tamil", /\p{Script=Tamil}/u],
    ["telugu", /\p{Script=Telugu}/u],
    ["kannada", /\p{Script=Kannada}/u],
    ["malayalam", /\p{Script=Malayalam}/u],
    ["arabic", /\p{Script=Arabic}/u],
    ["hebrew", /\p{Script=Hebrew}/u],
    ["cyrillic", /\p{Script=Cyrillic}/u],
    ["greek", /\p{Script=Greek}/u],
    ["han", /\p{Script=Han}/u],
  ];
  for (const character of Array.from(String(value || ""))) {
    const match = scripts.find(([, pattern]) => pattern.test(character));
    if (match) counts.set(match[0], (counts.get(match[0]) || 0) + 1);
  }
  return [...counts.entries()].sort((left, right) => right[1] - left[1])[0]?.[0] || "neutral";
}

function scriptGroupForFont(family) {
  const name = String(family || "").toLowerCase();
  if (/devanagari|hindi|nagari/.test(name)) return "devanagari";
  if (/bengali|bangla/.test(name)) return "bengali";
  if (/gurmukhi|punjabi/.test(name)) return "gurmukhi";
  if (/gujarati/.test(name)) return "gujarati";
  if (/oriya|odia/.test(name)) return "oriya";
  if (/tamil/.test(name)) return "tamil";
  if (/telugu/.test(name)) return "telugu";
  if (/kannada/.test(name)) return "kannada";
  if (/malayalam/.test(name)) return "malayalam";
  if (/arabic|naskh|nastaliq|urdu|persian/.test(name)) return "arabic";
  if (/hebrew/.test(name)) return "hebrew";
  if (/cyrillic|russian/.test(name)) return "cyrillic";
  if (/greek/.test(name)) return "greek";
  if (/cjk|han|chinese|japanese|japan|korean|gothic/.test(name)) return "han";
  return "generic";
}

function fontMatchesTextScript(family, text) {
  const textScript = scriptGroupForText(text);
  const fontScript = scriptGroupForFont(family);
  return fontScript === "generic" || textScript === "neutral" || fontScript === textScript;
}

function fontCandidateEntries(availableFonts, originalText = "") {
  const candidates = [...FONT_CANDIDATES];
  const seen = new Set(candidates.map(({ family }) => family.toLowerCase()));
  // For non-Latin text, include the host catalog so a matching script font
  // can be found. Latin OCR deliberately uses the same curated cross-platform
  // list in the browser and worker; arbitrary host faces such as bitmap and
  // script-specific system fonts can match a small crop numerically while
  // exporting bars or unrelated glyphs.
  const includeHostFonts = !["latin", "neutral"].includes(scriptGroupForText(originalText));
  if (!includeHostFonts) return candidates;
  for (const family of Array.isArray(availableFonts) ? availableFonts : []) {
    const name = String(family).trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key) || inferredFontGroup(name) === "unsupported" || !/[a-z]/i.test(name)) continue;
    seen.add(key);
    candidates.push({ family: name, group: inferredFontGroup(name) });
  }
  return candidates;
}

function cssFontFamily(family) {
  if (/^(sans-serif|serif|monospace|cursive|fantasy)$/i.test(family)) return family;
  return `"${String(family).replaceAll('"', '\\"')}"`;
}

function fontSpec(weight, size, family) {
  return `${weight} ${Math.max(1, size)}px ${cssFontFamily(family)}`;
}

function fontIsAvailable(family, availableFonts) {
  if (Array.isArray(availableFonts) && availableFonts.length) {
    const target = family.toLowerCase();
    return availableFonts.some((candidate) => String(candidate).toLowerCase() === target);
  }
  if (typeof document !== "undefined" && document.fonts?.check) {
    try {
      return document.fonts.check(fontSpec(400, 16, family));
    } catch {
      return false;
    }
  }
  // Node's canvas uses the host font registry. When the caller cannot expose
  // that registry, let the canvas resolve the family or its normal fallback.
  return true;
}

function createScratchCanvas(canvas, width, height) {
  if (typeof OffscreenCanvas !== "undefined") return new OffscreenCanvas(width, height);
  if (typeof document !== "undefined" && document.createElement) {
    const output = document.createElement("canvas");
    output.width = width;
    output.height = height;
    return output;
  }
  if (typeof canvas?.constructor === "function") {
    try {
      return new canvas.constructor(width, height);
    } catch {
      return null;
    }
  }
  return null;
}

function preservedTextRegion(canvas, data, original, mask, width, height) {
  const regionWidth = Math.max(1, Math.ceil(original.x1 - original.x0));
  const regionHeight = Math.max(1, Math.ceil(original.y1 - original.y0));
  const scratch = createScratchCanvas(canvas, regionWidth, regionHeight);
  const scratchContext = scratch?.getContext?.("2d");
  if (!scratchContext?.createImageData) return null;
  const image = scratchContext.createImageData(regionWidth, regionHeight);
  for (let y = 0; y < regionHeight; y += 1) {
    for (let x = 0; x < regionWidth; x += 1) {
      const sourceX = clamp(Math.floor(original.x0 + x), 0, width - 1);
      const sourceY = clamp(Math.floor(original.y0 + y), 0, height - 1);
      const pixel = readPixel(data, sourceX, sourceY, width, height);
      const background = estimateBackground(data, mask, sourceX, sourceY, width, height);
      const alpha = clamp(Math.round((distance(pixel, background) - 8) * 255 / 44), 0, 255);
      const offset = (y * regionWidth + x) * 4;
      image.data[offset] = pixel[0];
      image.data[offset + 1] = pixel[1];
      image.data[offset + 2] = pixel[2];
      image.data[offset + 3] = alpha;
    }
  }
  scratchContext.putImageData(image, 0, 0);
  return scratch;
}

function sourceInkMask(data, original, mask, width, height) {
  const sourceWidth = Math.max(1, Math.ceil(original.x1 - original.x0));
  const sourceHeight = Math.max(1, Math.ceil(original.y1 - original.y0));
  // Font comparison only needs the shape, not every full-resolution pixel.
  // Capping the probe keeps OCR usable for very large poster headings.
  const targetWidth = Math.min(720, sourceWidth);
  const targetHeight = Math.min(180, sourceHeight);
  const values = new Float32Array(targetWidth * targetHeight);
  let maximumDistance = 0;
  const distances = new Float32Array(values.length);
  for (let targetY = 0; targetY < targetHeight; targetY += 1) {
    const y = Math.min(height - 1, Math.floor(original.y0 + ((targetY + 0.5) * sourceHeight) / targetHeight));
    for (let targetX = 0; targetX < targetWidth; targetX += 1) {
      const x = Math.min(width - 1, Math.floor(original.x0 + ((targetX + 0.5) * sourceWidth) / targetWidth));
      const pixel = readPixel(data, x, y, width, height);
      const background = estimateBackground(data, mask, x, y, width, height);
      const pixelDistance = distance(pixel, background);
      const offset = targetY * targetWidth + targetX;
      distances[offset] = pixelDistance;
      maximumDistance = Math.max(maximumDistance, pixelDistance);
    }
  }
  const threshold = Math.max(35, maximumDistance * 0.16);
  const range = Math.max(1, maximumDistance - threshold);
  for (let index = 0; index < values.length; index += 1) values[index] = clamp((distances[index] - threshold) / range, 0, 1);
  return { values, width: targetWidth, height: targetHeight };
}

function candidateInkMask(canvas, text, weight, family, width, height) {
  const scratch = createScratchCanvas(canvas, width, height);
  if (!scratch) return null;
  const context = scratch.getContext("2d");
  context.clearRect(0, 0, width, height);
  context.fillStyle = "#ffffff";
  context.font = fontSpec(weight, 100, family);
  const metrics = context.measureText(text);
  const glyphHeight = Number(metrics.actualBoundingBoxAscent || 0) + Number(metrics.actualBoundingBoxDescent || 0);
  if (!metrics.width || !glyphHeight) return null;
  const scaleX = width / metrics.width;
  const scaleY = height / glyphHeight;
  context.save();
  context.scale(scaleX, scaleY);
  context.textAlign = "left";
  context.textBaseline = "alphabetic";
  context.fillText(text, -(Number(metrics.actualBoundingBoxLeft) || 0), Number(metrics.actualBoundingBoxAscent || 80));
  context.restore();
  const pixels = context.getImageData(0, 0, width, height).data;
  const values = new Float32Array(width * height);
  for (let index = 0; index < values.length; index += 1) values[index] = pixels[index * 4 + 3] / 255;
  return { values, width, height, metrics, glyphHeight };
}

function maskDifference(source, candidate) {
  let difference = 0;
  const count = source.values.length;
  for (let index = 0; index < count; index += 1) {
    const left = source.values[index];
    const right = candidate.values[index];
    difference += Math.abs(left - right) * 0.7;
    difference += (left >= 0.28) === (right >= 0.28) ? 0 : 0.3;
  }
  return difference / Math.max(1, count);
}

function closestFont(canvas, originalText, original, mask, weight, data, foreground, width, height, availableFonts) {
  if (!originalText || originalText.length > 400) return null;
  const source = sourceInkMask(data, original, mask, width, height);
  const channels = foreground.slice(0, 3);
  const saturation = Math.max(...channels) - Math.min(...channels);
  const textScript = scriptGroupForText(originalText);
  let best = null;
  const entries = fontCandidateEntries(availableFonts, originalText).filter((entry) => fontMatchesTextScript(entry.family, originalText));
  // Host font catalogs contain many script-specific and decorative faces. A
  // Latin title rendered with Kannada/Gurmukhi/Zapfino can score well on a
  // small OCR crop while producing bars or wildly incorrect glyphs in the
  // export. For neutral-colour Latin text, prefer stable sans/serif faces;
  // vivid artwork text still gets the handwritten/display candidates used by
  // the browser preview. Non-Latin text keeps script-specific candidates.
  const safeEntries = (textScript === "latin" || textScript === "neutral") && saturation < 70
    ? entries.filter(({ group }) => ["sans", "rounded", "serif"].includes(group))
    : entries;
  const eligibleEntries = safeEntries.length ? safeEntries : entries;
  for (const entry of eligibleEntries) {
    const { family, group } = entry;
    if (!fontIsAvailable(family, availableFonts)) continue;
    const candidate = candidateInkMask(canvas, originalText, weight, family, source.width, source.height);
    if (!candidate) continue;
    // Colour is a useful signal for slide-style OCR: yellow/cyan text is
    // commonly handwritten or display text. Keep those candidates in the
    // race, but apply a small prior so a geometry tie does not turn a title
    // into Arial. For neutral text, prefer sans/rounded families unless a
    // serif candidate is materially closer to the source glyph mask.
    const groupPenalty = saturation >= 70
      ? (group === "hand" || group === "display" ? 0 : group === "rounded" ? 0.02 : 0.08)
      : (group === "sans" || group === "rounded" ? 0 : group === "serif" ? 0.035 : 0.06);
    const score = maskDifference(source, candidate) + groupPenalty;
    if (!best || score < best.score) best = { family, score, glyphHeight: candidate.glyphHeight };
  }
  if (!best) return null;
  const fontSize = Math.max(8, Math.round((original.y1 - original.y0) * 100 / (best.glyphHeight || 100)));
  const context = canvas.getContext("2d");
  context.font = fontSpec(weight, fontSize, best.family);
  const metrics = context.measureText(originalText);
  const glyphHeight = Number(metrics.actualBoundingBoxAscent || 0) + Number(metrics.actualBoundingBoxDescent || 0);
  return {
    weight,
    fontFamily: best.family,
    fontSize,
    scaleX: (original.x1 - original.x0) / Math.max(1, metrics.width),
    ascent: Number(metrics.actualBoundingBoxAscent || fontSize * 0.8),
    descent: Number(metrics.actualBoundingBoxDescent || fontSize * 0.2),
    score: best.score,
    glyphHeight,
    foreground,
  };
}

function textStyle(canvas, context, data, original, mask, originalText, replacement, foreground, width, height, availableFonts, fontCache) {
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
  const cacheKey = [originalText, Math.round(original.x1 - original.x0), Math.round(original.y1 - original.y0), weight, ...foreground.slice(0, 3)].join("|");
  if (fontCache.has(cacheKey)) return fontCache.get(cacheKey);
  const matched = closestFont(canvas, originalText, original, mask, weight, data, foreground, width, height, availableFonts);
  if (matched) {
    fontCache.set(cacheKey, matched);
    return matched;
  }
  const channels = foreground.slice(0, 3);
  const saturation = Math.max(...channels) - Math.min(...channels);
  // OCR cannot recover a font file from an image-only PDF. Preserve the
  // visual character where possible: saturated display text is usually a
  // handwritten/title face, while neutral text is best reconstructed with a
  // bold sans-serif stack. The same choice is used in preview and export.
  const fontFamily = saturation >= 70
    ? "Comic Sans MS"
    : "Arial";
  let fontSize = Math.max(8, original.y1 - original.y0);
  const sample = replacement || "Hg";
  for (let iteration = 0; iteration < 4; iteration += 1) {
    context.font = fontSpec(weight, Math.max(8, Math.round(fontSize)), fontFamily);
    const metrics = context.measureText(sample);
    const glyphHeight = Number(metrics.actualBoundingBoxAscent || 0) + Number(metrics.actualBoundingBoxDescent || 0);
    if (glyphHeight > 0) fontSize *= (original.y1 - original.y0) / glyphHeight;
  }
  context.font = fontSpec(weight, Math.max(8, Math.round(fontSize)), fontFamily);
  const metrics = context.measureText(sample);
  const style = {
    weight,
    fontFamily,
    scaleX: 1,
    fontSize: Math.max(8, Math.round(fontSize)),
    ascent: Number(metrics.actualBoundingBoxAscent || fontSize * 0.8),
    descent: Number(metrics.actualBoundingBoxDescent || fontSize * 0.2),
  };
  fontCache.set(cacheKey, style);
  return style;
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
export function applyRasterTextEdits(canvas, edits, { availableFonts, onFontMatch } = {}) {
  const context = canvas.getContext("2d");
  const width = canvas.width;
  const height = canvas.height;
  const source = context.getImageData(0, 0, width, height);
  const warnings = [];
  const prepared = [];
  const fontCache = new Map();
  for (const edit of edits || []) {
    const original = normalizedBox(edit?.bbox);
    if (!original) throw new Error("An OCR text edit has an invalid page region.");
    if (original.x0 < 0 || original.y0 < 0 || original.x1 > width || original.y1 > height) throw new Error("An OCR text edit is outside the rendered page.");
    const offsetX = Number(edit?.offsetX) || 0;
    const offsetY = Number(edit?.offsetY) || 0;
    const rawScale = Number(edit?.scale);
    const scale = Number.isFinite(rawScale) ? Math.max(0.25, Math.min(4, rawScale)) : 1;
    const rawRotation = Number(edit?.rotation);
    const rotation = Number.isFinite(rawRotation) ? rawRotation : 0;
    const moveOnly = Boolean(edit?.moveOnly);
    const replacement = String(edit?.replacementText ?? "");
    // Clear only the original OCR region. Extending the inpaint mask to the
    // replacement width creates a visible rectangle and erases artwork,
    // borders, or adjacent runs. Overflow is intentionally painted over the
    // untouched page instead, so the surrounding graphic remains authentic.
    const mask = expandedBox(original, width, height);
    const foreground = foregroundColor(source.data, original, mask, width, height);
    const preserved = moveOnly ? preservedTextRegion(canvas, source.data, original, mask, width, height) : null;
    const style = !moveOnly && replacement ? textStyle(canvas, context, source.data, original, mask, String(edit?.originalText || ""), replacement, foreground, width, height, availableFonts, fontCache) : null;
    if (style && typeof onFontMatch === "function") onFontMatch({ originalText: String(edit?.originalText || ""), ...style });
    const placement = {
      x0: original.x0 + offsetX,
      y0: original.y0 + offsetY,
      x1: original.x1 + offsetX,
      y1: original.y1 + offsetY,
    };
    prepared.push({ edit, original, mask, placement, replacement, style, foreground, preserved, moveOnly, scale, rotation });
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
  for (const { edit, original, placement, replacement, style, foreground, preserved, moveOnly, scale, rotation } of prepared) {
    if (moveOnly && preserved) {
      context.save();
      const centerX = (placement.x0 + placement.x1) / 2;
      const centerY = (placement.y0 + placement.y1) / 2;
      context.translate(centerX, centerY);
      context.rotate(rotation * Math.PI / 180);
      context.scale(scale, scale);
      context.translate(-centerX, -centerY);
      context.drawImage(preserved, placement.x0, placement.y0, preserved.width, preserved.height);
      context.restore();
    } else if (!moveOnly && replacement) {
      context.save();
      context.font = fontSpec(style.weight, style.fontSize, style.fontFamily);
      context.textAlign = "left";
      context.textBaseline = "alphabetic";
      const glyphHeight = style.ascent + style.descent;
      const baseline = placement.y0 + Math.max(0, (original.y1 - original.y0 - glyphHeight) / 2) + style.ascent;
      context.fillStyle = rgbaString(foreground);
      context.save();
      const centerX = (placement.x0 + placement.x1) / 2;
      const centerY = (placement.y0 + placement.y1) / 2;
      context.translate(centerX, centerY);
      context.rotate(rotation * Math.PI / 180);
      context.scale(scale, scale);
      context.translate(-centerX, -centerY);
      context.translate(placement.x0, baseline);
      context.scale(style.scaleX || 1, 1);
      context.fillText(replacement, 0, 0);
      context.restore();
      const renderedWidth = context.measureText(replacement).width * (style.scaleX || 1) * scale;
      const originalWidth = Math.max(1, original.x1 - original.x0);
      if (renderedWidth > originalWidth) warnings.push(`OCR replacement for “${String(edit?.originalText || "text").slice(0, 80)}” is wider than the original text region and was allowed to overflow without reflow.`);
      const rotatedHalfWidth = Math.abs(Math.cos(rotation * Math.PI / 180)) * renderedWidth / 2 + Math.abs(Math.sin(rotation * Math.PI / 180)) * (style.ascent + style.descent) * scale / 2;
      if (centerX + rotatedHalfWidth > width || centerX - rotatedHalfWidth < 0) warnings.push(`OCR replacement for “${String(edit?.originalText || "text").slice(0, 80)}” reaches the page edge and may be clipped there.`);
      context.restore();
    }
    if (Number(edit?.confidence) && Number(edit.confidence) < 70) warnings.push(`OCR confidence was low for “${String(edit?.originalText || "text").slice(0, 80)}”. Review the exported page.`);
  }
  return warnings;
}
