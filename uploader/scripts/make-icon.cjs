// A small vector-style application mark, rasterized without external assets.
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const dimension = 256;
const pixels = Buffer.alloc((dimension * 4 + 1) * dimension);
const rounded = (x, y, left, top, width, height, radius) => {
  if (x < left || y < top || x >= left + width || y >= top + height)
    return false;
  const cx = Math.max(left + radius, Math.min(x, left + width - radius));
  const cy = Math.max(top + radius, Math.min(y, top + height - radius));
  return (x - cx) ** 2 + (y - cy) ** 2 <= radius ** 2;
};
for (let y = 0; y < dimension; y++)
  for (let x = 0; x < dimension; x++) {
    const offset = y * (dimension * 4 + 1) + 1 + x * 4;
    const background = rounded(x, y, 0, 0, dimension, dimension, 54);
    const bar = [
      [57, 89, 20, 78],
      [97, 56, 20, 144],
      [137, 75, 20, 106],
      [177, 103, 20, 50],
    ].some(([left, top, width, height]) =>
      rounded(x, y, left, top, width, height, 10),
    );
    pixels.set(
      bar
        ? [219, 236, 180, 255]
        : background
          ? [23, 60, 52, 255]
          : [0, 0, 0, 0],
      offset,
    );
  }
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let n = 0; n < 8; n++)
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4);
  data.copy(result, 8);
  result.writeUInt32BE(
    crc(result.subarray(4, data.length + 8)),
    data.length + 8,
  );
  return result;
}
const header = Buffer.alloc(13);
header.writeUInt32BE(dimension, 0);
header.writeUInt32BE(dimension, 4);
header[8] = 8;
header[9] = 6;
const png = Buffer.concat([
  Buffer.from("89504e470d0a1a0a", "hex"),
  chunk("IHDR", header),
  chunk("IDAT", zlib.deflateSync(pixels)),
  chunk("IEND", Buffer.alloc(0)),
]);
const ico = Buffer.alloc(22);
ico.writeUInt16LE(1, 2);
ico.writeUInt16LE(1, 4);
ico.writeUInt16LE(1, 10);
ico.writeUInt16LE(32, 12);
ico.writeUInt32LE(png.length, 14);
ico.writeUInt32LE(22, 18);
const folder = path.join(__dirname, "../electron/assets");
fs.mkdirSync(folder, { recursive: true });
fs.writeFileSync(path.join(folder, "icon.png"), png);
fs.writeFileSync(path.join(folder, "icon.ico"), Buffer.concat([ico, png]));
