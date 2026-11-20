"use strict";
// core64.js - 64-bit integer core helpers (BigInt-backed, HP64.js)
// All results are normalized to unsigned 64-bit range [0, 2^64).

const MASK = (1n << 64n) - 1n;
const B8 = 0xFFn;

function u64(x) {
  const b = typeof x === "bigint" ? x : BigInt(x);
  return b & MASK;
}

function add64(a, b) { return (u64(a) + u64(b)) & MASK; }
function sub64(a, b) { return (u64(a) - u64(b)) & MASK; }
function mul64(a, b) { return (u64(a) * u64(b)) & MASK; }
function and64(a, b) { return u64(a) & u64(b); }
function or64(a, b) { return u64(a) | u64(b); }
function xor64(a, b) { return u64(a) ^ u64(b); }
function shl64(a, n) { return (u64(a) << BigInt(n & 63)) & MASK; }
function shr64(a, n) { return u64(a) >> BigInt(n & 63); }

function readU64LE(buf, off) {
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(buf[off + i]);
  return v;
}
function writeU64LE(buf, off, v) {
  let b = u64(v);
  for (let i = 0; i < 8; i++) {
    buf[off + i] = Number(b & B8);
    b >>= 8n;
  }
}
function toHex64(x) { return "0x" + u64(x).toString(16).padStart(16, "0"); }
function toDec64(x) { return u64(x).toString(10); }

module.exports = {
  MASK, u64, add64, sub64, mul64, and64, or64, xor64, shl64, shr64,
  readU64LE, writeU64LE, toHex64, toDec64,
};
