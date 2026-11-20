"use strict";
// Compiler.js - HP64.js core tokenizer/stripper. OPTIMIZED v3 (flat typed arrays)
// Strategy: lex the source once into PARALLEL TYPED ARRAYS (no per-token objects,
// no per-token string slices), classify by interned numeric codes, then cut
// TypeScript-only syntax out by token range (no re-printing of untouched code).
// v3 perf notes:
//  - tt/ts/te/tl/tc Int32/Uint8Arrays instead of {t,v,s,e,line} objects -> no GC
//  - every punctuator and keyword interned to a numeric code -> integer compares
//  - keyword lookup by hash+byte compare (zero string allocation)
//  - numeric flag tables instead of Set<string>.has
// Token codes: tv = 0 (plain id/str/num/tpl/eof) | charCode (1-char punct)
//            | 128+i (multi-char punct) | 256+i (keyword)

const T_EOF = 0, T_ID = 1, T_P = 2, T_STR = 3, T_NUM = 4, T_TPL = 5;
const TV_SIZE = 512;

// multi-char punctuators: code = 128 + index (order defines codes)
const MULTI = [">>>>=", "===", "!==", "**=", "...", "<<=", ">>=", "&&=", "||=",
  "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>", "?."];
const MULTI_IDX = new Map();
for (let i = 0; i < MULTI.length; i++) MULTI_IDX.set(MULTI[i], 128 + i);

// keywords: code = 256 + index
const KW_LIST = ("function class const let var if else for while do return break continue " +
  "new delete typeof void in of switch case default try catch finally throw import export " +
  "extends super this null true false instanceof yield await async static get set from " +
  "public private protected readonly abstract override declare accessor interface type enum " +
  "namespace with satisfies implements debugger keyof infer is asserts unique out as").split(" ");
const KW_MAP = new Map();
for (let i = 0; i < KW_LIST.length; i++) KW_MAP.set(KW_LIST[i], 256 + i);
const K = Object.create(null);
for (const [w, c] of KW_MAP) K[w] = c;

// punct/keyword code of a literal used in sets (1-char -> charCode, multi -> 128+i, word -> 256+i)
function codeOfWord(w) {
  if (w.length === 1 && w.charCodeAt(0) < 128) return w.charCodeAt(0);
  const m = MULTI_IDX.get(w);
  if (m !== undefined) return m;
  const k = KW_MAP.get(w);
  if (k !== undefined) return k;
  throw new Error("intern: unknown literal " + JSON.stringify(w));
}
function flagsOf(words) {
  const f = new Uint8Array(TV_SIZE);
  for (const w of words) f[codeOfWord(w)] = 1;
  return f;
}

// set -> numeric flag table (flag[tv] <=> old set.has(v))
const KWF = flagsOf(KW_LIST);                                     // KEYWORDS
const MODWF = flagsOf(["public", "private", "protected", "readonly", "abstract", "override", "declare", "accessor"]);
const TSF = flagsOf(["interface", "type", "enum", "declare", "namespace"]);   // TYPE_START_KW
const NPF = flagsOf(["if", "while", "for", "switch", "with"]);    // NOT_PARAM_PREV
const WSNF = flagsOf(["case", "default", "if", "while", "for", "switch", "with", "return", "throw"]);
const TCF = flagsOf(["extends", "keyof", "infer", "readonly", "new", "typeof", "is", "asserts", "unique", "out"]);
const SEF = flagsOf(["return", "throw", "break", "continue", "case", "var", "let", "const", "function", "class", "if", "for", "while", "do", "switch", "try", "import", "export", "debugger"]);
const STOP_PARAM = flagsOf([",", ")", "=", "?"]);
const STOP_RETURN = flagsOf(["{", "=>", ";", "="]);
const STOP_VAR = flagsOf(["=", ";", ",", ")", "of", "in"]); // of/in: for-heads `for (const x: T of y)`
const STOP_AS = flagsOf([",", ";", ")", "]", "}", "=>", "?", ":", "=", "+", "-", "*", "/", "&&", "||", "==="]);
const STOP_MEMBER = flagsOf(["=", ";", "}"]);
// v2's original KEYWORDS set (44 words, ends at "from"). Used ONLY where v2
// used KEYWORDS.has() — KWF is a superset and must not be substituted there.
const KEYF = flagsOf(("function class const let var if else for while do return break continue " +
  "new delete typeof void in of switch case default try catch finally throw import export " +
  "extends super this null true false instanceof yield await async static get set from").split(" "));

// 1-char punct codes (charCode) + multi codes used in hot compares
const C_LP = 40, C_RP = 41, C_LB = 91, C_RB = 93, C_LBR = 123, C_RBR = 125;
const C_SEMI = 59, C_COLON = 58, C_COMMA = 44, C_DOT = 46, C_EQ = 61;
const C_QMARK = 63, C_BANG = 33, C_GT = 62, C_LT = 60, C_STAR = 42;
const C_HASH = 35, C_PLUS = 43, C_MINUS = 45, C_SLASH = 47, C_AMP = 38, C_PIPE = 124;
const M_ARROW = 138, M_EQEQEQ = 129, M_AMPAMP = 143, M_PIPEPIPE = 144;
const M_SHR = 158, M_GE = 142, M_SHREQ = 134, M_SHL = 157, M_OROR = 144;

// keyword lookup hash buckets over KW_LIST (zero-allocation, char-by-char)
const KW_HEAD = new Int32Array(1024).fill(-1);
const KW_NEXT = new Int32Array(KW_LIST.length);
for (let i = KW_LIST.length - 1; i >= 0; i--) {
  const w = KW_LIST[i];
  const h = ((w.length * 31 + w.charCodeAt(0) * 7 + w.charCodeAt(w.length - 1)) & 1023);
  KW_NEXT[i] = KW_HEAD[h];
  KW_HEAD[h] = i;
}
// resolve a keyword candidate for an already-hashed identifier (h passed in so
// the caller's call-site precheck isn't repeated). 0 if not a keyword.
function kwResolve(h, src, s, len) {
  for (let k = KW_HEAD[h]; k >= 0; k = KW_NEXT[k]) {
    const w = KW_LIST[k];
    if (w.length === len) {
      let j = 0;
      while (j < len && w.charCodeAt(j) === src.charCodeAt(s + j)) j++;
      if (j === len) return 256 + k;
    }
  }
  return 0;
}

function isIdStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95; // a-z A-Z $ _
}
function isIdPart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95;
}
function isDigit(c) { return c >= 48 && c <= 57; }

// punctuator at i -> packed ((tv << 8) | length), zero-alloc. Single chars: tv = charCode.
// Fast path: a multi-char punctuator's 2nd char is always one of these; anything
// else (the common case: `(x)`, `a;`, `x = y`...) returns a single-char code
// without entering the chain.
const PUNCT_CONT = new Uint8Array(128);
for (const w of MULTI) if (w.length > 1) PUNCT_CONT[w.charCodeAt(1)] = 1;

// Only these punctuators can ever start a classification (`(`, `:`, `!`, `?`);
// only keyword ids (tv >= 256) can take the word branches. Everything else is
// skipped by the classify prepass entirely.
const CLSP = new Uint8Array(128);
CLSP[33] = CLSP[40] = CLSP[58] = CLSP[63] = 1; // ! ( : ?

// Character class table (64K, one load replaces the ~11-compare dispatch chain):
// 0 ws | 1 a-z | 2 A-Z | 3 digit | 4 $_ | 5 " | 6 ' | 7 ` | 8 / | 9 . | 10 other
const CH = new Uint8Array(65536).fill(10);
CH[9] = 0; CH[10] = 0; CH[13] = 0; CH[32] = 0;   // \t \n \r space
CH.fill(1, 97, 123);                              // a-z
CH.fill(2, 65, 91);                               // A-Z
CH.fill(3, 48, 58);                               // 0-9
CH[36] = 4; CH[95] = 4;                           // $ _
CH[34] = 5; CH[39] = 6; CH[96] = 7; CH[47] = 8; CH[46] = 9;

function punctPack(c, s, i, n) {
  const c1 = i + 1 < n ? s.charCodeAt(i + 1) : 0;
  if (c1 >= 128 || !PUNCT_CONT[c1]) return ((c < 128 ? c : 0) << 8) | 1;
  if (i + 2 < n) {
    const c2 = s.charCodeAt(i + 2);
    if (c === 62 && c1 === 62 && c2 === 61) return (128 << 8) | 4; // >>>=
    if (c === 61 && c1 === 61 && c2 === 61) return (129 << 8) | 3; // ===
    if (c === 33 && c1 === 61 && c2 === 61) return (130 << 8) | 3; // !==
    if (c === 42 && c1 === 42 && c2 === 61) return (131 << 8) | 3; // **=
    if (c === 46 && c1 === 46 && c2 === 46) return (132 << 8) | 3; // ...
    if (c === 60 && c1 === 60 && c2 === 61) return (133 << 8) | 3; // <<=
    if (c === 62 && c1 === 62 && c2 === 61) return (134 << 8) | 3; // >>=
    if (c === 38 && c1 === 38 && c2 === 61) return (135 << 8) | 3; // &&=
    if (c === 124 && c1 === 124 && c2 === 61) return (136 << 8) | 3; // ||=
    if (c === 63 && c1 === 63 && c2 === 61) return (137 << 8) | 3; // ??=
  }
  if (i + 1 < n) {
    if (c === 61 && c1 === 62) return (138 << 8) | 2; // =>
    if (c === 61 && c1 === 61) return (139 << 8) | 2; // ==
    if (c === 33 && c1 === 61) return (140 << 8) | 2; // !=
    if (c === 60 && c1 === 61) return (141 << 8) | 2; // <=
    if (c === 62 && c1 === 61) return (142 << 8) | 2; // >=
    if (c === 38 && c1 === 38) return (143 << 8) | 2; // &&
    if (c === 124 && c1 === 124) return (144 << 8) | 2; // ||
    if (c === 63 && c1 === 63) return (145 << 8) | 2; // ??
    if (c === 43 && c1 === 43) return (146 << 8) | 2; // ++
    if (c === 45 && c1 === 45) return (147 << 8) | 2; // --
    if (c === 43 && c1 === 61) return (148 << 8) | 2; // +=
    if (c === 45 && c1 === 61) return (149 << 8) | 2; // -=
    if (c === 42 && c1 === 61) return (150 << 8) | 2; // *=
    if (c === 47 && c1 === 61) return (151 << 8) | 2; // /=
    if (c === 37 && c1 === 61) return (152 << 8) | 2; // %=
    if (c === 38 && c1 === 61) return (153 << 8) | 2; // &=
    if (c === 124 && c1 === 61) return (154 << 8) | 2; // |=
    if (c === 94 && c1 === 61) return (155 << 8) | 2; // ^=
    if (c === 42 && c1 === 42) return (156 << 8) | 2; // **
    if (c === 60 && c1 === 60) return (157 << 8) | 2; // <<
    if (c === 62 && c1 === 62) return (158 << 8) | 2; // >>
    if (c === 63 && c1 === 46) return (159 << 8) | 2; // ?.
  }
  return ((c < 128 ? c : 0) << 8) | 1;
}
// tokenize(src, store?) -> flat token store T:
//   { n, src, tt (kind Uint8Array), ts, te, tl (Int32Array), tv (interned code),
//     close, open, sd, cand, cn }
// kinds: 0 eof, 1 id, 2 punct, 3 str, 4 num, 5 tpl
// FUSED PASSES: bracket pairing (close/open/sd) and the classify candidate
// list (cand/cn) are produced inline while emitting tokens — this removes a
// separate 113K-token bracketMap pass + two -1 fills per compile.
// With `store`, the typed arrays are REUSED across calls (compile()'s hot path)
// — the returned view aliases them and must not outlive the next call.
function tokenize(src, store) {
  const n = src.length;
  let cap, tt, ts, te, tl, tv, close, open, sd, cand, stack;
  if (store && store.cap) {
    cap = store.cap; tt = store.tt; ts = store.ts; te = store.te; tl = store.tl; tv = store.tv;
    close = store.close; open = store.open; sd = store.sd; cand = store.cand; stack = store.stack;
  } else {
    cap = 256;
    tt = new Uint8Array(cap);
    ts = new Int32Array(cap);
    te = new Int32Array(cap);
    tl = new Int32Array(cap);
    tv = new Int32Array(cap);
    close = new Int32Array(cap);
    open = new Int32Array(cap);
    sd = new Int32Array(cap);
    cand = new Int32Array(cap);
    stack = new Int32Array(cap);
  }
  let count = 0, line = 1, i = 0, sp = 0, d = 0, cn = 0;
  function grow() {
    cap *= 2;
    const ntt = new Uint8Array(cap), nts = new Int32Array(cap),
      nte = new Int32Array(cap), ntl = new Int32Array(cap), ntv = new Int32Array(cap);
    ntt.set(tt); nts.set(ts); nte.set(te); ntl.set(tl); ntv.set(tv);
    tt = ntt; ts = nts; te = nte; tl = ntl; tv = ntv;
    const nc = new Int32Array(cap), no = new Int32Array(cap), ns = new Int32Array(cap),
      nd = new Int32Array(cap), nk = new Int32Array(cap);
    nc.set(close); no.set(open); ns.set(sd); nd.set(cand); nk.set(stack);
    close = nc; open = no; sd = ns; cand = nd; stack = nk;
  }
  while (i < n) {
    if (count === cap) grow(); // each iteration emits at most one token
    const c = src.charCodeAt(i);
    const cls = CH[c];
    // whitespace / newlines — consume the ENTIRE run in one pass: the old code
    // paid a full outer-loop iteration (grow check + comment/string/number/id
    // dispatch) for every single space char.
    if (cls === 0) {
      while (i < n) {
        const w = src.charCodeAt(i);
        if (w === 10) line++;
        else if (w !== 32 && w !== 9 && w !== 13) break;
        i++;
      }
      continue;
    }
    const start = i;
    switch (cls) {
      case 1: case 2: case 4: { // identifiers / keywords
        i++;
        // kwc stays true only while every char is a lowercase letter — keywords
        // are pure a-z, so any digit/_/uppercase means "not a keyword" and skips
        // the hash lookup entirely (the common case for generated identifiers).
        let kwc = cls === 1;
        while (i < n) {
          const k = CH[src.charCodeAt(i)];
          if (k >= 1 && k <= 4) { if (k !== 1) kwc = false; i++; }
          else break;
        }
        let tvv = 0;
        if (kwc) {
          const klen = i - start;
          // call-site bucket precheck: ~93% of identifiers land in an EMPTY
          // hash bucket, so most never enter kwResolve (saves call + re-hash).
          if (klen >= 2 && klen <= 14) {
            const h = ((klen * 31 + c * 7 + src.charCodeAt(i - 1)) & 1023);
            if (KW_HEAD[h] >= 0) tvv = kwResolve(h, src, start, klen);
          }
        }
        tt[count] = T_ID; ts[count] = start; te[count] = i; tl[count] = line; tv[count] = tvv;
        sd[count] = d;
        if (tvv >= 256) cand[cn++] = count; // classify candidate (fused prepass)
        count++;
        continue;
      }
      case 3: // digit -> number
      case 9: { // '.' + digit -> number, else punctuator
        if (cls === 9 && CH[src.charCodeAt(i + 1)] !== 3) break;
        i++;
        while (i < n) {
          const cc = src.charCodeAt(i);
          if (isDigit(cc) || (cc >= 97 && cc <= 102) || (cc >= 65 && cc <= 70) ||
              cc === 120 || cc === 88 || cc === 111 || cc === 79 || cc === 98 || cc === 66 ||
              cc === 110 || cc === 78 || cc === 101 || cc === 69 || cc === 46 || cc === 95) { i++; continue; }
          if (cc === 43 || cc === 45) {
            const prev = src.charCodeAt(i - 1);
            if (prev === 101 || prev === 69) { i++; continue; }
          }
          break;
        }
        tt[count] = T_NUM; ts[count] = start; te[count] = i; tl[count] = line; tv[count] = 0;
        sd[count] = d; count++;
        continue;
      }
      case 5: case 6: { // strings (" or ')
        i++;
        while (i < n) {
          const cc = src.charCodeAt(i);
          if (cc === 92) { i += 2; continue; }
          if (cc === c) { i++; break; }
          i++;
        }
        tt[count] = T_STR; ts[count] = start; te[count] = i; tl[count] = line; tv[count] = 0;
        sd[count] = d; count++;
        continue;
      }
      case 7: { // template literals
        i++;
        let depth = 0;
        while (i < n) {
          const cc = src.charCodeAt(i);
          if (cc === 92) { i += 2; continue; }
          if (depth === 0 && cc === 96) { i++; break; }
          if (depth === 0 && cc === 36 && src.charCodeAt(i + 1) === 123) { depth = 1; i += 2; continue; }
          if (depth > 0) {
            if (cc === 123) depth++;
            else if (cc === 125) depth--;
            else if (cc === 96) { // nested template: skip fully
              i++;
              let d2 = 0;
              while (i < n) {
                const c2 = src.charCodeAt(i);
                if (c2 === 92) { i += 2; continue; }
                if (d2 === 0 && c2 === 96) { i++; break; }
                if (d2 === 0 && c2 === 36 && src.charCodeAt(i + 1) === 123) { d2 = 1; i += 2; continue; }
                if (d2 > 0 && c2 === 123) d2++;
                else if (d2 > 0 && c2 === 125) d2--;
                i++;
              }
              continue;
            }
          }
          i++;
        }
        tt[count] = T_TPL; ts[count] = start; te[count] = i; tl[count] = line; tv[count] = 0;
        sd[count] = d; count++;
        continue;
      }
      case 8: { // '/' — line/block comment, else punctuator
        const c1 = src.charCodeAt(i + 1);
        if (c1 === 47) { while (i < n && src.charCodeAt(i) !== 10) i++; continue; }
        if (c1 === 42) {
          i += 2;
          while (i < n && !(src.charCodeAt(i) === 42 && src.charCodeAt(i + 1) === 47)) {
            if (src.charCodeAt(i) === 10) line++;
            i++;
          }
          i += 2; continue;
        }
        break; // ordinary punctuator
      }
      // case 10 (everything else): fall through to the punctuator path
    }
    // punctuators — fast path: virtually every punctuator is one char, so test
    // the 2nd char against PUNCT_CONT before entering punctPack (which would
    // re-read charCodeAt(i) we already hold as `c`).
    const c1 = i + 1 < n ? src.charCodeAt(i + 1) : 0;
    let pv, plen;
    if (PUNCT_CONT[c1]) {
      const pk = punctPack(c, src, i, n);
      pv = pk >>> 8; plen = pk & 0xff;
    } else {
      pv = c < 128 ? c : 0; plen = 1;
    }
    i += plen;
    tt[count] = T_P; ts[count] = start; te[count] = i; tl[count] = line; tv[count] = pv;
    sd[count] = d;
    if (pv < 128 && CLSP[pv]) cand[cn++] = count; // classify candidate (fused prepass)
    // fused bracket pairing — replicates bracketMap() exactly (type-checked
    // pop, unmatched brackets keep -1), so no separate pass + no -1 fills.
    if (pv === C_LP || pv === C_LB || pv === C_LBR) {
      close[count] = -1; open[count] = -1;
      stack[sp++] = count; d++;
    } else if (pv === C_RP || pv === C_RB || pv === C_RBR) {
      close[count] = -1; open[count] = -1;
      if (d > 0) d--;
      if (sp > 0) {
        const o = stack[--sp];
        const ov = tv[o];
        if ((pv === C_RP && ov === C_LP) || (pv === C_RB && ov === C_LB) || (pv === C_RBR && ov === C_LBR)) {
          close[o] = count;
          open[count] = o;
        }
      }
    }
    count++;
  }
  if (count === cap) grow();
  tt[count] = T_EOF; ts[count] = n; te[count] = n; tl[count] = line; tv[count] = 0;
  sd[count] = d; count++;
  if (store) {
    store.cap = cap; store.tt = tt; store.ts = ts; store.te = te; store.tl = tl; store.tv = tv;
    store.close = close; store.open = open; store.sd = sd; store.cand = cand; store.stack = stack;
    store.cn = cn;
  }
  return { n: count, src, tt, ts, te, tl, tv, close, open, sd, cand, cn };
}
// bracket pairing over flat store -> close[]/open[] (Int32Array, -1) + depth sd[]
// With `store`, arrays are reused across calls (compile()'s hot path).
function bracketMap(T, store) {
  const n = T.n, tv = T.tv;
  let close, open, sd, stack;
  if (store && store.cap >= n) {
    close = store.close; open = store.open; sd = store.sd; stack = store.stack;
    close.fill(-1, 0, n); open.fill(-1, 0, n);
  } else {
    close = new Int32Array(n).fill(-1);
    open = new Int32Array(n).fill(-1);
    sd = new Int32Array(n);
    stack = new Int32Array(n);
    if (store) { store.cap = n; store.close = close; store.open = open; store.sd = sd; store.stack = stack; }
  }
  let sp = 0, d = 0;
  for (let i = 0; i < n; i++) {
    const v = tv[i];
    sd[i] = d;
    if (v === C_LP || v === C_LB || v === C_LBR) { stack[sp++] = i; d++; continue; }
    if (v === C_RP || v === C_RB || v === C_RBR) {
      if (d > 0) d--;
      if (sp > 0) {
        const o = stack[--sp];
        const ov = tv[o];
        if ((v === C_RP && ov === C_LP) || (v === C_RB && ov === C_LB) || (v === C_RBR && ov === C_LBR)) {
          close[o] = i;
          open[i] = o;
        }
      }
    }
  }
  return { close, open, sd };
}

// find matching close token index for an open bracket at index i (-1 if none)
function findClose(T, i) {
  const tv = T.tv, n = T.n;
  const v = tv[i];
  const want = v === C_LP ? C_RP : v === C_LB ? C_RB : C_RBR;
  let depth = 0;
  for (let j = i; j < n; j++) {
    const jj = tv[j];
    if (jj === v) depth++;
    else if (jj === want) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// Is this "(" a parameter list? (function/method/arrow/catch params)
// cached: paramFlag[i] 0=unknown 1=yes 2=no
function isParamList(T, i, closeIdx, closeArr, paramFlag, openOf) {
  if (PROF) CNT.paramC++;
  if (paramFlag[i]) return paramFlag[i] === 1;
  const tv = T.tv, tt = T.tt;
  let res = false;
  const prevOk = i > 0 && tt[i - 1] === T_ID && NPF[tv[i - 1]];
  if (prevOk) {
    res = false;
  } else {
    const after = closeIdx + 1 < T.n ? closeIdx + 1 : -1;
    if (after < 0) res = false;
    else if (tv[after] === C_LBR || tv[after] === M_ARROW) res = true;
    else if (tv[after] === C_COLON) {
      // return type follows: confirm by walking back
      let j = i - 1, depth = 0;
      res = true;
      while (j >= 0) {
        const v = tv[j];
        if (v === C_RP || v === C_RB || v === C_RBR) {
          if (depth === 0 && openOf) {
            const o = openOf[j];
            if (o >= 0) { j = o - 1; continue; }
          }
          depth++;
        }
        else if (v === C_LP || v === C_LB || v === C_LBR) { if (depth === 0) { j--; continue; } depth--; }
        else if (depth === 0) {
          if (v === C_QMARK) { res = false; break; }
          if (tt[j] === T_ID && WSNF[v]) { res = false; break; }
          if (v === C_SEMI || v === C_LBR || v === C_RBR || v === C_EQ || v === C_COLON || v === C_COMMA || j === 0) break;
        }
        j--;
      }
    }
  }
  paramFlag[i] = res ? 1 : 2;
  return res;
}
// find statement end index (inclusive) starting at `from`
function stmtEnd(T, from) {
  const tv = T.tv, tt = T.tt, tl = T.tl, n = T.n;
  let depth = 0;
  const fromLine = tl[from];
  for (let i = from; i < n; i++) {
    if (PROF) CNT.stmtS++;
    const kind = tt[i];
    if (kind === T_EOF) return i - 1;
    const v = tv[i];
    if (v === C_LP || v === C_LB || v === C_LBR) depth++;
    else if (v === C_RP || v === C_RB || v === C_RBR) {
      if (depth === 0) return i - 1;
      depth--;
    } else if (v === C_SEMI && depth === 0) return i;
    else if (depth === 0 && i > from && tl[i] !== fromLine && tl[i - 1] < tl[i]) {
      // first token of a new line: possible ASI boundary
      const pk = tv[i - 1], pt = tt[i - 1];
      const endsStmt = pt === T_ID || pt === T_NUM || pt === T_STR || pt === T_TPL ||
        pk === C_RP || pk === C_RB || pk === C_RBR || pk === K.this || pk === K.super ||
        pk === K.true || pk === K.false || pk === K.null;
      if (endsStmt) {
        if (kind === T_ID && !TCF[v]) return i - 1;
        if (kind === T_STR || kind === T_NUM || kind === T_TPL) return i - 1;
        if (SEF[v]) return i - 1;
      } else if (kind === T_ID && SEF[v]) return i - 1;
    }
  }
  return n - 2;
}

// End of an `import/export { ... }` statement: specifier braces (+ optional
// `from "mod"`); import attributes after the module string are left intact.
function impExpEnd(T, i, closeArr) {
  const tv = T.tv, tt = T.tt, n = T.n;
  const bOpen = tv[i + 1] === C_LBR ? i + 1 : i + 2;
  const close = closeArr[bOpen];
  if (close < 0) return stmtEnd(T, i);
  let j = close + 1;
  if (tv[j] === K.from) {
    j++;
    while (j < n && tt[j] !== T_STR && tt[j] !== T_EOF) j++;
    if (tt[j] === T_STR) j++;
  }
  if (tv[j] === C_SEMI) return j;
  return j - 1;
}

// parse `interface X ... { }` / `type X = ...;` / `declare ...` / `enum`
function stripDeclaration(T, i, del, closeArr, replIdx, replVal) {
  const tv = T.tv, tt = T.tt, n = T.n, src = T.src, ts = T.ts, te = T.te;
  const kw = tv[i];
  if (kw === K.interface) {
    let j = i;
    while (j < n && tv[j] !== C_LBR) j++;
    const end = closeArr[j];
    if (end < 0) return;
    del.fill(1, i, end + 1);
    if (tv[end + 1] === C_SEMI) del[end + 1] = 1;
    return;
  }
  if (kw === K.type || kw === K.declare || kw === K.namespace) {
    const end = stmtEnd(T, i);
    del.fill(1, i, end + 1);
    return;
  }
  if (kw === K.enum) {
    // enum X { A, B = 1 }  ->  const X = { A: 0, B: 1 }
    let j = i + 1;
    while (j < n && tt[j] !== T_ID) j++;
    const name = j < n ? src.slice(ts[j], te[j]) : "Enum";
    let b = j;
    while (b < n && tv[b] !== C_LBR) b++;
    const end = closeArr[b];
    if (end < 0) return;
    const body = ENUM_BODY;
    body.length = 0;
    let auto = 0;
    for (let k = b + 1; k < end; k++) {
      if (tt[k] === T_ID) {
        const key = src.slice(ts[k], te[k]);
        let val = auto;
        if (tv[k + 1] === C_EQ) {
          const lit = k + 2 < n ? k + 2 : -1;
          if (lit >= 0 && (tt[lit] === T_NUM || tt[lit] === T_STR)) {
            if (tt[lit] === T_NUM) val = Number(src.slice(ts[lit], te[lit]));
            else val = src.slice(ts[lit], te[lit]);
            if (typeof val === "number") auto = val;
            k += 2;
          } else { k += 1; }
        }
        // identifier keys never need JSON escaping (no quotes/backslashes/
        // control chars can occur in an identifier) — manual quotes skip the
        // JSON.stringify call overhead (400 enums x members per compile).
        body.push('"' + key + '":' + val);
        auto++;
      }
    }
    replIdx.push(i);
    replVal.push("const " + name + "={" + body.join(",") + "}");
    if (i > 0 && tv[i - 1] === K.const) del[i - 1] = 1; // `const enum` -> keep one `const`
    del.fill(1, i, end + 1);
    return;
  }
}
// When skipType stops mid-token (fused `>>=`/`>=` closers), record how many
// leading chars of that token must be deleted. Consumed by callers after skipType.
let SPLIT_TOK = -1;
let SPLIT_CHARS = 0;

// Diagnostic counters — only touched when PROF is on (global.__HP64_PROF set).
let PROF = false;
const CNT = { kind: Object.create(null), ternC: 0, ternS: 0, varC: 0, varS: 0,
  paramC: 0, skipS: 0, stmtS: 0, impC: 0, declC: 0, typeS: 0 };

// skip a type expression starting at index i; returns index of last consumed token
function skipType(T, i, stopTab) {
  const tv = T.tv, tt = T.tt, tl = T.tl, te = T.te, n = T.n;
  let depth = 0, j = i;
  while (j < n) {
    if (PROF) CNT.skipS++;
    const kind = tt[j];
    if (kind === T_EOF) return j - 1;
    const v = tv[j];
    if (depth === 0 && j > i) {
      if (tl[j - 1] < tl[j]) {
        // first token on a new line — if the previous token ended a statement,
        // a bare id/str/num here can't continue the type (e.g. `x: T\ny: U`).
        const pv = tv[j - 1], pk = tt[j - 1];
        if (!(pv === K.as || pv === K.satisfies)) {
          const endsStmt = pk === T_ID || pk === T_NUM || pk === T_STR || pk === T_TPL ||
            pv === C_RP || pv === C_RB || pv === C_RBR || pv === K.true || pv === K.false ||
            pv === K.null || pv === K.this || pv === K.super;
          if (endsStmt) {
            if (kind === T_ID && !TCF[v]) return j - 1;
            if (kind === T_STR || kind === T_NUM || kind === T_TPL) return j - 1;
          }
        }
      }
    }
    if (depth === 0 && stopTab[v]) {
      // `{` may be an object type in a return position: `): {a: number} {`
      if (v === C_LBR) {
        const close = findClose(T, j);
        const after = close >= 0 ? close + 1 : -1;
        if (after >= 0 && (tv[after] === C_LBR || tv[after] === M_ARROW)) { j = close + 1; continue; }
      }
      return j - 1;
    }
    if (v === C_LT || v === C_LP || v === C_LB || v === C_LBR) depth++;
    else if (v === C_GT || v === C_RP || v === C_RB || v === C_RBR) {
      if (depth === 0) return j - 1;
      depth--;
    }
    else if (v === M_SHR || v === M_SHREQ || v === M_GE) {
      // fused generic closers: `Map<string, Array<number>>`, `Array<number>= x`
      if (depth === 0) return j - 1;
      const k = v === M_GE ? 1 : 2;
      if (depth >= k) {
        depth -= k;
        if (te[j] - ts0(T, j) > k) { SPLIT_TOK = j; SPLIT_CHARS = k; return j; } // keep `=` suffix
        j++;
        continue;
      }
      // more closers than open groups: keep (k - depth) of them as text
      SPLIT_TOK = j;
      SPLIT_CHARS = k - depth;
      return j;
    }
    j++;
  }
  return j - 1;
}
function ts0(T, j) { return T.ts[j]; }

// Is the `:` at index i belong to a ternary (`a ? b() : c`) rather than a
// return/annotation type? Walks back at bracket-depth 0 looking for `?`.
// Bracket groups are jumped over via openOf — their interior can never hold a
// same-level `?`, so this is O(groups) instead of O(tokens).
function isTernaryBefore(T, i, del, openOf) {
  const tv = T.tv, tt = T.tt;
  if (PROF) CNT.ternC++;
  let j = i - 1, depth = 0;
  while (j >= 0) {
    if (PROF) CNT.ternS++;
    if (del && del[j]) { j--; continue; } // already stripped (e.g. optional `?`)
    const v = tv[j];
    if (v === C_RP || v === C_RB || v === C_RBR) {
      if (depth === 0 && openOf) {
        const o = openOf[j];
        if (o >= 0) { j = o - 1; continue; }
      }
      depth++; j--; continue;
    }
    if (v === C_LP || v === C_LB || v === C_LBR) {
      if (depth === 0) return false; // `:` sits inside this group; its head has no same-level `?`
      depth--; j--; continue;
    }
    if (depth === 0) {
      if (v === C_QMARK) return true;
      if (v === C_SEMI || v === C_LBR || v === C_RBR || v === C_EQ || v === C_COMMA || v === M_ARROW || v === C_COLON) return false;
      if (tt[j] === T_ID) {
        if (v === K.return || v === K.case || v === K.default || v === K.break || v === K.continue || v === K.throw) return false;
      }
      if (tt[j] === T_EOF) return false;
    }
    j--;
  }
  return false;
}
// Is the `:` at i the 2nd+ declarator of a var statement (`let a: T = 1, b: U`)?
// Walks back from the `,` before the name at bracket-depth 0 looking for
// let/const/var; stops at statement boundaries and non-ternary colons.
function isVarDeclBefore(T, i, del, openOf) {
  const tv = T.tv, tt = T.tt, tl = T.tl;
  if (PROF) CNT.varC++;
  let j = i - 2, depth = 0; // i-1 is the declarator name
  while (j >= 0) {
    if (PROF) CNT.varS++;
    if (del && del[j]) { j--; continue; }
    const v = tv[j];
    if (v === C_RP || v === C_RB || v === C_RBR) {
      if (depth === 0 && openOf) {
        const o = openOf[j];
        if (o >= 0) { j = o - 1; continue; }
      }
      depth++; j--; continue;
    }
    if (v === C_LP || v === C_LB || v === C_LBR) {
      if (depth === 0) return false;
      depth--; j--; continue;
    }
    if (depth === 0) {
      if (v === K.let || v === K.const || v === K.var) return true;
      if (v === C_SEMI) return false;
      if (v === M_ARROW || v === C_QMARK || v === K.case) return false;
      if (v === C_COLON) { if (isTernaryBefore(T, j, del, openOf)) { j--; continue; } return false; }
      if (tt[j] === T_ID && (v === K.return || v === K.default || v === K.break ||
        v === K.continue || v === K.throw || v === K.function || v === K.class ||
        v === K.export || v === K.import)) return false;
      // ASI boundary: prev token ends a statement and next starts a new line —
      // but a `,` at j+1 continues the declarator list across the break.
      if (tl[j] < tl[j + 1] && tv[j + 1] !== C_COMMA) {
        const pk = tt[j];
        const endsStmt = pk === T_ID || pk === T_NUM || pk === T_STR || pk === T_TPL ||
          v === C_RP || v === C_RB || v === C_RBR || v === K.true || v === K.false ||
          v === K.null || v === K.this || v === K.super;
        if (endsStmt) return false;
      }
    }
    j--;
  }
  return false;
}

// First `{` that opens a class body after the `class` token at i (angle-aware
// so `extends B<{x: 1}>` doesn't confuse us). -1 if not a class declaration.
function findClassBody(T, i) {
  const tv = T.tv, tt = T.tt, n = T.n;
  let angle = 0;
  for (let j = i + 1; j < n; j++) {
    if (tt[j] === T_EOF) return -1;
    const v = tv[j];
    if (v === C_LBR && angle === 0) return j;
    if (v === C_LT) angle++;
    else if (v === C_GT) { if (angle > 0) angle--; }
    else if (v === M_SHR) { angle = angle >= 2 ? angle - 2 : 0; }
    else if (v === C_SEMI || v === C_EQ || v === C_LP || v === C_RP) return -1;
    else if (tt[j] === T_ID && (v === K.function || v === K.var || v === K.let || v === K.const)) return -1;
  }
  return -1;
}

// Is the `:`/`?` at i in member-DECLARATION position (name preceded by a class
// body boundary / modifier), not inside a field initializer expression?
function memberBoundaryOk(T, i, openOf) {
  const tv = T.tv, tt = T.tt;
  let nameIdx = i - 1;
  if (nameIdx < 0) return false;
  const nv = tv[nameIdx];
  if (nv === C_QMARK) nameIdx--;                 // `x?: T`
  else if (nv === C_RB) {                        // `[k]: T`
    const o = openOf[nameIdx];
    if (o < 0) return false;
    nameIdx = o;
  }
  if (nameIdx <= 0) return true;
  const bv = tv[nameIdx - 1];
  if (bv === C_LBR || bv === C_SEMI || bv === C_RBR || bv === C_HASH) return true;
  if (tt[nameIdx - 1] === T_ID && (MODWF[bv] || bv === K.async || bv === K.get ||
    bv === K.set || bv === K.static || bv === K.abstract)) return true;
  return false;
}

// Start index of the signature statement whose params `)` is at closeIdx
// (`m(): void;` / `abstract m(): T;` / `function f(a): T;`), or -1.
function sigStart(T, closeIdx, openOf) {
  const tv = T.tv, tt = T.tt;
  let j = openOf[closeIdx];
  if (j <= 0) return -1;
  j--;
  let nameSeen = false, includeKw = false;
  while (j >= 0) {
    const kind = tt[j];
    const v = tv[j];
    if (kind === T_ID) {
      if (v === K.function || v === K.class) { includeKw = true; j--; break; }
      if (v === K.export || v === K.default || v === K.declare || v === K.async) {
        if (!includeKw && !nameSeen) return -1;
        j--;
        continue;
      }
      nameSeen = true;
      j--;
      continue;
    }
    if (v === C_QMARK || v === C_STAR || v === C_HASH) { j--; continue; }
    if (v === C_RB) {
      const o = openOf[j];
      if (o < 0) return -1;
      j = o - 1;
      nameSeen = true;
      continue;
    }
    break;
  }
  if (!nameSeen) return -1;
  if (includeKw) {
    while (j >= 0 && tt[j] === T_ID &&
      (tv[j] === K.export || tv[j] === K.default || tv[j] === K.declare || tv[j] === K.async)) j--;
    return j + 1;
  }
  if (j < 0) return -1;
  const bv = tv[j];
  if (bv === C_LBR || bv === C_SEMI || bv === C_RBR) return j + 1;
  return -1;
}

// skipType + mark the `:` (or `as`) at index i through the type end as deleted,
// applying any mid-token split skipType recorded.
function markType(T, i, stopTab, del, partial) {
  SPLIT_TOK = -1;
  const end = skipType(T, i + 1, stopTab);
  del.fill(1, i, end + 1);
  if (SPLIT_TOK >= i && SPLIT_TOK <= end) partial[SPLIT_TOK] = SPLIT_CHARS;
  SPLIT_TOK = -1;
  return end;
}

// Scratch stores reused across compile() calls: compile() is synchronous and
// these views never escape it, so after warmup there is no typed-array
// allocation at all (~4 MB + growth copies saved per compile).
const TK_STORE = { cap: 0, tt: null, ts: null, te: null, tl: null, tv: null };
const BK_STORE = { cap: 0, close: null, open: null, sd: null, stack: null };
const DEL_STORE = { cap: 0, del: null, partial: null, paramFlag: null };
const REPL_IDX = [];
const REPL_VAL = [];
const ENUM_BODY = []; // reused scratch for enum -> object literal members
// class-body stack: Int32Array pairs [end, memberSd] — replaces per-class JS
// object allocation (kills the GC churn from 400+ pushes per compile).
const CLS_STK = new Int32Array(2048);
let CAND_BUF = new Int32Array(4096); // classify candidate indices (reused)

/**
 * compile(src) -> { code, stats }
 * Removes TS syntax; leaves plain JS untouched (byte-identical for pure JS).
 */
function compile(src) {
  const __p = global.__HP64_PROF;
  PROF = !!global.__HP64_CNT;
  if (PROF) {
    CNT.kind = Object.create(null);
    CNT.ternC = CNT.ternS = CNT.varC = CNT.varS = CNT.paramC = CNT.skipS =
      CNT.stmtS = CNT.impC = CNT.declC = CNT.typeS = 0;
  }
  const __t0 = __p ? performance.now() : 0;
  const T = tokenize(src, TK_STORE);
  const __t1 = __p ? performance.now() : 0;
  const __tb = __t1; // bracket pairing is fused into tokenize now
  const { close: closeArr, open: openOf, sd, cand, cn } = T;
  const n = T.n, tt = T.tt, tv = T.tv, ts = T.ts, te = T.te;
  if (DEL_STORE.cap < n) {
    DEL_STORE.cap = n;
    DEL_STORE.del = new Uint8Array(n);
    DEL_STORE.partial = new Uint8Array(n);
    DEL_STORE.paramFlag = new Uint8Array(n);
  }
  const del = DEL_STORE.del, partial = DEL_STORE.partial, paramFlag = DEL_STORE.paramFlag;
  del.fill(0, 0, n); partial.fill(0, 0, n); paramFlag.fill(0, 0, n);
  const __tf = __p ? performance.now() : 0;
  const replIdx = REPL_IDX, replVal = REPL_VAL; // enum replacements: parallel arrays
  replIdx.length = 0; replVal.length = 0;

  const IMPORT_EXPORT_TYPE = 1;
  const DECL = 2;
  const ABSTRACT_CLASS = 3;
  const IMPLEMENTS = 5;
  const PARAMS = 6;
  const RETURN_OR_VAR = 7;
  const AS = 8;
  const NOTNULL = 9;
  const MODIFIER = 10;
  const OPT_MEMBER = 11;
  const IMPORT_EXPORT_BRACES = 12;
  const MEMBER_TYPE = 13;

  // pass 1: classify + mark deletions.
  // Candidates (keyword ids + `(`/`:`/`!`/`?`) and close/open/sd were already
  // collected inline by tokenize — no separate prepass or bracketMap pass.
  let csp = 0; // class-body stack depth (pairs in CLS_STK)
  let skipTo = -1; // cases jump the loop forward; candidates <= this are skipped
  if (PROF) CNT.cn = cn;
  const __tp = __p ? performance.now() : 0;
  for (let ci = 0; ci < cn; ci++) {
    const i = cand[ci];
    if (i <= skipTo) continue;
    if (del[i]) continue;
    const v = tv[i], tk = tt[i];

    while (csp > 0 && CLS_STK[(csp - 1) << 1] < i) csp--;
    let memberPos = false;
    if (csp > 0) memberPos = sd[i] === CLS_STK[((csp - 1) << 1) + 1];
    // class declarations: remember body extent for member-position checks
    if (tk === T_ID && v === K.class && (i === 0 || tv[i - 1] !== C_DOT)) {
      const nx = i + 1 < n ? i + 1 : -1;
      if (nx >= 0 && (tt[nx] === T_ID || tv[nx] === C_LBR)) {
        const b = findClassBody(T, i);
        if (b >= 0 && closeArr[b] >= 0 && csp < 1024) {
          CLS_STK[csp << 1] = closeArr[b];
          CLS_STK[(csp << 1) + 1] = sd[b] + 1;
          csp++;
        }
      }
    }

    // import/export statements: handle wholesale (also protects `as` aliases).
    // Partition by token kind first: only keyword ids match the word branches,
    // only punctuators the symbol branches — plain identifiers/literals skip
    // the entire chain (they can never classify).
    let kind = 0;
    if (tk === T_ID && v >= 256) {
      if (v === K.import || v === K.export) {
        const nx = i + 1 < n ? i + 1 : -1;
        if (nx >= 0 && tv[nx] === K.type) kind = IMPORT_EXPORT_TYPE;
        else if (nx >= 0 && tv[nx] === C_LBR) kind = IMPORT_EXPORT_BRACES;
      }
      else if (TSF[v]) {
        // statement start, possibly preceded by export/declare (and const for `const enum`)
        let k = i - 1;
        while (k >= 0) {
          const pv = tv[k];
          if (pv === K.export || pv === K.declare || (v === K.enum && pv === K.const)) k--;
          else break;
        }
        const nx = i + 1 < n ? i + 1 : -1;
        if (nx >= 0 && tt[nx] === T_ID &&
            (k < 0 || tv[k] === C_SEMI || tv[k] === C_LBR || tv[k] === C_RBR || tt[k] === T_EOF)) kind = DECL;
      }
      else if (v === K.abstract && i + 1 < n && tv[i + 1] === K.class) kind = ABSTRACT_CLASS;
      else if (v === K.implements) kind = IMPLEMENTS;
      else if (v === K.as || v === K.satisfies) {
        const bi = i - 1;
        if (bi >= 0) {
          const bt = tt[bi], bv = tv[bi];
          if (bt === T_ID || bv === C_RP || bv === C_RB || bv === C_RBR || bv === C_GT ||
              bv === C_BANG || bt === T_NUM || bt === T_STR || bt === T_TPL ||
              bv === K.this || bv === K.super) {
            const bkw = bt === T_ID ? bv : 0;
            if (!(bkw === K.import || bkw === K.export || bkw === K.from)) kind = AS;
          }
        }
      }
      else if (MODWF[v]) {
        const bi = i - 1, ni = i + 1;
        const memberStart = bi < 0 || tv[bi] === C_LBR || tv[bi] === C_SEMI || tv[bi] === C_RBR ||
          (tt[bi] === T_ID && MODWF[tv[bi]]);
        if (memberStart && ni < n && (tt[ni] === T_ID || tv[ni] === C_STAR || tv[ni] === C_HASH || tv[ni] === C_LB)) kind = MODIFIER;
      }
    }
    else if (tk === T_P) {
      if (v === C_LP) {
        const close = closeArr[i];
        if (close >= 0 && isParamList(T, i, close, closeArr, paramFlag, openOf)) kind = PARAMS;
      }
      else if (v === C_COLON) {
        const pi = i - 1;
        if (pi >= 0 && (tv[pi] === C_RP || tv[pi] === C_GT)) {
          if (!isTernaryBefore(T, i, del, openOf)) kind = RETURN_OR_VAR;
        }
        else if (pi >= 0 && tt[pi] === T_ID && !KEYF[tv[pi]]) {
          const bi = i - 2;
          if (bi >= 0 && (tv[bi] === K.let || tv[bi] === K.const || tv[bi] === K.var)) kind = RETURN_OR_VAR;
          else if (bi >= 0 && tv[bi] === C_COMMA && isVarDeclBefore(T, i, del, openOf)) kind = RETURN_OR_VAR; // `let a: T = 1, b: U`
          else if (memberPos && memberBoundaryOk(T, i, openOf)) kind = MEMBER_TYPE;
        }
        else if (memberPos && pi >= 0 && (tt[pi] === T_ID || tv[pi] === C_QMARK || tv[pi] === C_RB) &&
                 memberBoundaryOk(T, i, openOf)) kind = MEMBER_TYPE;
      }
      else if (v === C_BANG) {
        const bi = i - 1, ni = i + 1;
        if (bi >= 0 && ni < n) {
          const bt = tt[bi], bv = tv[bi], at = tt[ni], av = tv[ni];
          if ((bt === T_ID || bv === C_RP || bv === C_RB || bt === T_NUM ||
               bt === T_STR || bt === T_TPL || bv === K.this) &&
              (av === C_DOT || av === C_LB || av === C_LP || av === C_SEMI || av === C_RP ||
               av === C_COMMA || av === C_RBR || av === C_COLON || av === C_EQ || av === C_QMARK ||
               at === T_EOF || at === T_ID || av === C_BANG || av === C_PLUS)) kind = NOTNULL;
        }
      }
      else if (v === C_QMARK) {
        const pi = i - 1, ni = i + 1;
        if (pi >= 0 && tt[pi] === T_ID && ni < n &&
            (tv[ni] === C_COLON || tv[ni] === C_SEMI ||
             (tv[ni] === C_LP && memberPos && memberBoundaryOk(T, i, openOf)))) kind = OPT_MEMBER;
      }
    }

    if (PROF && kind) CNT.kind[kind] = (CNT.kind[kind] || 0) + 1;
    switch (kind) {
      case IMPORT_EXPORT_TYPE: {
        const nx = i + 1 < n ? i + 1 : -1;
        const isBraces = tv[nx] === C_LBR || (i + 2 < n && tv[i + 2] === C_LBR);
        const end = isBraces ? impExpEnd(T, i, closeArr) : stmtEnd(T, i);
        del.fill(1, i, end + 1);
        if (end > skipTo) skipTo = end;
        break;
      }
      case IMPORT_EXPORT_BRACES: {
        // `import { type A, B } from` / `export { type A, B }` — strip type-only
        // specifiers; jump past the statement so `as` aliases are never re-classified.
        const bOpen = tv[i + 1] === C_LBR ? i + 1 : i + 2;
        const close = closeArr[bOpen];
        if (close >= 0) {
          for (let k = bOpen + 1; k < close; k++) {
            if (tt[k] === T_ID && tv[k] === K.type) {
              const nx = k + 1 < n ? k + 1 : -1, nx2 = k + 2 < n ? k + 2 : -1;
              if (nx >= 0 && tt[nx] === T_ID && nx2 >= 0 && (tv[nx2] === C_COMMA || tv[nx2] === C_RBR)) {
                del[k] = 1;
                del[k + 1] = 1;
                if (tv[nx2] === C_COMMA) { del[k + 2] = 1; k += 2; }
                else if (tv[k - 1] === C_COMMA) del[k - 1] = 1;
              }
            }
          }
        }
        const ie = impExpEnd(T, i, closeArr);
        if (ie > skipTo) skipTo = ie;
        break;
      }
      case DECL:
        stripDeclaration(T, i, del, closeArr, replIdx, replVal);
        break;
      case ABSTRACT_CLASS:
        del[i] = 1;
        break;
      case IMPLEMENTS: {
        let j = i;
        while (j < n && tv[j] !== C_LBR) j++;
        for (let k = i; k < j; k++) del[k] = 1;
        if (j - 1 > skipTo) skipTo = j - 1;
        break;
      }
      case PARAMS: {
        const close = closeArr[i];
        let depth = 0;
        for (let j = i + 1; j < close; j++) {
          const pv = tv[j];
          if (pv === C_LP || pv === C_LB || pv === C_LBR) depth++;
          else if (pv === C_RP || pv === C_RB || pv === C_RBR) depth--;
          else if (depth === 0) {
            if (pv === C_COLON) {
              const end = markType(T, j, STOP_PARAM, del, partial);
              j = end;
            } else if (pv === C_QMARK) {
              const nx = j + 1 < n ? j + 1 : -1;
              if (nx >= 0 && (tv[nx] === C_COLON || tv[nx] === C_RP)) del[j] = 1;
            } else if (MODWF[pv]) {
              const nx = j + 1 < n ? j + 1 : -1;
              if (nx >= 0 && tt[nx] === T_ID) del[j] = 1;
            }
          }
        }
        break;
      }
      case RETURN_OR_VAR: {
        const pi = i - 1;
        const isReturn = pi >= 0 && (tv[pi] === C_RP || tv[pi] === C_GT);
        const end = markType(T, i, isReturn ? STOP_RETURN : STOP_VAR, del, partial);
        // bodyless signature: `m(): void;` / `function f(a): T;` — the whole
        // statement is TS-only (overload / abstract member / interface-style sig)
        if (isReturn && end + 1 < n && tv[end + 1] === C_SEMI) {
          const start = sigStart(T, i - 1, openOf);
          if (start >= 0) {
            del.fill(1, start, end + 2);
            if (end + 1 > skipTo) skipTo = end + 1;
            break;
          }
        }
        if (end > skipTo) skipTo = end;
        break;
      }
      case MEMBER_TYPE: {
        const end = markType(T, i, STOP_MEMBER, del, partial);
        if (end > skipTo) skipTo = end;
        break;
      }
      case AS: {
        const end = markType(T, i, STOP_AS, del, partial);
        if (end > skipTo) skipTo = end;
        break;
      }
      case NOTNULL:
      case MODIFIER:
      case OPT_MEMBER:
        del[i] = 1;
        break;
    }
  }

  // fast path: nothing removed
  const __t2 = __p ? performance.now() : 0;
  let anyDel = false;
  for (let i = 0; i < n; i++) if (del[i]) { anyDel = true; break; }
  if (!anyDel) return { code: src, stats: { tokens: n, removed: 0 } };

  // pass 2: emit, cutting deleted ranges, applying replacements.
  // Runs of consecutive deleted tokens are collapsed into one position jump
  // (one slice per run instead of one per token). Removed tokens are counted
  // here as they're consumed — no separate countDel pass over all n tokens.
  let out = "";
  let pos = 0, rp = 0, removed = 0;
  const replLen = replIdx.length;
  for (let i = 0; i < n; i++) {
    if (rp < replLen && replIdx[rp] === i) {
      if (ts[i] > pos) out += src.slice(pos, ts[i]);
      out += replVal[rp];
      if (del[i]) removed++;
      pos = te[i];
      rp++;
      while (i + 1 < n && del[i + 1]) { i++; pos = te[i]; removed++; }
    } else if (del[i]) {
      if (ts[i] < pos) { removed++; continue; }
      if (ts[i] > pos) out += src.slice(pos, ts[i]);
      // extend over the whole run of deleted tokens (runs stop at a partial
      // split or a replacement — those need per-token handling)
      let e = i;
      while (e + 1 < n && del[e + 1] && !partial[e + 1] &&
             !(rp < replLen && replIdx[rp] === e + 1)) e++;
      removed += e - i + 1;
      if (e > i) { pos = te[e]; i = e; }
      else pos = partial[i] ? ts[i] + partial[i] : te[i];
    }
  }
  out += src.slice(pos);
  if (__p) {
    __p.tok += __t1 - __t0;
    __p.bm += __tb - __t1;
    __p.fill += __tf - __tb;
    __p.pre += __tp - __tf;
    __p.cls += __t2 - __tp;
    __p.emit += performance.now() - __t2;
    if (PROF) __p.cnt = CNT;
  }
  return { code: out, stats: { tokens: n, removed } };
}

module.exports = { compile, tokenize, bracketMap };
