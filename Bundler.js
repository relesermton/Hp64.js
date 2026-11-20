"use strict";
// Bundler.js - resolves import graph, compiles each module with Compiler.js,
// emits one self-contained JS file wrapped in a tiny module runtime.

const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const { compileChunked } = require("./Chunked.js"); // parallel for large modules; serial fallback

const EXTS = ["", ".go", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"];

function resolve(spec, fromDir) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return null; // external: keep as require
  const base = path.resolve(fromDir, spec);
  for (const ext of EXTS) {
    const p = base + ext;
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p;
    const idx = path.join(base, ext === "" ? "index.js" : "index" + ext);
    if (fs.existsSync(idx) && fs.statSync(idx).isFile()) return idx;
  }
  throw new Error("Cannot resolve '" + spec + "' from " + fromDir);
}

// find static/dynamic imports in raw source
function findImports(src) {
  const specs = [];
  const re = /(?:import\s+(?:[\w$]+\s*,\s*)?(?:\{[^}]*\}|\*\s+as\s+[\w$]+|[\w$]+)?\s*from\s*|import\s*\(\s*|require\s*\(\s*|export\s+(?:\{[^}]*\}|\*)\s*from\s*)['"]([^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) specs.push(m[1]);
  return specs;
}

// rewrite ESM import/export-from into the mini runtime's require()
function transformModules(code) {
  // import Default, { a as b } from 'x'  /  import * as ns from 'x'  /  import 'x'
  code = code.replace(/import\s+([\w$]+)\s*,\s*\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (m, d, names, spec) => `var ${d}=require(${JSON.stringify(spec)}).default||{};var {${renameList(names)}}=require(${JSON.stringify(spec)});`);
  code = code.replace(/import\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (m, ns, spec) => `var ${ns}=require(${JSON.stringify(spec)});`);
  code = code.replace(/import\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (m, names, spec) => `var {${renameList(names)}}=require(${JSON.stringify(spec)});`);
  code = code.replace(/import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (m, d, spec) => `var ${d}=require(${JSON.stringify(spec)}).default;`);
  code = code.replace(/import\s*['"]([^'"]+)['"]\s*;?/g,
    (m, spec) => `require(${JSON.stringify(spec)});`);
  // export ... from 'x'
  code = code.replace(/export\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g,
    (m, names, spec) => `var __r=require(${JSON.stringify(spec)});` +
      renameList(names).split(",").filter(Boolean).map(pair => {
        const [a, b] = pair.split(/\s+as\s+/).map(s => s.trim());
        return `exports.${b || a}=__r.${a};`;
      }).join(""));
  code = code.replace(/export\s+\*\s+from\s*['"]([^'"]+)['"]\s*;?/g,
    (m, spec) => `Object.assign(exports,require(${JSON.stringify(spec)}));`);
  // export { a, b as c } (local)
  code = code.replace(/export\s+\{([^}]*)\}\s*;?/g,
    (m, names) => renameList(names).split(",").filter(Boolean).map(pair => {
      const [a, b] = pair.split(/\s+as\s+/).map(s => s.trim());
      return `exports.${b || a}=${a};`;
    }).join(""));
  // export default X
  code = code.replace(/export\s+default\s+/g, "exports.default=");
  // export const/let/var/function/class  -> append export assignment
  code = code.replace(/export\s+(const|let|var|function|class|async function)\s+([\w$]+)/g,
    (m, kind, name) => `${kind} ${name}`);
  code = code.replace(/export\s+(const|let|var)\s+/g, "$1 ");
  // post-pass: after top-level declarations that were exported, assign exports
  return code;
}

function renameList(names) {
  return names.split(",").map(s => s.trim()).filter(Boolean).join(", ");
}

// collect exported names (pre-transform) so Builder can append exports.X=X
function findExports(code) {
  const names = new Set();
  let m;
  const re1 = /export\s+(?:const|let|var|function|class|async\s+function)\s+([\w$]+)/g;
  while ((m = re1.exec(code))) names.add(m[1]);
  const re2 = /export\s*\{([^}]*)\}/g;
  while ((m = re2.exec(code))) {
    for (const part of m[1].split(",")) {
      const s = part.trim(); if (!s) continue;
      const as = s.split(/\s+as\s+/);
      names.add((as[1] || as[0]).trim());
    }
  }
  if (/export\s+default\s*/.test(code)) names.add("default");
  return [...names];
}

/**
 * bundle(entryPath, opts) -> { code, modules: [{id, deps}] }
 */
function bundle(entryPath, opts = {}) {
  const entry = path.resolve(entryPath);
  const modules = new Map(); // abs path -> { id, code, deps: [{spec, id|null, external}] }
  const queue = [entry];
  const t0 = performance.now();

  while (queue.length) {
    const file = queue.shift();
    if (modules.has(file)) continue;
    const src = fs.readFileSync(file, "utf8");
    const isEntry = file === entry;
    // .go goes through the Go/WASM pipeline (compiler_Stack.go -> hp64stack.wasm);
    // until that lands, keep the source raw instead of running the TS stripper.
    const { code: compiled } = file.endsWith(".go")
      ? { code: src }
      : compileChunked(src, { filename: file });
    const exported = findExports(compiled);
    const specs = findImports(src);
    const deps = [];
    for (const spec of specs) {
      const resolved = resolve(spec, path.dirname(file));
      if (resolved) {
        deps.push({ spec, id: resolved, external: false });
        if (!modules.has(resolved)) queue.push(resolved);
      } else {
        deps.push({ spec, id: null, external: true });
      }
    }
    let code = transformModules(compiled);
    // rewrite relative specifiers to canonical absolute ids
    for (const d of deps) {
      if (!d.external && d.id) {
        code = code.split("require(" + JSON.stringify(d.spec) + ")")
                   .join("require(" + JSON.stringify(d.id) + ")");
      }
    }
    if (exported.length) {
      code += "\n;" + exported.map(n => n === "default"
        ? "exports.default=exports.default;"
        : `exports.${n}=${n};`).join("");
    }
    const id = isEntry ? path.join(path.dirname(entry), "__entry__") : file;
    modules.set(file, { id, code, deps, isEntry });
  }

  // topological-ish order: BFS already close; entry last
  const order = [...modules.values()].filter(m => !m.isEntry);
  const entryMod = [...modules.values()].find(m => m.isEntry);

  let out = "(function(){\"use strict\";\nvar __defs={},__cache={};\n";
  out += "function __req(id){if(__cache[id])return __cache[id].exports;var m=__cache[id]={exports:{}};__defs[id](m,m.exports,__req);return m.exports;}\n";
  for (const m of order.concat(entryMod ? [entryMod] : [])) {
    out += "__defs[" + JSON.stringify(m.id) + "]=function(module,exports,require){\n" + m.code + "\n};\n";
  }
  if (entryMod) out += "__req(" + JSON.stringify(entryMod.id) + ");\n";
  out += "})();\n";
  return { code: out, stats: { modules: modules.size, ms: +(performance.now() - t0).toFixed(2) } };
}

module.exports = { bundle, resolve, findImports };
