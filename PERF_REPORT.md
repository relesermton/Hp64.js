# HP64.js — final performance & correctness report

Date: 2026-11-20

## Goal vs result

- **Goal:** ≥10x faster than esbuild on `bench/app.ts` (~9–13 ms vs esbuild ~93–156 ms).
- **Result:** **~4.4–6x** on this machine. 10x not reached.
- Root cause is hardware, not correctness: the box has **2 physical / 4 logical cores** and
  ran at **25–96% external load** throughout testing. Four worker threads therefore
  compete for two cores and the parallel speedup is cancelled by scheduling/bridge
  overhead. esbuild wall time moved 93 → 1,448 ms between runs; HP64 CPU time moved
  19 → 44 ms. All ratios below are from a single interleaved run.

## Final benchmark (post-cleanup, `node _vpar.js 12 4 1`)

```
validated: out=224985B chunks=4 target=96627B esbuildJS=237740B
           tokens=113201 removed=46400 cores=4
par wall    44.5  24.1  22.3  23.3   -> med 24.1 ms  min 22.3 ms
ser wall    41.7  27.9  21.6  24.2   -> med 27.9 ms  min 21.6 ms
ser cpu     36.5  26.0  20.8  23.5   -> med 26.0 ms  min 20.8 ms
esb wall   127.7 128.5 118.5  99.1   -> med 127.7 ms  min 99.1 ms
esbuild/serialCPU: 4.76x (mins)   esbuild/parallelWall: 4.44x (mins)
paired esb/par ratio: med 4.84x (p10 3.96x, p90 6.45x)
```

Historical best on this machine: **6.0x** ratio-of-mins (esbuild min vs HP64 CPU min).

## Correctness gates (all green after final changes)

| Gate | Result |
|---|---|
| `node App.js selftest` | 7/7 |
| `node _probe.js` | 34/34 |
| `node _chunktest.js` | 355 checks (71 inputs × 4 serial targets + forced-parallel); byte-identical to `compile()` |
| `node _bundletest.js` | demo + bench bundles valid JS; worker pool `unref()` → clean exit |
| `node _gjstest.js` | 500 fuzz + 5 real files; exact match vs `bracketMap` |
| `dist/hp64.exe selftest` | 7/7 (rebuilt SEA exe) |
| `dist/hp64.exe build demo/main.ts` | 2 modules, valid output |

## Architecture

- `Compiler.js` — v3 flat typed-array tokenizer + fused bracket pairing and
  candidate collection + no-AST fuse passes. Temporary `__HP64_PROF` / `__HP64_CNT`
  instrumentation removed.
- `Chunked.js` — split only after depth-0 `;`; chunks overlap by one `;` so
  backward walks stay byte-equivalent; `compileChunked()` is API-compatible with
  `compile()`. Large inputs (≥64 KB) use a persistent `worker_threads` pool;
  any failure falls back to serial. `HP64_POOL` overrides worker count.
- Reply bridge: **SharedArrayBuffer + Atomics**, because a MessagePort reply
  cannot reach a main thread blocked in `Atomics.wait` (proved by `_partest.js`).
  Workers write payload into their slot, then bump one monotonic counter; main
  blocks on that single cell (one wake-up per dispatch).
- `CompilerWorker.js` — worker entry. SEA/pkg builds skip pool creation entirely
  (`POOL_DISABLED`) to avoid a warmup timeout per module; single-file exe uses
  the serial path.
- `Bundler.js` — now calls `compileChunked()` for every module.
- Auxiliary: GopherJS pipeline (`compiler_Stack_gjs.go` → `dist/hp64stack.js`,
  verified), `.go` bundler rule, webVk `mem.mjs` TS-ism fixed + smoke test.

## Why 10x was not reached

- Profiling (`_cpurun.js` + `_prof.js`): tokenize 47% self, classify loop 24%,
  kwResolve 5%, everything else ≤4%. No low-risk 2x remains in the serial path.
- Parallel scaling needs ≥2 free physical cores. With 2 cores shared with other
  work, 2–4 workers deliver ≈1x vs serial (measured P=1,2,4). The compiler work
  itself is identical in workers and main (`_wb.js`).
- On a quiet 2-core box the expected ceiling is ~19.3 ms ÷ 2 ≈ 10 ms, which
  against esbuild's 93 ms would be ~9–10x. `_vpar.js` is ready to verify that.

## Reproduce

```
cd HP64.js
node App.js selftest && node _probe.js && node _chunktest.js
node _bundletest.js && node _gjstest.js
node _vpar.js 25 10        # interleaved par/serial/esbuild + paired ratios
HP64_POOL=2 node _vpar.js 25 10
```
