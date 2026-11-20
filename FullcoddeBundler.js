"use strict";
// FullcoddeBundler.js - "fullcode" bundler: concatenates the ENTIRE program
// into a single scope (no module runtime), for max execution speed.
// Imports are flattened: each module's exports are inlined as unique names.

const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const { resolve, findImports } = require("./Bundler.js");
const { compileFull } = require("./FullcodeCompiler.js");

/**
 * bundleFull(entryPath, opts) -> { code, stats }
 * Walks the import graph (same as Bundler), then emits one flat script:
 *   - modules in dependency order
 *   - `import {x} from './m'` becomes `const x = __mN_x;` (name-mangled)
 *   - `export` declarations are hoisted to top-level consts
 */
function bundleFull(entryPath, opts = {}) {
  const entry = path.resolve(entryPath);
  const t0 = performance.now();
  const order = [];
  const seen = new Set();
  // DFS post-order: dependencies emitted before dependents, entry last
  function walk(f) {
    if (seen.has(f)) return;
    seen.add(f);
    const src = fs.readFileSync(f, "utf8");
    for (const spec of findImports(src)) {
      const r = resolve(spec, path.dirname(f));
      if (r) walk(r);
    }
    order.push({ file: f, src, isEntry: f === entry });
  }
  walk(entry);

  // emit: dependency-first, entry last
  const parts = [];
  const exportMap = new Map(); // abs file -> Map(localName -> mangled)

  for (const mod of order) {
    const source = (opts.stripped && opts.stripped.get(mod.file)) ||
      compile(mod.src, { filename: mod.file }).code;
    const prefix = mod.isEntry ? "" : "__" + sanitize(path.basename(mod.file)) + "_";
    const local = new Map();

    // mangle exported names and drop the export keyword (flat scope)
    let out = source.replace(/export\s+(const|let|var|function|class|async\s+function)\s+([\w$]+)/g,
      (m, kind, name) => { local.set(name, prefix + name); return `${kind} ${prefix}${name}`; });
    out = out.replace(/export\s+default\s+/g, "exports." + (mod.isEntry ? "default" : prefix + "default") + "=");
    out = out.replace(/export\s*\{[^}]*\}\s*;?/g, "");

    // rewrite imports to reference mangled exports of dependency modules
    out = out.replace(/import\s+\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]\s*;?/g, (m, names, spec) => {
      const depFile = resolve(spec, path.dirname(mod.file));
      const depLocal = exportMap.get(depFile) || new Map();
      const decls = names.split(",").map(s => s.trim()).filter(Boolean).map(pair => {
        const [a, b] = pair.split(/\s+as\s+/).map(s => s.trim());
        const target = depLocal.get(a) || a;
        return `const ${b || a}=${target};`;
      }).join("");
      return decls;
    });
    out = out.replace(/import\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]\s*;?/g, (m, d, spec) => {
      const depFile = resolve(spec, path.dirname(mod.file));
      const depLocal = exportMap.get(depFile) || new Map();
      return `const ${d}=${depLocal.get("default") || "undefined"};`;
    });
    out = out.replace(/import\s*['"]([^'"]+)['"]\s*;?/g, "");
    out = out.replace(/import\s+\*\s+as\s+[\w$]+\s+from\s*['"][^'"]+['"]\s*;?/g, "");

    exportMap.set(mod.file, local);
    if (!mod.isEntry) parts.push("// " + path.basename(mod.file) + "\n" + out);
    else parts.push(out);
  }

  let out = "(function(){\"use strict\";\n" + parts.join("\n") + "\n})();\n";
  out = compileFull(out, { dedupeRequires: false }).code; // final safety strip
  return { code: out, stats: { modules: order.length, fullcode: true, ms: +(performance.now() - t0).toFixed(2) } };
}

function sanitize(s) { return s.replace(/[^A-Za-z0-9]/g, "_"); }

module.exports = { bundleFull };
