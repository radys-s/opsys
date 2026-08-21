/**
 * Vygeneruje ikony aplikace do `src-tauri/icons/`.
 *
 * Proč skript a ne binární soubory v repozitáři: ikona je odvozená z týchž
 * tokenů jako UI (pozadí #07090a, accent #3ff0b2, segmentový motiv), takže
 * když se změní paleta, přegeneruje se jedním příkazem:
 *
 *     node scripts/make-icons.mjs
 *
 * Zapisuje PNG (vlastní enkodér nad zlib) a ICO (32bpp BMP záznamy).
 * Žádná externí závislost.
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src-tauri', 'icons');

const BG = [0x07, 0x09, 0x0a];
const ACCENT = [0x3f, 0xf0, 0xb2];
const LINE = [0x1a, 0x3d, 0x35];

/** RGBA buffer, řádky shora dolů. */
function drawIcon(size) {
  const px = Buffer.alloc(size * size * 4);

  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    const i = (y * size + x) * 4;
    px[i] = r;
    px[i + 1] = g;
    px[i + 2] = b;
    px[i + 3] = a;
  };

  // podklad
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) set(x, y, BG);
  }

  const unit = size / 32;
  const round = (v) => Math.round(v);
  const inset = round(unit * 3);
  const border = Math.max(1, round(unit));

  // rámeček
  for (let t = 0; t < border; t++) {
    for (let x = inset; x < size - inset; x++) {
      set(x, inset + t, LINE);
      set(x, size - inset - 1 - t, LINE);
    }
    for (let y = inset; y < size - inset; y++) {
      set(inset + t, y, LINE);
      set(size - inset - 1 - t, y, LINE);
    }
  }

  // tři segmentové pruhy — stejný motiv jako ukazatele metrik v UI
  const barLeft = inset + round(unit * 3);
  const barRight = size - inset - round(unit * 3);
  const span = barRight - barLeft;
  const barH = Math.max(1, round(unit * 3));
  const gap = Math.max(1, round(unit * 2.4));
  const firstTop = round(size / 2 - (barH * 3 + gap * 2) / 2);
  const fills = [0.85, 0.55, 0.3];

  fills.forEach((fill, row) => {
    const top = firstTop + row * (barH + gap);
    const lit = round(span * fill);
    for (let y = top; y < top + barH; y++) {
      for (let x = barLeft; x < barRight; x++) {
        set(x, y, x - barLeft < lit ? ACCENT : LINE);
      }
    }
  });

  return px;
}

// ---- PNG -------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = -1;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(size, rgba) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filtr: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- ICO -------------------------------------------------------------------

/** Jeden záznam ICO jako 32bpp BMP: hlavička, BGRA zdola nahoru, AND maska. */
function bmpEntry(size, rgba) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // výška XOR + AND masky
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(0, 16); // BI_RGB

  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const src = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      const s = src + x * 4;
      const d = (y * size + x) * 4;
      xor[d] = rgba[s + 2];
      xor[d + 1] = rgba[s + 1];
      xor[d + 2] = rgba[s];
      xor[d + 3] = rgba[s + 3];
    }
  }

  // AND maska: řádek zarovnaný na 4 bajty, samé nuly = vše neprůhledné
  const maskRow = Math.ceil(size / 32) * 4;
  const and = Buffer.alloc(maskRow * size);

  return Buffer.concat([header, xor, and]);
}

function encodeIco(sizes) {
  const images = sizes.map((size) => bmpEntry(size, drawIcon(size)));

  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // typ: ikona
  header.writeUInt16LE(sizes.length, 4);

  const dir = Buffer.alloc(16 * sizes.length);
  let offset = 6 + 16 * sizes.length;

  sizes.forEach((size, i) => {
    const at = i * 16;
    dir[at] = size >= 256 ? 0 : size;
    dir[at + 1] = size >= 256 ? 0 : size;
    dir[at + 2] = 0; // paleta
    dir[at + 3] = 0;
    dir.writeUInt16LE(1, at + 4); // barevné roviny
    dir.writeUInt16LE(32, at + 6); // bitů na pixel
    dir.writeUInt32LE(images[i].length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += images[i].length;
  });

  return Buffer.concat([header, dir, ...images]);
}

// ---- zápis -----------------------------------------------------------------

mkdirSync(OUT_DIR, { recursive: true });

const pngs = [
  ['32x32.png', 32],
  ['128x128.png', 128],
  ['128x128@2x.png', 256],
  ['icon.png', 512],
];

for (const [name, size] of pngs) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, encodePng(size, drawIcon(size)));
  console.log(`${name.padEnd(16)} ${size}x${size}`);
}

const icoPath = join(OUT_DIR, 'icon.ico');
writeFileSync(icoPath, encodeIco([16, 32, 48, 256]));
console.log('icon.ico        16/32/48/256');
