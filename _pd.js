"use strict";
// _pd.js - where does parallel dispatch time go?
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const { splitChunks, destroyPool, PARALLEL_MIN } = require("./Chunked.js");

// reuse Chunked's internals by re-implementing the dispatch with timers
const os = require("os");
const { Worker } = require("worker_threads");

// synchronous log: console.log output sits in an async pipe buffer and never
// flushes while the main thread blocks in Atomics.wait — write(1) is sync.
function log(...a) { fs.writeSync(1, a.join(" ") + "\n"); }

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const P = Math.max(1, os.availableParallelism());
const target = Math.max(16384, Math.ceil(src.length / P));
const ranges = splitChunks(src, target);
const parts = ranges.map(r => src.substring(r.start, r.end));
log("cores:", P, "chunks:", parts.length, "part lens:",
  parts.map(p => p.length).join(","));

const maxLen = Math.max(...parts.map(p => p.length));
const cap = Math.max(65536, maxLen * 4 + 65536) & ~3;
const sab = new SharedArrayBuffer(cap * P);
const states = new Int32Array(sab);

const workers = [];
for (let i = 0; i < P; i++) {
  const w = new Worker(path.join(__dirname, "CompilerWorker.js"), { workerData: { slot: i } });
  w.on("error", (e) => log("WORKER", i, "ERROR:", e.message));
  w.on("exit", (c) => log("WORKER", i, "exit:", c));
  workers.push(w);
}
log("workers created:", P);

function ms(a, b) { return Number(b - a) / 1e6; }

// warmup with timing
let wid = 1;
let t = process.hrtime.bigint();
for (let i = 0; i < P; i++) {
  workers[i].postMessage({ id: wid, chunks: ["let __w = 1;\n"], buf: sab, cap });
}
for (let i = 0; i < P; i++) {
  const idx = (i * cap) >> 2;
  const dl = Date.now() + 5000;
  for (;;) {
    const v = Atomics.load(states, idx);
    if (v === wid) break;
    if (Date.now() >= dl) { log("warmup timeout slot", i); process.exit(1); }
    Atomics.wait(states, idx, v, 500);
  }
}
log("warmup:", ms(t, process.hrtime.bigint()), "ms");

// real dispatch with per-slot wake timing
const id = 2;
t = process.hrtime.bigint();
for (let i = 0; i < P; i++) {
  const job = [];
  for (let j = i; j < parts.length; j += P) job.push(parts[j]);
  workers[i].postMessage({ id, chunks: job, buf: sab, cap });
}
const tPost = process.hrtime.bigint();
log("post all:", ms(t, tPost), "ms");

const wakes = [];
for (let i = 0; i < P; i++) {
  const idx = (i * cap) >> 2;
  const dl = Date.now() + 15000;
  const w0 = process.hrtime.bigint();
  for (;;) {
    const v = Atomics.load(states, idx);
    if (v === id) break;
    if (Date.now() >= dl) { log("timeout slot", i, "v=", v); process.exit(1); }
    Atomics.wait(states, idx, v, 500);
  }
  wakes.push(ms(tPost, process.hrtime.bigint()));
}
log("wake times after post:", wakes.map(w => w.toFixed(1)).join(", "), "ms");
const tWake = process.hrtime.bigint();

// decode
let bytesTotal = 0;
for (let i = 0; i < P; i++) {
  const dataOff = i * cap;
  const byteLen = states[((i * cap) >> 2) + 1];
  bytesTotal += byteLen;
}
log("payload bytes:", bytesTotal, "decode:", ms(tWake, process.hrtime.bigint()), "ms");
log("TOTAL dispatch:", ms(t, process.hrtime.bigint()), "ms");

// reference: serial full compile on this thread
const ts = process.hrtime.bigint();
compile(src);
log("serial full compile:", ms(ts, process.hrtime.bigint()), "ms");

// reference: one part compiled on this thread (cold-ish)
const tp = process.hrtime.bigint();
compile(parts[0]);
log("one part compile (this thread):", ms(tp, process.hrtime.bigint()), "ms");

workers.forEach(w => w.terminate());
setTimeout(() => process.exit(0), 300);
