"use strict";
// _stages.js - split compile() time into tokenize / bracketMap / classify+emit.
const fs = require("fs");
const path = require("path");
const { compile, tokenize, bracketMap } = require("./Compiler.js");
const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const N = Number(process.argv[2] || 20);

function med(fn) {
  fn(); fn(); // warmup
  const t = [];
  for (let i = 0; i < N; i++) {
    const t0 = performance.now();
    fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  return t[Math.floor(t.length / 2)];
}

// warm scratch stores exactly like compile() uses them
const ST = { cap: 0, tt: null, ts: null, te: null, tl: null, tv: null };
const BK = { cap: 0, close: null, open: null, sd: null, stack: null };
const tokT = med(() => tokenize(src, ST));
const T = tokenize(src, ST);
const bmT = med(() => bracketMap(T, BK));
const allT = med(() => compile(src));
const rest = Math.max(0, allT - tokT - bmT);
console.log(`tokenize:      ${tokT.toFixed(2)} ms`);
console.log(`bracketMap:    ${bmT.toFixed(2)} ms`);
console.log(`classify+emit: ${rest.toFixed(2)} ms`);
console.log(`compile total: ${allT.toFixed(2)} ms`);
