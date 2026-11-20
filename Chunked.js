"use strict";
// Chunked.js - statement-boundary chunked compilation (serial + parallel).
//
// Splitting rules (verified against Compiler.js semantics):
//  - boundaries ONLY after depth-0 `;` (statement separators; `for(;;)` semis
//    are depth>=1 inside the parens, strings/comments/templates are skipped
//    exactly the way tokenize() skips them — tokenize has no regex handling,
//    so neither does this scanner)
//  - chunks OVERLAP: each chunk ENDS with the boundary `;` and the next chunk
//    STARTS with that same `;`. The compiled piece of chunks>0 therefore
//    begins with ";" and gets .substring(1) when concatenating.
//    This one-token overlap makes every backward walk (sigStart,
//    isTernaryBefore, isVarDeclBefore, DECL backwalk) byte-equivalent to a
//    full compile: statements never span a depth-0 `;`, and all forward
//    walkers stop at `;` (STOP_PARAM lacks `;` but `)`/`,` always intervene
//    inside a chunk).
//  - stats merge: tokens = sum - 2*(K-1)  [each boundary `;` is tokenized
//    twice, and each chunk carries its own EOF token]; removed = sum (the
//    boundary `;` is only ever deleted by the previous chunk's view, so it
//    is counted at most once).
//
// Parallel path (>= PARALLEL_MIN bytes): chunks are dealt round-robin across
// a persistent worker_threads pool. The main thread keeps its synchronous
// API by blocking in Atomics.wait on a per-dispatch SharedArrayBuffer; the
// worker writes the compiled payload into shared memory and signals with
// Atomics.store/notify. Replies CANNOT travel over a MessagePort here: port
// messages are only enqueued when the destination event loop pumps, and a
// main thread blocked in Atomics.wait never pumps (verified: signal arrives,
// receiveMessageOnPort returns undefined — see _partest.js).
// Any pool failure (startup, crash, timeout, overflow) falls back to the
// serial path, so correctness never depends on the pool.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { Worker } = require("worker_threads");
const { compile } = require("./Compiler.js");

// In a single-file executable (SEA/pkg) CompilerWorker.js isn't a real file,
// so spawning it would only burn a warmup timeout on every module. Detect that
// once and go straight to the (correct, just non-parallel) serial path.
const WORKER_PATH = path.join(__dirname, "CompilerWorker.js");
let POOL_DISABLED = !fs.existsSync(WORKER_PATH);
try {
  const sea = require("node:sea");
  if (sea.isSea && sea.isSea()) POOL_DISABLED = true;
} catch (_) { /* not a Node with node:sea (or not SEA) */ }

// Inputs at least this big attempt the parallel path (smaller inputs never
// pay pool/dispatch overhead). opts.minParallel overrides (harness use).
const PARALLEL_MIN = 65536;
// Safety valve: a wedged worker must not hang the caller forever. On timeout
// the whole pool is destroyed and the compile falls back to serial.
const DISPATCH_TIMEOUT_MS = 15000;
const WARMUP_TIMEOUT_MS = 5000;
const STATE_ERR = -4;     // worker's compile() threw
const STATE_OVERFLOW = -5; // payload exceeded the slot region

// ---------------------------------------------------------------------------
// Splitting
// ---------------------------------------------------------------------------

// Scan src and return the char indices of every depth-0 `;`.
function depthZeroSemis(src) {
  const n = src.length;
  const semis = [];
  let i = 0, d = 0;
  while (i < n) {
    const c = src.charCodeAt(i);
    // strings (" or ') — same skip loop as tokenize case 5/6
    if (c === 34 || c === 39) {
      i++;
      while (i < n) {
        const cc = src.charCodeAt(i);
        if (cc === 92) { i += 2; continue; }
        if (cc === c) { i++; break; }
        i++;
      }
      continue;
    }
    // template literals — replicates tokenize case 7 (incl. nested templates)
    if (c === 96) {
      i++;
      let depth = 0;
      while (i < n) {
        const cc = src.charCodeAt(i);
        if (cc === 92) { i += 2; continue; }
        if (depth === 0 && cc === 96) { i++; break; }
        if (depth === 0 && cc === 36 && src.charCodeAt(i + 1) === 123) { depth = 1; i += 2; continue; }
        if (depth > 0) {
          if (cc === 123) depth++;
          else if (cc === 125) depth--;
          else if (cc === 96) { // nested template: skip fully
            i++;
            let d2 = 0;
            while (i < n) {
              const c2 = src.charCodeAt(i);
              if (c2 === 92) { i += 2; continue; }
              if (d2 === 0 && c2 === 96) { i++; break; }
              if (d2 === 0 && c2 === 36 && src.charCodeAt(i + 1) === 123) { d2 = 1; i += 2; continue; }
              if (d2 > 0 && c2 === 123) d2++;
              else if (d2 > 0 && c2 === 125) d2--;
              i++;
            }
            continue;
          }
        }
        i++;
      }
      continue;
    }
    // '/' — line/block comment, else ordinary punctuator (tokenize case 8;
    // there is no regex literal handling in this compiler)
    if (c === 47) {
      const c1 = src.charCodeAt(i + 1);
      if (c1 === 47) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; }
      if (c1 === 42) {
        i += 2;
        while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) i++;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    if (c === 40 || c === 91 || c === 123) { d++; i++; continue; }
    if (c === 41 || c === 93 || c === 125) { if (d > 0) d--; i++; continue; }
    if (c === 59 && d === 0) { semis.push(i); i++; continue; }
    i++;
  }
  return semis;
}

// splitChunks(src, target=65536) -> [{start, end}] half-open ranges.
// Chunks overlap by the boundary `;`: chunk[j].end-1 === chunk[j+1].start.
function splitChunks(src, target) {
  target = target || 65536;
  const semis = depthZeroSemis(src);
  const n = src.length;
  if (semis.length === 0) return [{ start: 0, end: n }];

  const chunks = [];
  let start = 0;
  for (let b = 0; b < semis.length; b++) {
    const end = semis[b] + 1; // include the `;`
    if (end - start >= target) {
      chunks.push({ start, end });
      start = semis[b]; // next chunk STARTS at the `;` (overlap)
    }
  }
  if (start < n) chunks.push({ start, end: n });
  if (chunks.length === 0) return [{ start: 0, end: n }];
  return chunks;
}

// ---------------------------------------------------------------------------
// Worker pool + synchronous dispatch over SharedArrayBuffer.
//
// Slot region layout inside the SAB (cap bytes per slot, cap % 4 === 0):
//   [0] Int32 state     — dispatch id on success, STATE_ERR / STATE_OVERFLOW
//   [1] Int32 byteLen   — payload bytes that follow
//   [8] payload         — i32 chunkCount, then per chunk:
//                         i32 codeByteLen, i32 tokens, i32 removed, UTF-8
//
// Worker: payload -> byteLen (plain) -> Atomics.store(state, id) -> notify.
// Main   : Atomics.wait(state) -> decode region. No event-loop dependency.
// ---------------------------------------------------------------------------

function poolSize() {
  // HP64_POOL overrides the core count (benchmark tuning: a 2-core/4-HT box
  // often does better with one worker per PHYSICAL core).
  const override = Number(process.env.HP64_POOL);
  const n = override >= 1 ? override
    : (os.availableParallelism ? os.availableParallelism() : os.cpus().length);
  return Math.max(1, n);
}

let POOL = null; // { workers, size, seq, dead, cleanExit, sab, cap, states }

function destroyPool() {
  if (!POOL) return;
  POOL.cleanExit = true;
  for (const w of POOL.workers) {
    try { w.terminate(); } catch (_) { /* already gone */ }
  }
  POOL = null;
}

// (Re)allocate the shared buffer when a dispatch needs bigger slot regions.
// Layout: [slot 0 region][slot 1 region]...[completion counter (1 i32)].
// The counter is MONOTONIC across dispatches (workers increment, never reset),
// so a late worker from an older dispatch can't corrupt the current one.
function sabFor(pool, maxPartLen) {
  const need = Math.max(65536, maxPartLen * 4 + 65536) & ~3;
  if (!pool.sab || pool.cap < need) {
    pool.cap = need;
    pool.sab = new SharedArrayBuffer(pool.cap * pool.size + 4);
    pool.states = new Int32Array(pool.sab);
    pool.doneIdx = (pool.cap * pool.size) >> 2;
  }
  return pool.sab;
}

// Block until ALL workers have incremented the shared completion counter to
// `target`. One Atomics.wait/wake-up per dispatch (not one per slot).
// Returns true on completion, false on timeout.
function awaitAll(pool, target, deadline) {
  const done = pool.doneIdx;
  const states = pool.states;
  for (;;) {
    const v = Atomics.load(states, done);
    if (v >= target) return true;
    if (Date.now() >= deadline) return false;
    Atomics.wait(states, done, v, Math.max(1, deadline - Date.now()));
  }
}

function ensurePool() {
  if (POOL && !POOL.dead) return POOL;
  destroyPool();

  const P = poolSize();
  const p = { workers: [], size: P, seq: 0, dead: false, cleanExit: false, sab: null, cap: 0, states: null, doneIdx: 0 };
  for (let i = 0; i < P; i++) {
    const w = new Worker(path.join(__dirname, "CompilerWorker.js"), { workerData: { slot: i } });
    w.unref(); // pool must not keep the process alive after compiles finish
    w.on("error", (e) => {
      console.error("hp64 worker error:", (e && e.message) || e);
      if (POOL === p) p.dead = true;
    });
    w.on("exit", () => {
      if (POOL === p && !p.cleanExit) p.dead = true;
    });
    p.workers.push(w);
  }
  POOL = p;

  // Warmup: every worker must start and answer before any real dispatch —
  // turns "worker never started" from a 15s timeout into a fast failure.
  const warm = sabFor(p, 16);
  const wid = ++p.seq;
  const target = Atomics.load(p.states, p.doneIdx) + P;
  for (let i = 0; i < P; i++) {
    p.workers[i].postMessage({
      id: wid, chunks: ["let __hp64_warm = 1;\n"], buf: warm, cap: p.cap, done: warm, doneIdx: p.doneIdx,
    });
  }
  const dl = Date.now() + WARMUP_TIMEOUT_MS;
  if (!awaitAll(p, target, dl)) {
    destroyPool();
    throw new Error("worker warmup timed out");
  }
  for (let i = 0; i < P; i++) {
    const st = Atomics.load(p.states, (i * p.cap) >> 2);
    if (st !== wid) {
      destroyPool();
      throw new Error("worker " + i + " warmup failed (state " + st + ")");
    }
  }
  return p;
}

function regionResults(pool, slot, byteLen) {
  const dataOff = slot * pool.cap;
  const bytes = new Uint8Array(pool.sab, dataOff + 8, byteLen);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, byteLen);
  const count = dv.getInt32(0, true);
  const dec = new TextDecoder();
  const out = new Array(count);
  let o = 4;
  for (let i = 0; i < count; i++) {
    const codeLen = dv.getInt32(o, true);
    const tokens = dv.getInt32(o + 4, true);
    const removed = dv.getInt32(o + 8, true);
    o += 12;
    out[i] = { code: dec.decode(bytes.subarray(o, o + codeLen)), stats: { tokens, removed } };
    o += codeLen;
  }
  return out;
}

// compileParallel(parts) -> { code, stats, chunks, parallel } | null.
// parts are chunk SOURCE STRINGS; jobs are dealt round-robin across the pool.
function compileParallel(parts) {
  let pool;
  try {
    pool = ensurePool();
  } catch (e) {
    console.error("hp64: worker pool unavailable, serial fallback:", e.message);
    return null;
  }

  const K = parts.length;
  const P = Math.min(pool.size, K);
  const id = ++pool.seq;
  let maxLen = 0;
  for (let j = 0; j < K; j++) if (parts[j].length > maxLen) maxLen = parts[j].length;
  const sab = sabFor(pool, maxLen);
  const cap = pool.cap;
  const target = Atomics.load(pool.states, pool.doneIdx) + P;

  try {
    for (let i = 0; i < P; i++) {
      const job = [];
      for (let j = i; j < K; j += P) job.push(parts[j]);
      pool.workers[i].postMessage({ id, chunks: job, buf: sab, cap, done: sab, doneIdx: pool.doneIdx });
    }
  } catch (_) {
    destroyPool();
    return null;
  }

  const deadline = Date.now() + DISPATCH_TIMEOUT_MS;
  if (!awaitAll(pool, target, deadline)) {
    destroyPool();
    return null; // wedged worker -> serial fallback
  }
  const results = new Array(K);
  for (let i = 0; i < P; i++) {
    const idx = (i * cap) >> 2;
    const st = Atomics.load(pool.states, idx);
    const byteLen = Atomics.load(pool.states, idx + 1);
    if (st === STATE_ERR) {
      console.error("hp64: worker compile error:\n" +
        new TextDecoder().decode(new Uint8Array(sab, i * cap + 8, byteLen)));
      destroyPool();
      return null;
    }
    if (st === STATE_OVERFLOW) return null; // serial fallback, keep pool
    if (st !== id) { destroyPool(); return null; }
    const rs = regionResults(pool, i, byteLen);
    for (let q = 0; q < rs.length; q++) results[i + q * P] = rs[q];
  }

  let code = "";
  let tokens = 0, removed = 0;
  for (let j = 0; j < K; j++) {
    const r = results[j];
    if (!r) { destroyPool(); return null; }
    code += j === 0 ? r.code : r.code.substring(1); // drop the overlapping `;`
    tokens += r.stats.tokens;
    removed += r.stats.removed;
  }
  return {
    code,
    stats: { tokens: tokens - 2 * (K - 1), removed },
    chunks: K,
    parallel: true,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

// compileChunked(src, opts) -> { code, stats, chunks } — same shape as
// compile(), so callers can swap freely.
//   opts.target      : split target bytes (harness; also used by parallel)
//   opts.parallel    : false to force serial
//   opts.minParallel : size threshold override (harness forces parallel)
function compileChunked(src, opts) {
  opts = opts || {};
  const minParallel = opts.minParallel != null ? opts.minParallel : PARALLEL_MIN;

  // ---- parallel path ----
  if (opts.parallel !== false && !POOL_DISABLED && src.length >= minParallel) {
    const P = poolSize();
    // aim for ~one chunk per core; never smaller than 16KB so dispatch
    // overhead stays a rounding error against the compile itself
    const target = opts.target || Math.max(16384, Math.ceil(src.length / P));
    const ranges = splitChunks(src, target);
    if (ranges.length > 1) {
      const parts = new Array(ranges.length);
      for (let j = 0; j < ranges.length; j++) {
        parts[j] = src.substring(ranges[j].start, ranges[j].end);
      }
      const r = compileParallel(parts);
      if (r) return r;
      // fall through to serial on any pool failure
    }
  }

  // ---- serial path ----
  const chunks = splitChunks(src, opts.target || 65536);
  if (chunks.length === 1) {
    const r = compile(src, opts);
    r.chunks = 1;
    return r;
  }
  let code = "";
  let tokens = 0, removed = 0;
  for (let j = 0; j < chunks.length; j++) {
    const c = src.substring(chunks[j].start, chunks[j].end);
    const r = compile(c, opts);
    tokens += r.stats.tokens;
    removed += r.stats.removed;
    code += j === 0 ? r.code : r.code.substring(1); // drop the overlapping `;`
  }
  const K = chunks.length;
  return {
    code,
    stats: { tokens: tokens - 2 * (K - 1), removed },
    chunks: K,
  };
}

module.exports = {
  splitChunks, depthZeroSemis, compileChunked,
  destroyPool, PARALLEL_MIN,
};
