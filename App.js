#!/usr/bin/env node
"use strict";
// App.js - HP64.js CLI
//   node App.js build <entry.ts> [--fullcode] [--threads N] [--out file]
//   node App.js compile <file.ts>        strip TS only, print to stdout
//   node App.js bench <file.ts>          compare normal vs fullcode vs single-thread
//   node App.js selftest                 run built-in correctness tests

const fs = require("fs");
const path = require("path");
const { workerData } = require("worker_threads");

// When spawned as a worker (bundle/exe re-entry), don't run the CLI.
const isWorker = workerData && Array.isArray(workerData.files);

const [, , cmd, ...args] = process.argv;

function flag(name, fallback = undefined) {
  const i = args.indexOf("--" + name);
  if (i === -1) return fallback;
  const v = args[i + 1];
  if (v === undefined || v.startsWith("--")) return true;
  return v;
}

async function main() {
  switch (cmd) {
    case "build": {
      const entry = args.find(a => !a.startsWith("--"));
      if (!entry) throw new Error("usage: hp64 build <entry.ts>");
      const opts = {
        out: flag("out"),
        threads: flag("threads") === true ? 0 : Number(flag("threads")),
        cwd: process.cwd()
      };
      const res = flag("fullcode")
        ? await require("./FullcodeBuilder.js").buildFull(entry, opts)
        : await require("./Builder.js").build(entry, opts);
      console.log(`HP64.js -> ${res.out}`);
      console.log(`  modules=${res.stats.modules} compile=${res.stats.compileMs ?? res.stats.parallelMs}ms total=${res.stats.totalMs}ms${res.stats.fullcode ? " [fullcode]" : ""}`);
      break;
    }
    case "compile": {
      const file = args.find(a => !a.startsWith("--"));
      if (!file) throw new Error("usage: hp64 compile <file.ts>");
      const { compile } = require("./Compiler.js");
      const r = compile(fs.readFileSync(file, "utf8"), { filename: file });
      process.stdout.write(r.code);
      break;
    }
    case "bench": {
      const file = args.find(a => !a.startsWith("--"));
      if (!file) throw new Error("usage: hp64 bench <file.ts>");
      const { build } = require("./Builder.js");
      const { buildFull } = require("./FullcodeBuilder.js");
      const runs = 5;
      const t = [];
      for (let i = 0; i < runs; i++) t.push((await build(file, { threads: 0, out: "dist/_b.js" })).stats.totalMs);
      const f = [];
      for (let i = 0; i < runs; i++) f.push((await buildFull(file, { out: "dist/_f.js" })).stats.totalMs);
      const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(2);
      console.log(`normal   avg ${avg(t)}ms  (${t.map(x => x.toFixed(1)).join(", ")})`);
      console.log(`fullcode avg ${avg(f)}ms  (${f.map(x => x.toFixed(1)).join(", ")})`);
      break;
    }
    case "selftest": {
      const { compile } = require("./Compiler.js");
      const cases = [
        ["function f(a: number): number { return a; }", "function f(a) { return a; }"],
        ["const x: string = 'a';", "const x  = 'a';"],
        ["interface I { a: number }", ""],
        ["enum E { A, B = 2 }", 'const E={"A":0,"B":2}'],
        ["const y = v as string;", "const y = v  ;"],
        ["class C { private m() {} }", "class C {  m() {} }"],
        ["const a = 1; let b = a + 2;", "const a = 1; let b = a + 2;"]
      ];
      let pass = 0;
      for (const [src, want] of cases) {
        const got = compile(src).code.replace(/\s+/g, " ").trim();
        const norm = want.replace(/\s+/g, " ").trim();
        if (got === norm || (norm === "" && got === "")) pass++;
        else console.error(`FAIL\n  in:   ${src}\n  want: ${JSON.stringify(norm)}\n  got:  ${JSON.stringify(got)}`);
      }
      const ok = pass === cases.length;
      console.log(`selftest: ${pass}/${cases.length} passed`);
      process.exit(ok ? 0 : 1);
      break;
    }
    default:
      console.log("HP64.js - the fastest JS and TS compiler");
      console.log("commands: build | compile | bench | selftest");
      console.log("flags: --fullcode --threads N --out file");
  }
}

if (!isWorker) {
  main().catch(e => { console.error("HP64 error:", e.message); process.exit(1); });
}
