"use strict";
// _pd2.js - do workers warm up? time successive identical dispatches, then
// compare against main-thread serial compiles (cold + warm) on the same input.
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");
const { compile } = require("./Compiler.js");
const { splitChunks } = require("./Chunked.js");

function log(...a) { fs.writeSync(1, a.join(" ") + "\n"); }
function ms(a, b) { return (Number(b - a) / 1e6).toFixed(1); }

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const P = Math.max(1, os.availableParallelism());
const target = Math.max(16384, Math.ceil(src.length / P));
const parts = splitChunks(src, target).map(r => src.substring(r.start, r.end));
log("cores:", P, "parts:", parts.length, "lens:", parts.map(p => p.length).join(","));

const maxLen = Math.max(...parts.map(p => p.length));
const cap = Math.max(65536, maxLen * 4 + 65536) & ~3;
const sab = new SharedArrayBuffer(cap * P);
const states = new Int32Array(sab);

const workers = [];
for (let i = 0; i < P; i++) {
  const w = new Worker(path.join(__dirname, "CompilerWorker.js"), { workerData: { slot: i } });
  w.on("error", (e) => log("WORKER", i, "ERROR:", e.message));
  workers.push(w);
}

function dispatch(id) {
  const t = process.hrtime.bigint();
  for (let i = 0; i < P; i++) {
    const job = [];
    for (let j = i; j < parts.length; j += P) job.push(parts[j]);
    workers[i].postMessage({ id, chunks: job, buf: sab, cap });
  }
  const tPost = process.hrtime.bigint();
  const wakes = [];
  for (let i = 0; i < P; i++) {
    const idx = (i * cap) >> 2;
    const dl = Date.now() + 15000;
    const w0 = process.hrtime.bigint();
    for (;;) {
      const v = Atomics.load(states, idx);
      if (v === id) break;
      if (Date.now() >= dl) { log("TIMEOUT slot", i, "v=", v); process.exit(1); }
      Atomics.wait(states, idx, v, 500);
    }
    wakes.push(ms(w0, process.hrtime.bigint()));
  }
  return { post: ms(t, tPost), wakes: wakes.join("/"), total: ms(t, process.hrtime.bigint()) };
}

// tiny warmup (pool start)
let t = process.hrtime.bigint();
for (let i = 0; i < P; i++) workers[i].postMessage({ id: 1, chunks: ["let __w = 1;\n"], buf: sab, cap });
for (let i = 0; i < P; i++) {
  const idx = (i * cap) >> 2;
  const dl = Date.now() + 5000;
  for (;;) {
    const v = Atomics.load(states, idx);
    if (v === 1) break;
    if (Date.now() >= dl) { log("warmup timeout", i); process.exit(1); }
    Atomics.wait(states, idx, v, 500);
  }
}
log("tiny warmup:", ms(t, process.hrtime.bigint()), "ms");

// 5 real dispatches of the SAME parts
for (let d = 2; d <= 6; d++) {
  const r = dispatch(d);
  log("dispatch", d - 1, "post:", r.post, "ms wakes:", r.wakes, "total:", r.total, "ms");
}

// main-thread serial: 1 cold + 2 warm full compiles
for (let k = 1; k <= 3; k++) {
  const t0 = process.hrtime.bigint();
  const out = compile(src);
  log("main full #" + k + ":", ms(t0, process.hrtime.bigint()), "ms out:", out.code.length, "B");
}
// main-thread: one part (warm)
const t0 = process.hrtime.bigint();
compile(parts[0]);
log("main one part (warm):", ms(t0, process.hrtime.bigint()), "ms");

workers.forEach(w => w.terminate());
setTimeout(() => process.exit(0), 300);
