// Compiler_Rule.ts - HP64.js compiler rule tables + classification (typed port
// of Compiler.js's interned-code tables and pass-1 candidate classifier).
//
// Everything here is a pure table/helper module: no I/O, no token store
// allocation. Numeric codes match Compiler.js exactly:
//   tv = 0 (plain id/str/num/tpl/eof) | charCode (1-char punct)
//      | 128+i (multi-char punct) | 256+i (keyword)

// ---------------------------------------------------------------------------
// Token kinds
// ---------------------------------------------------------------------------
export const T_EOF = 0, T_ID = 1, T_P = 2, T_STR = 3, T_NUM = 4, T_TPL = 5;
export type TokenKind = typeof T_EOF | typeof T_ID | typeof T_P | typeof T_STR | typeof T_NUM | typeof T_TPL;

export const TV_SIZE = 512;

// ---------------------------------------------------------------------------
// Multi-char punctuators: code = 128 + index (order defines codes)
// ---------------------------------------------------------------------------
export const MULTI: readonly string[] = [
  ">>>=", "===", "!==", "**=", "...", "<<=", ">>=", "&&=", "||=",
  "??=", "=>", "==", "!=", "<=", ">=", "&&", "||", "??", "++", "--",
  "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "**", "<<", ">>", "?.",
];

export const MULTI_IDX = new Map<string, number>();
for (let i = 0; i < MULTI.length; i++) MULTI_IDX.set(MULTI[i], 128 + i);

// ---------------------------------------------------------------------------
// Keywords: code = 256 + index
// ---------------------------------------------------------------------------
export const KW_LIST: readonly string[] = (
  "function class const let var if else for while do return break continue " +
  "new delete typeof void in of switch case default try catch finally throw import export " +
  "extends super this null true false instanceof yield await async static get set from " +
  "public private protected readonly abstract override declare accessor interface type enum " +
  "namespace with satisfies implements debugger keyof infer is asserts unique out as"
).split(" ");

export const KW_MAP = new Map<string, number>();
for (let i = 0; i < KW_LIST.length; i++) KW_MAP.set(KW_LIST[i], 256 + i);

export const K: Record<string, number> = Object.create(null);
for (const [w, c] of KW_MAP) K[w] = c;

// ---------------------------------------------------------------------------
// Literal -> packed code (1-char -> charCode, multi -> 128+i, word -> 256+i)
// ---------------------------------------------------------------------------
export function codeOfWord(w: string): number {
  if (w.length === 1 && w.charCodeAt(0) < 128) return w.charCodeAt(0);
  const m = MULTI_IDX.get(w);
  if (m !== undefined) return m;
  const k = KW_MAP.get(w);
  if (k !== undefined) return k;
  throw new Error("intern: unknown literal " + JSON.stringify(w));
}

export function flagsOf(words: Iterable<string>): Uint8Array {
  const f = new Uint8Array(TV_SIZE);
  for (const w of words) f[codeOfWord(w)] = 1;
  return f;
}

// ---------------------------------------------------------------------------
// Set -> numeric flag table (flag[tv] <=> old Set.has(v))
// ---------------------------------------------------------------------------
export const KWF = flagsOf(KW_LIST);                                       // KEYWORDS (superset)
export const MODWF = flagsOf(["public", "private", "protected", "readonly", "abstract", "override", "declare", "accessor"]);
export const TSF = flagsOf(["interface", "type", "enum", "declare", "namespace"]);  // TYPE_START_KW
export const NPF = flagsOf(["if", "while", "for", "switch", "with"]);       // NOT_PARAM_PREV
export const WSNF = flagsOf(["case", "default", "if", "while", "for", "switch", "with", "return", "throw"]);
export const TCF = flagsOf(["extends", "keyof", "infer", "readonly", "new", "typeof", "is", "asserts", "unique", "out"]);
export const SEF = flagsOf(["return", "throw", "break", "continue", "case", "var", "let", "const", "function", "class", "if", "for", "while", "do", "switch", "try", "import", "export", "debugger"]);
export const STOP_PARAM = flagsOf([",", ")", "=", "?"]);
export const STOP_RETURN = flagsOf(["{", "=>", ";", "="]);
export const STOP_VAR = flagsOf(["=", ";", ",", ")", "of", "in"]);          // of/in: for-heads `for (const x: T of y)`
export const STOP_AS = flagsOf([",", ";", ")", "]", "}", "=>", "?", ":", "=", "+", "-", "*", "/", "&&", "||", "==="]);
export const STOP_MEMBER = flagsOf(["=", ";", "}"]);

// v2's original KEYWORDS set (44 words, ends at "from"). Used ONLY where v2
// used KEYWORDS.has() — KWF is a superset and must not be substituted there.
export const KEYF = flagsOf(
  ("function class const let var if else for while do return break continue " +
   "new delete typeof void in of switch case default try catch finally throw import export " +
   "extends super this null true false instanceof yield await async static get set from").split(" ")
);

// ---------------------------------------------------------------------------
// 1-char punct codes (charCode) + multi codes used in hot compares
// ---------------------------------------------------------------------------
export const C_LP = 40, C_RP = 41, C_LB = 91, C_RB = 93, C_LBR = 123, C_RBR = 125;
export const C_SEMI = 59, C_COLON = 58, C_COMMA = 44, C_DOT = 46, C_EQ = 61;
export const C_QMARK = 63, C_BANG = 33, C_GT = 62, C_LT = 60, C_STAR = 42;
export const C_HASH = 35, C_PLUS = 43, C_MINUS = 45, C_SLASH = 47, C_AMP = 38, C_PIPE = 124;
export const M_ARROW = 138, M_EQEQEQ = 129, M_AMPAMP = 143, M_PIPEPIPE = 144;
export const M_SHR = 158, M_GE = 142, M_SHREQ = 134, M_SHL = 157, M_OROR = 144;

// ---------------------------------------------------------------------------
// Classification kinds (pass 1 of Compiler.js)
// ---------------------------------------------------------------------------
export const IMPORT_EXPORT_TYPE = 1;
export const DECL = 2;
export const ABSTRACT_CLASS = 3;
// (4 unused)
export const IMPLEMENTS = 5;
export const PARAMS = 6;
export const RETURN_OR_VAR = 7;
export const AS = 8;
export const NOTNULL = 9;
export const MODIFIER = 10;
export const OPT_MEMBER = 11;
export const IMPORT_EXPORT_BRACES = 12;
export const MEMBER_TYPE = 13;

export type Kind =
  | 0 | typeof IMPORT_EXPORT_TYPE | typeof DECL | typeof ABSTRACT_CLASS
  | typeof IMPLEMENTS | typeof PARAMS | typeof RETURN_OR_VAR | typeof AS
  | typeof NOTNULL | typeof MODIFIER | typeof OPT_MEMBER
  | typeof IMPORT_EXPORT_BRACES | typeof MEMBER_TYPE;

// ---------------------------------------------------------------------------
// Keyword lookup hash buckets over KW_LIST (zero-allocation, char-by-char)
// ---------------------------------------------------------------------------
export const KW_HEAD: Int32Array = new Int32Array(1024).fill(-1);
export const KW_NEXT: Int32Array = new Int32Array(KW_LIST.length);
for (let i = KW_LIST.length - 1; i >= 0; i--) {
  const w = KW_LIST[i];
  const h = (w.length * 31 + w.charCodeAt(0) * 7 + w.charCodeAt(w.length - 1)) & 1023;
  KW_NEXT[i] = KW_HEAD[h];
  KW_HEAD[h] = i;
}

/** Resolve an already-hashed identifier. 0 if not a keyword. */
export function kwResolve(h: number, src: string, s: number, len: number): number {
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

export function isIdStart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 36 || c === 95;
}
export function isIdPart(c: number): boolean {
  return (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 36 || c === 95;
}
export function isDigit(c: number): boolean { return c >= 48 && c <= 57; }

// Only these punctuators can ever start a classification (`(`, `:`, `!`, `?`);
// only keyword ids (tv >= 256) can take the word branches. Everything else is
// skipped by the classify prepass entirely.
export const CLSP = new Uint8Array(128);
CLSP[33] = CLSP[40] = CLSP[58] = CLSP[63] = 1; // ! ( : ?

// ---------------------------------------------------------------------------
// classifyCandidate - typed port of Compiler.js pass-1 kind decision
// (lines ~908-984). The structural walkers (isParamList, isTernaryBefore,
// isVarDeclBefore, memberBoundaryOk, findClassBody) are injected so this
// module stays a pure rules table.
// ---------------------------------------------------------------------------

/** Flat token store view (aliases the live typed arrays; see Compiler.js). */
export interface TokenStore {
  n: number;
  src: string;
  tt: Uint8Array;   // kinds
  ts: Int32Array;   // start offsets
  te: Int32Array;   // end offsets
  tl: Int32Array;   // line numbers
  tv: Int32Array;   // interned codes
  close: Int32Array;
  open: Int32Array;
  sd: Int32Array;   // bracket depth (before effect)
}

/** Structural helpers injected by the backend (see Compiler.js). */
export interface Walkers {
  findClassBody(T: TokenStore, i: number): number;
  isParamList(T: TokenStore, i: number, close: number, closeArr: Int32Array, paramFlag: Uint8Array, openOf: Int32Array): boolean;
  isTernaryBefore(T: TokenStore, i: number, del: Uint8Array, openOf: Int32Array): boolean;
  isVarDeclBefore(T: TokenStore, i: number, del: Uint8Array, openOf: Int32Array): boolean;
  memberBoundaryOk(T: TokenStore, i: number, openOf: Int32Array): boolean;
}

export interface ClassifyCtx {
  T: TokenStore;
  i: number;            // candidate index
  del: Uint8Array;      // deletion flags (read by isTernaryBefore/isVarDeclBefore)
  closeArr: Int32Array;
  paramFlag: Uint8Array;
  openOf: Int32Array;
  memberPos: boolean;
  walkers: Walkers;
}

/** Classify one candidate token. Returns 0 when the candidate is not TS syntax. */
export function classifyCandidate(c: ClassifyCtx): Kind {
  const { T, i, del, closeArr, paramFlag, openOf, memberPos, walkers: W } = c;
  const n = T.n, tv = T.tv, tt = T.tt;
  const v = tv[i], tk = tt[i];
  let kind: Kind = 0;

  if (tk === T_ID && v >= 256) {
    if (v === K.import || v === K.export) {
      const nx = i + 1 < n ? i + 1 : -1;
      if (nx >= 0 && tv[nx] === K.type) kind = IMPORT_EXPORT_TYPE;
      else if (nx >= 0 && tv[nx] === C_LBR) kind = IMPORT_EXPORT_BRACES;
    } else if (TSF[v]) {
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
    } else if (v === K.abstract && i + 1 < n && tv[i + 1] === K.class) kind = ABSTRACT_CLASS;
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
    } else if (MODWF[v]) {
      const bi = i - 1, ni = i + 1;
      const memberStart = bi < 0 || tv[bi] === C_LBR || tv[bi] === C_SEMI || tv[bi] === C_RP ||
        (tt[bi] === T_ID && MODWF[tv[bi]]);
      if (memberStart && ni < n && (tt[ni] === T_ID || tv[ni] === C_STAR || tv[ni] === C_HASH || tv[ni] === C_LB)) kind = MODIFIER;
    }
  } else if (tk === T_P) {
    if (v === C_LP) {
      const close = closeArr[i];
      if (close >= 0 && W.isParamList(T, i, close, closeArr, paramFlag, openOf)) kind = PARAMS;
    } else if (v === C_COLON) {
      const pi = i - 1;
      if (pi >= 0 && (tv[pi] === C_RP || tv[pi] === C_GT)) {
        if (!W.isTernaryBefore(T, i, del, openOf)) kind = RETURN_OR_VAR;
      } else if (pi >= 0 && tt[pi] === T_ID && !KEYF[tv[pi]]) {
        const bi = i - 2;
        if (bi >= 0 && (tv[bi] === K.let || tv[bi] === K.const || tv[bi] === K.var)) kind = RETURN_OR_VAR;
        else if (bi >= 0 && tv[bi] === C_COMMA && W.isVarDeclBefore(T, i, del, openOf)) kind = RETURN_OR_VAR; // `let a: T = 1, b: U`
        else if (memberPos && W.memberBoundaryOk(T, i, openOf)) kind = MEMBER_TYPE;
      } else if (memberPos && pi >= 0 && (tt[pi] === T_ID || tv[pi] === C_QMARK || tv[pi] === C_RB) &&
                 W.memberBoundaryOk(T, i, openOf)) kind = MEMBER_TYPE;
    } else if (v === C_BANG) {
      const bi = i - 1, ni = i + 1;
      if (bi >= 0 && ni < n) {
        const bt = tt[bi], bv = tv[bi], at = tt[ni], av = tv[ni];
        if ((bt === T_ID || bv === C_RP || bv === C_RB || bt === T_NUM ||
             bt === T_STR || bt === T_TPL || bv === K.this) &&
            (av === C_DOT || av === C_LB || av === C_LP || av === C_SEMI || av === C_RP ||
             av === C_COMMA || av === C_RBR || av === C_COLON || av === C_EQ || av === C_QMARK ||
             at === T_EOF || at === T_ID || av === C_BANG || av === C_PLUS)) kind = NOTNULL;
      }
    } else if (v === C_QMARK) {
      const pi = i - 1, ni = i + 1;
      if (pi >= 0 && tt[pi] === T_ID && ni < n &&
          (tv[ni] === C_COLON || tv[ni] === C_SEMI ||
           (tv[ni] === C_LP && memberPos && W.memberBoundaryOk(T, i, openOf)))) kind = OPT_MEMBER;
    }
  }
  return kind;
}
