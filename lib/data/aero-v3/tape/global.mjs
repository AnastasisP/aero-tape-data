// Global hourly series (goal §5c, §6; A26): total, allocated, idle and mobile voting
// power, and per chain the leaf-booked VP and its mobile part. Class D over archived
// class-E rows. Pure: no I/O.
//
// Mobile (LeafAllocationLibrary._consumeCooldownReduction): a token may allocate again
// when elapsed >= allocationCooldown, or its accumulated reduction covers the remaining
// cooldown — i.e. elapsed + reduction >= cooldown (elapsed = max(0, t - lastAllocated)).
import { resolvePoint, contribution } from "./points.mjs";

const big = (v) => BigInt(v);

/** True when the token's allocation can move at time t. */
export function isMobile(t, lastAllocated, cooldownReduction, cooldown) {
  if (lastAllocated === 0) return true;
  const elapsed = t > lastAllocated ? t - lastAllocated : 0;
  return elapsed + cooldownReduction >= cooldown;
}

/**
 * Per hour, the chain's leaf-booked VP and its mobile part.
 * @param rows tape rows of one chain: allocation-change, token-leaf-state, leaf-state
 * @param through last hour both late metrics were processed (min of their cursors)
 * @param relayTokens Set of relay-owned tokenIds (A38), or null
 * @returns Map bucket -> { blockNumber, booked, mobile, relay } (bigint VP wei; relay = booked VP of relay veNFTs, null without the set)
 */
export function chainMobility(rows, through, relayTokens = null) {
  const sorted = rows.filter((r) => r.bucket <= through).sort((a, b) => a.bucket - b.bucket);
  const leaf = new Map(sorted.filter((r) => r.metric === "leaf-state").map((r) => [r.bucket, r]));
  const alloc = new Map(); // tokenId -> Map gauge -> amount
  const tokens = new Map(); // tokenId -> state
  let allocFull = null;
  let tokenFull = null;
  const out = new Map();
  const hours = [...new Set(sorted.map((r) => r.bucket))].sort((a, b) => a - b);
  let i = 0;
  for (const h of hours) {
    for (; i < sorted.length && sorted[i].bucket <= h; i++) {
      const r = sorted[i];
      if (r.metric === "allocation-change") {
        if (r.kind === "full" && r.bucket !== allocFull) {
          alloc.clear();
          allocFull = r.bucket;
        }
        const g = alloc.get(r.tokenId) ?? new Map();
        if (r.allocated === "0") g.delete(r.gauge);
        else g.set(r.gauge, big(r.allocated));
        if (g.size) alloc.set(r.tokenId, g);
        else alloc.delete(r.tokenId);
      } else if (r.metric === "token-leaf-state") {
        if (r.kind === "full" && r.bucket !== tokenFull) {
          tokens.clear();
          tokenFull = r.bucket;
        }
        if (r.gone) tokens.delete(r.tokenId);
        else tokens.set(r.tokenId, r);
      }
    }
    const l = leaf.get(h);
    if (!l) continue;
    const t = l.blockTimestamp;
    const cooldown = Number(l.allocationCooldown);
    let booked = 0n;
    let mobile = 0n;
    let relay = 0n;
    for (const [tokenId, gauges] of alloc) {
      const s = tokens.get(tokenId);
      if (!s) continue; // no leaf state for this token at this hour: not counted (verify-mobile would show it)
      let amount = 0n;
      for (const a of gauges.values()) amount += a;
      const k = contribution(amount, BigInt(s.stakeEnd), BigInt(t), s.isPermanent);
      const vp = k.bias + k.perm;
      booked += vp;
      if (isMobile(t, s.lastAllocated, s.cooldownReduction, cooldown)) mobile += vp;
      if (relayTokens?.has(tokenId)) relay += vp;
    }
    out.set(h, { blockNumber: l.blockNumber, booked, mobile, relay: relayTokens ? relay : null });
  }
  return out;
}

/**
 * Global points from root-state rows and each chain's mobility map.
 * @returns Array<{ bucket, blockNumber, totalVotingPower, allocated, idle, mobile, booked, mobilePressurePpm, relay, relaySharePpm, chains }>
 *          relaySharePpm (§5c, A38) = relay x 1e6 / booked: the leaf-booked VP held by relay veNFTs
 *          mobilePressurePpm (§5d, A32) = mobile x 1e6 / booked, both summed over chains on the
 *          leaf-booked basis, so the share is of weight that is allocated on the leaves
 */
export function globalSeries(rootRows, mobilityByChain) {
  return rootRows
    .slice()
    .sort((a, b) => a.bucket - b.bucket)
    .map((r) => {
      const t = BigInt(r.blockTimestamp);
      let allocated = 0n;
      let exact = true;
      const chains = {};
      for (const c of r.chainStates) {
        const p = { bias: big(c.point.bias), slope: big(c.point.slope), ts: BigInt(c.point.ts), permanentStakeBalance: big(c.point.permanentStakeBalance) };
        // a week boundary inside (ts, t] would need chainSlopeChanges (not archived): leave the budget out
        const crosses = p.slope !== 0n && (p.ts / 604800n + 1n) * 604800n <= t;
        const budget = crosses ? null : resolvePoint(p, t, () => 0n).weight;
        if (budget === null) exact = false;
        else allocated += budget;
        const m = mobilityByChain[c.chainId]?.get(r.bucket) ?? null;
        chains[c.chainId] = { budget, booked: m ? m.booked : null, mobile: m ? m.mobile : null, relay: m && m.relay !== undefined ? m.relay : null };
      }
      const total = big(r.votingEscrow.totalVotingPower);
      const mobiles = Object.values(chains).map((c) => c.mobile);
      const bookeds = Object.values(chains).map((c) => c.booked);
      const mobile = mobiles.every((m) => m !== null) ? mobiles.reduce((a, b) => a + b, 0n) : null;
      const booked = bookeds.every((b) => b !== null) ? bookeds.reduce((a, b) => a + b, 0n) : null;
      const relays = Object.values(chains).map((c) => c.relay);
      const relay = relays.every((x) => x !== null) ? relays.reduce((a, b) => a + b, 0n) : null;
      return {
        bucket: r.bucket,
        blockNumber: r.blockNumber,
        totalVotingPower: total,
        allocated: exact ? allocated : null,
        idle: exact ? total - allocated : null,
        mobile,
        booked,
        mobilePressurePpm: mobile !== null && booked !== null && booked > 0n ? (mobile * 1_000_000n) / booked : null,
        relay,
        relaySharePpm: relay !== null && booked !== null && booked > 0n ? (relay * 1_000_000n) / booked : null,
        chains,
      };
    });
}
