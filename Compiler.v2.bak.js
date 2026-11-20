"use strict";
// Compiler.js - HP64.js core tokenizer/stripper. OPTIMIZED v2
// Strategy: lex the source once into tokens, then cut TypeScript-only
// syntax out by token range (no re-printing of untouched code).
// Perf notes:
//  - charCodeAt + if-chains instead of RegExp per char
//  - canonical punctuator literals (zero string allocs for operators)
//  - Uint8Array delete flags instead of Set<number>
//  - precomputed stop-sets (no `new Set()` in hot loop)
//  - cached param-list classification

const KEYWORDS = new Set(("function class const let var if else for while do return break continue " +
  "new delete typeof void in of switch case default try catch finally throw import export " +
  "extends super this null true false instanceof yield await async static get set from").split(" "));
const MODIFIERS = new Set(["public", "private", "protected", "readonly", "abstract", "override", "declare", "accessor"]);
const TYPE_START_KW = new Set(["interface", "type", "enum", "declare", "namespace"]);
const NOT_PARAM_PREV = new Set(["if", "while", "for", "switch", "with"]);
const WALK_STOP_NOT_PARAM = new Set(["case", "default", "if", "while", "for", "switch", "with", "return", "throw"]);

// stop-sets for skipType (preallocated)
const STOP_PARAM = new Set([",", ")", "=", "?"]);
const STOP_RETURN = new Set(["{", "=>", ";", "="]);
const STOP_VAR = new Set(["=", ";", ",", ")", "of", "in"]); // of/in: for-heads `for (const x: T of y)`
const STOP_AS = new Set([",", ";", ")", "]", "}", "=>", "?", ":", "=", "+", "-", "*", "/", "&&", "||", "==="]);
const STOP_MEMBER = new Set(["=", ";", "}"]);

const CH = new Array(128); // cached single-char strings
for (let i = 0; i < 128; i++) CH[i] = String.fromCharCode(i);

function isIdStart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95; // a-z A-Z $ _
}
function isIdPart(c) {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95;
}
function isDigit(c) { return c >= 48 && c <= 57; }

// punctuator at i -> canonical literal (interned, no alloc) or null
function punctAt(s, i, n) {
  const c = s.charCodeAt(i);
  if (i + 2 < n) {
    const c1 = s.charCodeAt(i + 1), c2 = s.charCodeAt(i + 2);
    if (c === 62 && c1 === 62 && c2 === 61) return ">>>="; // >>>=
    if (c === 61 && c1 === 61 && c2 === 61) return "===";
    if (c === 33 && c1 === 61 && c2 === 61) return "!==";
    if (c === 42 && c1 === 42 && c2 === 61) return "**=";
    if (c === 46 && c1 === 46 && c2 === 46) return "...";
    if (c === 60 && c1 === 60 && c2 === 61) return "<<=";
    if (c === 62 && c1 === 62 && c2 === 61) return ">>=";
    if (c === 38 && c1 === 38 && c2 === 61) return "&&=";
    if (c === 124 && c1 === 124 && c2 === 61) return "||=";
    if (c === 63 && c1 === 63 && c2 === 61) return "??=";
  }
  if (i + 1 < n) {
    const c1 = s.charCodeAt(i + 1);
    if (c === 61 && c1 === 62) return "=>";
    if (c === 61 && c1 === 61) return "==";
    if (c === 33 && c1 === 61) return "!=";
    if (c === 60 && c1 === 61) return "<=";
    if (c === 62 && c1 === 61) return ">=";
    if (c === 38 && c1 === 38) return "&&";
    if (c === 124 && c1 === 124) return "||";
    if (c === 63 && c1 === 63) return "??";
    if (c === 43 && c1 === 43) return "++";
    if (c === 45 && c1 === 45) return "--";
    if (c === 43 && c1 === 61) return "+=";
    if (c === 45 && c1 === 61) return "-=";
    if (c === 42 && c1 === 61) return "*=";
    if (c === 47 && c1 === 61) return "/=";
    if (c === 37 && c1 === 61) return "%=";
    if (c === 38 && c1 === 61) return "&=";
    if (c === 124 && c1 === 61) return "|=";
    if (c === 94 && c1 === 61) return "^=";
    if (c === 42 && c1 === 42) return "**";
    if (c === 60 && c1 === 60) return "<<";
    if (c === 62 && c1 === 62) return ">>";
    if (c === 63 && c1 === 46) return "?.";
  }
  return null;
}

function tokenize(src) {
  const toks = [];
  const n = src.length;
  let i = 0, line = 1;
  while (i < n) {
    const c = src.charCodeAt(i);
    // whitespace / newlines
    if (c === 10) { line++; i++; continue; }
    if (c === 32 || c === 9 || c === 13) { i++; continue; }
    const start = i;
    // comments
    if (c === 47) { // /
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
    }
    // strings
    if (c === 34 || c === 39) {
      i++;
      while (i < n) {
        const cc = src.charCodeAt(i);
        if (cc === 92) { i += 2; continue; }
        if (cc === c) { i++; break; }
        i++;
      }
      toks.push({ t: "str", v: src.slice(start, i), s: start, e: i, line });
      continue;
    }
    // template literals
    if (c === 96) {
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
      toks.push({ t: "tpl", v: src.slice(start, i), s: start, e: i, line });
      continue;
    }
    // numbers
    if (isDigit(c) || (c === 46 && isDigit(src.charCodeAt(i + 1)))) {
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
      toks.push({ t: "num", v: src.slice(start, i), s: start, e: i, line });
      continue;
    }
    // identifiers / keywords
    if (isIdStart(c)) {
      i++;
      while (i < n && isIdPart(src.charCodeAt(i))) i++;
      toks.push({ t: "id", v: src.slice(start, i), s: start, e: i, line });
      continue;
    }
    // punctuators (canonical, zero-alloc)
    const p = punctAt(src, i, n);
    if (p !== null) { toks.push({ t: "p", v: p, s: start, e: i + p.length, line }); i += p.length; continue; }
    toks.push({ t: "p", v: c < 128 ? CH[c] : src.slice(i, i + 1), s: start, e: i + 1, line });
    i++;
  }
  toks.push({ t: "eof", v: "", s: n, e: n, line });
  return toks;
}

// bracket pairing -> close[]/open[] (Int32Array, -1 if none) + per-token bracket depth sd[]
function bracketMap(toks) {
  const n = toks.length;
  const close = new Int32Array(n).fill(-1);
  const open = new Int32Array(n).fill(-1);
  const sd = new Int32Array(n);
  const stack = new Int32Array(n);
  let sp = 0, d = 0;
  for (let i = 0; i < n; i++) {
    const v = toks[i].v;
    sd[i] = d;
    if (v === "(" || v === "[" || v === "{") { stack[sp++] = i; d++; continue; }
    if (v === ")" || v === "]" || v === "}") {
      if (d > 0) d--;
      if (sp > 0) {
        const o = stack[--sp];
        const ov = toks[o].v;
        if ((v === ")" && ov === "(") || (v === "]" && ov === "[") || (v === "}" && ov === "{")) {
          close[o] = i;
          open[i] = o;
        }
      }
    }
  }
  return { close, open, sd };
}

// find matching close token index for an open bracket at index i (-1 if none)
function findClose(toks, i) {
  const v = toks[i].v;
  const want = v === "(" ? ")" : v === "[" ? "]" : "}";
  let depth = 0;
  for (let j = i; j < toks.length; j++) {
    const jj = toks[j].v;
    if (jj === v) depth++;
    else if (jj === want) { depth--; if (depth === 0) return j; }
  }
  return -1;
}

// Is this "(" a parameter list? (function/method/arrow/catch params)
// cached: paramFlag[i] 0=unknown 1=yes 2=no
function isParamList(toks, i, closeIdx, closeArr, paramFlag) {
  if (paramFlag[i]) return paramFlag[i] === 1;
  let res = false;
  const prev = toks[i - 1];
  if (prev && prev.t === "id" && NOT_PARAM_PREV.has(prev.v)) {
    res = false;
  } else {
    const after = toks[closeIdx + 1];
    if (!after) res = false;
    else if (after.v === "{" || after.v === "=>") res = true;
    else if (after.v === ":") {
      // return type follows: confirm by walking back
      let j = i - 1, depth = 0;
      res = true;
      while (j >= 0) {
        const t = toks[j];
        const tv = t.v;
        if (tv === ")" || tv === "]" || tv === "}") depth++;
        else if (tv === "(" || tv === "[" || tv === "{") { if (depth === 0) { j--; continue; } depth--; }
        else if (depth === 0) {
          if (tv === "?") { res = false; break; }
          if (t.t === "id" && WALK_STOP_NOT_PARAM.has(tv)) { res = false; break; }
          if (tv === ";" || tv === "{" || tv === "}" || tv === "=" || tv === ":" || tv === "," || j === 0) break;
        }
        j--;
      }
    }
  }
  paramFlag[i] = res ? 1 : 2;
  return res;
}

// find statement end index (inclusive) starting at `from`
const TYPE_CONT = new Set(["extends", "keyof", "infer", "readonly", "new", "typeof", "is", "asserts", "unique", "out"]);
const STMT_END_ID = new Set(["return", "throw", "break", "continue", "case", "var", "let", "const", "function", "class", "if", "for", "while", "do", "switch", "try", "import", "export", "debugger"]);

function stmtEnd(toks, from) {
  let depth = 0;
  const fromLine = toks[from].line;
  for (let i = from; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === "eof") return i - 1;
    const v = t.v;
    if (v === "(" || v === "[" || v === "{") depth++;
    else if (v === ")" || v === "]" || v === "}") {
      if (depth === 0) return i - 1;
      depth--;
    } else if (v === ";" && depth === 0) return i;
    else if (depth === 0 && i > from && t.line !== fromLine && toks[i - 1].line < t.line) {
      // first token of a new line: possible ASI boundary
      const pt = toks[i - 1], pv = pt.v;
      const endsStmt = pt.t === "id" || pt.t === "num" || pt.t === "str" || pt.t === "tpl" ||
        pv === ")" || pv === "]" || pv === "}" || pv === "this" || pv === "super" ||
        pv === "true" || pv === "false" || pv === "null";
      if (endsStmt) {
        if (t.t === "id" && !TYPE_CONT.has(v)) return i - 1;
        if (t.t === "str" || t.t === "num" || t.t === "tpl") return i - 1;
        if (STMT_END_ID.has(v)) return i - 1;
      } else if (t.t === "id" && STMT_END_ID.has(v)) return i - 1;
    }
  }
  return toks.length - 2;
}

// End of an `import/export { ... }` statement: specifier braces (+ optional
// `from "mod"`); import attributes after the module string are left intact.
function impExpEnd(toks, i, closeArr) {
  const bOpen = toks[i + 1] && toks[i + 1].v === "{" ? i + 1 : i + 2;
  const close = closeArr[bOpen];
  if (close < 0) return stmtEnd(toks, i);
  let j = close + 1;
  if (toks[j] && toks[j].v === "from") {
    j++;
    while (j < toks.length && toks[j].t !== "str" && toks[j].t !== "eof") j++;
    if (toks[j] && toks[j].t === "str") j++;
  }
  if (toks[j] && toks[j].v === ";") return j;
  return j - 1;
}

// parse `interface X ... { }` / `type X = ...;` / `declare ...` / `enum`
function stripDeclaration(toks, i, del, closeArr, replAt) {
  const kw = toks[i].v;
  if (kw === "interface") {
    let j = i;
    while (j < toks.length && toks[j].v !== "{") j++;
    const end = closeArr[j];
    if (end < 0) return;
    for (let k = i; k <= end; k++) del[k] = 1;
    if (toks[end + 1] && toks[end + 1].v === ";") del[end + 1] = 1;
    return;
  }
  if (kw === "type" || kw === "declare" || kw === "namespace") {
    const end = stmtEnd(toks, i);
    for (let k = i; k <= end; k++) del[k] = 1;
    return;
  }
  if (kw === "enum") {
    // enum X { A, B = 1 }  ->  const X = { A: 0, B: 1 }
    let j = i + 1;
    while (j < toks.length && toks[j].t !== "id") j++;
    const name = toks[j] ? toks[j].v : "Enum";
    let b = j;
    while (b < toks.length && toks[b].v !== "{") b++;
    const end = closeArr[b];
    if (end < 0) return;
    const body = [];
    let auto = 0;
    for (let k = b + 1; k < end; k++) {
      if (toks[k].t === "id") {
        const key = toks[k].v;
        let val = auto;
        if (toks[k + 1] && toks[k + 1].v === "=") {
          const lit = toks[k + 2];
          if (lit && (lit.t === "num" || lit.t === "str")) {
            val = lit.t === "num" ? Number(lit.v) : lit.v;
            if (typeof val === "number") auto = val;
            k += 2;
          } else { k += 1; }
        }
        body.push(JSON.stringify(key) + ":" + (typeof val === "number" ? val : val));
        auto++;
      }
    }
    replAt[i] = "const " + name + "={" + body.join(",") + "}";
    if (i > 0 && toks[i - 1].v === "const") del[i - 1] = 1; // `const enum` -> keep one `const`
    for (let k2 = i; k2 <= end; k2++) del[k2] = 1;
    return;
  }
}

// When skipType stops mid-token (fused `>>=`/`>=` closers), record how many
// leading chars of that token must be deleted. Consumed by callers after skipType.
let SPLIT_TOK = -1;
let SPLIT_CHARS = 0;

// skip a type expression starting at index i; returns index of last consumed token
function skipType(toks, i, stopSet) {
  let depth = 0, j = i;
  const m = toks.length;
  while (j < m) {
    const t = toks[j];
    if (t.t === "eof") return j - 1;
    const v = t.v;
    if (depth === 0 && j > i) {
      const prev = toks[j - 1];
      if (prev.line < t.line) {
        // first token on a new line — if the previous token ended a statement,
        // a bare id/str/num here can't continue the type (e.g. `x: T\ny: U`).
        const pv = prev.v;
        if (!(pv === "as" || pv === "satisfies")) {
          const endsStmt = prev.t === "id" || prev.t === "num" || prev.t === "str" || prev.t === "tpl" ||
            pv === ")" || pv === "]" || pv === "}" || pv === "true" || pv === "false" ||
            pv === "null" || pv === "this" || pv === "super";
          if (endsStmt) {
            if (t.t === "id" && !TYPE_CONT.has(v)) return j - 1;
            if (t.t === "str" || t.t === "num" || t.t === "tpl") return j - 1;
          }
        }
      }
    }
    if (depth === 0 && stopSet.has(v)) {
      // `{` may be an object type in a return position: `): {a: number} {`
      if (v === "{") {
        const close = findClose(toks, j);
        const after = close >= 0 ? toks[close + 1] : null;
        if (after && (after.v === "{" || after.v === "=>")) { j = close + 1; continue; }
      }
      return j - 1;
    }
    if (v === "<" || v === "(" || v === "[" || v === "{") depth++;
    else if (v === ">" || v === ")" || v === "]" || v === "}") {
      if (depth === 0) return j - 1;
      depth--;
    }
    else if (v === ">>" || v === ">>=" || v === ">=") {
      // fused generic closers: `Map<string, Array<number>>`, `Array<number>= x`
      if (depth === 0) return j - 1;
      const k = v === ">=" ? 1 : 2;
      if (depth >= k) {
        depth -= k;
        if (v.length > k) { SPLIT_TOK = j; SPLIT_CHARS = k; return j; } // keep `=` suffix
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

// Does the `:` at index i belong to a ternary (`a ? b() : c`) rather than a
// return/annotation type? Walks back at bracket-depth 0 looking for `?`.
function isTernaryBefore(toks, i, del) {
  let j = i - 1, depth = 0;
  while (j >= 0) {
    if (del && del[j]) { j--; continue; } // already stripped (e.g. optional `?`)
    const t = toks[j];
    const v = t.v;
    if (v === ")" || v === "]" || v === "}") { depth++; j--; continue; }
    if (v === "(" || v === "[" || v === "{") {
      if (depth === 0) return false; // `:` sits inside this group; its head has no same-level `?`
      depth--; j--; continue;
    }
    if (depth === 0) {
      if (v === "?") return true;
      if (v === ";" || v === "{" || v === "}" || v === "=" || v === "," || v === "=>" || v === ":") return false;
      if (t.t === "id") {
        if (v === "return" || v === "case" || v === "default" || v === "break" || v === "continue" || v === "throw") return false;
      }
      if (t.t === "eof") return false;
    }
    j--;
  }
  return false;
}

// Is the `:` at i the 2nd+ declarator of a var statement (`let a: T = 1, b: U`)?
// Walks back from the `,` before the name at bracket-depth 0 looking for
// let/const/var; stops at statement boundaries and non-ternary colons.
function isVarDeclBefore(toks, i, del) {
  let j = i - 2, depth = 0; // i-1 is the declarator name
  while (j >= 0) {
    if (del && del[j]) { j--; continue; }
    const t = toks[j];
    const v = t.v;
    if (v === ")" || v === "]" || v === "}") { depth++; j--; continue; }
    if (v === "(" || v === "[" || v === "{") {
      if (depth === 0) return false;
      depth--; j--; continue;
    }
    if (depth === 0) {
      if (v === "let" || v === "const" || v === "var") return true;
      if (v === ";") return false;
      if (v === "=>" || v === "?" || v === "case") return false;
      if (v === ":") { if (isTernaryBefore(toks, j, del)) { j--; continue; } return false; }
      if (t.t === "id" && (v === "return" || v === "default" || v === "break" ||
        v === "continue" || v === "throw" || v === "function" || v === "class" ||
        v === "export" || v === "import")) return false;
      // ASI boundary: prev token ends a statement and next starts a new line —
      // but a `,` at j+1 continues the declarator list across the break.
      if (t.line < toks[j + 1].line && toks[j + 1].v !== ",") {
        const nv = t.v;
        const endsStmt = t.t === "id" || t.t === "num" || t.t === "str" || t.t === "tpl" ||
          nv === ")" || nv === "]" || nv === "}" || nv === "true" || nv === "false" ||
          nv === "null" || nv === "this" || nv === "super";
        if (endsStmt) return false;
      }
    }
    j--;
  }
  return false;
}

// First `{` that opens a class body after the `class` token at i (angle-aware
// so `extends B<{x: 1}>` doesn't confuse us). -1 if not a class declaration.
function findClassBody(toks, i) {
  let angle = 0;
  for (let j = i + 1; j < toks.length; j++) {
    const t = toks[j];
    if (t.t === "eof") return -1;
    const v = t.v;
    if (v === "{" && angle === 0) return j;
    if (v === "<") angle++;
    else if (v === ">") { if (angle > 0) angle--; }
    else if (v === ">>") { angle = angle >= 2 ? angle - 2 : 0; }
    else if (v === ";" || v === "=" || v === "(" || v === ")") return -1;
    else if (t.t === "id" && (v === "function" || v === "var" || v === "let" || v === "const")) return -1;
  }
  return -1;
}

// Is the `:`/`?` at i in member-DECLARATION position (name preceded by a class
// body boundary / modifier), not inside a field initializer expression?
function memberBoundaryOk(toks, i, openOf) {
  let nameIdx = i - 1;
  if (nameIdx < 0) return false;
  const nv = toks[nameIdx].v;
  if (nv === "?") nameIdx--;                 // `x?: T`
  else if (nv === "]") {                     // `[k]: T`
    const o = openOf[nameIdx];
    if (o < 0) return false;
    nameIdx = o;
  }
  if (nameIdx <= 0) return true;
  const b = toks[nameIdx - 1];
  const bv = b.v;
  if (bv === "{" || bv === ";" || bv === "}" || bv === "#") return true;
  if (b.t === "id" && (MODIFIERS.has(bv) || bv === "async" || bv === "get" || bv === "set" ||
    bv === "static" || bv === "abstract")) return true;
  return false;
}

// Start index of the signature statement whose params `)` is at closeIdx
// (`m(): void;` / `abstract m(): T;` / `function f(a): T;`), or -1.
function sigStart(toks, closeIdx, openOf) {
  let j = openOf[closeIdx];
  if (j <= 0) return -1;
  j--;
  let nameSeen = false, includeKw = false;
  while (j >= 0) {
    const t = toks[j];
    const v = t.v;
    if (t.t === "id") {
      if (v === "function" || v === "class") { includeKw = true; j--; break; }
      if (v === "export" || v === "default" || v === "declare" || v === "async") {
        if (!includeKw && !nameSeen) return -1;
        j--;
        continue;
      }
      nameSeen = true;
      j--;
      continue;
    }
    if (v === "?" || v === "*" || v === "#") { j--; continue; }
    if (v === "]") {
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
    while (j >= 0 && toks[j].t === "id" &&
      (toks[j].v === "export" || toks[j].v === "default" || toks[j].v === "declare" || toks[j].v === "async")) j--;
    return j + 1;
  }
  if (j < 0) return -1;
  const bv = toks[j].v;
  if (bv === "{" || bv === ";" || bv === "}") return j + 1;
  return -1;
}

// skipType + mark the `:` (or `as`) at index i through the type end as deleted,
// applying any mid-token split skipType recorded.
function markType(toks, i, stopSet, del, partial) {
  SPLIT_TOK = -1;
  const end = skipType(toks, i + 1, stopSet);
  for (let k = i; k <= end; k++) del[k] = 1;
  if (SPLIT_TOK >= i && SPLIT_TOK <= end) partial[SPLIT_TOK] = SPLIT_CHARS;
  SPLIT_TOK = -1;
  return end;
}

/**
 * compile(src) -> { code, stats }
 * Removes TS syntax; leaves plain JS untouched (byte-identical for pure JS).
 */
function compile(src) {
  const toks = tokenize(src);
  const { close: closeArr, open: openOf, sd } = bracketMap(toks);
  const n = toks.length;
  const del = new Uint8Array(n);
  const partial = new Uint8Array(n); // leading chars to delete from token (fused closers)
  const replAt = new Array(n).fill(undefined);
  const paramFlag = new Uint8Array(n);

  const IMPORT_EXPORT_TYPE = 1;
  const DECL = 2;
  const ABSTRACT_CLASS = 3;
  const ENUM = 4;
  const IMPLEMENTS = 5;
  const PARAMS = 6;
  const RETURN_OR_VAR = 7;
  const AS = 8;
  const NOTNULL = 9;
  const MODIFIER = 10;
  const OPT_MEMBER = 11;
  const IMPORT_EXPORT_BRACES = 12;
  const MEMBER_TYPE = 13;

  // pass 1: classify + mark deletions
  const classStack = []; // {end, memberSd} of open class bodies
  for (let i = 0; i < n; i++) {
    if (del[i]) continue;
    const t = toks[i];
    const v = t.v;

    while (classStack.length && classStack[classStack.length - 1].end < i) classStack.pop();
    let memberPos = false;
    if (classStack.length) {
      const top = classStack[classStack.length - 1];
      memberPos = sd[i] === top.memberSd;
    }
    // class declarations: remember body extent for member-position checks
    if (t.t === "id" && v === "class" && (!toks[i - 1] || toks[i - 1].v !== ".")) {
      const nx = toks[i + 1];
      if (nx && (nx.t === "id" || nx.v === "{")) {
        const b = findClassBody(toks, i);
        if (b >= 0 && closeArr[b] >= 0) classStack.push({ end: closeArr[b], memberSd: sd[b] + 1 });
      }
    }

    // import/export statements: handle wholesale (also protects `as` aliases)
    let kind = 0;
    if (v === "import" || v === "export") {
      const nx = toks[i + 1];
      if (nx && nx.v === "type") kind = IMPORT_EXPORT_TYPE;
      else if (nx && nx.v === "{") kind = IMPORT_EXPORT_BRACES;
    }
    if (!kind) {
      const prev = toks[i - 1];
      if (t.t === "id" && TYPE_START_KW.has(v)) {
        // statement start, possibly preceded by export/declare (and const for `const enum`)
        let k = i - 1;
        while (k >= 0) {
          const pv = toks[k].v;
          if (pv === "export" || pv === "declare" || (v === "enum" && pv === "const")) k--;
          else break;
        }
        const nx = toks[i + 1];
        if (nx && nx.t === "id" &&
            (k < 0 || toks[k].v === ";" || toks[k].v === "{" || toks[k].v === "}" || toks[k].t === "eof")) kind = DECL;
      }
      else if (v === "abstract" && toks[i + 1] && toks[i + 1].v === "class") kind = ABSTRACT_CLASS;
      else if (v === "implements") kind = IMPLEMENTS;
      else if (v === "(") {
        const close = closeArr[i];
        if (close >= 0 && isParamList(toks, i, close, closeArr, paramFlag)) kind = PARAMS;
      }
      else if (v === ":") {
        const prevTok = toks[i - 1];
        if (prevTok && (prevTok.v === ")" || prevTok.v === ">")) {
          if (!isTernaryBefore(toks, i, del)) kind = RETURN_OR_VAR;
        }
        else if (prevTok && prevTok.t === "id" && !KEYWORDS.has(prevTok.v)) {
          const before = toks[i - 2];
          if (before && (before.v === "let" || before.v === "const" || before.v === "var")) kind = RETURN_OR_VAR;
          else if (before && before.v === "," && isVarDeclBefore(toks, i, del)) kind = RETURN_OR_VAR; // `let a: T = 1, b: U`
          else if (memberPos && memberBoundaryOk(toks, i, openOf)) kind = MEMBER_TYPE;
        }
        else if (memberPos && prevTok && (prevTok.t === "id" || prevTok.v === "?" || prevTok.v === "]") &&
                 memberBoundaryOk(toks, i, openOf)) kind = MEMBER_TYPE;
      }
      else if ((v === "as" || v === "satisfies") && t.t === "id") {
        const before = toks[i - 1];
        if (before && (before.t === "id" || before.v === ")" || before.v === "]" || before.v === "}" ||
            before.v === ">" || before.v === "!" || before.t === "num" || before.t === "str" || before.t === "tpl" || before.v === "this" || before.v === "super")) {
          const bv = before.t === "id" ? before.v : "";
          if (!(bv === "import" || bv === "export" || bv === "from")) kind = AS;
        }
      }
      else if (v === "!") {
        const before = toks[i - 1], after = toks[i + 1];
        if (before && (before.t === "id" || before.v === ")" || before.v === "]" || before.t === "num" || before.t === "str" || before.t === "tpl" || before.v === "this") &&
            after) {
          const av = after.v;
          if (av === "." || av === "[" || av === "(" || av === ";" || av === ")" || av === "," || av === "}" || av === ":" || av === "=" || av === "?" || av === "eof" || after.t === "id" || av === "!" || av === "+") kind = NOTNULL;
        }
      }
      else if (t.t === "id" && MODIFIERS.has(v)) {
        const before = toks[i - 1], after = toks[i + 1];
        const memberStart = !before || before.v === "{" || before.v === ";" || before.v === "}" ||
          (before.t === "id" && MODIFIERS.has(before.v));
        if (memberStart && after && (after.t === "id" || after.v === "*" || after.v === "#" || after.v === "[")) kind = MODIFIER;
      }
      else if (v === "?" && toks[i - 1] && toks[i - 1].t === "id" && toks[i + 1] &&
        (toks[i + 1].v === ":" || toks[i + 1].v === ";" ||
         (toks[i + 1].v === "(" && memberPos && memberBoundaryOk(toks, i, openOf)))) {
        kind = OPT_MEMBER;
      }
    }

    switch (kind) {
      case IMPORT_EXPORT_TYPE: {
        const nx = toks[i + 1];
        const isBraces = nx.v === "{" || (toks[i + 2] && toks[i + 2].v === "{");
        const end = isBraces ? impExpEnd(toks, i, closeArr) : stmtEnd(toks, i);
        for (let k = i; k <= end; k++) del[k] = 1;
        i = end;
        break;
      }
      case IMPORT_EXPORT_BRACES: {
        // `import { type A, B } from` / `export { type A, B }` — strip type-only
        // specifiers; jump past the statement so `as` aliases are never re-classified.
        const bOpen = toks[i + 1].v === "{" ? i + 1 : i + 2;
        const close = closeArr[bOpen];
        if (close >= 0) {
          for (let k = bOpen + 1; k < close; k++) {
            if (toks[k].t === "id" && toks[k].v === "type") {
              const nx = toks[k + 1], nx2 = toks[k + 2];
              if (nx && nx.t === "id" && nx2 && (nx2.v === "," || nx2.v === "}")) {
                del[k] = 1;
                del[k + 1] = 1;
                if (nx2.v === ",") { del[k + 2] = 1; k += 2; }
                else if (toks[k - 1].v === ",") del[k - 1] = 1;
              }
            }
          }
        }
        i = impExpEnd(toks, i, closeArr);
        break;
      }
      case DECL:
      case ENUM:
        stripDeclaration(toks, i, del, closeArr, replAt);
        break;
      case ABSTRACT_CLASS:
        del[i] = 1;
        break;
      case IMPLEMENTS: {
        let j = i;
        while (j < n && toks[j].v !== "{") j++;
        for (let k = i; k < j; k++) del[k] = 1;
        i = j - 1;
        break;
      }
      case PARAMS: {
        const close = closeArr[i];
        let depth = 0;
        for (let j = i + 1; j < close; j++) {
          const p = toks[j];
          const pv = p.v;
          if (pv === "(" || pv === "[" || pv === "{") depth++;
          else if (pv === ")" || pv === "]" || pv === "}") depth--;
          else if (depth === 0) {
            if (pv === ":") {
              const end = markType(toks, j, STOP_PARAM, del, partial);
              j = end;
            } else if (pv === "?") {
              const nx = toks[j + 1];
              if (nx && (nx.v === ":" || nx.v === ")")) del[j] = 1;
            } else if (MODIFIERS.has(pv)) {
              const nx = toks[j + 1];
              if (nx && nx.t === "id") del[j] = 1;
            }
          }
        }
        break;
      }
      case RETURN_OR_VAR: {
        const prevTok = toks[i - 1];
        const isReturn = prevTok && (prevTok.v === ")" || prevTok.v === ">");
        const end = markType(toks, i, isReturn ? STOP_RETURN : STOP_VAR, del, partial);
        // bodyless signature: `m(): void;` / `function f(a): T;` — the whole
        // statement is TS-only (overload / abstract member / interface-style sig)
        if (isReturn && end + 1 < n && toks[end + 1].v === ";") {
          const start = sigStart(toks, i - 1, openOf);
          if (start >= 0) {
            for (let k = start; k <= end + 1; k++) del[k] = 1;
            i = end + 1;
            break;
          }
        }
        i = end;
        break;
      }
      case MEMBER_TYPE: {
        const end = markType(toks, i, STOP_MEMBER, del, partial);
        i = end;
        break;
      }
      case AS: {
        const end = markType(toks, i, STOP_AS, del, partial);
        i = end;
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
  let anyDel = false;
  for (let i = 0; i < n; i++) if (del[i]) { anyDel = true; break; }
  if (!anyDel) return { code: src, stats: { tokens: n, removed: 0 } };

  // pass 2: emit, cutting deleted ranges, applying replacements
  let out = "";
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const tk = toks[i];
    const r = replAt[i];
    if (r !== undefined) {
      out += src.slice(pos, tk.s) + r;
      pos = tk.e;
      while (i + 1 < n && del[i + 1]) { i++; pos = toks[i].e; }
    } else if (del[i]) {
      if (tk.s < pos) continue;
      out += src.slice(pos, tk.s);
      pos = partial[i] ? tk.s + partial[i] : tk.e;
    }
  }
  out += src.slice(pos);
  return { code: out, stats: { tokens: n, removed: countDel(del, n) } };
}

function countDel(del, n) {
  let c = 0;
  for (let i = 0; i < n; i++) c += del[i];
  return c;
}

module.exports = { compile, tokenize, bracketMap };
