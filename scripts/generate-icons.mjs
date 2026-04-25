import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const COLORS = {
  grey:  [0x6B, 0x72, 0x80],
  blue:  [0x3B, 0x82, 0xF6],
  green: [0x10, 0xB9, 0x81],
};
const SIZES = [16, 32, 48, 128];

const crc32 = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return (buf) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

// 6-arm asterisk = 3 capsules through origin at 60° apart (vertical, ±60°).
const AXES = [Math.PI / 2, Math.PI / 6, -Math.PI / 6];
const AXIS_TRIG = AXES.map((a) => [Math.cos(a), Math.sin(a)]);

// Returns coverage [0..1] of pixel (px,py) by the asterisk shape, using N×N
// supersampling for anti-aliased edges.
function asteriskCoverage(px, py, size) {
  const cx = size / 2;
  const cy = size / 2;
  // Arm tip reaches `radius + halfW` from center; keep that under size/2 so the
  // shape never gets clipped by the toolbar's icon bounding box.
  const radius = size * 0.30;   // capsule half-length (arm reach from center)
  const halfW = size * 0.16;    // capsule half-width (arm thickness)
  const halfWSq = halfW * halfW;
  const N = 4;
  let hits = 0;
  for (let sy = 0; sy < N; sy++) {
    for (let sx = 0; sx < N; sx++) {
      const x = px + (sx + 0.5) / N - cx;
      const y = py + (sy + 0.5) / N - cy;
      for (const [ca, sa] of AXIS_TRIG) {
        const along = x * ca + y * sa;
        const perp = -x * sa + y * ca;
        if (Math.abs(along) <= radius && Math.abs(perp) <= halfW) { hits++; break; }
        const d1 = along - radius;
        if (d1 * d1 + perp * perp <= halfWSq) { hits++; break; }
        const d2 = along + radius;
        if (d2 * d2 + perp * perp <= halfWSq) { hits++; break; }
      }
    }
  }
  return hits / (N * N);
}

function makePng(size, [r, g, b]) {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rowLen = 1 + size * 4;
  const raw = Buffer.alloc(rowLen * size);
  for (let y = 0; y < size; y++) {
    const off = y * rowLen;
    raw[off] = 0;
    for (let x = 0; x < size; x++) {
      const p = off + 1 + x * 4;
      const cov = asteriskCoverage(x, y, size);
      if (cov > 0) {
        raw[p] = r;
        raw[p + 1] = g;
        raw[p + 2] = b;
        raw[p + 3] = Math.round(cov * 255);
      }
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", Buffer.alloc(0))]);
}

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "icons");
mkdirSync(outDir, { recursive: true });

let count = 0;
for (const [name, rgb] of Object.entries(COLORS)) {
  for (const size of SIZES) {
    writeFileSync(join(outDir, `icon-${name}-${size}.png`), makePng(size, rgb));
    count++;
  }
}
console.log(`Wrote ${count} icons to ${outDir}`);
