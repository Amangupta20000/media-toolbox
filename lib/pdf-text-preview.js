import { PDFArray, PDFDocument, PDFRawStream, PDFName, decodePDFRawStream } from "pdf-lib";

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
    const ordinal = Number(edit?.operatorOrdinal);
    const operator = operatorList(page.content).filter((item) => TEXT_OPERATORS.has(item.name))[ordinal];
    const operand = textOperand(operator);
    if (!operator || !operand) throw new Error("The live preview could not locate the selected PDF text operator.");
    const encoded = encodeWinAnsi(String(edit?.replacementText ?? ""));
    const patch = { start: operand.start, end: operand.end, replacement: replacementOperand(operand, encoded) };
    if (!patchesByPage.has(pageIndex)) patchesByPage.set(pageIndex, []);
    patchesByPage.get(pageIndex).push(patch);
  }
  for (const [pageIndex, patches] of patchesByPage) {
    const page = pageData[pageIndex];
    page.page.node.set(PDFName.Contents, document.context.register(document.context.flateStream(applyPatches(page.content, patches))));
  }
  return document.save({ useObjectStreams: false });
}
