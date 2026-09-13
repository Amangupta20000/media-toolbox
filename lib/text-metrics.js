export function graphemeCount(value) {
  const text = String(value ?? "");
  if (!text) return 0;
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter === "function") {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text)].length;
  }
  return Array.from(text).length;
}
