import { PDF_TEXT_BOX_FONTS, textBoxFontDefinition } from "./pdf-text-box.js";

export const PDF_TEXT_ALIGNMENTS = ["left", "center", "right"];

const FONT_VALUES = new Set(PDF_TEXT_BOX_FONTS.map((font) => font.value));

export function formatHexColor(value, fallback = "#000000") {
  const candidate = String(value || "").trim();
  return /^#[0-9a-f]{6}$/i.test(candidate) ? candidate.toLowerCase() : fallback;
}

export function fontFamilyFromPdfName(value) {
  const name = String(value || "").toLowerCase();
  if (/noto.?serif.?devanagari/.test(name)) return "NotoSerifDevanagari";
  if (/noto.?sans.?devanagari|devanagari|hindi|nagari/.test(name)) return "NotoSansDevanagari";
  if (/roboto/.test(name)) return "Roboto";
  if (/open.?sans/.test(name)) return "OpenSans";
  if (/merriweather/.test(name)) return "Merriweather";
  if (/montserrat/.test(name)) return "Montserrat";
  if (/nunito/.test(name)) return "Nunito";
  if (/lato/.test(name)) return "Lato";
  if (/fira.?mono/.test(name)) return "FiraMono";
  if (/courier|mono|consolas|menlo|monaco/.test(name)) return "Courier";
  if (/times|serif|roman|georgia|baskerville|garamond|palatino|bodoni|caslon|charter|didot|cochin|athelas|bookman/.test(name)) return "Times-Roman";
  return "Helvetica";
}

export function textFormatDefaults(run = {}) {
  const baseFont = String(run.baseFont || run.fontName || run.previewFontFamily || run.fontFamily || "");
  const boxHeight = Number(run.bbox?.y1) - Number(run.bbox?.y0);
  const fontSize = Number(run.fontSize) || Number(run.item?.height) || Number(run.height) || (Number.isFinite(boxHeight) ? boxHeight : 0);
  return {
    fontFamily: FONT_VALUES.has(run.fontFamily) ? run.fontFamily : fontFamilyFromPdfName(baseFont),
    fontSize: Math.max(1, Math.min(500, fontSize || 18)),
    bold: Boolean(run.bold ?? /bold|black|heavy|semibold|demi/i.test(baseFont)),
    italic: Boolean(run.italic ?? /italic|oblique|slanted/i.test(baseFont)),
    underline: Boolean(run.underline),
    color: formatHexColor(run.color, "#000000"),
    alignment: PDF_TEXT_ALIGNMENTS.includes(run.alignment) ? run.alignment : "left",
    characterSpacing: Number.isFinite(Number(run.characterSpacing)) ? Number(run.characterSpacing) : 0,
    lineSpacing: Number.isFinite(Number(run.lineSpacing)) ? Number(run.lineSpacing) : 1.2,
  };
}

export function normalizeTextFormat(value, fallback = {}) {
  if (!value || typeof value !== "object") return null;
  const defaults = textFormatDefaults(fallback);
  const fontFamily = FONT_VALUES.has(value.fontFamily) ? value.fontFamily : defaults.fontFamily;
  const fontSizeValue = Number(value.fontSize);
  const characterSpacingValue = Number(value.characterSpacing);
  const lineSpacingValue = Number(value.lineSpacing);
  const result = {
    fontFamily,
    fontSize: Number.isFinite(fontSizeValue) ? Math.max(1, Math.min(500, fontSizeValue)) : defaults.fontSize,
    bold: value.bold === undefined ? defaults.bold : Boolean(value.bold),
    italic: value.italic === undefined ? defaults.italic : Boolean(value.italic),
    underline: value.underline === undefined ? defaults.underline : Boolean(value.underline),
    color: formatHexColor(value.color, defaults.color),
    alignment: PDF_TEXT_ALIGNMENTS.includes(value.alignment) ? value.alignment : defaults.alignment,
    characterSpacing: Number.isFinite(characterSpacingValue) ? Math.max(-100, Math.min(100, characterSpacingValue)) : defaults.characterSpacing,
    lineSpacing: Number.isFinite(lineSpacingValue) ? Math.max(0.1, Math.min(10, lineSpacingValue)) : defaults.lineSpacing,
  };
  return result;
}

export function scaleTextFormat(value, scale = 1) {
  const format = normalizeTextFormat(value);
  if (!format) return null;
  const factor = Number.isFinite(Number(scale)) && Number(scale) > 0 ? Number(scale) : 1;
  return {
    ...format,
    fontSize: Math.max(1, Math.min(500, format.fontSize * factor)),
    characterSpacing: Math.max(-100, Math.min(100, format.characterSpacing * factor)),
  };
}

export function hasTextFormat(value) {
  return Boolean(value && typeof value === "object" && Object.keys(value).length);
}

export function textFormatColor(value) {
  const hex = formatHexColor(value, "#000000").slice(1);
  return {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
  };
}

export function textFormatFontName(format) {
  const definition = textBoxFontDefinition(format?.fontFamily);
  if (format?.bold && format?.italic) return definition.boldItalic;
  if (format?.bold) return definition.bold;
  if (format?.italic) return definition.italic;
  return definition.regular;
}
