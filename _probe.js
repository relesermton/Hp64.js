"use strict";
// probe known edge cases — validates output with esbuild (parses ESM + JS)
const { compile } = require("./Compiler.js");
const esbuild = require("esbuild");

const cases = {
  "export const enum": "export const enum K { A, B = 2 }\nconsole.log(K.A);",
  "export interface": "export interface I { a: number }\nconst x = 1;",
  "ternary paren else": "const r = c ? foo() : x;\nconsole.log(r);",
  "ternary or-chain": "const r = a || b ? foo() : x;\nconsole.log(r);",
  "import as alias": "import { a as b } from 'm';\nconsole.log(b);",
  "export {type A, B}": "const A = 1, B = 2;\nexport { type A, B };",
  "export {A, type B}": "const A = 1, B = 2;\nexport { A, type B };",
  "import {type A, B}": "import { type A, B } from 'm';\nconsole.log(B);",
  "optional method": "class A { m?(): void {} }",
  "optional prop": "class A { x?: number = 1; }",
  "class field": "class A { x: number = 1; y: string; }",
  "class field nested obj": "class A { m() { const o = { a: 1, b: 'x' }; return o; } }",
  "multi decl types": "let a: number = 1, b: string = 'x';\nconsole.log(a, b);",
  "for-of annotated": "for (const x: number of [1,2]) console.log(x);",
  "for-in annotated": "for (const k: string in {}) console.log(k);",
  "abstract method sig": "abstract class A { abstract m(): void; }",
  "abstract prop sig": "abstract class A { abstract x: number; }",
  "overload sig": "function f(a: number): string;\nfunction f(a: any): any { return a; }\nconsole.log(f(1));",
  "unary not after paren": "if (c) !x;",
  "nested generics": "const m: Map<string, Array<number>> = new Map();",
  "gen assign": "const x: Array<number>= [1, 2];\nconsole.log(x);",
  "triple nested": "const m: Map<string, Array<Map<string, number>>> = new Map();",
  "label": "loop: for(;;) break loop;",
  "obj literal keys": "const o = { type: 1, declare: 2, interface: 3, enum: 4 };\nconsole.log(o);",
  "let named type": "const type = 5;\nconsole.log(type);",
  "return type obj": "function f(): { a: number } { return { a: 1 }; }\nconsole.log(f());",
  "arrow ret type": "const f = (a: number): string => String(a);\nconsole.log(f(1));",
  "import type stmt": "import type { A } from 'm';\nconsole.log(1);",
  "export type alias": "export type X = A | B;\nexport type Y = { a: string };",
  "type continuation": "type X = T\n  extends Array<string> ? 1 : 2;\nconst v: X = 1;\nconsole.log(v);",
  "asi import": "import { a } from 'm'\nconsole.log(a)",
  "namespace declare": "declare namespace N { const x: number; }\nconst y = 1;",
  "chained ternary": "const r = a ? b() : c ? d() : e;\nconsole.log(r);",
  "optional chain ternary": "const r = f(a ? b() : c);\nconsole.log(r);",
};

let pass = 0, fail = 0;
for (const [name, src] of Object.entries(cases)) {
  const out = compile(src).code;
  let parse = "OK";
  try {
    esbuild.transformSync(out, { loader: "js" });
  } catch (e) { parse = "PARSE-FAIL: " + String(e.message).split("\n")[0].slice(0, 70); }
  const hasTS = /\binterface\s+\w|\benum\s+\w|\bdeclare\s+\w|abstract\s+\w/.test(out) ||
    /:\s*(number|string|void|boolean|Map|Array|Promise|unknown|any)\b/.test(out.replace(/["'`].*?["'`]/g, ""));
  const ok = parse === "OK" && !hasTS;
  if (ok) pass++; else fail++;
  console.log(`--- ${name} [${ok ? "PASS" : parse + (hasTS ? " TS-LEAK" : "")}]`);
  if (!ok) {
    console.log("  in: ", JSON.stringify(src.split("\n")[0]));
    console.log("  out:", JSON.stringify(out.split("\n").slice(0, 3).join(" | ")));
  }
}
console.log(`\n${pass} pass, ${fail} fail`);
