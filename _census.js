"use strict";
// _census.js - where do the source chars and tokens go?
const fs = require("fs");
const { tokenize } = require("./Compiler.js");
const src = fs.readFileSync("bench/app.ts", "utf8");
const T = tokenize(src);
const n = T.n, tt = T.tt, ts = T.ts, te = T.te, tv = T.tv;

let ws = 0, nl = 0, cmt = 0;
let idChars = 0, strChars = 0, numChars = 0, tplChars = 0, pChars = 0, other = 0;
const kinds = [0, 0, 0, 0, 0, 0];
let prevEnd = 0;
const IDKW = 0, IDPLAIN = 1;
let kwIds = 0, plainIds = 0;
for (let i = 0; i < n; i++) {
  const k = tt[i];
  kinds[k]++;
  const gap = ts[i] - prevEnd;
  if (gap > 0) {
    // count whitespace vs comments in the gap
    let j = prevEnd;
    while (j < ts[i]) {
      const c = src.charCodeAt(j);
      if (c === 32 || c === 9 || c === 13 || c === 10) { ws++; if (c === 10) nl++; j++; }
      else if (c === 47 && src.charCodeAt(j + 1) === 47) { while (j < ts[i] && src.charCodeAt(j) !== 10) { cmt++; j++; } }
      else if (c === 47 && src.charCodeAt(j + 1) === 42) { while (j < ts[i] && !(src.charCodeAt(j) === 42 && src.charCodeAt(j + 1) === 47)) { if (src.charCodeAt(j) === 10) nl++; cmt++; j++; } j += 2; }
      else { other++; j++; }
    }
  }
  const len = te[i] - ts[i];
  if (k === 1) { idChars += len; if (tv[i] >= 256) kwIds++; else plainIds++; }
  else if (k === 2) pChars += len;
  else if (k === 3) strChars += len;
  else if (k === 4) numChars += len;
  else if (k === 5) tplChars += len;
  prevEnd = te[i];
}
ws += src.length - prevEnd;
console.log(`src=${src.length} tokens=${n}`);
console.log(`kinds: eof=${kinds[0]} id=${kinds[1]} punct=${kinds[2]} str=${kinds[3]} num=${kinds[4]} tpl=${kinds[5]}`);
console.log(`ids: keyword=${kwIds} plain=${plainIds}`);
console.log(`chars: id=${idChars} punct=${pChars} str=${strChars} num=${numChars} tpl=${tplChars} ws=${ws} (nl=${nl}) comments=${cmt} other-gap=${other}`);
