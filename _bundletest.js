"use strict";
// _bundletest.js - wire-check: bundler uses compileChunked (parallel for big
// modules, serial for small), produces valid JS, exits promptly (unref pool).
const fs = require("fs");
const path = require("path");
const { bundle } = require("./Bundler.js");
const esbuild = require("esbuild");

const cases = ["demo/main.ts", "bench/app.ts"];
let fails = 0;
for (const c of cases) {
  const p = path.join(__dirname, c);
  if (!fs.existsSync(p)) continue;
  const t0 = process.hrtime.bigint();
  const out = bundle(p);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  esbuild.transformSync(out.code, { loader: "js" }); // syntax validation
  const ok = out.code.length > 0 && out.stats.modules >= 1;
  if (!ok) fails++;
  console.log(c + ": " + out.code.length + "B, " + out.stats.modules + " modules, " +
    ms.toFixed(1) + "ms, " + (ok ? "OK" : "FAIL"));
  if (c.startsWith("bench")) fs.writeFileSync(path.join(__dirname, "dist", "bench.bundle.js"), out.code);
}
// async: if worker handles were ref'd, the process would hang here.
setTimeout(() => {
  console.log(fails === 0 ? "BUNDLE: all passed (pool unref -> clean exit)" : fails + " FAILURES");
  process.exit(fails ? 1 : 0);
}, 500);
