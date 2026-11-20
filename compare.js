"use strict";
// compare.js - HP64.js vs esbuild vs SWC vs TypeScript on the same file.
// Measures: cold compile (single run) + warm avg over N runs. Lower is better.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "bench", "app.ts");
const src = fs.readFileSync(FILE, "utf8");
const N = Number(process.argv[2] || 10);

function bench(name, fn) {
  // warmup
  try { fn(); } catch (e) { console.log(name.padEnd(14), "FAILED:", e.message.slice(0, 80)); return null; }
  const times = [];
  let outLen = 0;
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    outLen = fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const avg = times.reduce((a, b) => a + b, 0) / times.length;
  const med = times[Math.floor(times.length / 2)];
  return { name, avg, med, min: times[0], outLen };
}

const results = [];

// HP64
results.push(bench("HP64.js", () => {
  const { compile } = require("./Compiler.js");
  return compile(src).code.length;
}));

// esbuild (JS API)
const esbuild = require("esbuild");
esbuild.buildSync({ stdin: { contents: src, loader: "ts" }, write: false, minify: false });
results.push(bench("esbuild", () => {
  const r = esbuild.transformSync(src, { loader: "ts" });
  return r.code.length;
}));

// SWC
const swc = require("@swc/core");
swc.transformSync(src, { jsc: { parser: { syntax: "typescript" }, target: "es2022" } });
results.push(bench("SWC", () => {
  const r = swc.transformSync(src, { jsc: { parser: { syntax: "typescript" }, target: "es2022" } });
  return r.code.length;
}));

// TypeScript transpileModule (no type check - same job as HP64)
const ts = require("typescript");
ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
results.push(bench("tsc(transpile)", () => {
  const r = ts.transpileModule(src, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return r.outputText.length;
}));

const ok = results.filter(Boolean);
ok.sort((a, b) => a.med - b.med);
console.log(`\nfile: bench/app.ts (${(Buffer.byteLength(src) / 1024).toFixed(0)} KB), ${N} runs each\n`);
console.log("compiler           avg(ms)   med(ms)   min(ms)");
console.log("-".repeat(44));
for (const r of ok) {
  console.log(r.name.padEnd(18), r.avg.toFixed(2).padStart(7), r.med.toFixed(2).padStart(9), r.min.toFixed(2).padStart(9));
}
const hp = ok.find(r => r.name === "HP64.js");
if (hp) {
  const fastest = ok.filter(r => r.name !== "HP64.js")[0];
  if (fastest) {
    const ratio = fastest.med / hp.med;
    console.log(`\nvs fastest (${fastest.name}): ${ratio >= 1 ? "HP64 is " + ratio.toFixed(2) + "x FASTER" : "HP64 is " + (1 / ratio).toFixed(2) + "x SLOWER"}`);
  }
}
