"use strict";
const { compile } = require("./Compiler.js");
const cases = [
  "let a: T = 1, b: U = 2;",
  'const x: number = 1, y: string = "s";',
  "let a: T = 1, b: U = 2, c: V = 3;",
  "let first: A = 1;\nlet second: B = 2;",
];
for (const c of cases) {
  const r = compile(c);
  console.log(JSON.stringify(c), "->", JSON.stringify(r.code));
}
