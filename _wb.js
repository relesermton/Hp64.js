"use strict";
// _wb.js - main side: one worker vs this thread, identical source, same window.
const fs = require("fs");
const path = require("path");
const { Worker } = require("worker_threads");
const { compile } = require("./Compiler.js");
const src = fs.readFileSync(path.join(__dirname, "bench", "app.ts"), "utf8");
const ms = (a, b) => Number(b - a) / 1e6;
const w = new Worker(path.join(__dirname, "_WorkerBench.js"));
w.on("message", () => {
  const wall = [], cpu = [];
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint(), c = process.cpuUsage();
    compile(src);
    const d = process.cpuUsage(c);
    wall.push(ms(t, process.hrtime.bigint()));
    cpu.push((d.user + d.system) / 1000);
  }
  const tail = a => a.slice(-10).map(x => x.toFixed(1)).join(",");
  fs.writeSync(1, "MAIN   wall(last10): " + tail(wall) + "\n");
  fs.writeSync(1, "MAIN   cpu(last10): " + tail(cpu) + "\n");
  w.terminate();
  setTimeout(() => process.exit(0), 200);
});
w.postMessage({ src });
