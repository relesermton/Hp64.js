"use strict";
// corecrt.js - CRT-style runtime helpers for HP64.js tools
// Minimal file/timer/process facilities shared by App.js and the builders.

const fs = require("fs");
const path = require("path");

function readText(p) { return fs.readFileSync(p, "utf8"); }
function readBytes(p) { return fs.readFileSync(p); }
function writeText(p, s) {
  const dir = path.dirname(p);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, s);
}
function writeBytes(p, buf) {
  const dir = path.dirname(p);
  if (dir && dir !== ".") fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(p, buf);
}
function exists(p) { return fs.existsSync(p); }
function fileSize(p) { return fs.statSync(p).size; }

function now() { return performance.now(); }
function fmtMs(ms) { return ms.toFixed(2) + "ms"; }
function fmtBytes(n) {
  if (n < 1024) return n + "B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + "KB";
  return (n / (1024 * 1024)).toFixed(1) + "MB";
}

function exit(code, msg) {
  if (msg) console.error(msg);
  process.exit(code);
}

module.exports = {
  readText, readBytes, writeText, writeBytes, exists, fileSize,
  now, fmtMs, fmtBytes, exit,
};
