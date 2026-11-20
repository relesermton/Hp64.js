// Compiler_BackendFullcode.ts - typed port of FullcodeCompiler.js:
// compiles an entire program given as ONE string (all sources concatenated).
// Used by the fullcode pipeline where the whole app is compiled in a single
// pass instead of per-file.

import type { CompileOptions, CompileResult, CompileStats } from "./Compiler_Backend";

/* eslint-disable @typescript-eslint/no-var-requires */
declare function require(id: string): any;
const { compile } = require("./Compiler.js") as {
  compile(src: string, opts?: CompileOptions): CompileResult;
};

export interface FullcodeResult {
  code: string;
  stats: CompileStats & { fullcode: true; ms: number };
}

export interface FullcodeOptions extends CompileOptions {
  /** collapse duplicate require("x") declarations of the same spec */
  dedupeRequires?: boolean;
}

/** Collapse duplicate `var x = require("spec");` declarations of the same spec. */
export function dedupeRequires(code: string): string {
  const seen = new Map<string, string>();
  return code.replace(
    /var\s+(\w+)\s*=\s*require\((["'][^"']+["'])\);?/g,
    (m: string, name: string, spec: string): string => {
      const prior = seen.get(spec);
      if (prior !== undefined) return `var ${name}=${prior};`;
      seen.set(spec, name);
      return m;
    }
  );
}

/**
 * compileFull(code, opts) -> { code, stats }
 * Strips TS from a whole program in one pass; optional `dedupeRequires`
 * merges repeated import specifiers so the fullcode bundler sees one
 * require per module.
 */
export function compileFull(source: string, opts: FullcodeOptions = {}): FullcodeResult {
  const t0 = performance.now();
  const { code, stats } = compile(source, { filename: opts.filename || "fullcode" });

  const out = opts.dedupeRequires ? dedupeRequires(code) : code;

  return {
    code: out,
    stats: { ...stats, fullcode: true, ms: +(performance.now() - t0).toFixed(2) },
  };
}
