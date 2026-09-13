export const PDF_TEXT_BOX_FONTS = [
  { value: "Helvetica", label: "Helvetica" },
  { value: "Times-Roman", label: "Times Roman" },
  { value: "Courier", label: "Courier" },
  { value: "Roboto", label: "Roboto" },
  { value: "OpenSans", label: "Open Sans" },
  { value: "Lato", label: "Lato" },
  { value: "Montserrat", label: "Montserrat" },
  { value: "Nunito", label: "Nunito" },
  { value: "Merriweather", label: "Merriweather" },
  { value: "FiraMono", label: "Fira Mono" },
  { value: "NotoSansDevanagari", label: "Noto Sans Devanagari" },
  { value: "NotoSerifDevanagari", label: "Noto Serif Devanagari" },
];

const FONT_VARIANTS = {
  Helvetica: {
    kind: "standard",
    cssFamily: "Arial, Helvetica, sans-serif",
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    boldItalic: "Helvetica-BoldOblique",
  },
  "Times-Roman": {
    kind: "standard",
    cssFamily: "Georgia, 'Times New Roman', serif",
    regular: "Times-Roman",
    bold: "Times-Bold",
    italic: "Times-Italic",
    boldItalic: "Times-BoldItalic",
  },
  Courier: {
    kind: "standard",
    cssFamily: "'Courier New', Courier, monospace",
    regular: "Courier",
    bold: "Courier-Bold",
    italic: "Courier-Oblique",
    boldItalic: "Courier-BoldOblique",
  },
  Roboto: {
    kind: "bundled",
    cssFamily: "Roboto, Arial, sans-serif",
    regular: "roboto-regular.ttf",
    bold: "roboto-bold.ttf",
    italic: "roboto-italic.ttf",
    boldItalic: "roboto-bold-italic.ttf",
  },
  OpenSans: {
    kind: "bundled",
    cssFamily: "'Open Sans', Arial, sans-serif",
    regular: "open-sans-regular.ttf",
    bold: "open-sans-bold.ttf",
    italic: "open-sans-italic.ttf",
    boldItalic: "open-sans-bold-italic.ttf",
  },
  Lato: {
    kind: "bundled",
    cssFamily: "Lato, Arial, sans-serif",
    regular: "lato-regular.ttf",
    bold: "lato-bold.ttf",
    italic: "lato-italic.ttf",
    boldItalic: "lato-bold-italic.ttf",
  },
  Montserrat: {
    kind: "bundled",
    cssFamily: "Montserrat, Arial, sans-serif",
    regular: "montserrat-regular.ttf",
    bold: "montserrat-bold.ttf",
    italic: "montserrat-italic.ttf",
    boldItalic: "montserrat-bold-italic.ttf",
  },
  Nunito: {
    kind: "bundled",
    cssFamily: "Nunito, Arial, sans-serif",
    regular: "nunito-regular.ttf",
    bold: "nunito-bold.ttf",
    italic: "nunito-italic.ttf",
    boldItalic: "nunito-bold-italic.ttf",
  },
  Merriweather: {
    kind: "bundled",
    cssFamily: "Merriweather, Georgia, serif",
    regular: "merriweather-regular.ttf",
    bold: "merriweather-bold.ttf",
    italic: "merriweather-italic.ttf",
    boldItalic: "merriweather-bold-italic.ttf",
  },
  FiraMono: {
    kind: "bundled",
    cssFamily: "'Fira Mono', 'Courier New', monospace",
    regular: "fira-mono-regular.ttf",
    bold: "fira-mono-bold.ttf",
    italic: "fira-mono-regular.ttf",
    boldItalic: "fira-mono-bold.ttf",
  },
  NotoSansDevanagari: {
    kind: "bundled",
    cssFamily: "'Noto Sans Devanagari', Arial, sans-serif",
    regular: "noto-sans-devanagari-regular.ttf",
    bold: "noto-sans-devanagari-bold.ttf",
    italic: "noto-sans-devanagari-regular.ttf",
    boldItalic: "noto-sans-devanagari-bold.ttf",
  },
  NotoSerifDevanagari: {
    kind: "bundled",
    cssFamily: "'Noto Serif Devanagari', Georgia, serif",
    regular: "noto-serif-devanagari.ttf",
    bold: "noto-serif-devanagari.ttf",
    italic: "noto-serif-devanagari.ttf",
    boldItalic: "noto-serif-devanagari.ttf",
  },
};

function fontStyle(textBox = {}) {
  if (textBox.bold && textBox.italic) return "boldItalic";
  if (textBox.bold) return "bold";
  if (textBox.italic) return "italic";
  return "regular";
}

export function textBoxFontDefinition(value) {
  const family = String(value || "Helvetica");
  const variants = FONT_VARIANTS[family] || FONT_VARIANTS.Helvetica;
  return { family: FONT_VARIANTS[family] ? family : "Helvetica", ...variants };
}

export function textBoxFontAsset(textBox = {}) {
  const definition = textBoxFontDefinition(textBox.fontFamily);
  return definition.kind === "bundled" ? definition[fontStyle(textBox)] : "";
}

export function textBoxFontName(textBox = {}) {
  const definition = textBoxFontDefinition(textBox.fontFamily);
  return definition.kind === "standard" ? definition[fontStyle(textBox)] : textBoxFontAsset(textBox);
}

export function textBoxCssFontFamily(value) {
  return textBoxFontDefinition(value).cssFamily;
}

const TEXT_BOX_STYLE_KEYS = ["fontFamily", "fontSize", "bold", "italic", "underline", "color", "backgroundColor"];

function textBoxBaseStyle(textBox = {}) {
  return {
    fontFamily: textBoxFontDefinition(textBox.fontFamily).family,
    fontSize: Math.max(1, Number(textBox.fontSize) || 18),
    bold: Boolean(textBox.bold),
    italic: Boolean(textBox.italic),
    underline: Boolean(textBox.underline),
    color: /^#[0-9a-f]{6}$/i.test(String(textBox.color || "")) ? String(textBox.color).toLowerCase() : "#173b53",
    backgroundColor: textBox.backgroundColor === "transparent" || !/^#[0-9a-f]{6}$/i.test(String(textBox.backgroundColor || "")) ? "transparent" : String(textBox.backgroundColor).toLowerCase(),
  };
}

function textBoxRunStyle(run, base) {
  const style = { ...base };
  for (const key of TEXT_BOX_STYLE_KEYS) {
    if (run?.[key] === undefined) continue;
    if (key === "fontFamily") style.fontFamily = textBoxFontDefinition(run.fontFamily).family;
    else if (key === "fontSize") style.fontSize = Math.max(1, Number(run.fontSize) || base.fontSize);
    else if (key === "color") style.color = /^#[0-9a-f]{6}$/i.test(String(run.color || "")) ? String(run.color).toLowerCase() : base.color;
    else if (key === "backgroundColor") style.backgroundColor = run.backgroundColor === "transparent" || /^#[0-9a-f]{6}$/i.test(String(run.backgroundColor || "")) ? String(run.backgroundColor).toLowerCase() : base.backgroundColor;
    else style[key] = Boolean(run[key]);
  }
  return style;
}

export function textBoxTextRuns(textBox = {}) {
  const text = String(textBox.text ?? "");
  const base = textBoxBaseStyle(textBox);
  const sourceRuns = Array.isArray(textBox.runs) ? textBox.runs : [];
  const runs = [];
  let cursor = 0;
  for (const sourceRun of sourceRuns) {
    const start = Math.max(cursor, Math.min(text.length, Math.trunc(Number(sourceRun?.start))));
    const end = Math.max(start, Math.min(text.length, Math.trunc(Number(sourceRun?.end))));
    if (end <= start) continue;
    if (start > cursor) runs.push({ start: cursor, end: start, text: text.slice(cursor, start), ...base });
    runs.push({ start, end, text: text.slice(start, end), ...textBoxRunStyle(sourceRun, base) });
    cursor = end;
  }
  if (cursor < text.length) runs.push({ start: cursor, end: text.length, text: text.slice(cursor), ...base });
  if (!runs.length && text) runs.push({ start: 0, end: text.length, text, ...base });
  return runs;
}

export function layoutPdfTextRuns(runs, fontForRun, maxWidth) {
  const widthLimit = Math.max(1, Number(maxWidth) || 1);
  const lines = [{ items: [], width: 0, height: 0 }];
  const currentLine = () => lines[lines.length - 1];
  const finishLine = () => lines.push({ items: [], width: 0, height: 0 });
  const append = (run, text, font) => {
    if (!text) return;
    const size = Math.max(1, Number(run.fontSize) || 18);
    const width = font.widthOfTextAtSize(text, size);
    const line = currentLine();
    if (line.items.length && line.width + width > widthLimit) finishLine();
    const target = currentLine();
    if (width <= widthLimit) {
      target.items.push({ ...run, text, width, font });
      target.width += width;
      target.height = Math.max(target.height, size * 1.2);
      return;
    }
    let piece = "";
    for (const character of Array.from(text)) {
      const candidate = piece + character;
      if (piece && font.widthOfTextAtSize(candidate, size) + target.width > widthLimit) {
        append(run, piece, font);
        piece = character;
      } else piece = candidate;
    }
    if (piece) append(run, piece, font);
  };
  for (const run of Array.isArray(runs) ? runs : []) {
    const font = fontForRun(run);
    if (!font) continue;
    const parts = String(run.text ?? "").split("\n");
    parts.forEach((part, index) => {
      for (const token of part.match(/\s+|[^\s]+/g) || []) append(run, token, font);
      if (index < parts.length - 1) finishLine();
    });
  }
  if (lines.length > 1 && !currentLine().items.length) lines.pop();
  return lines.map((line) => ({ ...line, height: line.height || 21.6 }));
}

export function textBoxColor(value, fallback = "#173b53") {
  const match = String(value || "").trim().match(/^#([0-9a-f]{6})$/i) || String(fallback).match(/^#([0-9a-f]{6})$/i);
  const hex = match?.[1] || "173b53";
  return {
    r: Number.parseInt(hex.slice(0, 2), 16) / 255,
    g: Number.parseInt(hex.slice(2, 4), 16) / 255,
    b: Number.parseInt(hex.slice(4, 6), 16) / 255,
  };
}

export function textBoxDrawPlacement(textBox, pageHeight) {
  const width = Number(textBox?.width) || 0;
  const height = Number(textBox?.height) || 0;
  return {
    x: Number(textBox?.x) || 0,
    y: (Number(pageHeight) || 0) - (Number(textBox?.y) || 0) - height,
    width,
    height,
  };
}

function splitLongWord(word, font, size, maxWidth) {
  const pieces = [];
  let piece = "";
  for (const character of word) {
    const candidate = piece + character;
    if (piece && font.widthOfTextAtSize(candidate, size) > maxWidth) {
      pieces.push(piece);
      piece = character;
    } else {
      piece = candidate;
    }
  }
  if (piece || !pieces.length) pieces.push(piece);
  return pieces;
}

export function wrapPdfTextLines(text, font, size, maxWidth) {
  const lines = [];
  const paragraphs = String(text ?? "").replace(/\r\n/g, "\n").split("\n");
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }
    let line = "";
    for (const token of paragraph.split(/(\s+)/).filter(Boolean)) {
      const candidate = line + token;
      if (!line || font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
        continue;
      }
      lines.push(line.trimEnd());
      line = token.trimStart();
      if (font.widthOfTextAtSize(line, size) > maxWidth) {
        const pieces = splitLongWord(line, font, size, maxWidth);
        lines.push(...pieces.slice(0, -1));
        line = pieces.at(-1) || "";
      }
    }
    lines.push(line.trimEnd());
  }
  return lines.length ? lines : [""];
}
