"use strict";
// _parcheck.js - confirm the parallel worker path really runs (not fallback).
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const { compileChunked, destroyPool } = require("./Chunked.js");

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const full = compile(src);

// force parallel with a realistic target
const t0 = process.hrtime.bigint();
const r = compileChunked(src, { minParallel: 0 });
const t1 = process.hrtime.bigint();

console.log("parallel:", r.parallel === true, "chunks:", r.chunks,
  "wall:", Number(t1 - t0) / 1e6, "ms");
console.log("byte-identical:", r.code === full.code,
  "stats:", JSON.stringify(r.stats), "vs", JSON.stringify(full.stats));

// second call reuses the warm pool
const t2 = process.hrtime.bigint();
const r2 = compileChunked(src, { minParallel: 0 });
const t3 = process.hrtime.bigint();
console.log("warm-pool wall:", Number(t3 - t2) / 1e6, "ms identical:",
  r2.code === full.code, "parallel:", r2.parallel === true);

destroyPool();
setTimeout(() => process.exit(r.code === full.code && r.parallel === true ? 0 : 1), 300);
