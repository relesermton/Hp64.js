"use strict";
// Builder.js - standard build pipeline:
// Config.pak -> graph (Town.js) -> parallel compile (MultiThreadingBuild.js)
// -> link (Bundler.js) -> dist/out.js

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Town = require("./Town.js");
const { bundle, resolve, findImports } = require("./Bundler.js");
const { buildInParallel } = require("./MultiThreadingBuild.js");

function loadConfig(cwd) {
  const pak = path.join(cwd, "Config.pak");
  if (!fs.existsSync(pak)) return { out: "dist/out.js", threads: 0, minify: false };
  const raw = fs.readFileSync(pak, "utf8").replace(/^#HP64-PAK\d*\n/, "");
  try { return JSON.parse(raw); } catch { return { out: "dist/out.js" }; }
}

function hash(s) { return crypto.createHash("sha1").update(s).digest("hex"); }

/**
 * build(entry, opts) -> { code, out, stats }
 */
async function build(entry, opts = {}) {
  const cwd = opts.cwd || process.cwd();
  const cfg = loadConfig(cwd);
  const t0 = performance.now();
  const town = new Town();

  // 1. walk graph
  const files = [];
  const seen = new Set();
  const queue = [path.resolve(entry)];
  while (queue.length) {
    const f = queue.shift();
    if (seen.has(f)) continue;
    seen.add(f);
    const src = fs.readFileSync(f, "utf8");
    const specs = findImports(src);
    const deps = [];
    for (const spec of specs) {
      const r = resolve(spec, path.dirname(f));
      if (r) { deps.push({ spec, id: r, external: false }); queue.push(r); }
      else deps.push({ spec, id: null, external: true });
    }
    town.build(f, { deps, external: deps.filter(d => d.external).map(d => d.spec) });
    if (!town.reuse(f, hash(src))) files.push(f);
    town.clean(f);
  }

  // 2. parallel compile of changed files (cache-aware)
  const useThreads = opts.threads ?? cfg.threads ?? 0;
  let compileMs = 0;
  if (files.length && useThreads !== 1) {
    const r = await buildInParallel(files, { maxWorkers: useThreads || undefined });
    compileMs = r.ms;
  } else {
    const t = performance.now();
    const { compile } = require("./Compiler.js");
    for (const f of files) compile(fs.readFileSync(f, "utf8"), { filename: f });
    compileMs = +(performance.now() - t).toFixed(2);
  }

  // 3. link
  const { code, stats } = bundle(entry, opts);
  const out = opts.out || cfg.out || "dist/out.js";
  const outAbs = path.resolve(cwd, out);
  fs.mkdirSync(path.dirname(outAbs), { recursive: true });
  fs.writeFileSync(outAbs, code);

  return {
    out: outAbs,
    code,
    stats: {
      ...stats, ...town.stats(),
      compileMs, totalMs: +(performance.now() - t0).toFixed(2),
      threads: useThreads
    }
  };
}

module.exports = { build, loadConfig };
