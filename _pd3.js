"use strict";
// _pd3.js - main side of the worker-timing diagnostic (_WorkerDiag.js).
const fs = require("fs");
const path = require("path");
const os = require("os");
const { Worker } = require("worker_threads");
const { compile } = require("./Compiler.js");
const { splitChunks } = require("./Chunked.js");
function log(...a) { fs.writeSync(1, "[main] " + a.join(" ") + "\n"); }
function ms(a, b) { return Number(b - a) / 1e6; }

const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const P = Number(process.env.HP64_POOL) >= 1 ? Number(process.env.HP64_POOL) : Math.max(1, os.availableParallelism());
const parts = splitChunks(src, Math.ceil(src.length / P)).map(r => src.substring(r.start, r.end));
const cap = (Math.max(65536, Math.max(...parts.map(p => p.length)) * 4 + 65536)) & ~3;
const sab = new SharedArrayBuffer(cap * P);
const states = new Int32Array(sab);
const workers = [];
for (let i = 0; i < P; i++) {
  const w = new Worker(path.join(__dirname, "_WorkerDiag.js"), { workerData: { slot: i } });
  w.on("error", (e) => log("worker", i, "ERROR", e.message));
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
  for (let i = 0; i < P; i++) {
    const idx = (i * cap) >> 2;
    const dl = Date.now() + 15000;
    for (;;) {
      const v = Atomics.load(states, idx);
      if (v === id) break;
      if (Date.now() >= dl) { log("TIMEOUT slot", i, "v=", v); process.exit(1); }
      Atomics.wait(states, idx, v, 500);
    }
  }
  log("dispatch", id - 1, "post=" + ms(t, tPost).toFixed(1),
      "total=" + ms(t, process.hrtime.bigint()).toFixed(1));
}

// warmup with real parts so JIT is settled, then 5 measured dispatches
for (let d = 1; d <= 3; d++) dispatch(d);
for (let d = 4; d <= 8; d++) dispatch(d);

const t0 = process.hrtime.bigint();
compile(src);
log("main serial full:", ms(t0, process.hrtime.bigint()).toFixed(1), "ms");
workers.forEach(w => w.terminate());
setTimeout(() => process.exit(0), 300);
