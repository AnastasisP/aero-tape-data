// A28: LP-side context series per gauge, derived hourly from archived pool-state rows
// (scripts/tape/pools.mjs). What the gauge's pool holds and what swappers paid the pool
// and its LPs. NEVER staker revenue: stakers are paid only through FeeDistribution +
// incentives (goal §13). Kept apart from the core SERIES_META so no staker view reads it.
import { HOUR } from "./series.mjs";

export const LP_SIDE = "lp-side";

/** Units of the LP-side series. Token-keyed series hold one value per token address. */
export const LP_SERIES_META = Object.freeze({
  poolBalance: { kind: "level", unit: "token wei", class: "E", side: LP_SIDE, formula: "token.balanceOf(pool) at the sample block", tokens: true },
  poolSwapFees: { kind: "flow", unit: "token wei", class: "D", side: LP_SIDE, formula: "delta of PoolTape.accumulators(pool).cumulativeFee over the hour (paid by swappers to the pool, LP-side)", tokens: true },
  poolVolume: { kind: "flow", unit: "token wei (input side)", class: "D", side: LP_SIDE, formula: "delta of PoolTape.accumulators(pool).cumulativeVolume over the hour", tokens: true },
  poolSwaps: { kind: "flow", unit: "swaps", class: "D", side: LP_SIDE, formula: "delta of PoolTape.accumulators(pool).swapCount over the hour" },
  // A31, CL pools only (cl-liquidity rows)
  activeLiquidity: { kind: "level", unit: "liquidity units", class: "E", side: LP_SIDE, formula: "CLPool.liquidity() at the sample block (in-range)" },
  stakedLiquidity: { kind: "level", unit: "liquidity units", class: "E", side: LP_SIDE, formula: "CLPool.stakedLiquidity() at the sample block (in-range, staked in the gauge)" },
  stakedShare: { kind: "level", unit: "ppm", class: "D", side: LP_SIDE, formula: "stakedLiquidity x 1e6 / liquidity, floor; null when liquidity is 0" },
});

const big = (s) => BigInt(s);

/** Delta of a cumulative, null when it went backwards (tape replaced or reset): never guessed. */
const delta = (now, before) => (now >= before ? now - before : null);

/**
 * @param rows pool-state (and cl-liquidity, A31) rows of one chain, any order
 * @returns Map gauge -> hourly points, ascending by bucket. A flow is null on a gauge's
 *          first hour, after a gap, when the tape changed, or when a cumulative went back.
 */
export function deriveLpHourly(rows) {
  const cl = new Map(rows.filter((x) => x.metric === "cl-liquidity").map((r) => [`${r.gauge}:${r.bucket}`, r]));
  const byGauge = new Map();
  for (const r of rows.filter((x) => x.metric === "pool-state").sort((a, b) => a.bucket - b.bucket)) {
    if (!byGauge.has(r.gauge)) byGauge.set(r.gauge, []);
    byGauge.get(r.gauge).push(r);
  }
  const out = new Map();
  for (const [gauge, list] of byGauge) {
    const points = [];
    let prev = null;
    for (const r of list) {
      const pt = {
        bucket: r.bucket,
        blockNumber: r.blockNumber,
        blockTimestamp: r.blockTimestamp,
        poolBalance: { [r.token0]: big(r.balance0), [r.token1]: big(r.balance1) },
        poolSwapFees: null,
        poolVolume: null,
        poolSwaps: null,
        activeLiquidity: null,
        stakedLiquidity: null,
        stakedShare: null,
      };
      const c = cl.get(`${gauge}:${r.bucket}`);
      if (c) {
        pt.activeLiquidity = big(c.liquidity);
        pt.stakedLiquidity = big(c.stakedLiquidity);
        pt.stakedShare = pt.activeLiquidity > 0n ? (pt.stakedLiquidity * 1_000_000n) / pt.activeLiquidity : null;
      }
      if (prev && prev.bucket === r.bucket - HOUR && prev.tape === r.tape && prev.pool === r.pool) {
        const f0 = delta(big(r.cumulativeFee0), big(prev.cumulativeFee0));
        const f1 = delta(big(r.cumulativeFee1), big(prev.cumulativeFee1));
        const v0 = delta(big(r.cumulativeVolume0), big(prev.cumulativeVolume0));
        const v1 = delta(big(r.cumulativeVolume1), big(prev.cumulativeVolume1));
        const n = delta(BigInt(r.swapCount), BigInt(prev.swapCount));
        if (f0 !== null && f1 !== null) pt.poolSwapFees = { [r.token0]: f0, [r.token1]: f1 };
        if (v0 !== null && v1 !== null) pt.poolVolume = { [r.token0]: v0, [r.token1]: v1 };
        pt.poolSwaps = n;
      }
      points.push(pt);
      prev = r;
    }
    out.set(gauge, points);
  }
  return out;
}
