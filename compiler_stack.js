"use strict";
// compiler_stack.js - bracket / parse stack primitives for the HP64.js compiler
const { bracketMap } = require("./Compiler.js");

// Fixed-capacity Int32Array stack (no per-push allocation).
function createStack(cap = 4096) {
  const a = new Int32Array(cap);
  let sp = 0;
  return {
    push(v) {
      if (sp === a.length) throw new Error("compiler stack overflow");
      a[sp++] = v | 0;
    },
    pop() { return sp ? a[--sp] : -1; },
    peek() { return sp ? a[sp - 1] : -1; },
    get depth() { return sp; },
    clear() { sp = 0; },
  };
}

// Pair every bracket token with its match + per-token bracket depth.
// Returns { close: Int32Array, open: Int32Array, sd: Int32Array }.
function matchBrackets(toks) {
  return bracketMap(toks);
}

// Matched span [openIdx, closeIdx] for the bracket at openIdx, or null.
function span(toks, openIdx, brackets) {
  const c = brackets.close[openIdx];
  return c >= 0 ? { start: openIdx, end: c } : null;
}

module.exports = { createStack, matchBrackets, span };
