"use strict";
// _chunktest.js - chunked-vs-full consistency gate.
// For every corpus file and several chunk targets: compileChunked output must
// be BYTE-IDENTICAL to compile(), with equal stats (tokens after the
// 2*(K-1) correction, removed as-is).
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const { splitChunks, compileChunked } = require("./Chunked.js");

const DIR = __dirname;

// ---- corpus: real files ----
const corpus = [];
function addFile(p) {
  const abs = path.join(DIR, p);
  if (fs.existsSync(abs)) corpus.push({ name: p, src: fs.readFileSync(abs, "utf8") });
}
addFile("bench/app.ts");
addFile("demo/main.ts");
addFile("demo/util.ts");
for (const f of fs.readdirSync(DIR)) {
  if (f.endsWith(".js") && fs.statSync(path.join(DIR, f)).isFile()) addFile(f);
}

// ---- corpus: synthetic edge cases (target the boundary-`;` traps) ----
const synth = [
  ["bodyless sig", "declare function f(a: number): void;\nlet x = 1;"],
  ["overload sig", "function f(a: string): string;\nfunction f(a: any): any { return a; }\nlet y = 2;"],
  ["abstract member", "abstract class A { abstract m(): void; abstract p: number; }\nlet z = 3;"],
  ["double semi", "let a = 1;;let b = 2;"],
  ["for-semicolons", "for (let i = 0; i < 10; i++) { f(i); }\nlet c = 4;"],
  ["semi in string", 'let s = "a;b{c}d";\nlet d = 5;'],
  ["semi in template", "let t = `x;${1 + 2}y`;\nlet e = 6;"],
  ["semi in comment", "// ; { ] \nlet g = 7; /* ; */ let h = 8;"],
  ["nested template", "let q = `a${`b${`c;`}d`}e`;\nlet i2 = 9;"],
  ["export braces", "export { type A, B } from './x';\nexport const k = 10;"],
  ["import type", "import type { T } from './t';\nimport { a, type B } from './m';\nlet j = 11;"],
  ["iface + type", "interface I { a: number; b?: string }\ntype T = { c: boolean };\nlet l = 12;"],
  ["enum + const enum", "enum E { A, B }\nconst enum CE { X = 1 }\nlet m = 13;"],
  ["class body semis", "class C { f(): void { return; } g = 1; }\nlet n = 14;"],
  ["ternary + as", "let p = cond ? (a as string) : (b as any);\nlet r = 15;"],
  ["notnull + opt", "let u = obj!.prop;\nclass D { x!: number; y?: string; }\nlet v = 16;"],
  ["no semis at all", "let a1 = 1\nlet a2 = 2\nfunction f2(x) { return x }\n"],
  ["only semis", ";;;;;;;;"],
  ["empty", ""],
  ["unmatched braces in string", 'let w = "{"; let w2 = "}";\nlet w3 = 17;'],
  ["regex-like slash", "let re = /a;b/; let re2 = /[)}]/;\nlet w4 = 18;"],
];
for (const [name, src] of synth) corpus.push({ name: "synth:" + name, src });

// ---- run ----
const TARGETS = [100, 1000, 16384, 65536];
let fails = 0, checks = 0;
const chunkCounts = new Set();

function compare(label, name, full, r) {
  checks++;
  if (r.code !== full.code) {
    fails++;
    console.log("FAIL code " + label + " " + name + " (chunks=" + r.chunks +
      ") full=" + full.code.length + "B out=" + r.code.length + "B");
    const a = full.code, b = r.code;
    let i = 0;
    while (i < a.length && i < b.length && a.charCodeAt(i) === b.charCodeAt(i)) i++;
    console.log("  first diff @" + i + ": full=" + JSON.stringify(a.slice(Math.max(0, i - 40), i + 40)) +
      " out=" + JSON.stringify(b.slice(Math.max(0, i - 40), i + 40)));
  } else if (r.stats.tokens !== full.stats.tokens || r.stats.removed !== full.stats.removed) {
    fails++;
    console.log("FAIL stats " + label + " " + name + " tokens " +
      r.stats.tokens + " vs " + full.stats.tokens + ", removed " +
      r.stats.removed + " vs " + full.stats.removed);
  }
}

for (const { name, src } of corpus) {
  const full = compile(src);
  for (const target of TARGETS) {
    const chunks = splitChunks(src, target);
    // overlap invariant: each chunk ends with `;` where the next starts
    for (let j = 0; j + 1 < chunks.length; j++) {
      const b = chunks[j].end - 1;
      if (chunks[j + 1].start !== b || src.charCodeAt(b) !== 59) {
        fails++;
        console.log("FAIL overlap " + name + " t=" + target + " @" + j);
        break;
      }
    }
    const r = compileChunked(src, { target, parallel: false });
    chunkCounts.add(r.chunks);
    compare("serial t=" + target, name, full, r);
  }
  // ---- parallel-forced: tiny target makes even small inputs multi-chunk,
  //      exercising the worker pool, round-robin deal and assembly ----
  const pr = compileChunked(src, { target: 64, minParallel: 0, parallel: true });
  if (pr.parallel) chunkCounts.add("p" + pr.chunks);
  compare("parallel t=64", name, full, pr);
}

// ---- report ----
const bench = corpus.find(c => c.name === "bench/app.ts");
if (bench) {
  const info = TARGETS.map(t => t + "B:" + splitChunks(bench.src, t).length + "chunks").join(" ");
  console.log("bench/app.ts -> " + info);
}
console.log(corpus.length + " inputs x (" + TARGETS.length + " serial targets + 1 parallel) = " +
  checks + " checks, " + chunkCounts.size + " distinct chunk counts");
if (fails === 0) console.log("CHUNK: all consistency checks passed");
else { console.log(fails + " FAILURES"); process.exit(1); }
