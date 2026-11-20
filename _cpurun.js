"use strict";
// _cpurun.js - generate a CPU profile of the hot compile path.
const fs = require("fs");
const path = require("path");
const { compile } = require("./Compiler.js");
const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
for (let i = 0; i < 5; i++) compile(src); // JIT warmup
for (let i = 0; i < 200; i++) compile(src);
