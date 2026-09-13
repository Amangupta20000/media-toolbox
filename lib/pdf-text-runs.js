function hasWhitespace(value) {
  return /\s/.test(String(value || ""));
}

function isDevanagariMark(value) {
  return /[\u093a-\u094d\u0962\u0963\u200c\u200d\u0300-\u036f]/u.test(String(value || ""));
}

function transformFor(item) {
  const transform = Array.isArray(item?.transform) ? item.transform : [];
  const a = Number(transform[0]) || 1;
  const b = Number(transform[1]) || 0;
  const length = Math.hypot(a, b) || 1;
  return {
    a,
    b,
    x: Number(transform[4]) || 0,
    y: Number(transform[5]) || 0,
    directionX: a / length,
    directionY: b / length,
    normalX: -b / length,
    normalY: a / length,
  };
}

function sameTextLine(left, right) {
  const leftTransform = transformFor(left.item);
  const rightTransform = transformFor(right.item);
  const lineTolerance = Math.max(1, Math.max(Number(left.item?.height) || 0, Number(right.item?.height) || 0) * 0.35);
  const leftNormal = leftTransform.x * leftTransform.normalX + leftTransform.y * leftTransform.normalY;
  const rightNormal = rightTransform.x * leftTransform.normalX + rightTransform.y * leftTransform.normalY;
  return Math.abs(leftNormal - rightNormal) <= lineTolerance
    && Math.abs(leftTransform.a - rightTransform.a) <= 0.01
    && Math.abs(leftTransform.b - rightTransform.b) <= 0.01;
}

function hasActualSeparator(left, right, items) {
  if (hasWhitespace(left.text) || hasWhitespace(right.text)) return true;
  const between = items.slice((left.itemIndex ?? 0) + 1, right.itemIndex ?? 0);
  const leftTail = left.lastItem || left.item;
  for (const item of between) {
    const text = String(item?.str || "");
    if (!hasWhitespace(text)) continue;
    // Some PDF producers encode a Devanagari mark as a separate text item
    // after a positioning-only space. A zero-width preceding glyph plus a
    // following mark is still part of the same visible word.
    if ((Number(leftTail?.width) || 0) <= 0.01 && isDevanagariMark(right.text)) continue;
    return true;
  }
  return false;
}

function canMerge(left, right, items) {
  if (!left.item || !right.item || left.item?.fontName !== right.item?.fontName) return false;
  if (!sameTextLine(left, right) || hasActualSeparator(left, right, items)) return false;
  const leftTransform = transformFor(left.item);
  const leftTail = left.lastItem || left.item;
  const leftTailTransform = transformFor(leftTail);
  const rightTransform = transformFor(right.item);
  const leftStart = leftTailTransform.x * leftTransform.directionX + leftTailTransform.y * leftTransform.directionY;
  const rightStart = rightTransform.x * leftTransform.directionX + rightTransform.y * leftTransform.directionY;
  const leftWidth = Math.max(0, Number(leftTail.width) || 0);
  const gap = rightStart - leftStart - leftWidth;
  const tolerance = Math.max(4, Math.max(Number(left.item.height) || 0, Number(right.item.height) || 0) * 0.9);
  // A zero-width glyph often carries a combining mark whose advance is
  // represented by the next text-position operator rather than item.width.
  return leftWidth <= 0.01 || gap >= -tolerance && gap <= tolerance;
}

function mergePair(left, right) {
  const leftTransform = transformFor(left.item);
  const rightTransform = transformFor(right.item);
  const start = leftTransform.x * leftTransform.directionX + leftTransform.y * leftTransform.directionY;
  const rightStart = rightTransform.x * leftTransform.directionX + rightTransform.y * leftTransform.directionY;
  const end = rightStart + Math.max(0, Number(right.item?.width) || 0);
  const width = Math.max(Number(left.item?.width) || 0, end - start);
  const operatorOrdinals = [...new Set([...(left.operatorOrdinals || [left.ordinal]), ...(right.operatorOrdinals || [right.ordinal])])].sort((a, b) => a - b);
  return {
    ...left,
    text: `${left.text}${right.text}`,
    originalText: `${left.originalText || left.text}${right.originalText || right.text}`,
    operatorText: `${left.operatorText || left.text}${right.operatorText || right.text}`,
    operatorOrdinals,
    operatorEndIndex: Math.max(left.operatorEndIndex ?? left.operatorIndex, right.operatorEndIndex ?? right.operatorIndex),
    item: { ...left.item, str: `${left.item.str || ""}${right.item.str || ""}`, width },
    itemIndex: right.itemIndex,
    lastItem: right.lastItem || right.item,
    editable: left.editable && right.editable,
    reason: left.editable && right.editable ? left.reason : left.reason || right.reason,
  };
}

export function mergeAdjacentTextRuns(runs, items = []) {
  const merged = [];
  for (const run of runs) {
    const previous = merged.at(-1);
    if (previous && canMerge(previous, run, items)) merged[merged.length - 1] = mergePair(previous, run);
    else merged.push({ ...run, lastItem: run.lastItem || run.item });
  }
  return merged;
}
