import { PDFArray, PDFDict, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";

const TEXT_OPERATORS = new Set(["Tj", "TJ", "'", "\""]);
const PDF_WHITESPACE = new Set([0, 9, 10, 12, 13, 32]);
const PDF_DELIMITERS = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);

function bytesFor(value) {
  return value instanceof Uint8Array ? value : new Uint8Array(value || []);
}

function stringFromBytes(value) {
  const bytes = bytesFor(value);
  let result = "";
  for (let index = 0; index < bytes.length; index += 8192) result += String.fromCharCode(...bytes.slice(index, index + 8192));
  return result;
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
  return { token: { type: "string", bytes: Uint8Array.from(output), start, end: index }, index };
}

function parseHex(bytes, start) {
  let index = start + 1;
  while (index < bytes.length && bytes[index] !== 62) index += 1;
  if (bytes[index] === 62) index += 1;
  const raw = stringFromBytes(bytes.slice(start + 1, index - 1));
  const clean = raw.replace(/\s+/g, "");
  const padded = clean.length % 2 ? `${clean}0` : clean;
  const value = Uint8Array.from({ length: padded.length / 2 }, (_, offset) => Number.parseInt(padded.slice(offset * 2, offset * 2 + 2), 16) || 0);
  return { token: { type: "string", bytes: value, start, end: index }, index };
}

function parseName(bytes, start) {
  let index = start + 1;
  const raw = [];
  while (index < bytes.length && !isDelimiter(bytes[index])) raw.push(bytes[index++]);
  const rawText = stringFromBytes(raw);
  const value = rawText.replace(/#([0-9a-fA-F]{2})/g, (_, code) => String.fromCharCode(Number.parseInt(code, 16)));
  return { token: { type: "name", value, raw: rawText, start, end: index }, index };
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
  if (/^[+-]?(?:\d+\.?\d*|\.\d+)$/.test(value)) return { token: { type: "number", value: Number(value), raw: value, start, end: index }, index };
  return { token: { type: "word", value, raw: value, start, end: index }, index };
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

export function operatorList(bytes) {
  const rebuilt = [];
  let operands = [];
  for (const token of tokenize(bytesFor(bytes))) {
    if (token.type !== "word") { operands.push(token); continue; }
    rebuilt.push({ name: token.value, operands, start: operands.length ? operands[0].start : token.start, end: token.end, token });
    operands = [];
  }
  return rebuilt;
}

function lookupObject(context, value) {
  return context.lookup(value) || value;
}

export function streamBytes(context, reference) {
  const stream = lookupObject(context, reference);
  if (!stream) return new Uint8Array();
  if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
  if (typeof stream.getUnencodedContents === "function") return stream.getUnencodedContents();
  if (typeof stream.getContents === "function") return stream.getContents();
  return new Uint8Array();
}

export function pageContentBytes(page, context) {
  const contents = page.node.Contents();
  if (!contents) return new Uint8Array();
  const streams = contents instanceof PDFArray ? Array.from({ length: contents.size() }, (_, index) => contents.get(index)) : [contents];
  const parts = streams.map((reference) => streamBytes(context, reference));
  const result = new Uint8Array(parts.reduce((total, part) => total + part.length + 1, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; result[offset++] = 10; }
  return result;
}

function resourceDictionary(resources, category) {
  return resources?.lookupMaybe(PDFName.of(category), PDFDict);
}

function findResource(context, resourceStack, category, name) {
  for (const resources of resourceStack || []) {
    const dictionary = resourceDictionary(resources, category);
    const reference = dictionary?.get(PDFName.of(name));
    if (!reference) continue;
    return { reference, object: lookupObject(context, reference) };
  }
  return null;
}

function objectName(object) {
  if (!object) return "";
  if (typeof object.asString === "function") return object.asString().replace(/^\//, "");
  return String(object).replace(/^\//, "");
}

function formResourceStack(form, parentStack) {
  const resources = form?.dict?.lookupMaybe(PDFName.Resources, PDFDict);
  return resources ? [resources, ...(parentStack || [])] : (parentStack || []);
}

function isFormXObject(object) {
  return object?.dict && objectName(object.dict.get(PDFName.of("Subtype"))) === "Form";
}

export function collectTextStreams(page, context) {
  const pageContent = pageContentBytes(page, context);
  const pageResources = page.node.Resources();
  const streams = [{ key: "page", content: pageContent, object: null, reference: null, isPage: true, resources: [pageResources] }];
  const streamByKey = new Map([["page", streams[0]]]);
  const textOperators = [];

  function walk(content, resourceStack, stream, ancestry, inheritedFontKey = "", inheritedFontSize = 0) {
    let activeFontKey = inheritedFontKey;
    let activeFontSize = inheritedFontSize;
    for (const item of operatorList(content)) {
      if (item.name === "Tf" && item.operands.length >= 2 && item.operands.at(-2)?.type === "name") {
        activeFontKey = item.operands.at(-2).value;
        activeFontSize = Number(item.operands.at(-1)?.value) || 0;
        continue;
      }
      if (TEXT_OPERATORS.has(item.name)) {
        textOperators.push({ ...item, streamKey: stream.key, content, resourceStack, fontKey: activeFontKey, fontSize: activeFontSize });
        continue;
      }
      if (item.name !== "Do") continue;
      const resourceName = item.operands.at(-1)?.type === "name" ? item.operands.at(-1).value : "";
      if (!resourceName) continue;
      const resource = findResource(context, resourceStack, "XObject", resourceName);
      if (!resource || !isFormXObject(resource.object)) continue;
      const referenceKey = resource.reference?.toString?.() || resourceName;
      if (ancestry.includes(referenceKey)) continue;
      const key = `form:${referenceKey}`;
      let formStream = streamByKey.get(key);
      const nextResources = formResourceStack(resource.object, resourceStack);
      const nextContent = streamBytes(context, resource.object);
      if (!formStream) {
        formStream = { key, content: nextContent, object: resource.object, reference: resource.reference, isPage: false, resources: nextResources };
        streamByKey.set(key, formStream);
        streams.push(formStream);
      }
      walk(nextContent, nextResources, formStream, [...ancestry, referenceKey], "", 0);
    }
  }

  walk(pageContent, [pageResources], streams[0], []);
  return { content: pageContent, streams, textOperators };
}

export function textOperatorsForStream(stream) {
  return operatorList(stream?.content || []).filter((item) => TEXT_OPERATORS.has(item.name));
}
