"use strict";
// FullcodeBuilder.js - fullcode build pipeline:
// parallel pre-compile (MultiThreadingBuildFullcode.js)
// -> flat single-scope link (FullcoddeBundler.js) -> dist/fullcode.js

const fs = require("fs");
const path = require("path");
const { bundleFull } = require("./FullcoddeBundler.js");
const { buildFullcodeInParallel } = require("./MultiThreadingBuildFullcode.js");
const { resolve, findImports } = require("./Bundler.js");
const { loadConfig } = require("./Builder.js");

/**
 * buildFull(entry, opts) -> { code, out, stats }
 * Pre-compiles every file in the graph on worker threads (parallel TS strip),
 * then runs the flat fullcode link pass on the main thread.
 */
async function buildFull(entry, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const cfg = loadConfig(cwd);
  const t0 = performance.now();

  // collect graph
  const files = [];
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    files.push(f);
    for (const spec of findImports(fs.readFileSync(f, "utf8"))) {
      const r = resolve(spec, path.dirname(f));
      if (r) queue.push(r);
    }
  }

  // parallel TS strip pass
  const r = await buildFullcodeInParallel(files, { maxWorkers: opts.threads || undefined });

  // flat link pass (bundleFull re-reads sources; stripped cache reused via results map)
  const stripped = new Map(r.results.map(x => [x.file, x.code]));
  const { code, stats } = bundleFull(entry, { stripped });

  const out = opts.out || cfg.fullcodeOut || "dist/fullcode.js";
  const outAbs = path.resolve(cwd, out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, code);

  return {
    out: outAbs,
    code,
    stats: {
      ...stats,
      files: files.length,
      workers: r.workers,
      parallelMs: r.ms,
      totalMs: +(performance.now() - t0).toFixed(2)
    }
  };
}

module.exports = { buildFull };
