// Position history (A40): booked allocations of given veNFTs per gauge per hour, replayed
// from the tape. Each token's allocation legs and leaf state are kept as change events
// (tokenEvents, written by build-derived into <chainId>/alloc/<tokenId % ALLOC_SHARDS>.json);
// the VP of a leg at an hour is AllocationLogicLibrary._contribution at that hour's block
// time (points.mjs contribution), as verify-mobile rebuilds it. Pure: no I/O.
import { contribution } from "./points.mjs";

export const ALLOC_SHARDS = 64;
export const shardOf = (tokenId) => Number(BigInt(tokenId) % BigInt(ALLOC_SHARDS));

/**
 * Change events per token from allocation-change and token-leaf-state rows. A "full" hour
 * replaces the whole set (a token missing from it is a removal), as replayAllocations does.
 * @returns Map tokenId -> { legs: [bucket, blockNumber, gauge, allocated][], states: [bucket, blockNumber, stakeEnd, isPermanent 0|1, gone 0|1][] }
 */
export function tokenEvents(rows) {
  const out = new Map();
  const ev = (id) => out.get(id) ?? out.set(id, { legs: [], states: [] }).get(id);
  const byBucket = (metric) => {
    const m = new Map();
    for (const r of rows.filter((x) => x.metric === metric).sort((a, b) => a.bucket - b.bucket)) {
      if (!m.has(r.bucket)) m.set(r.bucket, []);
      m.get(r.bucket).push(r);
    }
    return m;
  };
  let legs = new Map(); // "tokenId:gauge" -> allocated
  for (const [bucket, rs] of byBucket("allocation-change")) {
    const full = rs.some((r) => r.kind === "full");
    const next = full ? new Map() : new Map(legs);
    for (const r of rs) {
      const k = `${r.tokenId}:${r.gauge}`;
      if (r.allocated === "0") next.delete(k);
      else next.set(k, r.allocated);
    }
    const block = rs[0].blockNumber;
    for (const k of new Set([...legs.keys(), ...next.keys()])) {
      if (legs.get(k) === next.get(k)) continue;
      const [id, gauge] = k.split(":");
      ev(id).legs.push([bucket, block, gauge, next.get(k) ?? "0"]);
    }
    legs = next;
  }
  let states = new Map(); // tokenId -> "stakeEnd,perm"
  for (const [bucket, rs] of byBucket("token-leaf-state")) {
    const full = rs.some((r) => r.kind === "full");
    const next = full ? new Map() : new Map(states);
    for (const r of rs) {
      if (r.gone) next.delete(r.tokenId);
      else next.set(r.tokenId, `${r.stakeEnd},${r.isPermanent ? 1 : 0}`);
    }
    const block = rs[0].blockNumber;
    for (const id of new Set([...states.keys(), ...next.keys()])) {
      if (states.get(id) === next.get(id)) continue;
      const v = next.get(id);
      if (v === undefined) ev(id).states.push([bucket, block, 0, 0, 1]);
      else {
        const [end, perm] = v.split(",").map(Number);
        ev(id).states.push([bucket, block, end, perm, 0]);
      }
    }
    states = next;
  }
  return out;
}

/**
 * VP per gauge per hour of the given tokens.
 * @param tokens { [tokenId]: { legs, states } } (tokenEvents shape, JSON)
 * @param hours [bucket, blockNumber, blockTimestamp][] ascending
 * @returns [{ bucket, blockNumber, total, gauges: { gauge: vp } }] (bigint VP wei)
 */
export function positionHistory(tokens, hours) {
  const ids = Object.keys(tokens);
  const cursor = Object.fromEntries(ids.map((id) => [id, { l: 0, s: 0, legs: new Map(), state: null }]));
  const out = [];
  for (const [bucket, blockNumber, ts] of hours) {
    const gauges = {};
    let total = 0n;
    for (const id of ids) {
      const t = tokens[id];
      const c = cursor[id];
      while (c.l < t.legs.length && t.legs[c.l][0] <= bucket) {
        const [, , g, a] = t.legs[c.l++];
        if (a === "0") c.legs.delete(g);
        else c.legs.set(g, BigInt(a));
      }
      while (c.s < t.states.length && t.states[c.s][0] <= bucket) {
        const [, , end, perm, gone] = t.states[c.s++];
        c.state = gone ? null : { end, perm: perm === 1 };
      }
      if (!c.state) continue;
      // each leg contributes on its own (the contracts add allocated / MAXTIME per gauge, as A27 proves)
      for (const [g, a] of c.legs) {
        const k = contribution(a, BigInt(c.state.end), BigInt(ts), c.state.perm);
        const vp = k.bias + k.perm;
        gauges[g] = (gauges[g] ?? 0n) + vp;
        total += vp;
      }
    }
    out.push({ bucket, blockNumber, total, gauges });
  }
  return out;
}
