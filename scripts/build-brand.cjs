#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

/**
 * Draws the logo and its animation from one set of geometry, with no image tools.
 * The moon orbits the planet once, settles into place, and a line draws through
 * both, like a key lining up. It then clears and the loop starts over.
 */

const ROOT = path.join(__dirname, "..");
const SAMPLES = 4;
const BG = [0x0b, 0x0b, 0x0d];
const FG = [0xf5, 0xf5, 0xf7];
const LEVELS = SAMPLES * SAMPLES + 1;
const TRANSPARENT = LEVELS;

const CENTER = 256;
const ORBIT_RADIUS = 150;
const RING_HALF_WIDTH = 8;
const PLANET_RADIUS = 50;
const MOON_RADIUS = 38;
const MOON_CLEARANCE = 66;
const REST_ANGLE = -Math.PI / 4;
const LINE_HALF_WIDTH = 6;
const LINE_REACH = 236;

const FRAME_CS = 4;
const ORBIT_FRAMES = 42;
const SETTLE_FRAMES = 4;
const DRAW_FRAMES = 10;
const HOLD_FRAMES = 16;
const PULSE_FRAMES = 6;
const CLEAR_FRAMES = 8;
const TOTAL_FRAMES = ORBIT_FRAMES + SETTLE_FRAMES + DRAW_FRAMES + HOLD_FRAMES + CLEAR_FRAMES;

const easeInOut = t => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = t => 1 - (1 - t) ** 3;
const easeIn = t => t * t * t;

const axis = [Math.cos(REST_ANGLE), Math.sin(REST_ANGLE)];
const lineStart = [CENTER - axis[0] * LINE_REACH, CENTER - axis[1] * LINE_REACH];
const lineEnd = [CENTER + axis[0] * LINE_REACH, CENTER + axis[1] * LINE_REACH];
const along = amount => [lineStart[0] + (lineEnd[0] - lineStart[0]) * amount, lineStart[1] + (lineEnd[1] - lineStart[1]) * amount];

const REST = { angle: REST_ANGLE, from: null, to: null, swell: 1 };

function stateAt(frame) {
  if (frame < ORBIT_FRAMES) return { ...REST, angle: REST_ANGLE + 2 * Math.PI * easeInOut(frame / ORBIT_FRAMES) };
  let step = frame - ORBIT_FRAMES;
  if (step < SETTLE_FRAMES) return REST;
  step -= SETTLE_FRAMES;
  if (step < DRAW_FRAMES) return { ...REST, from: 0, to: easeOut((step + 1) / DRAW_FRAMES) };
  step -= DRAW_FRAMES;
  if (step < HOLD_FRAMES) {
    const swell = step < PULSE_FRAMES ? 1 + 0.07 * Math.sin((Math.PI * step) / PULSE_FRAMES) : 1;
    return { ...REST, from: 0, to: 1, swell };
  }
  step -= HOLD_FRAMES;
  const cleared = easeIn((step + 1) / CLEAR_FRAMES);
  return cleared >= 1 ? REST : { ...REST, from: cleared, to: 1 };
}

function distanceToSegment(x, y, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared ? Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / lengthSquared)) : 0;
  return Math.sqrt((x - a[0] - t * dx) ** 2 + (y - a[1] - t * dy) ** 2);
}

function isLit(x, y, state) {
  const moonX = CENTER + ORBIT_RADIUS * Math.cos(state.angle);
  const moonY = CENTER + ORBIT_RADIUS * Math.sin(state.angle);
  const toCenter = Math.sqrt((x - CENTER) ** 2 + (y - CENTER) ** 2);
  const toMoon = Math.sqrt((x - moonX) ** 2 + (y - moonY) ** 2);
  const inPlanet = toCenter <= PLANET_RADIUS * state.swell;
  const inMoon = toMoon <= MOON_RADIUS * state.swell;
  const onRing = Math.abs(toCenter - ORBIT_RADIUS) <= RING_HALF_WIDTH && toMoon > MOON_CLEARANCE;
  if (state.from !== null && distanceToSegment(x, y, along(state.from), along(state.to)) <= LINE_HALF_WIDTH) {
    // Inside the bodies the line reads as a dark slot, so it visibly passes through them.
    return !(inPlanet || inMoon);
  }
  return inPlanet || inMoon || onRing;
}

function renderLevels(size, state) {
  const scale = 512 / size;
  const levels = new Uint8Array(size * size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0;
      for (let i = 0; i < SAMPLES; i++) {
        for (let j = 0; j < SAMPLES; j++) {
          if (isLit((x + (i + 0.5) / SAMPLES) * scale, (y + (j + 0.5) / SAMPLES) * scale, state)) hits++;
        }
      }
      levels[y * size + x] = hits;
    }
  }
  return levels;
}

const shade = level => BG.map((c, i) => Math.round(c + ((FG[i] - c) * level) / (LEVELS - 1)));

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function encodePng(size, levels) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  let at = 0;
  for (let y = 0; y < size; y++) {
    raw[at++] = 0;
    for (let x = 0; x < size; x++) for (const value of shade(levels[y * size + x])) raw[at++] = value;
  }
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, sum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

function lzwEncode(pixels, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;
  const output = [];
  let bits = 0;
  let bitCount = 0;
  let codeSize = minCodeSize + 1;
  let nextCode = endCode + 1;
  let table = new Map();

  const emit = code => {
    bits |= code << bitCount;
    bitCount += codeSize;
    while (bitCount >= 8) {
      output.push(bits & 255);
      bits >>>= 8;
      bitCount -= 8;
    }
  };
  const reset = () => {
    table = new Map();
    codeSize = minCodeSize + 1;
    nextCode = endCode + 1;
  };

  emit(clearCode);
  let prefix = pixels[0];
  for (let i = 1; i < pixels.length; i++) {
    const pixel = pixels[i];
    const key = (prefix << 8) | pixel;
    const found = table.get(key);
    if (found !== undefined) {
      prefix = found;
      continue;
    }
    emit(prefix);
    if (nextCode < 4096) {
      table.set(key, nextCode++);
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize++;
    } else {
      emit(clearCode);
      reset();
    }
    prefix = pixel;
  }
  emit(prefix);
  emit(endCode);
  if (bitCount > 0) output.push(bits & 255);
  return Buffer.from(output);
}

function subBlocks(data) {
  const parts = [];
  for (let i = 0; i < data.length; i += 255) {
    const piece = data.subarray(i, i + 255);
    parts.push(Buffer.from([piece.length]), piece);
  }
  parts.push(Buffer.from([0]));
  return Buffer.concat(parts);
}

function encodeGif(size, frames, delayCs) {
  const tableBits = 5;
  const palette = Buffer.alloc((1 << tableBits) * 3);
  for (let level = 0; level < LEVELS; level++) palette.set(shade(level), level * 3);
  const word = v => Buffer.from([v & 255, v >> 8]);
  const parts = [
    Buffer.from("GIF89a", "ascii"),
    word(size),
    word(size),
    Buffer.from([0xf0 | (tableBits - 1), 0, 0]),
    palette,
    Buffer.from([0x21, 0xff, 0x0b]),
    Buffer.from("NETSCAPE2.0", "ascii"),
    Buffer.from([0x03, 0x01, 0x00, 0x00, 0x00]),
  ];
  let previous = null;
  for (const levels of frames) {
    const pixels = new Uint8Array(levels.length);
    for (let i = 0; i < levels.length; i++) pixels[i] = previous && previous[i] === levels[i] ? TRANSPARENT : levels[i];
    parts.push(
      Buffer.from([0x21, 0xf9, 0x04, 0x05]),
      word(delayCs),
      Buffer.from([TRANSPARENT, 0x00, 0x2c]),
      word(0),
      word(0),
      word(size),
      word(size),
      Buffer.from([0x00, tableBits]),
      subBlocks(lzwEncode(pixels, tableBits))
    );
    previous = levels;
  }
  parts.push(Buffer.from([0x3b]));
  return Buffer.concat(parts);
}

function renderFrame(size, frame) {
  return renderLevels(size, stateAt(frame));
}

function build({ outputs = ROOT } = {}) {
  const write = (rel, data) => {
    const target = path.join(outputs, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    return target;
  };
  const logo = encodePng(512, renderLevels(512, REST));
  const frames = Array.from({ length: TOTAL_FRAMES }, (_, i) => renderFrame(256, i));
  return {
    logo: [write("assets/logo-512.png", logo), write("phone/logo.png", logo)],
    gif: write("phone/loading.gif", encodeGif(256, frames, FRAME_CS)),
  };
}

if (require.main === module) {
  const built = build();
  process.stdout.write(`${built.gif} (${fs.statSync(built.gif).size} bytes, ${TOTAL_FRAMES} frames)\n`);
}

module.exports = { build, renderFrame, encodePng, encodeGif, stateAt, TOTAL_FRAMES, ORBIT_FRAMES, SETTLE_FRAMES, DRAW_FRAMES };
