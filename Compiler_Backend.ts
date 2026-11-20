// Compiler_Backend.ts - HP64.js compiler backend (typed port of
// Compiler_backend.js): batch helpers over the core stripper.
//
// The actual strip/emit lives in Compiler.js (CommonJS); this module declares
// its surface and adds the batch helpers builders use.

/* eslint-disable @typescript-eslint/no-var-requires */

export interface CompileStats {
  tokens: number;
  removed: number;
}

export interface CompileResult {
  code: string;
  stats: CompileStats;
}

export interface CompileOptions {
  filename?: string;
}

// Declared surface of ./Compiler.js (see Compiler.js compile()).
declare function require(id: string): any;
const compiler = require("./Compiler.js") as {
  compile(src: string, opts?: CompileOptions): CompileResult;
};

/** emit(src) -> JS code string */
export function emit(src: string): string {
  return compiler.compile(src).code;
}

/** emitAll([src, ...]) -> [code, ...] (used by builders for module lists) */
export function emitAll(srcs: string[]): string[] {
  const out = new Array<string>(srcs.length);
  for (let i = 0; i < srcs.length; i++) out[i] = compiler.compile(srcs[i]).code;
  return out;
}

/** compileWithStats(src) -> { code, stats } (tokens seen / tokens removed) */
export function compileWithStats(src: string, opts?: CompileOptions): CompileResult {
  return compiler.compile(src, opts);
}

const compileFn = compiler.compile;
export { compileFn as compile };
