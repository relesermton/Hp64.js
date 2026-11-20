"use strict";
// _partest.js - diagnose the worker round-trip WITHOUT blocking the main
// thread: phase 1 polls receiveMessageOnPort from the event loop; phase 2
// (only if phase 1 passes) blocks with Atomics.wait like Chunked.js does.
const { Worker, MessageChannel, receiveMessageOnPort } = require("worker_threads");
const os = require("os");
const path = require("path");

const P = Math.min(4, os.availableParallelism());
const ctrl = new Int32Array(new SharedArrayBuffer(4 * P));
const workers = [], ports = [];
for (let i = 0; i < P; i++) {
  const ch = new MessageChannel();
  const w = new Worker(path.join(__dirname, "CompilerWorker.js"), {
    workerData: { ctrl: ctrl.buffer, slot: i, port: ch.port2 },
    transferList: [ch.port2],
  });
  w.on("error", (e) => console.log("worker", i, "ERROR:", e.message));
  w.on("exit", (c) => console.log("worker", i, "exit code:", c));
  workers.push(w);
  ports.push(ch.port1);
}
console.log("pool created,", P, "workers");

// ---- phase 1: non-blocking poll ----
const id = 1;
workers[0].postMessage({ id, chunks: ["let x: number = 1;\nlet y = x as number;\n"] });

let n = 0;
const t = setInterval(() => {
  let m;
  try {
    m = receiveMessageOnPort(ports[0]);
  } catch (e) {
    console.log("receiveMessageOnPort threw:", e.message);
    process.exit(1);
  }
  if (m) {
    clearInterval(t);
    console.log("PHASE1 OK reply:", JSON.stringify(m).slice(0, 220));
    console.log("PHASE1 ctrl[0] =", Atomics.load(ctrl, 0));
    phase2();
    return;
  }
  if (++n > 200) {
    console.log("PHASE1 FAIL: no reply in 10s; ctrl[0] =", Atomics.load(ctrl, 0));
    process.exit(1);
  }
}, 50);

// ---- phase 2: blocking wait (the Chunked.js pattern) ----
function phase2() {
  const id2 = 2;
  workers[0].postMessage({ id: id2, chunks: ["let z = 2 as const;\n"] });

  const deadline = Date.now() + 5000;
  let got = null;
  for (;;) {
    const v = Atomics.load(ctrl, 0);
    if (v === id2) {
      let m;
      while ((m = receiveMessageOnPort(ports[0])) !== undefined) {
        if (m.id === id2) { got = m; break; }
      }
      if (got) break;
      if (Date.now() >= deadline) break;
      Atomics.wait(ctrl, 0, v, 1);
      continue;
    }
    if (Date.now() >= deadline) break;
    Atomics.wait(ctrl, 0, v, Math.max(1, deadline - Date.now()));
  }
  if (got) {
    console.log("PHASE2 OK reply:", JSON.stringify(got).slice(0, 220));
    console.log("ALL OK");
    workers.forEach((w) => w.terminate());
    setTimeout(() => process.exit(0), 200);
  } else {
    console.log("PHASE2 FAIL: blocked wait never got reply; ctrl[0] =", Atomics.load(ctrl, 0));
    workers.forEach((w) => w.terminate());
    setTimeout(() => process.exit(1), 200);
  }
}
