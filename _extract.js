// _extract.js - pull the compiled GopherJS output out of the tool-output JSON
// and save it as dist/hp64stack.js
"use strict";
const fs = require("fs");
const path = require("path");

const src = process.argv[2];
const dst = process.argv[3] || path.join(__dirname, "dist", "hp64stack.js");

const raw = fs.readFileSync(src, "utf8");
let js;
try {
  const j = JSON.parse(raw);
  js = j.full || (j.value && j.value.full);
  if (!js) throw new Error("no 'full' field in JSON; keys=" + Object.keys(j).join(","));
} catch (e) {
  // maybe the file is the raw JS already
  if (raw.startsWith('"use strict"')) js = raw;
  else throw e;
}

fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, js, "utf8");
console.log("wrote", dst, js.length, "chars");
