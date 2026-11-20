"use strict";
// ThreadCore.js - persistent worker pool for HP64.js builds.
// Idea from Hd5.js (relesermton/Hd5.js): spawn workers lazily ONCE, keep them
// alive across builds, dispatch jobs round-robin, and unref while idle so the
// process can exit naturally. Replaces the old fresh-Worker-per-build chunks.

const { Worker, isMainThread, parentPort } = require("worker_threads");
const os = require("os");
const fs = require("fs");
const { compile } = require("./Compiler.js");

// SEA single-executable: the exe cannot re-spawn itself as a worker,
// so parallel builds fall back to inline compilation.
function isSEA() {
  try { return require("node:sea").isSea(); } catch { return false; }
}

if (!isMainThread && parentPort) {
  // worker loop: { id, file } -> { id, ok, result | error }
  parentPort.on("message", (job) => {
    try {
      const src = fs.readFileSync(job.file, "utf8");
      const t0 = performance.now();
      const { code, stats } = compile(src, { filename: job.file });
      parentPort.postMessage({
        id: job.id,
        ok: true,
        result: { file: job.file, code, stats, ms: +(performance.now() - t0).toFixed(2) },
      });
    } catch (error) {
      parentPort.postMessage({ id: job.id, ok: false, error: error.message, stack: error.stack });
    }
  });
}

class ThreadPool {
  constructor(size) {
    this.size = Math.max(1, size | 0);
    this.workers = [];
    this.next = 0;
    this.pending = new Map(); // id -> { resolve, reject, w }
    this.sequence = 0;
    this.closed = false;
  }

  spawn() {
    const w = new Worker(__filename);
    w.unref(); // idle workers must not keep the process alive
    w.on("message", (msg) => this.onMessage(w, msg));
    w.on("error", (err) => this.onCrash(w, err));
    w.on("exit", (code) => { if (code !== 0) this.onCrash(w, new Error("worker exited " + code)); });
    this.workers.push(w);
    return w;
  }

  getWorker() {
    if (this.closed) throw new Error("pool closed");
    if (this.workers.length < this.size) return this.spawn();
    const w = this.workers[this.next % this.workers.length];
    this.next++;
    return w;
  }

  dispatch(file) {
    const id = ++this.sequence;
    const w = this.getWorker();
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, w });
      w.ref(); // keep alive while jobs are in flight
      w.postMessage({ id, file });
    });
  }

  onMessage(w, msg) {
    const entry = this.pending.get(msg.id);
    if (!entry) return;
    this.pending.delete(msg.id);
    if (msg.ok) entry.resolve(msg.result);
    else {
      const err = new Error(msg.error);
      if (msg.stack) err.stack = msg.stack;
      entry.reject(err);
    }
    if (this.pending.size === 0) for (const worker of this.workers) worker.unref();
  }

  onCrash(w, err) {
    for (const [id, entry] of this.pending) {
      if (entry.w === w) { this.pending.delete(id); entry.reject(err); }
    }
    const idx = this.workers.indexOf(w);
    if (idx >= 0) this.workers.splice(idx, 1);
    try { w.terminate(); } catch { /* already dead */ }
    if (this.pending.size === 0) for (const worker of this.workers) worker.unref();
  }

  close() {
    this.closed = true;
    for (const [, entry] of this.pending) entry.reject(new Error("pool closed"));
    this.pending.clear();
    for (const w of this.workers) w.terminate();
    this.workers = [];
  }
}

// shared singleton pool (reused across builds in one process)
let shared = null;
function getPool(size) {
  if (!shared || shared.closed) shared = new ThreadPool(size);
  else shared.size = Math.max(shared.size, size); // grow lazily on demand
  return shared;
}

function inlineCompile(files) {
  const results = files.map((f) => {
    const src = fs.readFileSync(f, "utf8");
    const t0 = performance.now();
    const { code, stats } = compile(src, { filename: f });
    return { file: f, code, stats, ms: +(performance.now() - t0).toFixed(2) };
  });
  return { results, workers: 0, inline: true };
}

/**
 * compileFiles(files, opts) -> Promise<{ results, workers, ms, inline? }>
 * results preserve input order. Falls back to inline when: SEA exe,
 * opts.inline, or 0 files.
 */
function compileFiles(files, opts = {}) {
  const t0 = performance.now();
  if (!files.length) return Promise.resolve({ results: [], workers: 0, ms: 0 });
  if (isSEA() || opts.inline) {
    const r = inlineCompile(files);
    return Promise.resolve({ ...r, ms: +(performance.now() - t0).toFixed(2) });
  }
  const maxWorkers = Math.max(1, Math.min(opts.maxWorkers || os.cpus().length - 1, files.length));
  const pool = getPool(maxWorkers);
  return Promise.all(files.map((f) => pool.dispatch(f))).then((results) => ({
    results,
    workers: Math.min(pool.size, files.length),
    ms: +(performance.now() - t0).toFixed(2),
  }));
}

module.exports = { ThreadPool, getPool, compileFiles, isSEA };
