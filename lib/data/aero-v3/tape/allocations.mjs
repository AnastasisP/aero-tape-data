// Booked allocations as tape rows: full snapshot then deltas, replay, and per-gauge
// stats. Pure functions; the chain reads live in scripts/tape/allocations.mjs.

/**
 * Rows to append for one hour: every leg on a full snapshot (no previous state), else
 * only legs whose booked amount changed ("0" = removed).
 * @param prev Map key -> amount, or null for a full snapshot
 * @param next Map key -> amount
 */
export function allocationRows(prov, prev, next) {
  const row = (key, allocated, kind) => {
    const [tokenId, gauge] = key.split(":");
    return { ...prov, metric: "allocation-change", kind, tokenId, gauge, allocated };
  };
  if (prev === null) return [...next].sort().map(([k, v]) => row(k, v, "full"));
  const rows = [];
  for (const [k, v] of next) if (prev.get(k) !== v) rows.push(row(k, v, "delta"));
  for (const k of prev.keys()) if (!next.has(k)) rows.push(row(k, "0", "delta"));
  return rows.sort((a, b) => (a.tokenId + a.gauge < b.tokenId + b.gauge ? -1 : 1));
}

/** Replays allocation-change rows (in file order) into the booked state after the last hour. */
export function replayAllocations(rows) {
  let state = new Map();
  let fullBucket = null;
  for (const r of rows) {
    if (r.kind === "full" && r.bucket !== fullBucket) {
      state = new Map();
      fullBucket = r.bucket;
    }
    const key = `${r.tokenId}:${r.gauge}`;
    if (r.allocated === "0") state.delete(key);
    else state.set(key, r.allocated);
  }
  return state;
}

/** Map gauge -> number of tokenIds with allocation > 0. */
export function allocatorCounts(state) {
  const out = new Map();
  for (const key of state.keys()) {
    const gauge = key.split(":")[1];
    out.set(gauge, (out.get(gauge) ?? 0) + 1);
  }
  return out;
}

/**
 * Per gauge: allocators, allocated amount, and the relay part of both.
 * @param relayTokens Set of relay-owned tokenIds (decimal strings)
 * @returns Map gauge -> { allocators, allocated, relayAllocators, relayAllocated } (bigint amounts)
 */
export function gaugeAllocationStats(state, relayTokens) {
  const out = new Map();
  for (const [key, amount] of state) {
    const [tokenId, gauge] = key.split(":");
    const s = out.get(gauge) ?? { allocators: 0, allocated: 0n, relayAllocators: 0, relayAllocated: 0n };
    s.allocators++;
    s.allocated += BigInt(amount);
    if (relayTokens.has(tokenId)) {
      s.relayAllocators++;
      s.relayAllocated += BigInt(amount);
    }
    out.set(gauge, s);
  }
  return out;
}
