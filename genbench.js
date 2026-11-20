"use strict";
// genbench.js - generates bench/app.ts (a large realistic TS file)
const fs = require("fs");
const path = require("path");

let out = [];
out.push(`// generated benchmark - HP64.js vs the world`);
for (let i = 0; i < 400; i++) {
  out.push(`
interface Model${i} { id: number; name: string; tags: string[]; meta: Record<string, unknown>; }
type Handler${i} = (e: Model${i}) => Promise<void>;
export const enum Kind${i} { A, B = 10, C }
export class Service${i} implements Partial<Model${i}> {
  id: number = ${i};
  name: string = "svc${i}";
  tags: string[] = [];
  meta: Record<string, unknown> = {};
  private cache: Map<string, number> = new Map();
  constructor(private readonly prefix: string, protected depth: number = 3) {}
  async handle(e: Model${i}): Promise<void> {
    const x: number = (e.id as number) + this.depth!;
    const y = x > 1 ? x as unknown as string : String(x);
    this.cache.set(e.name, y.length);
    for (const t of e.tags) { if (t?.length > 0) this.cache.delete(t); }
  }
  get size(): number { return this.cache.size; }
}
export function make${i}(n: number): Model${i} {
  return { id: n, name: \`item\${n}\`, tags: [], meta: {} } as Model${i};
}
export const pipeline${i}: Handler${i}[] = [];
`);
}
fs.mkdirSync(path.join(__dirname, "bench"), { recursive: true });
fs.writeFileSync(path.join(__dirname, "bench", "app.ts"), out.join("\n"));
const size = fs.statSync(path.join(__dirname, "bench", "app.ts")).size;
console.log("bench/app.ts:", (size / 1024).toFixed(0) + " KB");
