"use strict";
// core32.js - 32-bit integer core helpers (HP64.js)
// Math.imul-based wrapping arithmetic, bit ops, FNV-1a hash, LE byte IO.

function u32(x) { return x >>> 0; }
function i32(x) { return x | 0; }
function add32(a, b) { return (a + b) >>> 0; }
function sub32(a, b) { return (a - b) >>> 0; }
function mul32(a, b) { return Math.imul(a, b) >>> 0; }
function and32(a, b) { return a & b; }
function or32(a, b) { return a | b; }
function xor32(a, b) { return a ^ b; }
function not32(a) { return ~a >>> 0; }
function shl32(a, n) { return a << (n & 31); }
function shr32(a, n) { return a >>> (n & 31); }
function sar32(a, n) { return a >> (n & 31); }
function rotl32(x, n) { n &= 31; return ((x << n) | (x >>> (32 - n))) >>> 0; }
function rotr32(x, n) { n &= 31; return ((x >>> n) | (x << (32 - n))) >>> 0; }

// FNV-1a 32-bit string hash (used for keyword/identifier interning)
function hash32(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function readU16LE(buf, off) { return buf[off] | (buf[off + 1] << 8); }
function readU32LE(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}
function writeU16LE(buf, off, v) { buf[off] = v & 255; buf[off + 1] = (v >>> 8) & 255; }
function writeU32LE(buf, off, v) {
  v >>>= 0;
  buf[off] = v & 255;
  buf[off + 1] = (v >>> 8) & 255;
  buf[off + 2] = (v >>> 16) & 255;
  buf[off + 3] = (v >>> 24) & 255;
}

module.exports = {
  u32, i32, add32, sub32, mul32, and32, or32, xor32, not32,
  shl32, shr32, sar32, rotl32, rotr32,
  hash32, readU16LE, readU32LE, writeU16LE, writeU32LE,
  MAX: 0xFFFFFFFF,
};
