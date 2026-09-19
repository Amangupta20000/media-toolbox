// The PDF-to-images result is intentionally a small, dependency-free ZIP. The
// entries are stored without compression because PNG and JPEG data is already
// compressed; this also keeps the worker portable in packaged agents.
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16LE(value & 0xffff);
  return output;
}

function uint32(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32LE(value >>> 0);
  return output;
}

export function createStoredZip(entries) {
  if (!Array.isArray(entries) || !entries.length) throw new Error("A ZIP archive needs at least one file.");
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const entry of entries) {
    const name = String(entry?.name || "file").replace(/[^a-zA-Z0-9._/-]/g, "_").replace(/^\/+/, "") || "file";
    const data = Buffer.from(entry?.data || []);
    const nameBytes = Buffer.from(name, "utf8");
    const checksum = crc32(data);
    const local = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04]),
      uint16(20),
      uint16(0x800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      nameBytes,
      data,
    ]);
    localParts.push(local);
    centralParts.push(Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x01, 0x02]),
      uint16(20),
      uint16(20),
      uint16(0x800),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(checksum),
      uint32(data.length),
      uint32(data.length),
      uint16(nameBytes.length),
      uint16(0),
      uint16(0),
      uint16(0),
      uint16(0),
      uint32(0),
      uint32(offset),
      nameBytes,
    ]));
    offset += local.length;
  }
  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x05, 0x06]),
    uint16(0),
    uint16(0),
    uint16(entries.length),
    uint16(entries.length),
    uint32(central.length),
    uint32(local.length),
    uint16(0),
  ]);
  return Buffer.concat([local, central, end]);
}
