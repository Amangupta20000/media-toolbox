export function normalizeImageRotation(value) {
  const rotation = Number(value);
  if (!Number.isFinite(rotation)) return 0;
  return ((rotation % 360) + 360) % 360;
}

export function rotatedImageDrawPlacement(placement, pageHeight) {
  const width = Number(placement?.width) || 0;
  const height = Number(placement?.height) || 0;
  const baseX = Number(placement?.x) || 0;
  const baseY = (Number(pageHeight) || 0) - (Number(placement?.y) || 0) - height;
  const rotation = normalizeImageRotation(placement?.rotation);
  const radians = rotation * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const corners = [
    [0, 0],
    [width * cosine, width * sine],
    [-height * sine, height * cosine],
    [width * cosine - height * sine, width * sine + height * cosine],
  ];
  const minX = Math.min(...corners.map(([x]) => x));
  const maxX = Math.max(...corners.map(([x]) => x));
  const minY = Math.min(...corners.map(([, y]) => y));
  const maxY = Math.max(...corners.map(([, y]) => y));
  const centerX = baseX + width / 2;
  const centerY = baseY + height / 2;
  return {
    x: centerX - (minX + maxX) / 2,
    y: centerY - (minY + maxY) / 2,
    width,
    height,
    rotation,
  };
}
