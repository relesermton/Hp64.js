"use strict";
// _v4.js - HP64 vs esbuild.
// HP64: PROCESS CPU TIME over batches (load-immune; Windows quantizes CPU to
//       15.6ms ticks, so we average 30 compiles per measurement window).
// esbuild: wall clock over batches (its work runs in a separate service
//       process, so our process CPU can't see it).
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const esbuild = require("esbuild");

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const REPS = Number(process.argv[2] || 30);
const BATCHES = Number(process.argv[3] || 10);

const hp = compile(src);
const v = esbuild.transformSync(hp.code, { loader: "js" }); // validity check
console.log(`validated: out=${hp.code.length}B esbuildJS=${v.code.length}B tokens=${hp.stats.tokens} removed=${hp.stats.removed}`);

function med(a) { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; }

// warmup: settle JIT + fill scratch stores
for (let i = 0; i < 5; i++) compile(src);
esbuild.transformSync(src, { loader: "ts" });

const hpCpu = [], hpWall = [];
for (let b = 0; b < BATCHES; b++) {
  const a = process.cpuUsage();
  const w0 = performance.now();
  for (let i = 0; i < REPS; i++) compile(src);
  const w1 = performance.now();
  const d = process.cpuUsage(a);
  hpCpu.push((d.user + d.system) / 1000 / REPS);
  hpWall.push((w1 - w0) / REPS);
}
const ebWall = [];
for (let b = 0; b < BATCHES; b++) {
  const w0 = performance.now();
  for (let i = 0; i < REPS; i++) esbuild.transformSync(src, { loader: "ts" });
  ebWall.push((performance.now() - w0) / REPS);
}

console.log(`\nHP64  cpu/run: ${hpCpu.map(x => x.toFixed(1)).join("  ")}`);
console.log(`  -> med ${med(hpCpu).toFixed(1)} ms   min ${Math.min(...hpCpu).toFixed(1)} ms`);
console.log(`HP64  wall/run: ${hpWall.map(x => x.toFixed(1)).join("  ")}`);
console.log(`  -> med ${med(hpWall).toFixed(1)} ms   min ${Math.min(...hpWall).toFixed(1)} ms`);
console.log(`esbld wall/run: ${ebWall.map(x => x.toFixed(1)).join("  ")}`);
console.log(`  -> med ${med(ebWall).toFixed(1)} ms   min ${Math.min(...ebWall).toFixed(1)} ms`);
const rMed = med(ebWall) / med(hpWall);
const rMin = Math.min(...ebWall) / Math.min(...hpWall);
console.log(`\nvs esbuild: ${rMed.toFixed(2)}x (medians)   ${rMin.toFixed(2)}x (mins)`);
console.log(`HP64 cpu min: ${Math.min(...hpCpu).toFixed(1)} ms   med: ${med(hpCpu).toFixed(1)} ms`);
