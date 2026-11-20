"use strict";
// _WorkerBench.js - compile the same source in a worker 20x, report last 10
// wall times + CPU times, then compare a latin1 round-tripped copy (tests
// one-byte vs two-byte string representation after structured clone).
const { parentPort, workerData } = require("worker_threads");
const fs = require("fs");
const { compile } = require("./Compiler.js");
const log = (s) => fs.writeSync(1, s + "\n");
const ms = (a, b) => Number(b - a) / 1e6;

parentPort.on("message", (job) => {
  const src = job.src;
  const times = [], cpu = [], conv = [];
  for (let i = 0; i < 20; i++) {
    const t = process.hrtime.bigint(), c = process.cpuUsage();
    compile(src);
    const d = process.cpuUsage(c);
    times.push(ms(t, process.hrtime.bigint()));
    cpu.push((d.user + d.system) / 1000);
  }
  const copy = Buffer.from(src, "latin1").toString("latin1");
  for (let i = 0; i < 10; i++) {
    const t = process.hrtime.bigint();
    compile(copy);
    conv.push(ms(t, process.hrtime.bigint()));
  }
  const tail = a => a.slice(-10).map(x => x.toFixed(1)).join(",");
  log("WORKER wall(last10): " + tail(times));
  log("WORKER cpu(last10): " + tail(cpu));
  log("WORKER latin1copy(last10): " + tail(conv));
  parentPort.postMessage("done");
});
