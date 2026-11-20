"use strict";
// _v3quick.js - HP64 vs esbuild only: validate output with esbuild + time both.
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const esbuild = require("esbuild");

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const N = Number(process.argv[2] || 10);

// 1) correctness: HP64 output must be valid JS per esbuild, and esbuild TS
//    output should match HP64 output modulo whitespace (both are strip-only).
const hp = compile(src);
const v = esbuild.transformSync(hp.code, { loader: "js" }); // throws if invalid
console.log(`validated: tokens=${hp.stats.tokens} removed=${hp.stats.removed} out=${hp.code.length}B esbuildJS=${v.code.length}B`);

function bench(name, fn) {
  try { fn(); } catch (e) { console.log(name, "FAILED:", e.message.slice(0, 120)); return null; }
  const t = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return { name, avg: t.reduce((a, b) => a + b, 0) / t.length, med: t[Math.floor(t.length / 2)], min: t[0] };
}

const r = [
  bench("HP64.js", () => compile(src).code.length),
  bench("esbuild", () => esbuild.transformSync(src, { loader: "ts" }).code.length),
].filter(Boolean);

console.log("\ncompiler     avg(ms)   med(ms)   min(ms)");
for (const x of r) console.log(x.name.padEnd(12), x.avg.toFixed(2).padStart(7), x.med.toFixed(2).padStart(9), x.min.toFixed(2).padStart(9));
const hp2 = r.find(x => x.name === "HP64.js"), eb = r.find(x => x.name === "esbuild");
if (hp2 && eb) {
  const ratio = eb.med / hp2.med;
  console.log(`\nvs esbuild: ${ratio >= 1 ? "HP64 is " + ratio.toFixed(2) + "x FASTER" : "HP64 is " + (1 / ratio).toFixed(2) + "x SLOWER"}`);
}
