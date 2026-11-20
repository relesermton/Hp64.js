"use strict";
// Town.js - HP64.js module graph registry ("the town where modules live").
// Tracks every discovered module, its edges, compile stats, and cache state.

const path = require("path");

class Town {
  constructor() {
    this.houses = new Map(); // abs path -> House
    this.built = 0;
    this.cached = 0;
  }

  // register a module ("build a house")
  build(file, { code = "", deps = [], external = [] } = {}) {
    const id = path.resolve(file);
    let h = this.houses.get(id);
    if (!h) {
      h = { id, code, deps, external, dirty: true, hits: 0 };
      this.houses.set(id, h);
    } else {
      h.code = code; h.deps = deps; h.external = external; h.dirty = true;
    }
    this.built++;
    return h;
  }

  // mark clean after successful compile
  clean(file) {
    const h = this.houses.get(path.resolve(file));
    if (h) h.dirty = false;
  }

  // reuse cached compile if source unchanged (returns true on cache hit)
  reuse(file, hash) {
    const h = this.houses.get(path.resolve(file));
    if (h && !h.dirty && h.hash === hash) { this.cached++; h.hits++; return true; }
    if (h) h.hash = hash;
    return false;
  }

  // neighbors of a module (resolved, non-external)
  neighbors(file) {
    const h = this.houses.get(path.resolve(file));
    return h ? h.deps.filter(d => !d.external).map(d => d.id) : [];
  }

  // Kahn topological order; throws on cyclic import (ESM cycles unsupported)
  topo() {
    const indeg = new Map();
    for (const [id, h] of this.houses) indeg.set(id, 0);
    for (const h of this.houses.values())
      for (const d of h.deps)
        if (!d.external && this.houses.has(d.id)) indeg.set(d.id, (indeg.get(d.id) || 0) + 1);
    const queue = [...indeg.entries()].filter(([, n]) => n === 0).map(([id]) => id);
    const order = [];
    while (queue.length) {
      const id = queue.shift();
      order.push(id);
      for (const d of (this.houses.get(id)?.deps || [])) {
        if (d.external || !this.houses.has(d.id)) continue;
        const n = indeg.get(d.id) - 1;
        indeg.set(d.id, n);
        if (n === 0) queue.push(d.id);
      }
    }
    if (order.length !== this.houses.size) {
      const leftover = [...this.houses.keys()].filter(k => !order.includes(k));
      throw new Error("Cyclic import detected: " + leftover.map(f => path.basename(f)).join(", "));
    }
    return order;
  }

  stats() {
    return { modules: this.houses.size, built: this.built, cached: this.cached };
  }
}

module.exports = Town;
