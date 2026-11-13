"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { qrMatrix, qrSvg } = require("../lib/qr.cjs");

/** Reads the format information back out of the grid, the way a camera would. */
function readFormat(m) {
  const size = m.length;
  const bit = (x, y) => (m[y][x] ? 1 : 0);
  let a = 0;
  for (let i = 14; i >= 9; i--) a = (a << 1) | bit(14 - i, 8);
  a = (a << 1) | bit(7, 8);
  a = (a << 1) | bit(8, 8);
  a = (a << 1) | bit(8, 7);
  for (let i = 5; i >= 0; i--) a = (a << 1) | bit(8, i);
  let b = 0;
  for (let i = 14; i >= 8; i--) b = (b << 1) | bit(8, size - 15 + i);
  for (let i = 7; i >= 0; i--) b = (b << 1) | bit(size - 1 - i, 8);
  return { a: a ^ 0x5412, b: b ^ 0x5412 };
}

test("the phone link becomes a QR code a camera can read: right size, finders, and level M with its mask", () => {
  const link = "https://example.github.io/ai-first-os/#b=https%3A%2F%2Fabcdefghijklmnopqrst.supabase.co%2Ffunctions%2Fv1%2Faios&k=" + "x".repeat(43);
  const m = qrMatrix(link);
  assert.equal(m.length, m.version * 4 + 17);
  assert.equal(m.version, 9);
  // The three finder squares: a dark ring, a light ring, a dark center.
  for (const [cx, cy] of [[3, 3], [m.length - 4, 3], [3, m.length - 4]]) {
    assert.equal(m[cy][cx], true);
    assert.equal(m[cy - 2][cx], false);
    assert.equal(m[cy - 3][cx], true);
  }
  const { a, b } = readFormat(m);
  assert.equal(a, b, "both copies of the format agree");
  assert.equal(a >>> 13, 0, "level M");
  assert.equal((a >>> 10) & 7, m.mask);
  assert.equal(m[m.length - 8][8], true, "the fixed dark module");
});

test("sizes grow with the text, and too much text is refused", () => {
  assert.equal(qrMatrix("hi").version, 1);
  assert.equal(qrMatrix("x".repeat(100)).version, 6);
  assert.equal(qrMatrix("x".repeat(107)).version, 7);
  assert.throws(() => qrMatrix("x".repeat(3000)), { code: "QR_TOO_LONG" });
  const svg = qrSvg("hello");
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 29 29"/);
  assert.doesNotMatch(svg, /hello/, "the link is drawn, not written into the page");
});
