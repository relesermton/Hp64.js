"use strict";
// _split.js - timed split: tokenize / (bracketMap+classify) / emit
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
compile(src); compile(src); // warmup (no timers)
global.__HP64_PROF = { tok: 0, bm: 0, fill: 0, pre: 0, cls: 0, emit: 0 };
if (process.argv[3] === "cnt") global.__HP64_CNT = true;
const N = Number(process.argv[2] || 20);
for (let i = 0; i < N; i++) compile(src);
const p = global.__HP64_PROF;
global.__HP64_PROF = null;
global.__HP64_CNT = false;
console.log(`tokenize:            ${(p.tok / N).toFixed(2)} ms`);
console.log(`bracketMap:          ${(p.bm / N).toFixed(2)} ms`);
console.log(`fills:               ${(p.fill / N).toFixed(2)} ms`);
console.log(`candidate prepass:   ${(p.pre / N).toFixed(2)} ms`);
console.log(`classify loop:       ${(p.cls / N).toFixed(2)} ms`);
console.log(`emit:                ${(p.emit / N).toFixed(2)} ms`);
console.log(`sum:                 ${((p.tok + p.bm + p.fill + p.pre + p.cls + p.emit) / N).toFixed(2)} ms`);
if (p.cnt) {
  const c = p.cnt;
  console.log(`\ncounts (last compile):`);
  console.log(`  candidates:      ${c.cn}`);
  console.log(`  isTernaryBefore: ${c.ternC} calls / ${c.ternS} steps`);
  console.log(`  isVarDeclBefore: ${c.varC} calls / ${c.varS} steps`);
  console.log(`  isParamList:     ${c.paramC} calls`);
  console.log(`  skipType steps:  ${c.skipS}`);
  console.log(`  stmtEnd steps:   ${c.stmtS}`);
  const names = { 1: "IMPORT_EXPORT_TYPE", 2: "DECL", 3: "ABSTRACT_CLASS", 5: "IMPLEMENTS", 6: "PARAMS", 7: "RETURN_OR_VAR", 8: "AS", 9: "NOTNULL", 10: "MODIFIER", 11: "OPT_MEMBER", 12: "IMPORT_EXPORT_BRACES", 13: "MEMBER_TYPE" };
  const ks = Object.keys(c.kind).sort((a, b) => c.kind[b] - c.kind[a]);
  for (const k of ks) console.log(`  kind ${names[k] || k}: ${c.kind[k]}`);
}
