import { PDFArray, PDFDict, PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } from "pdf-lib";
import { textBoxFontAsset } from "./pdf-text-box.js";
import { hasTextFormat, normalizeTextFormat, textFormatColor, textFormatFontName } from "./pdf-text-format.js";

const TEXT_OPERATORS = new Set(["Tj", "TJ", "'", "\""]);
const PDF_WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const PDF_DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
const WIN_ANSI_SPECIAL = new Map([
  [0x20ac, 0x80], [0x201a, 0x82], [0x192, 0x83], [0x201e, 0x84], [0x2026, 0x85], [0x2020, 0x86], [0x2021, 0x87],
  [0x2c6, 0x88], [0x2030, 0x89], [0x160, 0x8a], [0x2039, 0x8b], [0x152, 0x8c], [0x17d, 0x8e], [0x2018, 0x91],
  [0x2019, 0x92], [0x201c, 0x93], [0x201d, 0x94], [0x2022, 0x95], [0x2013, 0x96], [0x2014, 0x97], [0x2dc, 0x98],
  [0x2122, 0x99], [0x161, 0x9a], [0x203a, 0x9b], [0x153, 0x9c], [0x17e, 0x9e], [0x178, 0x9f],
]);

function bytesFor(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

function stringFromBytes(value) {
  const bytes = bytesFor(value);
  let result = "";
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.slice(index, index + 8192));
  return result;
}

function bytesFromString(value) {
  return Uint8Array.from(String(value), (character) => character.charCodeAt(0) & 0xff);
}

function decodeUnicodeHex(value) {
  const bytes = bytesFromString(String(value || "").replace(/[<>\s]/g, ""));
  const hexBytes = new Uint8Array(Math.ceil(bytes.length / 2));
  for (let index = 0; index < bytes.length; index += 2) {
    const pair = String.fromCharCode(bytes[index], bytes[index + 1] || 48);
    hexBytes[index / 2] = Number.parseInt(pair, 16) || 0;
  }
  if (hexBytes.length >= 2 && hexBytes[0] === 0xfe && hexBytes[1] === 0xff) {
    let text = "";
    for (let index = 2; index + 1 < hexBytes.length; index += 2) text += String.fromCharCode((hexBytes[index] << 8) | hexBytes[index + 1]);
    return text;
  }
  if (hexBytes.length >= 2 && hexBytes.length % 2 === 0) {
    let text = "";
    for (let index = 0; index + 1 < hexBytes.length; index += 2) text += String.fromCharCode((hexBytes[index] << 8) | hexBytes[index + 1]);
    return text;
  }
  return stringFromBytes(hexBytes);
}

function cmapHex(value) {
  return String(value || "").replace(/[<>\s]/g, "").toUpperCase();
}

function parseToUnicodeCMap(value) {
  const source = stringFromBytes(value);
  const mappings = new Map();
  let codeWidth = 0;
  for (const match of source.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) codeWidth = Math.max(codeWidth, match[1].length / 2);
  for (const section of source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) mappings.set(cmapHex(pair[1]), decodeUnicodeHex(pair[2]));
  }
  for (const section of source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const line of section[1].split(/\r?\n/)) {
      const range = line.match(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(.*)$/);
      if (!range) continue;
      const start = Number.parseInt(range[1], 16);
      const end = Number.parseInt(range[2], 16);
      const destination = range[3].trim();
      if (destination.startsWith("[")) {
        const values = [...destination.matchAll(/<([0-9A-Fa-f]+)>/g)];
        for (let offset = 0; offset <= end - start && offset < values.length; offset += 1) mappings.set((start + offset).toString(16).padStart(range[1].length, "0").toUpperCase(), decodeUnicodeHex(values[offset][1]));
      } else {
        const first = destination.match(/<([0-9A-Fa-f]+)>/);
        if (!first) continue;
        const base = Number.parseInt(first[1], 16);
        for (let offset = 0; offset <= end - start; offset += 1) mappings.set((start + offset).toString(16).padStart(range[1].length, "0").toUpperCase(), String.fromCharCode(base + offset));
      }
    }
  }
  return { mappings, codeWidth: codeWidth || 1 };
}

function isWhitespace(byte) {
  return PDF_WHITESPACE.has(byte);
}

function isDelimiter(byte) {
  return PDF_DELIMITERS.has(byte) || isWhitespace(byte);
}

function parseLiteral(bytes, start) {
  const output = [];
  let index = start + 1;
  let depth = 1;
  while (index < bytes.length) {
    const byte = bytes[index++];
    if (byte === 40) { depth += 1; output.push(byte); continue; }
    if (byte === 41) { depth -= 1; if (depth === 0) break; output.push(byte); continue; }
    if (byte !== 92) { output.push(byte); continue; }
    if (index >= bytes.length) break;
    const escaped = bytes[index++];
    const simple = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
    if (simple[escaped] !== undefined) { output.push(simple[escaped]); continue; }
    if (escaped === 10) continue;
    if (escaped === 13) { if (bytes[index] === 10) index += 1; continue; }
    if (escaped >= 48 && escaped <= 55) {
      let octal = String.fromCharCode(escaped);
      for (let count = 0; count < 2 && index < bytes.length && bytes[index] >= 48 && bytes[index] <= 55; count += 1) octal += String.fromCharCode(bytes[index++]);
      output.push(Number.parseInt(octal, 8));
      continue;
    }
    output.push(escaped);
  }
  return { token: { type: "string", start, end: index }, index };
}

function parseHex(bytes, start) {
  let index = start + 1;
  while (index < bytes.length && bytes[index] !== 62) index += 1;
  if (bytes[index] === 62) index += 1;
  return { token: { type: "string", start, end: index }, index };
}

function parseName(bytes, start) {
  let index = start + 1;
  while (index < bytes.length && !isDelimiter(bytes[index])) index += 1;
  return { token: { type: "name", value: stringFromBytes(bytes.slice(start + 1, index)), start, end: index }, index };
}

function parseArray(bytes, start) {
  const items = [];
  let index = start + 1;
  while (index < bytes.length) {
    while (index < bytes.length && isWhitespace(bytes[index])) index += 1;
    if (bytes[index] === 93) return { token: { type: "array", items, start, end: index + 1 }, index: index + 1 };
    const parsed = parseToken(bytes, index);
    if (!parsed || parsed.index <= index) break;
    items.push(parsed.token);
    index = parsed.index;
  }
  return { token: { type: "array", items, start, end: index }, index };
}

function parseToken(bytes, start) {
  const byte = bytes[start];
  if (byte === 40) return parseLiteral(bytes, start);
  if (byte === 91) return parseArray(bytes, start);
  if (byte === 60 && bytes[start + 1] !== 60) return parseHex(bytes, start);
  if (byte === 47) return parseName(bytes, start);
  let index = start;
  while (index < bytes.length && !isDelimiter(bytes[index])) index += 1;
  if (index === start) return { token: { type: "word", value: String.fromCharCode(byte), start, end: start + 1 }, index: start + 1 };
  const value = stringFromBytes(bytes.slice(start, index));
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { token: { type: "number", value, start, end: index }, index };
  return { token: { type: "word", value, start, end: index }, index };
}

function tokenize(bytes) {
  const tokens = [];
  let index = 0;
  while (index < bytes.length) {
    while (index < bytes.length && (isWhitespace(bytes[index]) || bytes[index] === 37)) {
      if (bytes[index] !== 37) { index += 1; continue; }
      while (index < bytes.length && bytes[index] !== 10 && bytes[index] !== 13) index += 1;
      break;
    }
    if (index >= bytes.length) break;
    const parsed = parseToken(bytes, index);
    if (!parsed || parsed.index <= index) break;
    tokens.push(parsed.token);
    index = parsed.index;
  }
  return tokens;
}

function operatorList(bytes) {
  const rebuilt = [];
  let operands = [];
  for (const token of tokenize(bytes)) {
    if (token.type !== "word") { operands.push(token); continue; }
    rebuilt.push({ name: token.value, operands, start: operands.length ? operands[0].start : token.start, end: token.end });
    operands = [];
  }
  return rebuilt;
}

function streamBytes(context, reference) {
  const stream = context.lookup(reference);
  if (!stream) return new Uint8Array();
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
  if (typeof stream.getContents === "function") return stream.getContents();
  return new Uint8Array();
}

function pageContentBytes(page, context) {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array();
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, index) => contents.get(index)) : [contents];
  const parts = streams.map((reference) => streamBytes(context, reference));
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length + 1, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; result[offset++] = 10; }
  return result;
}

function dictionaryValue(context, dictionary, name) {
  if (!dictionary) return undefined;
  const value = dictionary.get(PDFName.of(name));
  return value ? context.lookup(value) : undefined;
}

function pdfObjectText(object) {
  if (!object) return "";
  if (typeof object.asString === "function") return object.asString();
  if (typeof object.toString === "function") return object.toString();
  return String(object);
}

function fontDetails(page, context, resourceName) {
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.Font, PDFDict);
  const font = fonts?.lookupMaybe(PDFName.of(resourceName), PDFDict);
  if (!font) return { key: resourceName, baseFont: "", mappings: new Map(), codeWidth: 1, winAnsi: false };
  const subtype = pdfObjectText(dictionaryValue(context, font, "Subtype")).replace(/^\//, "");
  const baseFont = pdfObjectText(dictionaryValue(context, font, "BaseFont")).replace(/^\//, "");
  const toUnicodeObject = font.get(PDFName.of("ToUnicode"));
  const toUnicode = toUnicodeObject ? parseToUnicodeCMap(streamBytes(context, toUnicodeObject)) : { mappings: new Map(), codeWidth: 0 };
  const encoding = pdfObjectText(dictionaryValue(context, font, "Encoding")).replace(/^\//, "");
  const standard = /^(Courier|Helvetica|Times|Symbol|ZapfDingbats)(?:-|$)/.test(baseFont);
  return {
    key: resourceName,
    baseFont,
    mappings: toUnicode.mappings,
    codeWidth: toUnicode.codeWidth || (subtype === "Type0" ? 2 : 1),
    winAnsi: encoding === "WinAnsiEncoding" || standard || (!encoding && subtype !== "Type0"),
  };
}

function encodedTextFor(text, font) {
  const value = String(text ?? "");
  if (font?.mappings?.size) {
    // CMaps may map one code to a whole Unicode grapheme (for example a
    // Devanagari cluster). Prefer the longest mapping so the preview uses
    // the same embedded font code sequence as the source PDF.
    const mappings = [...font.mappings.entries()]
      .filter(([, unicode]) => unicode)
      .sort((left, right) => right[1].length - left[1].length);
    const codes = [];
    for (let index = 0; index < value.length;) {
      const match = mappings.find(([, unicode]) => value.startsWith(unicode, index));
      if (!match) return null;
      codes.push(match[0]);
      index += match[1].length;
    }
    return `<${codes.join("")}>`;
  }
  if (font?.winAnsi) return encodeWinAnsi(value);
  return null;
}

function textOperand(operator) {
  if (!operator) return null;
  if (operator.name === "Tj" || operator.name === "'") return operator.operands.length === 1 && operator.operands[0].type === "string" ? operator.operands[0] : null;
  if (operator.name === "\"") return operator.operands.length === 3 && operator.operands[2].type === "string" ? operator.operands[2] : null;
  if (operator.name === "TJ") {
    const array = operator.operands.length === 1 && operator.operands[0].type === "array" ? operator.operands[0] : null;
    return array && array.items.every((item) => item.type === "string" || item.type === "number") ? array : null;
  }
  return null;
}

function encodeWinAnsi(text) {
  const bytes = [];
  for (const character of Array.from(text)) {
    const code = character.codePointAt(0);
    const encoded = code >= 0x20 && code <= 0x7e ? code : code >= 0xa0 && code <= 0xff ? code : WIN_ANSI_SPECIAL.get(code);
    if (encoded === undefined) throw new Error(`The live preview cannot encode “${character}” in this PDF font yet. Export still supports the normal fallback-font path.`);
    bytes.push(encoded);
  }
  return `<${bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase()}>`;
}

function replacementOperand(operand, encoded) {
  if (operand.type !== "array") return encoded;
  const items = [];
  let inserted = false;
  for (const item of operand.items) {
    if (item.type === "string") {
      if (!inserted) { items.push(encoded); inserted = true; }
    } else items.push(item.value);
  }
  if (!inserted) items.unshift(encoded);
  return `[${items.join(" ")}]`;
}

function pdfNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 0.0001) return "0";
  return String(Math.round(number * 1000) / 1000);
}

function pdfName(value) {
  return `/${String(value || "").replace(/[^!#$&*+\-./0-9:;=?@A-Z\\^_`a-z|~]/g, (character) => `#${character.charCodeAt(0).toString(16).padStart(2, "0")}`)}`;
}

function bundledFallbackFamily(text, baseFont) {
  if (!/[\u0900-\u097f]/u.test(String(text || ""))) return "";
  return /times|serif/i.test(String(baseFont || "")) ? "NotoSerifDevanagari" : "NotoSansDevanagari";
}

let previewFontkitPromise;
const previewFontBytesCache = new Map();

async function embedPreviewFallbackFont(document, family, baseFontOrFormat) {
  const format = typeof baseFontOrFormat === "object" ? baseFontOrFormat : null;
  const bold = format ? Boolean(format.bold) : /bold|black|heavy/i.test(String(baseFontOrFormat || ""));
  const italic = format ? Boolean(format.italic) : /italic|oblique|slanted/i.test(String(baseFontOrFormat || ""));
  const asset = textBoxFontAsset({ fontFamily: family, bold, italic });
  if (!asset) return null;
  if (!previewFontkitPromise) previewFontkitPromise = import("fontkit").then((module) => module.default || module);
  document.registerFontkit(await previewFontkitPromise);
  let bytes = previewFontBytesCache.get(asset);
  if (!bytes) {
    const response = await fetch(`/fonts/${asset}`, { cache: "force-cache" });
    if (!response.ok) return null;
    bytes = new Uint8Array(await response.arrayBuffer());
    previewFontBytesCache.set(asset, bytes);
  }
  return document.embedFont(bytes);
}

function ensureFallbackFontResource(document, page, fallbackFont, sequence) {
  const context = document.context;
  const originalResources = page.node.Resources();
  const resources = originalResources ? originalResources.clone(context) : context.obj({});
  const originalFonts = originalResources?.lookupMaybe(PDFName.Font, PDFDict);
  const fonts = originalFonts ? originalFonts.clone(context) : context.obj({});
  let key = `MTPreviewFallback${sequence}`;
  while (fonts.has(PDFName.of(key))) key = `MTPreviewFallback${sequence += 1}`;
  fonts.set(PDFName.of(key), fallbackFont.ref);
  resources.set(PDFName.Font, fonts);
  page.node.set(PDFName.Resources, resources);
  return key;
}

function textFormatOperators(format, fontKey) {
  const color = textFormatColor(format?.color);
  const size = Number(format?.fontSize) || 18;
  const characterSpacing = Number(format?.characterSpacing) || 0;
  const lineSpacing = (Number(format?.lineSpacing) || 1.2) * size;
  return `${pdfName(fontKey)} ${pdfNumber(size)} Tf ${pdfNumber(characterSpacing)} Tc ${pdfNumber(lineSpacing)} TL ${pdfNumber(color.r)} ${pdfNumber(color.g)} ${pdfNumber(color.b)} rg`;
}

function formattedTextBody(operator, encoded, format, fontKey, alignmentShift = 0) {
  const text = encoded ? `<${encoded}>` : operator.name === "TJ" ? "[]" : "()";
  const prefix = `${textFormatOperators(format, fontKey)} `;
  const shift = Math.abs(Number(alignmentShift)) > 0.0001 ? `${pdfNumber(alignmentShift)} 0 Td ` : "";
  if (operator.name === "TJ") return `${prefix}${shift}${text} TJ`;
  if (operator.name === "'") return `${prefix}T* ${shift}${text} Tj`;
  if (operator.name === "\"") {
    const wordSpacing = operator.operands[0]?.value ?? "0";
    const characterSpacing = operator.operands[1]?.value ?? "0";
    return `${prefix}${wordSpacing} Tw ${characterSpacing} Tc T* ${shift}${text} Tj`;
  }
  return `${prefix}${shift}${text} Tj`;
}

function displayOffsetToPdf(page, edit) {
  const rawRotation = page?.getRotation?.();
  const angle = ((Number(rawRotation?.angle ?? rawRotation) || 0) % 360 + 360) % 360;
  const x = Number(edit?.offsetX) || 0;
  const y = Number(edit?.offsetY) || 0;
  const scaleValue = Number(edit?.scale);
  const scale = Number.isFinite(scaleValue) ? Math.max(0.25, Math.min(4, scaleValue)) : 1;
  const scaleXValue = Number(edit?.scaleX);
  const scaleYValue = Number(edit?.scaleY);
  const scaleX = Number.isFinite(scaleXValue) ? Math.max(0.25, Math.min(4, scaleXValue)) : scale;
  const scaleY = Number.isFinite(scaleYValue) ? Math.max(0.25, Math.min(4, scaleYValue)) : scale;
  const rotationValue = Number(edit?.rotation);
  const rotation = Number.isFinite(rotationValue) ? rotationValue : 0;
  const originX = Number.isFinite(Number(edit?.originX)) ? Number(edit.originX) : 0;
  const originY = Number.isFinite(Number(edit?.originY)) ? Number(edit.originY) : 0;
  const radians = rotation * Math.PI / 180;
  const a = scaleX * Math.cos(radians);
  const b = -scaleX * Math.sin(radians);
  const c = scaleY * Math.sin(radians);
  const d = scaleY * Math.cos(radians);
  let pdfX = x;
  let pdfY = -y;
  if (angle === 90) {
    pdfX = y;
    pdfY = x;
  } else if (angle === 180) {
    pdfX = -x;
    pdfY = y;
  } else if (angle === 270) {
    pdfX = -y;
    pdfY = -x;
  }
  const e = pdfX + originX - (a * originX + c * originY);
  const f = pdfY + originY - (b * originX + d * originY);
  if (Math.abs(e) < 0.0001 && Math.abs(f) < 0.0001 && Math.abs(a - 1) < 0.0001 && Math.abs(b) < 0.0001 && Math.abs(c) < 0.0001 && Math.abs(d - 1) < 0.0001) return null;
  return { a, b, c, d, e, f };
}

function moveOperator(operator, replacement, movement) {
  if (!movement) return null;
  const a = Number.isFinite(Number(movement.a)) ? movement.a : 1;
  const b = Number.isFinite(Number(movement.b)) ? movement.b : 0;
  const c = Number.isFinite(Number(movement.c)) ? movement.c : 0;
  const d = Number.isFinite(Number(movement.d)) ? movement.d : 1;
  const e = Number.isFinite(Number(movement.e)) ? movement.e : Number(movement.x) || 0;
  const f = Number.isFinite(Number(movement.f)) ? movement.f : Number(movement.y) || 0;
  return {
    start: operator.start,
    end: operator.end,
    replacement: `q ${pdfNumber(a)} ${pdfNumber(b)} ${pdfNumber(c)} ${pdfNumber(d)} ${pdfNumber(e)} ${pdfNumber(f)} cm ${replacement} Q`,
  };
}

function applyPatches(content, patches) {
  let result = bytesFor(content);
  for (const patch of [...patches].sort((left, right) => right.start - left.start)) {
    const replacement = bytesFromString(patch.replacement);
    const next = new Uint8Array(patch.start + replacement.length + result.length - patch.end);
    next.set(result.subarray(0, patch.start), 0);
    next.set(replacement, patch.start);
    next.set(result.subarray(patch.end), patch.start + replacement.length);
    result = next;
  }
  return result;
}

export async function createPdfTextPreview(input, edits = []) {
  const bytes = bytesFor(input);
  if (!edits.length) return bytes;
  const document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  const pageData = document.getPages().map((page) => ({ page, content: pageContentBytes(page, document.context) }));
  const patchesByPage = new Map();
  for (const edit of edits) {
    if (edit?.mode === "ocr") continue;
    const pageIndex = Number(edit?.pageIndex);
    const page = pageData[pageIndex];
    if (!page) throw new Error("The live preview edit points to an invalid PDF page.");
    const textOperators = [];
    let activeFontKey = "";
    let activeFontSize = 0;
    for (const item of operatorList(page.content)) {
      if (item.name === "Tf" && item.operands.length >= 2 && item.operands.at(-2)?.type === "name") {
        activeFontKey = item.operands.at(-2).value;
        activeFontSize = Number(item.operands.at(-1)?.value) || 0;
        continue;
      }
      if (TEXT_OPERATORS.has(item.name)) textOperators.push({ ...item, fontKey: activeFontKey, fontSize: activeFontSize });
    }
    const operatorGroups = Array.isArray(edit?.operatorGroups) && edit.operatorGroups.length
      ? edit.operatorGroups.map((group) => Array.isArray(group?.operatorOrdinals) && group.operatorOrdinals.length ? group.operatorOrdinals.map(Number) : [Number(group?.operatorOrdinal)])
      : [Array.isArray(edit?.operatorOrdinals) && edit.operatorOrdinals.length ? edit.operatorOrdinals.map(Number) : [Number(edit?.operatorOrdinal)]];
    for (const ordinals of operatorGroups) {
      const selectedOperators = ordinals.map((ordinal) => textOperators[ordinal]);
      if (selectedOperators.some((operator) => !operator)) throw new Error("The live preview could not locate the selected PDF text operator.");
      const movement = displayOffsetToPdf(page.page, edit);
      if (edit?.moveOnly) {
        // A move must not round-trip the displayed Unicode text through the
        // source font. PDF logos often contain private or duplicate glyph
        // mappings, so re-encoding the text can silently change the artwork.
        // Preserve every selected operator byte-for-byte and only wrap it in
        // the translation matrix.
        for (const operator of selectedOperators) {
          const originalOperator = stringFromBytes(page.content.slice(operator.start, operator.end));
          const patch = moveOperator(operator, originalOperator, movement);
          if (!patch) continue;
          if (!patchesByPage.has(pageIndex)) patchesByPage.set(pageIndex, []);
          patchesByPage.get(pageIndex).push(patch);
        }
        continue;
      }
      const firstFont = fontDetails(page.page, document.context, selectedOperators[0].fontKey);
      const replacementText = String(edit?.replacementText ?? "");
      const format = hasTextFormat(edit?.format) ? normalizeTextFormat(edit.format, { baseFont: firstFont.baseFont, fontSize: selectedOperators[0].fontSize, color: "#000000" }) : null;
      let formattedFontKey = "";
      let formattedFont = null;
      if (format) {
        const fontName = textFormatFontName(format);
        const standard = ["Helvetica", "Helvetica-Bold", "Helvetica-Oblique", "Helvetica-BoldOblique", "Times-Roman", "Times-Bold", "Times-Italic", "Times-BoldItalic", "Courier", "Courier-Bold", "Courier-Oblique", "Courier-BoldOblique"].includes(fontName);
        formattedFont = standard ? await document.embedFont(fontName) : await embedPreviewFallbackFont(document, format.fontFamily, format);
        if (!formattedFont) throw new Error(`The selected ${format.fontFamily} font could not be loaded for the live preview.`);
        formattedFontKey = ensureFallbackFontResource(document, page.page, formattedFont, pageIndex + 1);
      }
      let replacement = formattedFont ? formattedFont.encodeText(replacementText).toString().replace(/^<|>$/g, "") : encodedTextFor(replacementText, firstFont);
      let fallbackKey = "";
      if (replacement === null && !format) {
        const fallbackFamily = bundledFallbackFamily(replacementText, firstFont.baseFont);
        if (fallbackFamily) {
          try {
            const fallbackFont = await embedPreviewFallbackFont(document, fallbackFamily, firstFont.baseFont);
            if (fallbackFont) {
              replacement = `<${fallbackFont.encodeText(replacementText).toString().replace(/^<|>$/g, "")}>`;
              fallbackKey = ensureFallbackFontResource(document, page.page, fallbackFont, pageIndex + 1);
            }
          } catch {
            replacement = null;
          }
        }
      }
      if (replacement === null) {
        const character = Array.from(replacementText).find((value) => !firstFont.mappings?.size || !firstFont.mappings.has(value));
        throw new Error(`The live preview cannot encode “${character || replacementText || "the replacement"}” in this PDF font yet. Export still supports the normal fallback-font path.`);
      }
      let alignmentShift = 0;
      if (format && formattedFont) {
        const boxWidth = Number(edit?.boxWidth) || 0;
        const textWidth = formattedFont.widthOfTextAtSize(replacementText, Number(format.fontSize) || 18) + Math.max(0, Array.from(replacementText).length - 1) * (Number(format.characterSpacing) || 0);
        if (boxWidth > 0 && format.alignment === "center") alignmentShift = (boxWidth - textWidth) / 2;
        if (boxWidth > 0 && format.alignment === "right") alignmentShift = boxWidth - textWidth;
      }
      for (const [index, operator] of selectedOperators.entries()) {
        const operand = textOperand(operator);
        if (!operand) throw new Error("The live preview could not locate the selected PDF text operator.");
        const encoded = index === 0 ? replacement : encodedTextFor("", fontDetails(page.page, document.context, operator.fontKey));
        if (encoded === null) throw new Error("The live preview could not encode the selected PDF text operator.");
        if (format && index === 0) {
          const body = formattedTextBody(operator, replacement, format, formattedFontKey, alignmentShift);
          const patch = moveOperator(operator, `q ${body} Q`, movement) || { start: operator.start, end: operator.end, replacement: `q ${body} Q` };
          if (!patchesByPage.has(pageIndex)) patchesByPage.set(pageIndex, []);
          patchesByPage.get(pageIndex).push(patch);
          continue;
        }
        const normalReplacement = replacementOperand(operand, encoded);
        const emptyReplacement = encoded === "<>";
        const fallbackPrefix = fallbackKey && index === 0 && !emptyReplacement ? `${pdfName(fallbackKey)} ${operator.fontSize || 12} Tf ` : "";
        const fallbackSuffix = fallbackKey && index === 0 && !emptyReplacement ? ` ${pdfName(operator.fontKey)} ${operator.fontSize || 12} Tf` : "";
        const body = operator.name === "TJ"
          ? `${fallbackPrefix}${emptyReplacement ? "[]" : normalReplacement} TJ${fallbackSuffix}`
          : operator.name === "'"
            ? `T* ${fallbackPrefix}${emptyReplacement ? "()" : normalReplacement} Tj${fallbackSuffix}`
            : operator.name === "\""
              ? `${operator.operands[0]?.value ?? "0"} Tw ${operator.operands[1]?.value ?? "0"} Tc T* ${fallbackPrefix}${emptyReplacement ? "()" : normalReplacement} Tj${fallbackSuffix}`
              : `${fallbackPrefix}${emptyReplacement ? "()" : normalReplacement} Tj${fallbackSuffix}`;
        const patch = moveOperator(operator, body, movement) || { start: operand.start, end: operand.end, replacement: emptyReplacement ? (operator.name === "TJ" ? "[]" : "()") : normalReplacement };
        if (!patchesByPage.has(pageIndex)) patchesByPage.set(pageIndex, []);
        patchesByPage.get(pageIndex).push(patch);
      }
    }
  }
  for (const [pageIndex, patches] of patchesByPage) {
    const page = pageData[pageIndex];
    page.page.node.set(PDFName.Contents, document.context.register(document.context.flateStream(applyPatches(page.content, patches))));
  }
  return document.save({ useObjectStreams: false });
}
