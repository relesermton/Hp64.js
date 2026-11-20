"use strict";
// Compiler_backend.js - HP64.js compiler backend (stripped TS -> JS emission)
// Delegates the actual strip/emit to Compiler.js and adds batch helpers.

const { compile } = require("./Compiler.js");

// emit(src) -> JS code string
function emit(src) {
  return compile(src).code;
}

// emitAll([src, ...]) -> [code, ...] (used by builders for module lists)
function emitAll(srcs) {
  const out = new Array(srcs.length);
  for (let i = 0; i < srcs.length; i++) out[i] = compile(srcs[i]).code;
  return out;
}

// compileWithStats(src) -> { code, stats } (tokens seen / tokens removed)
function compileWithStats(src) {
  return compile(src);
}

module.exports = { emit, emitAll, compileWithStats, compile };
