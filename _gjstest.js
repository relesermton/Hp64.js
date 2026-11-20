// _gjstest.js - verify dist/hp64stack.js (GopherJS-compiled compiler_Stack)
// against Compiler.js bracketMap: unit tests + fuzz + real bench tokens.
"use strict";
const fs = require("fs");
const path = require("path");

require("./dist/hp64stack.js");
const { tokenize, bracketMap } = require("./Compiler.js");

let fails = 0;
function ok(cond, msg) {
  if (!cond) { fails++; console.log("FAIL: " + msg); }
}

function eqArr(a, b, msg) {
  if (a.length !== b.length) { fails++; console.log("FAIL(len): " + msg + " " + a.length + " vs " + b.length); return; }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) { fails++; console.log("FAIL(" + msg + ") @" + i + ": " + a[i] + " vs " + b[i]); return; }
  }
}

function waitReady(cb, tries) {
  const hp = globalThis.hp64Stack;
  if (hp && hp.ready) return cb(hp);
  if (tries <= 0) { console.log("FAIL: hp64Stack never became ready"); process.exit(1); }
  setImmediate(() => waitReady(cb, tries - 1));
}

waitReady((hp) => {
  // ---- unit: ( [ ] ) ----
  const r = hp.matchBrackets(new Int32Array([40, 91, 93, 41]));
  eqArr(Array.from(r.close), [3, 2, -1, -1], "unit close");
  eqArr(Array.from(r.open), [-1, -1, 1, 0], "unit open");
  eqArr(Array.from(r.sd), [0, 1, 2, 1], "unit sd");

  // ---- unit: stack ops ----
  const id = hp.newStack(8);
  ok(hp.stackPush(id, 1) === 0, "push1");
  ok(hp.stackPush(id, 2) === 0, "push2");
  ok(hp.stackPush(id, 3) === 0, "push3");
  ok(hp.stackDepth(id) === 3, "depth 3");
  ok(hp.stackPop(id) === 3, "pop 3");
  ok(hp.stackPop(id) === 2, "pop 2");
  ok(hp.stackPop(id) === 1, "pop 1");
  ok(hp.stackPop(id) === -1, "pop empty");
  hp.stackClear(id);
  hp.stackPush(id, 7);
  ok(hp.stackPeek(id) === 7, "peek 7");
  ok(hp.stackDepth(id) === 1, "depth 1 after clear+push");
  const small = hp.newStack(1);
  ok(hp.stackPush(small, 1) === 0, "small push ok");
  ok(hp.stackPush(small, 2) === 1, "overflow returns 1");

  // ---- unit: span ----
  const br = hp.matchBrackets(new Int32Array([40, 41]));
  const sp = hp.span(0, br);
  ok(sp && sp.start === 0 && sp.end === 1, "span matched");
  ok(hp.span(1, br) === null, "span unmatched -> null");

  // ---- fuzz vs bracketMap ----
  const BR = [40, 41, 91, 93, 123, 125];
  let seed = 12345;
  function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
  for (let t = 0; t < 500; t++) {
    const n = 1 + Math.floor(rnd() * 200);
    const tv = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      const r = rnd();
      if (r < 0.55) tv[i] = BR[Math.floor(rnd() * BR.length)];
      else if (r < 0.8) tv[i] = 33 + Math.floor(rnd() * 90); // random punct codes
      else tv[i] = 256 + Math.floor(rnd() * 80);             // keyword codes
    }
    const g = hp.matchBrackets(tv);
    const j = bracketMap({ n, tv });
    eqArr(Array.from(g.close), Array.from(j.close.subarray(0, n)), "fuzz close #" + t);
    eqArr(Array.from(g.open), Array.from(j.open.subarray(0, n)), "fuzz open #" + t);
    eqArr(Array.from(g.sd), Array.from(j.sd.subarray(0, n)), "fuzz sd #" + t);
  }

  // ---- real data: bench/app.ts + demo sources ----
  const files = ["bench/app.ts", "demo/main.ts", "demo/util.ts", "Compiler.js", "Bundler.js"];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, f), "utf8");
    const T = tokenize(src);
    const tv = T.tv.subarray(0, T.n);
    const g = hp.matchBrackets(tv);
    const j = bracketMap(T);
    eqArr(Array.from(g.close), Array.from(j.close.subarray(0, T.n)), f + " close");
    eqArr(Array.from(g.open), Array.from(j.open.subarray(0, T.n)), f + " open");
    eqArr(Array.from(g.sd), Array.from(j.sd.subarray(0, T.n)), f + " sd");
  }

  if (fails === 0) console.log("GJS: all tests passed (unit + 500 fuzz + 5 real files)");
  else { console.log(fails + " FAILURES"); process.exit(1); }
}, 200);
