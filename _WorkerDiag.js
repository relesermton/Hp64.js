"use strict";
// _WorkerDiag.js - CompilerWorker with synchronous timing logs (fd 1).
// Used only by _pd3.js to locate parallel-dispatch overhead.
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const { compile } = require("./Compiler.js");
const slot = workerData.slot;
const encoder = new TextEncoder();
const log = (...a) => fs.writeSync(1, "[w" + slot + "] " + a.join(" ") + "\n");
const ms = (a, b) => (Number(b - a) / 1e6).toFixed(1);

parentPort.on("message", (job) => {
  const { id, chunks, buf, cap } = job;
  const dataOff = slot * cap;
  const state = new Int32Array(buf, dataOff, 2);
  const payloadOff = dataOff + 8;
  const t0 = process.hrtime.bigint();
  const enc = new Array(chunks.length);
  let size = 4;
  for (let i = 0; i < chunks.length; i++) {
    const t1 = process.hrtime.bigint();
    const r = compile(chunks[i]);
    const t2 = process.hrtime.bigint();
    const bytes = encoder.encode(r.code);
    const t3 = process.hrtime.bigint();
    log("id=" + id, "chunk=" + i, "len=" + chunks[i].length,
        "compile=" + ms(t1, t2), "encode=" + ms(t2, t3));
    enc[i] = { bytes, tokens: r.stats.tokens, removed: r.stats.removed };
    size += 12 + bytes.length;
  }
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  dv.setInt32(0, chunks.length, true);
  let o = 4;
  for (let i = 0; i < enc.length; i++) {
    const e = enc[i];
    dv.setInt32(o, e.bytes.length, true);
    dv.setInt32(o + 4, e.tokens, true);
    dv.setInt32(o + 8, e.removed, true);
    o += 12;
    out.set(e.bytes, o);
    o += e.bytes.length;
  }
  new Uint8Array(buf, payloadOff, out.length).set(out);
  state[1] = out.length;
  Atomics.store(state, 0, id);
  Atomics.notify(state, 0);
  log("id=" + id, "TOTAL=" + ms(t0, process.hrtime.bigint()));
});
