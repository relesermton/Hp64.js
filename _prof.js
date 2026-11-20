"use strict";
// _prof.js - aggregate a .cpuprofile: self-time per function (top 30).
const fs = require("fs");
const path = require("path");

const file = process.argv[2] ||
  (fs.readdirSync(__dirname).filter(f => f.endsWith(".cpuprofile"))
    .map(f => ({ f, t: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)[0] || {}).f;
if (!file) { console.log("no .cpuprofile found"); process.exit(1); }
const p = JSON.parse(fs.readFileSync(path.join(__dirname, file), "utf8"));

const interval = p.timeDeltas && p.samples
  ? p.timeDeltas.reduce((a, b) => a + b, 0) / p.timeDeltas.length
  : 1000; // µs

const nodes = new Map();
for (const nd of p.nodes) nodes.set(nd.id, nd);
const self = new Map();
const total = new Map();
const counts = new Map(); // per sample
for (const id of p.samples) counts.set(id, (counts.get(id) || 0) + 1);
for (const [id, c] of counts) {
  const nd = nodes.get(id);
  if (!nd) continue;
  const cf = nd.callFrame;
  const key = `${cf.functionName || "(anonymous)"} ${cf.url.replace(/^file:\/\//, "").split(/[\\/]/).pop() || ""}:${cf.lineNumber + 1}`;
  self.set(key, (self.get(key) || 0) + c);
}
// total (self + children) via tree walk
const childrenOf = new Map();
for (const nd of p.nodes) {
  if (nd.children) for (const c of nd.children) childrenOf.set(c, nd.id);
}
for (const [id, c] of counts) {
  let cur = id;
  while (cur !== undefined) {
    const nd = nodes.get(cur);
    if (!nd) break;
    total.set(nd.id, (total.get(nd.id) || 0) + c);
    cur = childrenOf.get(nd.id);
  }
}

const ms = (c) => (c * interval / 1000).toFixed(1);
const sum = [...self.values()].reduce((a, b) => a + b, 0);
console.log(`samples=${sum} interval=${interval}µs  (${(sum * interval / 1e6).toFixed(1)}s total)\n`);
console.log("== self time ==");
[...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).forEach(([k, v]) =>
  console.log(`${ms(v).padStart(8)}ms ${(v / sum * 100).toFixed(1).padStart(5)}%  ${k}`));
console.log("\n== total time (incl. children) ==");
[...total.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20).forEach(([id, v]) => {
  const nd = nodes.get(id);
  const cf = nd.callFrame;
  console.log(`${ms(v).padStart(8)}ms ${(v / sum * 100).toFixed(1).padStart(5)}%  ${cf.functionName || "(anon)"} ${cf.url.replace(/^file:\/\//, "").split(/[\\/]/).pop() || ""}:${cf.lineNumber + 1}`);
});
