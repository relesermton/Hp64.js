"use strict";
// FullcodeCompiler.js - compiles an entire program given as ONE string
// (all sources concatenated). Used by the fullcode pipeline where the
// whole app is compiled in a single pass instead of per-file.

const { compile } = require("./Compiler.js");

/**
 * compileFull(code, opts) -> { code, stats }
 * Strips TS from a whole program in one pass; optional `hoist` merges
 * repeated import specifiers so the fullcode bundler sees one require per module.
 */
function compileFull(source, opts = {}) {
  const t0 = performance.now();
  const { code, stats } = compile(source, { filename: opts.filename || "fullcode" });

  let out = code;
  if (opts.dedupeRequires) {
    // collapse duplicate require("x") declarations of the same spec
    const seen = new Map();
    out = out.replace(/var\s+(\w+)\s*=\s*require\((["'][^"']+["'])\);?/g, (m, name, spec) => {
      if (seen.has(spec)) return `var ${name}=${seen.get(spec)};`;
      seen.set(spec, name);
      return m;
    });
  }

  return {
    code: out,
    stats: { ...stats, fullcode: true, ms: +(performance.now() - t0).toFixed(2) }
  };
}

module.exports = { compileFull };
