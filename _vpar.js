"use strict";
// _vpar.js - parallel compileChunked vs serial HP64 vs esbuild, INTERLEAVED.
//
// All three modes measured in every batch, order rotated per batch so load
// drift hits all modes equally (the _ab.js lesson). Per-mode stats:
//   par : wall (main thread blocks in Atomics.wait; workers do the work)
//   ser : wall AND process CPU (CPU is load-immune: the 15.6ms Windows tick
//         is why we average REPS compiles per batch)
//   esb : wall (its work runs in a separate service process)
// Pool warmup happens BEFORE measuring and is reported separately.
//
// usage: node _vpar.js [REPS=30] [BATCHES=10] [chunksPerCore=1]
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const { compileChunked, destroyPool } = require("./Chunked.js");
const esbuild = require("esbuild");

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const REPS = Number(process.argv[2] || 30);
const BATCHES = Number(process.argv[3] || 10);
const CPC = Number(process.argv[4] || 1); // chunks per core
const os = require("os");
const ov = Number(process.env.HP64_POOL);
const P = ov >= 1 ? ov : Math.max(1, os.availableParallelism());
const target = Math.max(4096, Math.ceil(src.length / (P * CPC)));

function med(a) { a = a.slice().sort((x, y) => x - y); return a[a.length >> 1]; }
function ms(a, b) { return Number(b - a) / 1e6; }

// ---- validation: parallel output must equal serial; esbuild must accept it
const ser = compile(src);
const par = compileChunked(src, { target, minParallel: 0 });
if (par.code !== ser.code) { console.log("FAIL: parallel != serial"); process.exit(1); }
if (par.stats.tokens !== ser.stats.tokens || par.stats.removed !== ser.stats.removed) {
  console.log("FAIL: stats mismatch"); process.exit(1);
}
const v = esbuild.transformSync(par.code, { loader: "js" });
console.log(`validated: out=${par.code.length}B chunks=${par.chunks} target=${target}B ` +
  `esbuildJS=${v.code.length}B tokens=${ser.stats.tokens} removed=${ser.stats.removed} cores=${P}`);

// ---- warmup (excluded from measurement): JIT + pool + SAB growth
const tw = process.hrtime.bigint();
for (let i = 0; i < 5; i++) compile(src);
for (let i = 0; i < 3; i++) compileChunked(src, { target, minParallel: 0 });
esbuild.transformSync(src, { loader: "ts" });
console.log(`warmup: ${ms(tw, process.hrtime.bigint()).toFixed(0)} ms (5 serial + 3 parallel + 1 esbuild)`);

// ---- interleaved batches
const parWall = [], serWall = [], serCpu = [], ebWall = [];
const modes = ["par", "ser", "esb"];
for (let b = 0; b < BATCHES; b++) {
  const order = b % 3 === 0 ? modes : b % 3 === 1 ? ["ser", "esb", "par"] : ["esb", "par", "ser"];
  for (const m of order) {
    if (m === "par") {
      const w0 = process.hrtime.bigint();
      for (let i = 0; i < REPS; i++) compileChunked(src, { target, minParallel: 0 });
      parWall.push(ms(w0, process.hrtime.bigint()) / REPS);
    } else if (m === "ser") {
      const c0 = process.cpuUsage();
      const w0 = process.hrtime.bigint();
      for (let i = 0; i < REPS; i++) compile(src);
      serWall.push(ms(w0, process.hrtime.bigint()) / REPS);
      const d = process.cpuUsage(c0);
      serCpu.push((d.user + d.system) / 1000 / REPS);
    } else {
      const w0 = process.hrtime.bigint();
      for (let i = 0; i < REPS; i++) esbuild.transformSync(src, { loader: "ts" });
      ebWall.push(ms(w0, process.hrtime.bigint()) / REPS);
    }
  }
}

function report(name, a) {
  console.log(`${name.padEnd(11)} ${a.map(x => x.toFixed(1)).join("  ")}`);
  console.log(`  -> med ${med(a).toFixed(1)} ms   min ${Math.min(...a).toFixed(1)} ms`);
}
report("par wall", parWall);
report("ser wall", serWall);
report("ser cpu", serCpu);
report("esb wall", ebWall);

const rMin = Math.min(...ebWall) / Math.min(...parWall);
const rMed = med(ebWall) / med(parWall);
console.log(`\npar vs esbuild: ${rMed.toFixed(2)}x (medians)   ${rMin.toFixed(2)}x (mins)`);
console.log(`par vs serial:   ${(med(serWall) / med(parWall)).toFixed(2)}x (medians)   ` +
  `${(Math.min(...serWall) / Math.min(...parWall)).toFixed(2)}x (mins)`);
console.log(`esbuild cpu-independent ref: esb min ${Math.min(...ebWall).toFixed(1)} ms   ` +
  `ser cpu min ${Math.min(...serCpu).toFixed(1)} ms`);

// Paired ratio: time par and esbuild back-to-back per rep so load drift hits
// both — far more stable than min-of-separate-batches on a noisy box.
const paired = [];
for (let i = 0; i < REPS; i++) {
  const a = process.hrtime.bigint();
  compileChunked(src, { target, minParallel: 0 });
  const b = process.hrtime.bigint();
  esbuild.transformSync(src, { loader: "ts" });
  const c = process.hrtime.bigint();
  const pw = ms(a, b), ew = ms(b, c);
  if (pw > 0) paired.push(ew / pw);
}
paired.sort((x, y) => x - y);
console.log(`paired esb/par ratio (n=${paired.length}): med ${med(paired).toFixed(2)}x   ` +
  `p10 ${paired[Math.floor(paired.length * 0.1)].toFixed(2)}x   ` +
  `p90 ${paired[Math.floor(paired.length * 0.9)].toFixed(2)}x`);

destroyPool();
setTimeout(() => process.exit(0), 300);
