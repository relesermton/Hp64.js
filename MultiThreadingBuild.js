"use strict";
// MultiThreadingBuild.js - splits compile work across a PERSISTENT worker pool.
// Pool implementation lives in ThreadCore.js (idea from Hd5.js: spawn workers
// once, keep them alive across builds, dispatch round-robin). Each worker runs
// Compiler.compile on one file and returns code.

const os = require("os");
const { compileFiles, isSEA } = require("./ThreadCore.js");

/**
 * buildInParallel(files, opts) -> Promise<{ results, workers, ms, inline? }>
 * results preserve input order: [{ file, code, stats, ms }]
 * Falls back to inline compilation inside a SEA exe (cannot re-spawn workers).
 */
async function buildInParallel(files, opts = {}) {
  const t0 = performance.now();
  const out = await compileFiles(files, opts);
  return {
    results: out.results,
    workers: out.inline ? 0 : out.workers,
    inline: !!out.inline,
    ms: +(performance.now() - t0).toFixed(2),
  };
}

module.exports = { buildInParallel, isSEA, maxWorkers: () => Math.max(1, os.cpus().length - 1) };
