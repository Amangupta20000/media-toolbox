import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, StandardFonts, decodePDFRawStream } from "pdf-lib";
import { Encodings } from "@pdf-lib/standard-fonts";
import * as fontkit from "fontkit";
import { graphemeCount } from "./text-metrics.js";
import { textBoxFontAsset } from "./pdf-text-box.js";

const TEXT_OPERATORS = new Set(["Tj", "TJ", "'", "\""]);
const PDF_WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const PDF_DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

function bytesFor(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value);
}

export function sha256Hex(value) {
  return crypto.createHash("sha256").update(Buffer.from(bytesFor(value))).digest("hex");
}

function hexFor(value) {
  return Array.from(bytesFor(value), (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function bytesFromHex(value) {
  const clean = String(value || "").replace(/\s+/g, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const result = new Uint8Array(padded.length / 2);
  for (let index = 0; index < result.length; index += 1) result[index] = Number.parseInt(padded.slice(index * 2, index * 2 + 2), 16) || 0;
  return result;
}

function isWhitespace(byte) {
  return PDF_WHITESPACE.has(byte);
}

function isDelimiter(byte) {
  return PDF_DELIMITERS.has(byte) || isWhitespace(byte);
}

function stringFromBytes(value) {
  return Buffer.from(bytesFor(value)).toString("latin1");
}

function parseLiteral(bytes, start) {
  const output = [];
  let index = start + 1;
  let depth = 1;
  while (index < bytes.length) {
    const byte = bytes[index++];
    if (byte === 40) {
      depth += 1;
      output.push(byte);
      continue;
    }
    if (byte === 41) {
      depth -= 1;
      if (depth === 0) break;
      output.push(byte);
      continue;
    }
    if (byte !== 92) {
      output.push(byte);
      continue;
    }
    if (index >= bytes.length) break;
    const escaped = bytes[index++];
    const simple = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12, 40: 40, 41: 41, 92: 92 };
    if (simple[escaped] !== undefined) {
      output.push(simple[escaped]);
      continue;
    }
    if (escaped === 10) continue;
    if (escaped === 13) {
      if (bytes[index] === 10) index += 1;
      continue;
    }
    if (escaped >= 48 && escaped <= 55) {
      let octal = String.fromCharCode(escaped);
      for (let count = 0; count < 2 && index < bytes.length && bytes[index] >= 48 && bytes[index] <= 55; count += 1) octal += String.fromCharCode(bytes[index++]);
      output.push(Number.parseInt(octal, 8));
      continue;
    }
    output.push(escaped);
  }
  return { token: { type: "string", bytes: Uint8Array.from(output), start, end: index }, index };
}

function parseName(bytes, start) {
  let index = start + 1;
  const raw = [];
  while (index < bytes.length && !isDelimiter(bytes[index])) raw.push(bytes[index++]);
  const rawText = stringFromBytes(raw);
  const value = rawText.replace(/#([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
  return { token: { type: "name", value, raw: rawText, start, end: index }, index };
}

function parseHexString(bytes, start) {
  let index = start + 1;
  const raw = [];
  while (index < bytes.length && bytes[index] !== 62) raw.push(bytes[index++]);
  if (bytes[index] === 62) index += 1;
  return { token: { type: "string", bytes: bytesFromHex(stringFromBytes(raw)), start, end: index }, index };
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
  if (byte === 60 && bytes[start + 1] !== 60) return parseHexString(bytes, start);
  if (byte === 47) return parseName(bytes, start);
  let index = start;
  while (index < bytes.length && !isDelimiter(bytes[index])) index += 1;
  if (index === start) return { token: { type: "word", value: String.fromCharCode(byte), start, end: start + 1 }, index: start + 1 };
  const value = stringFromBytes(bytes.slice(start, index));
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { token: { type: "number", value: Number(value), raw: value, start, end: index }, index };
  return { token: { type: "word", value, raw: value, start, end: index }, index };
}

function tokenize(bytes) {
  const tokens = [];
  let index = 0;
  while (index < bytes.length) {
    while (index < bytes.length && (isWhitespace(bytes[index]) || bytes[index] === 37)) {
      if (bytes[index] !== 37) {
        index += 1;
        continue;
      }
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
  const tokens = tokenize(bytes);
  const rebuilt = [];
  let operands = [];
  for (const token of tokens) {
    if (token.type !== "word") {
      operands.push(token);
      continue;
    }
    rebuilt.push({ name: token.value, operands, start: operands.length ? operands[0].start : token.start, end: token.end, token });
    operands = [];
  }
  return rebuilt;
}

function pdfName(value) {
  return `/${String(value || "").replace(/[^!#$&*+\-./0-9:;=?@A-Z\\^_`a-z|~]/g, (character) => `#${character.charCodeAt(0).toString(16).padStart(2, "0")}`)}`;
}

function pdfObjectText(object) {
  if (!object) return "";
  if (typeof object.asString === "function") return object.asString();
  if (typeof object.toString === "function") return object.toString();
  return String(object);
}

function decodeUnicodeHex(value) {
  const bytes = bytesFromHex(value);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let text = "";
    for (let index = 2; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    return text;
  }
  if (bytes.length >= 2 && bytes.length % 2 === 0) {
    let text = "";
    for (let index = 0; index + 1 < bytes.length; index += 2) text += String.fromCharCode((bytes[index] << 8) | bytes[index + 1]);
    return text;
  }
  return stringFromBytes(bytes);
}

function cmapHex(value) {
  return String(value || "").replace(/[<>\s]/g, "").toUpperCase();
}

function parseToUnicodeCMap(value) {
  const source = Buffer.from(bytesFor(value)).toString("latin1");
  const mappings = new Map();
  let codeWidth = 0;
  for (const match of source.matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) codeWidth = Math.max(codeWidth, match[1].length / 2);
  const charSections = source.matchAll(/beginbfchar([\s\S]*?)endbfchar/g);
  for (const section of charSections) {
    for (const pair of section[1].matchAll(/<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g)) mappings.set(cmapHex(pair[1]), decodeUnicodeHex(pair[2]));
  }
  const rangeSections = source.matchAll(/beginbfrange([\s\S]*?)endbfrange/g);
  for (const section of rangeSections) {
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
  const length = parts.reduce((total, part) => total + part.length + 1, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
    result[offset++] = 10;
  }
  return result;
}

function dictionaryValue(context, dictionary, name) {
  if (!dictionary) return undefined;
  const value = dictionary.get(PDFName.of(name));
  return value ? context.lookup(value) : undefined;
}

function fontDetails(page, context, resourceName) {
  const resources = page.node.Resources();
  const fonts = resources?.lookupMaybe(PDFName.Font, PDFDict);
  const font = fonts?.lookupMaybe(PDFName.of(resourceName), PDFDict);
  if (!font) return { key: resourceName, type: "unknown", supported: false, reason: "The PDF font resource could not be resolved." };
  const subtype = pdfObjectText(dictionaryValue(context, font, "Subtype"));
  const baseFont = pdfObjectText(dictionaryValue(context, font, "BaseFont")).replace(/^\//, "");
  const toUnicodeObject = font.get(PDFName.of("ToUnicode"));
  const toUnicode = toUnicodeObject ? parseToUnicodeCMap(streamBytes(context, toUnicodeObject)) : { mappings: new Map(), codeWidth: 0 };
  const encodingObject = dictionaryValue(context, font, "Encoding");
  const encoding = pdfObjectText(encodingObject).replace(/^\//, "");
  const isStandard = Object.values(StandardFonts).some((value) => String(value) === baseFont || String(value).replace(/-/g, "") === baseFont.replace(/-/g, ""));
  const isWinAnsi = encoding === "WinAnsiEncoding" || isStandard || (!encoding && subtype !== "Type0");
  return {
    key: resourceName,
    type: subtype.replace(/^\//, "") || "unknown",
    baseFont,
    toUnicode,
    encoding: isWinAnsi ? Encodings.WinAnsi : null,
    codeWidth: toUnicode.codeWidth || (subtype.replace(/^\//, "") === "Type0" ? 2 : 1),
    supported: Boolean(toUnicode.mappings.size || isWinAnsi),
  };
}

function decodeEncodedText(token, font) {
  const bytes = token?.bytes || new Uint8Array();
  if (font.toUnicode?.mappings?.size) {
    const width = Math.max(1, font.codeWidth || 1);
    let text = "";
    for (let index = 0; index < bytes.length; index += width) {
      const code = hexFor(bytes.slice(index, Math.min(index + width, bytes.length)));
      text += font.toUnicode.mappings.get(code) || "\ufffd";
    }
    return text;
  }
  if (font.encoding) {
    const inverse = new Map(Object.entries(font.encoding.unicodeMappings).map(([unicode, mapped]) => [mapped[0], String.fromCodePoint(Number(unicode))]));
    return Array.from(bytes, (byte) => {
      const decoded = inverse.get(byte);
      if (decoded) return decoded;
      // ReportLab writes a bullet as octal 177 (0x7f) while declaring the
      // standard WinAnsi encoding. PDF.js resolves that glyph from the font,
      // but the standard WinAnsi table correctly marks 0x7f as undefined.
      if (font.encoding.name === "WinAnsi" && byte === 0x7f) return "•";
      return "\ufffd";
    }).join("");
  }
  return "\ufffd".repeat(bytes.length);
}

function encodedTextFor(text, font) {
  if (font.toUnicode?.mappings?.size) {
    const reverse = new Map();
    for (const [code, unicode] of font.toUnicode.mappings) if (!reverse.has(unicode)) reverse.set(unicode, code);
    const codes = [];
    for (const character of Array.from(text)) {
      const code = reverse.get(character);
      if (!code) return null;
      codes.push(code);
    }
    return codes.join("");
  }
  if (font.encoding) {
    const codes = [];
    for (const character of Array.from(text)) {
      const mapped = font.encoding.unicodeMappings[character.codePointAt(0)];
      if (!mapped) return null;
      codes.push(mapped[0].toString(16).padStart(2, "0"));
    }
    return codes.join("").toUpperCase();
  }
  return null;
}

function fallbackStandardFont(baseFont = "") {
  const name = String(baseFont).toLowerCase();
  const bold = /(bold|black|heavy|semibold|demi)/.test(name);
  const italic = /(italic|oblique|slanted)/.test(name);
  if (bold && italic) return StandardFonts.HelveticaBoldOblique;
  if (bold) return StandardFonts.HelveticaBold;
  if (italic) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

function textOperand(operator) {
  if (operator.name === "Tj" || operator.name === "'") return operator.operands.length === 1 && operator.operands[0].type === "string" ? operator.operands[0] : null;
  if (operator.name === "\"") return operator.operands.length === 3 && operator.operands[2].type === "string" ? operator.operands[2] : null;
  if (operator.name === "TJ") {
    const array = operator.operands.length === 1 && operator.operands[0].type === "array" ? operator.operands[0] : null;
    if (!array || !array.items.every((item) => item.type === "string" || item.type === "number")) return null;
    return array;
  }
  return null;
}

function textForOperand(operand, font) {
  if (operand?.type === "array") return operand.items.filter((item) => item.type === "string").map((item) => decodeEncodedText(item, font)).join("");
  return decodeEncodedText(operand, font);
}

function runIdFor(pageIndex, ordinal, text, sourceHash) {
  return `p${pageIndex}-o${ordinal}-t${sha256Hex(Buffer.from(text, "utf8")).slice(0, 16)}-f${sourceHash.slice(0, 16)}`;
}

function collectPageRuns(page, pageIndex, context, sourceHash) {
  const content = pageContentBytes(page, context);
  const operators = operatorList(content);
  let fontKey = "";
  let fontSize = 0;
  let ordinal = 0;
  const runs = [];
  for (const operator of operators) {
    if (operator.name === "Tf" && operator.operands.length >= 2 && operator.operands.at(-2)?.type === "name" && operator.operands.at(-1)?.type === "number") {
      fontKey = operator.operands.at(-2).value;
      fontSize = operator.operands.at(-1).value;
      continue;
    }
    if (!TEXT_OPERATORS.has(operator.name)) continue;
    const operand = textOperand(operator);
    const font = fontKey ? fontDetails(page, context, fontKey) : { key: "", supported: false, reason: "The text run has no active font resource." };
    const text = operand ? textForOperand(operand, font) : "";
    const currentOrdinal = ordinal;
    ordinal += 1;
    const editable = Boolean(operand && text && !text.includes("\ufffd") && font.supported && fontSize > 0);
    runs.push({
      pageIndex,
      ordinal: currentOrdinal,
      runId: runIdFor(pageIndex, currentOrdinal, text, sourceHash),
      text,
      originalText: text,
      originalTextHash: sha256Hex(Buffer.from(text, "utf8")),
      operator: operator.name,
      operatorStart: operator.start,
      operatorEnd: operator.end,
      tokenStart: operand?.start ?? operator.start,
      tokenEnd: operand?.end ?? operator.end,
      fontKey,
      fontSize,
      baseFont: font.baseFont || "",
      fontType: font.type,
      editable,
      reason: editable ? "" : operand ? (text.includes("\ufffd") ? "This font encoding cannot be safely decoded." : font.reason || "This text run is not safely editable.") : "This text-show operator is unsupported.",
    });
  }
  return { content, runs };
}

export async function extractPdfTextRuns(input, options = {}) {
  const bytes = bytesFor(input);
  const sourceHash = sha256Hex(bytes);
  let document;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (error) {
    throw new Error(options.password ? "Password-protected PDFs cannot be safely modified by this editor. Save an unlocked copy and try again." : "This PDF is encrypted, corrupt, or unsupported for text editing.");
  }
  const pages = document.getPages().map((page, pageIndex) => {
    const value = collectPageRuns(page, pageIndex, document.context, sourceHash);
    return { pageIndex, runs: value.runs, editableCount: value.runs.filter((run) => run.editable).length };
  });
  return { sourceHash, pageCount: pages.length, pages };
}

function ensureFallbackFontResource(document, page, fallbackFont, sequence) {
  const context = document.context;
  const originalResources = page.node.Resources();
  const resources = originalResources ? originalResources.clone(context) : context.obj({});
  const originalFonts = originalResources?.lookupMaybe(PDFName.Font, PDFDict);
  const fonts = originalFonts ? originalFonts.clone(context) : context.obj({});
  let key = `MTFallback${sequence}`;
  while (fonts.has(PDFName.of(key))) key = `MTFallback${sequence += 1}`;
  fonts.set(PDFName.of(key), fallbackFont.ref);
  resources.set(PDFName.Font, fonts);
  page.node.set(PDFName.Resources, resources);
  return key;
}

const bundledFallbackFontCache = new Map();
const bundledFallbackFontkitDocuments = new WeakSet();

function bundledFallbackFamily(text, baseFont) {
  if (!/[\u0900-\u097f]/u.test(String(text || ""))) return "";
  return /times|serif/i.test(String(baseFont || "")) ? "NotoSerifDevanagari" : "NotoSansDevanagari";
}

async function embedBundledFallbackFont(document, family, baseFont) {
  const bold = /bold|black|heavy/i.test(String(baseFont || ""));
  const asset = textBoxFontAsset({ fontFamily: family, bold });
  if (!asset) return null;
  if (!bundledFallbackFontkitDocuments.has(document)) {
    document.registerFontkit(fontkit);
    bundledFallbackFontkitDocuments.add(document);
  }
  let bytes = bundledFallbackFontCache.get(asset);
  if (!bytes) {
    bytes = await fs.readFile(path.join(process.cwd(), "public", "fonts", asset));
    bundledFallbackFontCache.set(asset, bytes);
  }
  return document.embedFont(bytes);
}

function replacementTextArray(operand, encoded) {
  const items = [];
  let inserted = false;
  for (const item of operand?.items || []) {
    if (item.type === "string") {
      if (!inserted) {
        items.push(encoded);
        inserted = true;
      }
      continue;
    }
    if (item.type === "number") items.push(item.raw ?? String(item.value));
  }
  if (!inserted) items.unshift(encoded);
  return `[${items.join(" ")}] TJ`;
}

function pdfNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || Math.abs(number) < 0.0001) return "0";
  return String(Math.round(number * 1000) / 1000);
}

function hasMovement(movement) {
  const a = Number(movement?.a);
  const b = Number(movement?.b);
  const c = Number(movement?.c);
  const d = Number(movement?.d);
  const e = Number(movement?.e ?? movement?.pdfX ?? movement?.x);
  const f = Number(movement?.f ?? movement?.pdfY ?? movement?.y);
  if (![a, b, c, d, e, f].every(Number.isFinite)) return false;
  return Math.abs(a - 1) > 0.0001 || Math.abs(b) > 0.0001 || Math.abs(c) > 0.0001 || Math.abs(d - 1) > 0.0001 || Math.abs(e) > 0.0001 || Math.abs(f) > 0.0001;
}

function movedOperator(operator, replacement, movement) {
  if (!hasMovement(movement)) return null;
  // The UI stores offsets in displayed page coordinates (+Y is down). Convert
  // them to PDF user-space coordinates and isolate the operator with a saved
  // graphics state so the surrounding text and graphics are unchanged.
  return {
    start: operator.start,
    end: operator.end,
    replacement: `q ${pdfNumber(movement.a)} ${pdfNumber(movement.b)} ${pdfNumber(movement.c)} ${pdfNumber(movement.d)} ${pdfNumber(movement.e ?? movement.pdfX ?? movement.x)} ${pdfNumber(movement.f ?? movement.pdfY ?? movement.y)} cm ${replacement} Q`,
  };
}

function displayOffsetToPdf(page, movement) {
  const rawRotation = page?.getRotation?.();
  const angle = ((Number(rawRotation?.angle ?? rawRotation) || 0) % 360 + 360) % 360;
  const x = Number(movement?.x) || 0;
  const y = Number(movement?.y) || 0;
  const scaleValue = Number(movement?.scale);
  const scale = Number.isFinite(scaleValue) ? Math.max(0.25, Math.min(4, scaleValue)) : 1;
  const scaleXValue = Number(movement?.scaleX);
  const scaleYValue = Number(movement?.scaleY);
  const scaleX = Number.isFinite(scaleXValue) ? Math.max(0.25, Math.min(4, scaleXValue)) : scale;
  const scaleY = Number.isFinite(scaleYValue) ? Math.max(0.25, Math.min(4, scaleYValue)) : scale;
  const rotationValue = Number(movement?.rotation);
  const rotation = Number.isFinite(rotationValue) ? rotationValue : 0;
  const originX = Number.isFinite(Number(movement?.originX)) ? Number(movement.originX) : 0;
  const originY = Number.isFinite(Number(movement?.originY)) ? Number(movement.originY) : 0;
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
  return { a, b, c, d, e: pdfX + originX - (a * originX + c * originY), f: pdfY + originY - (b * originX + d * originY) };
}

function patchTextOperator(operator, operand, encodedHex, font, fallbackKey = "", movement = null) {
  const encoded = `<${encodedHex}>`;
  // Do not leave empty hex strings in a grouped replacement. Some PDF
  // renderers treat `<> Tj` as a malformed Type0 text string and stop
  // painting subsequent text on the page. Keep the operator semantics with
  // an empty literal/array instead, so the original page remains renderable.
  if (!encodedHex && !fallbackKey) {
    if (operator.name === "TJ") return movedOperator(operator, "[] TJ", movement) || { start: operand.start, end: operand.end, replacement: "[]" };
    if (operator.name === "\"") {
      const wordSpacing = operator.operands[0]?.raw ?? "0";
      const characterSpacing = operator.operands[1]?.raw ?? "0";
      return movedOperator(operator, `${wordSpacing} Tw ${characterSpacing} Tc T* () Tj`, movement) || { start: operator.start, end: operator.end, replacement: `${wordSpacing} ${characterSpacing} () \"` };
    }
    return movedOperator(operator, operator.name === "'" ? "T* () Tj" : "() Tj", movement) || { start: operand.start, end: operand.end, replacement: "()" };
  }
  if (!fallbackKey && operator.name !== "TJ") {
    const wordSpacing = operator.operands[0]?.raw ?? "0";
    const characterSpacing = operator.operands[1]?.raw ?? "0";
    const body = operator.name === "Tj" ? `${encoded} Tj`
      : operator.name === "'" ? `T* ${encoded} Tj`
        : `${wordSpacing} Tw ${characterSpacing} Tc T* ${encoded} Tj`;
    return movedOperator(operator, body, movement) || { start: operand.start, end: operand.end, replacement: encoded };
  }
  if (!font?.key || !font.fontSize) throw new Error("The selected text run has no safely restorable font state.");
  const originalFont = `${pdfName(font.key)} ${font.fontSize} Tf`;
  const fallbackFont = `${pdfName(fallbackKey)} ${font.fontSize} Tf`;
  if (operator.name === "Tj") {
    const body = `${fallbackFont} ${encoded} Tj ${originalFont}`;
    return movedOperator(operator, body, movement) || { start: operator.start, end: operator.end, replacement: body };
  }
  if (operator.name === "TJ") {
    const body = `${fallbackKey ? `${fallbackFont} ` : ""}${replacementTextArray(operand, encoded)}${fallbackKey ? ` ${originalFont}` : ""}`;
    return movedOperator(operator, body, movement) || { start: operator.start, end: operator.end, replacement: body };
  }
  if (operator.name === "'") {
    const body = `T* ${fallbackFont} ${encoded} Tj ${originalFont}`;
    return movedOperator(operator, body, movement) || { start: operator.start, end: operator.end, replacement: body };
  }
  if (operator.name === "\"") {
    const wordSpacing = operator.operands[0]?.raw ?? "0";
    const characterSpacing = operator.operands[1]?.raw ?? "0";
    const body = `${wordSpacing} Tw ${characterSpacing} Tc T* ${fallbackFont} ${encoded} Tj ${originalFont}`;
    return movedOperator(operator, body, movement) || { start: operator.start, end: operator.end, replacement: body };
  }
  throw new Error("This text operator cannot be safely replaced.");
}

function applyPatches(content, patches) {
  const sorted = [...patches].sort((left, right) => right.start - left.start);
  let result = Buffer.from(content);
  for (const patch of sorted) result = Buffer.concat([result.subarray(0, patch.start), Buffer.from(patch.replacement, "latin1"), result.subarray(patch.end)]);
  return new Uint8Array(result);
}

function yieldToEventLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function applyPdfTextEdits(input, edits = [], options = {}) {
  const bytes = bytesFor(input);
  const sourceHash = sha256Hex(bytes);
  if (!Array.isArray(edits) || edits.length === 0) throw new Error("Add at least one text edit before exporting.");
  if (edits.length > 500) throw new Error("This PDF has too many text edits for one export.");
  let document;
  try {
    document = await PDFDocument.load(bytes, { updateMetadata: false, throwOnInvalidObject: false });
  } catch (error) {
    throw new Error(options.password ? "Password-protected PDFs cannot be safely modified by this editor. Save an unlocked copy and try again." : "This PDF is encrypted, corrupt, or unsupported for text editing.");
  }
  const pages = document.getPages();
  const pageData = [];
  for (let pageIndex = 0; pageIndex < pages.length; pageIndex += 1) {
    const page = pages[pageIndex];
    pageData.push({ page, ...collectPageRuns(page, pageIndex, document.context, sourceHash) });
    options.onProgress?.(10 + Math.round(((pageIndex + 1) / pages.length) * 60));
    // A large PDF can contain hundreds of pages and many thousands of text
    // operators. Give the local agent a chance to answer job-status requests
    // between page scans instead of making the browser think the export died.
    if (pageIndex % 2 === 1) await yieldToEventLoop();
  }
  const patchesByPage = new Map();
  const warnings = [];
  let fallbackSequence = 1;
  const seen = new Set();
  for (const edit of edits) {
    const pageIndex = Number(edit?.pageIndex);
    const page = pageData[pageIndex];
    if (!page || !Number.isInteger(pageIndex)) throw new Error("One text edit points to an invalid PDF page.");
    const run = page.runs.find((item) => item.runId === String(edit?.runId || ""));
    if (!run) throw new Error("A selected text run no longer matches the uploaded PDF. Reload the original PDF and try again.");
    const operatorGroups = Array.isArray(edit?.operatorGroups) && edit.operatorGroups.length
      ? edit.operatorGroups.map((group) => ({
        selectedOrdinal: Number(group?.operatorOrdinal),
        ordinals: Array.isArray(group?.operatorOrdinals) && group.operatorOrdinals.length ? group.operatorOrdinals.map(Number) : [Number(group?.operatorOrdinal)],
      }))
      : [{
        selectedOrdinal: run.ordinal,
        ordinals: Array.isArray(edit?.operatorOrdinals) && edit.operatorOrdinals.length ? edit.operatorOrdinals.map(Number) : [run.ordinal],
      }];
    if (operatorGroups.some(({ selectedOrdinal, ordinals }) => !Number.isInteger(selectedOrdinal) || selectedOrdinal < 0 || !ordinals.length || !ordinals.every((value, index) => Number.isInteger(value) && value >= 0 && (index === 0 || value > ordinals[index - 1])) || !ordinals.includes(selectedOrdinal))) throw new Error("A duplicate PDF text edit must include ordered text groups.");
    if (!operatorGroups[0].ordinals.includes(run.ordinal)) throw new Error("The grouped PDF text edit does not include its selected text operator.");
    const groupedRunsByGroup = operatorGroups.map(({ ordinals }) => {
      const groupedRuns = ordinals.map((operatorOrdinal) => page.runs.find((item) => item.ordinal === operatorOrdinal));
      if (groupedRuns.some((item) => !item) || ordinals.some((operatorOrdinal, index) => index > 0 && operatorOrdinal !== ordinals[index - 1] + 1)) throw new Error("The grouped PDF text edit does not match a contiguous text region.");
      return groupedRuns;
    });
    const groupedRuns = groupedRunsByGroup.flat();
    if (groupedRuns.some((item) => seen.has(item.runId))) throw new Error("A text run was edited more than once in the same export.");
    groupedRuns.forEach((item) => seen.add(item.runId));
    if (String(edit?.originalTextHash || "") !== run.originalTextHash) throw new Error(`The original text for “${run.text.slice(0, 60)}” no longer matches the PDF.`);
    const normalized = (value) => String(value || "").replace(/\s+/g, "");
    for (const groupRuns of groupedRunsByGroup) {
      const groupedText = groupRuns.map((item) => item.text).join("");
      if (edit?.originalText && normalized(edit.originalText) !== normalized(groupedText)) throw new Error(`The selected text for “${run.text.slice(0, 60)}” no longer matches the PDF.`);
    }
    if (groupedRuns.some((item) => !item.editable)) {
      const unsafe = groupedRuns.find((item) => !item.editable);
      throw new Error(`“${unsafe.text.slice(0, 60)}” cannot be safely edited: ${unsafe.reason}`);
    }
    const movement = displayOffsetToPdf(page.page, { x: Number(edit?.offsetX) || 0, y: Number(edit?.offsetY) || 0, scale: edit?.scale, scaleX: edit?.scaleX, scaleY: edit?.scaleY, rotation: edit?.rotation, originX: edit?.originX, originY: edit?.originY });
    if (edit?.moveOnly) {
      // Movement-only edits must preserve the original text operators. Using
      // the extracted Unicode text as a replacement can change logos and
      // other glyphs whose PDF font has private or duplicate mappings.
      const operators = operatorList(page.content);
      for (const groupRuns of groupedRunsByGroup) {
        for (const groupedRun of groupRuns) {
          const operator = operators.find((item) => item.start === groupedRun.operatorStart && item.end === groupedRun.operatorEnd && item.name === groupedRun.operator);
          if (!operator) throw new Error(`The text operator for “${run.text.slice(0, 60)}” could not be located safely.`);
          const originalOperator = Buffer.from(page.content.slice(operator.start, operator.end)).toString("latin1");
          const patch = movedOperator(operator, originalOperator, movement);
          if (!patch) continue;
          if (!patchesByPage.has(pageIndex)) patchesByPage.set(pageIndex, []);
          patchesByPage.get(pageIndex).push(patch);
        }
      }
      continue;
    }
    const replacement = String(edit?.replacementText ?? "");
    if (replacement.includes("\n") || replacement.includes("\r")) throw new Error("Text replacements must stay on one line so the original PDF positioning is preserved.");
    const font = fontDetails(page.page, document.context, run.fontKey);
    const encoded = encodedTextFor(replacement, font);
    let encodedHex = encoded;
    let fallbackKey = "";
    if (encodedHex === null) {
      const fallbackFamily = bundledFallbackFamily(replacement, font.baseFont);
      let fallbackFont = fallbackFamily ? await embedBundledFallbackFont(document, fallbackFamily, font.baseFont) : null;
      let fallbackLabel = fallbackFamily ? fallbackFamily.replace(/([a-z])([A-Z])/g, "$1 $2") : "";
      try {
        if (fallbackFont) encodedHex = fallbackFont.encodeText(replacement).toString().replace(/^<|>$/g, "");
      } catch {
        fallbackFont = null;
        encodedHex = null;
      }
      if (!fallbackFont || encodedHex === null) {
        const fallbackFontName = fallbackStandardFont(font.baseFont);
        fallbackFont = await document.embedFont(fallbackFontName);
        try {
          encodedHex = fallbackFont.encodeText(replacement).toString().replace(/^<|>$/g, "");
          fallbackLabel = fallbackFontName;
        } catch {
          throw new Error(`The replacement for “${run.text.slice(0, 60)}” uses characters that are not available in the bundled fallback font.`);
        }
      }
      fallbackKey = ensureFallbackFontResource(document, page.page, fallbackFont, fallbackSequence);
      fallbackSequence += 1;
      warnings.push(`Used the bundled ${fallbackLabel} fallback for “${run.text.slice(0, 60)}”. The original font could not encode all replacement characters.`);
    }
    const operators = operatorList(page.content);
    for (const groupRuns of groupedRunsByGroup) {
      for (const [groupIndex, groupedRun] of groupRuns.entries()) {
        const operator = operators.find((item) => item.start === groupedRun.operatorStart && item.end === groupedRun.operatorEnd && item.name === groupedRun.operator);
        if (!operator) throw new Error(`The text operator for “${run.text.slice(0, 60)}” could not be located safely.`);
        const operand = textOperand(operator);
        if (!operand) throw new Error(`The text operator for “${run.text.slice(0, 60)}” is unsupported.`);
        const firstInDuplicate = groupIndex === 0;
        const patch = patchTextOperator(operator, operand, firstInDuplicate ? encodedHex : "", firstInDuplicate ? { ...font, fontSize: run.fontSize } : { key: "", fontSize: 0 }, firstInDuplicate ? fallbackKey : "", firstInDuplicate ? movement : null);
        if (!patchesByPage.has(pageIndex)) patchesByPage.set(pageIndex, []);
        patchesByPage.get(pageIndex).push(patch);
      }
    }
    const originalWidth = Math.max(1, graphemeCount(run.text));
    if (graphemeCount(replacement) > originalWidth) warnings.push(`Replacement text for “${run.text.slice(0, 60)}” may overflow its original area. Surrounding content was not reflowed.`);
  }
  for (const [pageIndex, patches] of patchesByPage) {
    const page = pageData[pageIndex];
    const updated = applyPatches(page.content, patches);
    const stream = document.context.flateStream(updated);
    page.page.node.set(PDFName.Contents, document.context.register(stream));
  }
  const output = await document.save({ useObjectStreams: false });
  return { bytes: output, sourceHash, editCount: edits.length, warnings };
}

export { runIdFor };
