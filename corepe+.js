"use strict";
// corepe+.js - PE32+ (64-bit) executable header reader (HP64.js)
// Parses MZ/PE headers of 64-bit Windows images (magic 0x20B),
// plus a dispatcher that picks PE32 vs PE32+ automatically.

const { readU16LE, readU32LE } = require("./core32.js");
const { readU64LE } = require("./core64.js");
const { parsePE32 } = require("./corepe32.js");

const MACHINES = {
  0x8664: "amd64",
  0xaa64: "arm64",
  0x0200: "ia64",
};

// parsePE32Plus(buf) -> header object, or null if not a PE32+ image.
function parsePE32Plus(buf) {
  if (!buf || buf.length < 0x40) return null;
  if (buf[0] !== 0x4d || buf[1] !== 0x5a) return null; // "MZ"
  const e_lfanew = readU32LE(buf, 0x3c);
  if (e_lfanew + 24 >= buf.length) return null;
  if (buf[e_lfanew] !== 0x50 || buf[e_lfanew + 1] !== 0x45 ||
      buf[e_lfanew + 2] !== 0 || buf[e_lfanew + 3] !== 0) return null; // "PE\0\0"

  const machine = readU16LE(buf, e_lfanew + 4);
  const numSections = readU16LE(buf, e_lfanew + 6);
  const sizeOfOptional = readU16LE(buf, e_lfanew + 20);
  const opt = e_lfanew + 24;
  if (opt + sizeOfOptional > buf.length) return null;
  const magic = readU16LE(buf, opt);
  if (magic !== 0x20b) return null; // not PE32+ (PE32 is 0x10b)

  return {
    format: "PE32+",
    machine,
    machineName: MACHINES[machine] || ("0x" + machine.toString(16)),
    numSections,
    sizeOfOptional,
    magic,
    imageBase: readU64LE(buf, opt + 24),
    sizeOfImage: readU32LE(buf, opt + 56),
    sizeOfHeaders: readU32LE(buf, opt + 60),
    checksum: readU32LE(buf, opt + 64),
    subsystem: readU16LE(buf, opt + 68),
    dllCharacteristics: readU16LE(buf, opt + 70),
    sizeOfStackReserve: readU64LE(buf, opt + 72),
    sizeOfHeapReserve: readU64LE(buf, opt + 88),
    fileLength: buf.length,
  };
}

// Auto-detect: returns PE32 or PE32+ header, or null.
function parsePE(buf) {
  return parsePE32Plus(buf) || parsePE32(buf);
}

module.exports = { parsePE32Plus, parsePE, MACHINES };
