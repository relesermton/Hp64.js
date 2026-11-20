"use strict";
// compiler_frontend.js - HP64.js compiler front end (lexing + structure)
// Wraps the core tokenizer and bracket matcher into a single parse step.
const { tokenize } = require("./Compiler.js");
const { matchBrackets } = require("./compiler_stack.js");

// token kinds as stored in tt[] (see Compiler.js tokenize)
const T_EOF = 0, T_ID = 1, T_P = 2, T_STR = 3, T_NUM = 4, T_TPL = 5;

// parse(src) -> { src, toks, close, open, sd, length }
// toks is the flat store { n, src, tt, ts, te, tl, tv }.
function parse(src) {
  const toks = tokenize(src);
  const { close, open, sd } = matchBrackets(toks);
  return { src, toks, close, open, sd, length: toks.n };
}

// Token census for diagnostics / benchmarks.
function stats(p) {
  let ids = 0, punct = 0, strs = 0, tpls = 0, nums = 0, lines = 1;
  const toks = p.toks;
  const tt = toks.tt, tl = toks.tl, n = toks.n;
  for (let i = 0; i < n; i++) {
    const t = tt[i];
    if (t === T_ID) ids++;
    else if (t === T_P) punct++;
    else if (t === T_STR) strs++;
    else if (t === T_TPL) tpls++;
    else if (t === T_NUM) nums++;
    if (tl[i] > lines) lines = tl[i];
  }
  return { tokens: n, ids, punct, strs, tpls, nums, lines };
}

module.exports = { parse, stats, tokenize };
