"use strict";
// _ab.js - interleaved A/B benchmark: ./Compiler.js (A) vs ./_base.js (B).
// Batches alternate order so moment-to-moment load hits both equally.
// Accept a change when A/B cpu ratio > 1.00 (A faster).
const fs = require("fs");
const path = require("path");

const A = require("./Compiler.js");
const B = require("./_base.js");
const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const REPS = Number(process.argv[2] || 25);
const BATCHES = Number(process.argv[3] || 12);

// sanity: both must produce identical output
const a0 = A.compile(src), b0 = B.compile(src);
if (a0.code !== b0.code) { console.log("OUTPUT DIFFERS — not a perf-only change"); process.exit(1); }
console.log(`output identical: ${a0.code.length}B tokens=${a0.stats.tokens} removed=${a0.stats.removed}`);

for (let i = 0; i < 5; i++) { A.compile(src); B.compile(src); } // warm both

// Paired wall timing: measure A and B back-to-back (alternating which goes
// first), so contention/thermal moments hit both members of a pair equally.
const REPS2 = Number(process.argv[4] || REPS * 8);
const pa = [], pb = [];
for (let i = 0; i < REPS2; i++) {
  if (i % 2 === 0) {
    const t0 = performance.now(); A.compile(src); const t1 = performance.now();
    B.compile(src); const t2 = performance.now();
    pa.push(t1 - t0); pb.push(t2 - t1);
  } else {
    const t0 = performance.now(); B.compile(src); const t1 = performance.now();
    A.compile(src); const t2 = performance.now();
    pa.push(t2 - t1); pb.push(t1 - t0);
  }
}

function measure(mod) {
  const a = process.cpuUsage();
  for (let i = 0; i < REPS; i++) mod.compile(src);
  const d = process.cpuUsage(a);
  return (d.user + d.system) / 1000 / REPS;
}

function med(x) { x = x.slice().sort((p, q) => p - q); return x[x.length >> 1]; }
function mn(x) { return Math.min(...x); }
const wA = med(pa), wB = med(pb);
console.log(`\npaired wall: A med ${wA.toFixed(2)} min ${mn(pa).toFixed(2)} | B med ${wB.toFixed(2)} min ${mn(pb).toFixed(2)} ms`);
console.log(`paired ratio A/B: med ${(wB / wA).toFixed(3)}  min ${(mn(pb) / mn(pa)).toFixed(3)}  (>1 = A faster = ACCEPT)`);

const ra = [], rb = [];
for (let b = 0; b < BATCHES; b++) {
  if (global.gc) global.gc(); // clean heap so GC of the other module's garbage
  if (b % 2 === 0) { ra.push(measure(A)); rb.push(measure(B)); } // doesn't land in our window
  else { rb.push(measure(B)); ra.push(measure(A)); }
}
function med(x) { x = x.slice().sort((p, q) => p - q); return x[x.length >> 1]; }
function mn(x) { return Math.min(...x); }
const ma = med(ra), mb = med(rb);
console.log(`A (current) cpu: med ${ma.toFixed(1)}  min ${mn(ra).toFixed(1)}  [${ra.map(x => x.toFixed(1)).join(" ")}]`);
console.log(`B (baseline) cpu: med ${mb.toFixed(1)}  min ${mn(rb).toFixed(1)}  [${rb.map(x => x.toFixed(1)).join(" ")}]`);
console.log(`\nratio A/B: med ${(mb / ma).toFixed(3)}   min ${(mn(rb) / mn(ra)).toFixed(3)}   (A/B > 1.000 = A faster = ACCEPT)`);
