"use strict";
// MultiThreadingBuildFullcode.js - parallel pre-compile stage for the
// fullcode pipeline, backed by the persistent pool in ThreadCore.js
// (idea from Hd5.js): workers stay alive across builds. The main thread
// concatenates results and runs the final fullcode link pass.

const os = require("os");
const { compileFiles, isSEA } = require("./ThreadCore.js");

/**
 * buildFullcodeInParallel(files, opts) -> Promise<{ results, workers, ms, inline? }>
 * results preserve input order (dependency order matters for the flat
 * fullcode link step, so the caller passes files already sorted).
 */
async function buildFullcodeInParallel(files, opts = {}) {
  const t0 = performance.now();
  const out = await compileFiles(files, opts);
  return {
    results: out.results,
    workers: out.inline ? 0 : out.workers,
    inline: !!out.inline,
    ms: +(performance.now() - t0).toFixed(2),
  };
}

module.exports = { buildFullcodeInParallel, isSEA, maxWorkers: () => Math.max(1, os.cpus().length - 1) };
