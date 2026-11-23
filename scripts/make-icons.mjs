// Génère les icônes PNG (sans dépendance) : flamme blanche et cœur jaune sur fond orange.
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

const ORANGE = [0xf5, 0xa5, 0x23], WHITE = [255, 255, 255], GOLD = [0xff, 0xd6, 0x34];

// Flamme : un disque en bas prolongé par une pointe qui s'affine vers le haut.
function inFlame(x, y, cx, cy, r, top) {
  if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) return true;
  if (y < top || y > cy) return false;
  const t = (y - top) / (cy - top);
  return Math.abs(x - cx) <= r * Math.pow(t, 0.75);
}

function render(size, padding) {
  const rows = [];
  const S = 4; // suréchantillonnage pour lisser les bords
  for (let py = 0; py < size; py++) {
    const row = [0];
    for (let px = 0; px < size; px++) {
      let acc = [0, 0, 0];
      for (let sy = 0; sy < S; sy++)
        for (let sx = 0; sx < S; sx++) {
          const x = ((px + (sx + 0.5) / S) / size - 0.5) / (1 - 2 * padding) + 0.5;
          const y = ((py + (sy + 0.5) / S) / size - 0.5) / (1 - 2 * padding) + 0.5;
          const c = inFlame(x, y, 0.5, 0.64, 0.12, 0.47) ? GOLD : inFlame(x, y, 0.5, 0.6, 0.22, 0.12) ? WHITE : ORANGE;
          acc = acc.map((v, i) => v + c[i]);
        }
      row.push(...acc.map((v) => Math.round(v / (S * S))));
    }
    rows.push(Buffer.from(row));
  }
  return png(size, Buffer.concat(rows));
}

function png(size, raw) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // 8 bits
  ihdr[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

writeFileSync("public/icons/icon-192.png", render(192, 0.04));
writeFileSync("public/icons/icon-512.png", render(512, 0.04));
writeFileSync("public/icons/icon-maskable-512.png", render(512, 0.14)); // zone sûre Android
console.log("icônes générées");
