"use strict";
// CompilerWorker.js - worker_threads entry for parallel chunked compilation
// (see Chunked.js). One persistent worker per CPU slot.
//
// Protocol (message -> shared-memory reply):
//   in : parentPort message { id, chunks: [src, ...], buf, cap, done }
//        buf = SharedArrayBuffer, slot from workerData
//        done = SharedArrayBuffer holding a MONOTONIC completion counter
//               (one cell). main blocks on this single cell, so a dispatch
//               costs one wake-up instead of one per worker slot.
//   out: worker writes INTO buf at its slot region:
//          [0] Int32 state   (dispatch id on success, -4 error, -5 overflow)
//          [1] Int32 byteLen (payload bytes)
//          [2..] payload: i32 chunkCount, then per chunk
//                i32 codeByteLen, i32 tokens, i32 removed, code UTF-8 bytes
//        then Atomics.store(state, id); Atomics.notify(stateCell)
//
// Why the reply goes through shared memory instead of postMessage: the main
// thread blocks in Atomics.wait, and a port message is only enqueued when
// the main event loop pumps — a blocked main thread would never see it
// (verified empirically: signal arrives, receiveMessageOnPort returns
// undefined until the loop runs again). Atomics on a SharedArrayBuffer are
// visible immediately, from any thread, without the event loop.
const { parentPort, workerData } = require("worker_threads");
const { compile } = require("./Compiler.js");

const slot = workerData.slot;
const encoder = new TextEncoder();

parentPort.on("message", (job) => {
  const { id, chunks, buf, cap, done, doneIdx } = job;
  const dataOff = slot * cap;
  const state = new Int32Array(buf, dataOff, 2); // [state, byteLen]
  const payloadOff = dataOff + 8;
  const maxPayload = cap - 8;
  const doneCell = new Int32Array(done, doneIdx * 4, 1);

  let payload;
  let finalState = id;
  try {
    payload = encodeResults(chunks);
  } catch (e) {
    payload = encoder.encode((e && e.stack) || String(e));
    finalState = -4; // compile error -> main falls back to serial
  }

  if (payload.length > maxPayload) {
    // pathological growth (should never happen: strip only removes text) —
    // tell the main thread to run this input serially instead.
    state[1] = payload.length;
    Atomics.store(state, 0, -5);
    Atomics.add(doneCell, 0, 1);
    Atomics.notify(doneCell, 0);
    return;
  }

  new Uint8Array(buf, payloadOff, payload.length).set(payload);
  state[1] = payload.length;
  Atomics.store(state, 0, finalState); // release: payload visible after this
  Atomics.add(doneCell, 0, 1);         // monotonic, no reset race
  Atomics.notify(doneCell, 0);
});

function encodeResults(chunks) {
  // measure first, then write
  const enc = new Array(chunks.length);
  let size = 4;
  for (let i = 0; i < chunks.length; i++) {
    const r = compile(chunks[i]);
    const bytes = encoder.encode(r.code);
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
  return out;
}
