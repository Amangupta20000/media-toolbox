export const PDF_TEXT_BOX_FONTS = [
  { value: "Helvetica", label: "Helvetica" },
  { value: "Times-Roman", label: "Times Roman" },
  { value: "Courier", label: "Courier" },
];

const FONT_VARIANTS = {
  Helvetica: {
    regular: "Helvetica",
    bold: "Helvetica-Bold",
    italic: "Helvetica-Oblique",
    boldItalic: "Helvetica-BoldOblique",
  },
  "Times-Roman": {
    regular: "Times-Roman",
    bold: "Times-Bold",
    italic: "Times-Italic",
    boldItalic: "Times-BoldItalic",
  },
  Courier: {
    regular: "Courier",
    bold: "Courier-Bold",
    italic: "Courier-Oblique",
    boldItalic: "Courier-BoldOblique",
  },
};

export function textBoxFontName(textBox = {}) {
  const variants = FONT_VARIANTS[textBox.fontFamily] || FONT_VARIANTS.Helvetica;
  if (textBox.bold && textBox.italic) return variants.boldItalic;
  if (textBox.bold) return variants.bold;
  if (textBox.italic) return variants.italic;
  return variants.regular;
}

export function textBoxCssFontFamily(value) {
  if (value === "Times-Roman") return "Georgia, 'Times New Roman', serif";
  if (value === "Courier") return "'Courier New', Courier, monospace";
  return "Arial, Helvetica, sans-serif";
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
