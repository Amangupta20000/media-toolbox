export const MAX_SVG_MARKUP_BYTES = 25 * 1000 * 1000;
export const MAX_CUSTOM_DIMENSION = 8192;
export const MAX_CUSTOM_PIXELS = MAX_CUSTOM_DIMENSION * MAX_CUSTOM_DIMENSION;

export const SVG_SCALE_OPTIONS = ["1", "2", "3", "4", "custom"];
export const SVG_BACKGROUND_OPTIONS = ["transparent", "color", "gradient"];

export function validateSvgMarkup(markup) {
  const value = String(markup || "").trim();
  if (!value) throw new Error("Add an SVG file or paste SVG code first.");
  if (new TextEncoder().encode(value).byteLength > MAX_SVG_MARKUP_BYTES) throw new Error("SVG files must be 25 MB or smaller.");
  if (!/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[^]*?-->\s*)*<svg\b/i.test(value)) throw new Error("The source does not look like a valid SVG document.");
  if (/<\/?(?:script|foreignObject|iframe|object|embed|audio|video)\b/i.test(value)) throw new Error("This SVG contains an unsupported active or embedded element.");
  if (/(?:\bon[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|\/\/|javascript:|data:(?!image\/)))/i.test(value)) throw new Error("For privacy, SVG event handlers and external or non-image resources are not supported.");
  if (/@import\s+url\s*\(|url\s*\(\s*(?:https?:|\/\/|javascript:)/i.test(value)) throw new Error("For privacy, external SVG stylesheets and resources are not supported.");
  if (/<\!DOCTYPE\b/i.test(value)) throw new Error("SVG documents with external declarations are not supported.");
  return value;
}

export function normalizeSvgMarkup(markup) {
  const value = validateSvgMarkup(markup);
  const rootStart = value.search(/<svg\b/i);
  if (rootStart < 0) return value;
  const rootEnd = value.indexOf(">", rootStart);
  if (rootEnd < 0 || /\bxmlns\s*=/i.test(value.slice(rootStart, rootEnd))) return value;
  return `${value.slice(0, rootStart)}<svg xmlns="http://www.w3.org/2000/svg"${value.slice(rootStart + 4)}`;
}

function positiveDimension(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > MAX_CUSTOM_DIMENSION) throw new Error(`${label} must be a whole number between 1 and ${MAX_CUSTOM_DIMENSION}.`);
  return number;
}

function normalizeBackgroundColor(value) {
  const color = String(value || "#ffffff").trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw new Error("Choose a valid six-digit background colour.");
  return color.toLowerCase();
}

function normalizeBackgroundOpacity(value) {
  const opacity = value === undefined || value === "" ? 100 : Number(value);
  if (!Number.isInteger(opacity) || opacity < 0 || opacity > 100) throw new Error("Background opacity must be a whole number between 0 and 100%.");
  return opacity;
}

function normalizeGradientAngle(value) {
  const angle = value === undefined || value === "" ? 135 : Number(value);
  if (!Number.isInteger(angle) || angle < 0 || angle > 360) throw new Error("Gradient direction must be a whole number between 0 and 360 degrees.");
  return angle;
}

export function normalizeSvgOptions(raw = {}) {
  raw = raw && typeof raw === "object" ? raw : {};
  const scale = String(raw.scale || "1");
  if (!SVG_SCALE_OPTIONS.includes(scale)) throw new Error("Choose 1×, 2×, 3×, 4×, or a custom SVG size.");
  const background = SVG_BACKGROUND_OPTIONS.includes(raw.background) ? raw.background : "transparent";
  const backgroundColor = normalizeBackgroundColor(raw.backgroundColor);
  const backgroundOpacity = normalizeBackgroundOpacity(raw.backgroundOpacity);
  const gradientStartColor = normalizeBackgroundColor(raw.gradientStartColor || "#ffffff");
  const gradientEndColor = normalizeBackgroundColor(raw.gradientEndColor || "#d9f3f1");
  const gradientAngle = normalizeGradientAngle(raw.gradientAngle);
  const preserveAspectRatio = raw.preserveAspectRatio !== false;
  if (scale !== "custom") return { scale, background, backgroundColor, backgroundOpacity, gradientStartColor, gradientEndColor, gradientAngle, preserveAspectRatio };
  const width = positiveDimension(raw.width, "Custom width");
  const height = positiveDimension(raw.height, "Custom height");
  if (width * height > MAX_CUSTOM_PIXELS) throw new Error("The custom output is too large. Choose dimensions up to 8192 × 8192 pixels.");
  return { scale, width, height, background, backgroundColor, backgroundOpacity, gradientStartColor, gradientEndColor, gradientAngle, preserveAspectRatio };
}
