const MAX_SVG_MARKUP_BYTES = 25 * 1000 * 1000;
const MAX_CUSTOM_DIMENSION = 8192;
const MAX_CUSTOM_PIXELS = 8192 * 8192;

export const SVG_SCALE_OPTIONS = ["1", "2", "3", "4", "custom"];

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

export function normalizeSvgOptions(raw = {}) {
  const scale = String(raw.scale || "1");
  if (!SVG_SCALE_OPTIONS.includes(scale)) throw new Error("Choose 1×, 2×, 3×, 4×, or a custom SVG size.");
  const background = raw.background === "color" ? "color" : "transparent";
  const backgroundColor = normalizeBackgroundColor(raw.backgroundColor);
  if (scale !== "custom") return { scale, background, backgroundColor };
  const width = positiveDimension(raw.width, "Custom width");
  const height = positiveDimension(raw.height, "Custom height");
  if (width * height > MAX_CUSTOM_PIXELS) throw new Error("The custom output is too large. Choose dimensions up to 8192 × 8192 pixels.");
  return { scale, width, height, background, backgroundColor };
}
