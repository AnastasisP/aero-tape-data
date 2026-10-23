// The core series of goal §5a, derived hourly from the tape (class D: deterministic
// functions of archived class-E values, bigint). No price, no forecast.
import { resolvePoint } from "./points.mjs";
import { gaugeAllocationStats, hhiBps, replayAllocations } from "./allocations.mjs";

export const HOUR = 3600;

/**
 * Units of every series. Token-keyed series hold one value per token address.
 * kind: level (OHLC when aggregated), flow (sum), count (close).
 */
export const SERIES_META = Object.freeze({
  weight: { kind: "level", unit: "VP wei", class: "D", formula: "gaugeStates(g).point resolved to the sample time" },
  weightFlow: { kind: "flow", unit: "VP wei", class: "D", formula: "W(t) - W(t-1h) resolved to t (allocations in minus out, decay removed)" },
  feeYield: { kind: "flow", unit: "token wei per VP wei x 1e24", class: "S", formula: "delta of FeeDistribution.feeRewardPerVotingPower over the hour", tokens: true },
  incentiveRate: { kind: "level", unit: "token wei per second x 1e18", class: "E", formula: "sum of IncentiveStreaming rate of programs active at the sample time", tokens: true },
  yieldPerWeight: { kind: "level", unit: "token wei per VP wei per hour x 1e24", class: "D", formula: "feeYield + sum(rate x active seconds in the hour) x 1e6 / vote supply", tokens: true },
  allocators: { kind: "count", unit: "tokenIds", class: "D", formula: "veNFTs with LeafVoter.allocations(tokenId, g) > 0" },
  allocatedAmount: { kind: "level", unit: "AERO wei (booked allocation, not decayed)", class: "D", formula: "sum of LeafVoter.allocations(tokenId, g)" },
  relayAllocatedAmount: { kind: "level", unit: "AERO wei (booked allocation, not decayed)", class: "D", formula: "sum of allocations of relay-owned veNFTs (relayConfig().tokenId)" },
  relayAllocators: { kind: "count", unit: "tokenIds", class: "D", formula: "relay-owned veNFTs with allocation > 0" },
  allocationHhi: { kind: "level", unit: "bps (Herfindahl-Hirschman, 0-10000)", class: "D", formula: "10000 x sum((a_i / sum a)^2) over the booked allocations a_i on the gauge" },
});

/** Series that need the booked-allocation archive (allocation-change). */
export const ALLOCATION_SERIES = ["allocators", "allocatedAmount", "relayAllocatedAmount", "relayAllocators", "allocationHhi"];

const big = (s) => BigInt(s);
const pointOf = (p) => ({ bias: big(p.bias), slope: big(p.slope), ts: BigInt(p.ts), permanentStakeBalance: big(p.permanentStakeBalance) });

/** Boundary slope changes for one gauge from the archive; a decaying point with a missing one fails loud. */
function slopeChangesOf(gauge, point, archived) {
  return (b) => {
    const v = archived.get(`${gauge}:${b}`);
    if (v !== undefined) return v;
    if (point.slope === 0n) return 0n;
    throw new Error(`series: gauge ${gauge} crosses week boundary ${b} with slope ${point.slope}; gauge slope changes are not archived`);
  };
}

/**
 * @param rows tape rows of one chain, any order: gauge-state, gauge-registry,
 *             incentive-program, allocation-change, gauge-slope-change
 * @param allocationThrough last hour the allocation-change metric was processed for
 *        (store.metricCursor); it is processed from the first hour, and an hour with no
 *        change writes no row. null = no allocation data: allocators stays null.
 * @param relayTokens Set of relay-owned tokenIds (from the root chain's relay-registry rows);
 *        null = relays not archived: the relay series stay null
 * @returns Map gauge -> hourly points, ascending by bucket
 */
export function deriveHourly(rows, allocationThrough = null, relayTokens = null) {
  const byMetric = (m) => rows.filter((r) => r.metric === m).sort((a, b) => a.bucket - b.bucket);
  const tokens = new Map(byMetric("gauge-registry").map((r) => [r.gauge, [r.token0, r.token1]]));
  const programs = byMetric("incentive-program");
  const slopes = new Map(byMetric("gauge-slope-change").map((r) => [`${r.gauge}:${r.boundary}`, BigInt(r.slopeDelta)]));
  const allocRows = byMetric("allocation-change");
  const countsAt = new Map();
  if (allocationThrough !== null) {
    let i = 0;
    const seen = [];
    const allHours = [...new Set(byMetric("gauge-state").map((r) => r.bucket))].sort((a, b) => a - b);
    for (const h of allHours) {
      if (h > allocationThrough) break;
      while (i < allocRows.length && allocRows[i].bucket <= h) seen.push(allocRows[i++]);
      countsAt.set(h, gaugeAllocationStats(replayAllocations(seen), relayTokens ?? new Set()));
    }
  }

  const byGauge = new Map();
  for (const r of byMetric("gauge-state")) {
    if (!byGauge.has(r.gauge)) byGauge.set(r.gauge, []);
    byGauge.get(r.gauge).push(r);
  }

  const out = new Map();
  for (const [gauge, list] of byGauge) {
    const [t0, t1] = tokens.get(gauge) ?? [];
    const progs = programs.filter((p) => p.gauge === gauge);
    const points = [];
    let prev = null;
    for (const r of list) {
      const t = BigInt(r.blockTimestamp);
      const point = pointOf(r.gaugeState.point);
      const weight = resolvePoint(point, t, slopeChangesOf(gauge, point, slopes)).weight;
      const known = progs.filter((p) => p.bucket <= r.bucket);
      const incentiveRate = {};
      for (const p of known) {
        if (BigInt(p.start) <= t && t < BigInt(p.end)) incentiveRate[p.token] = ((incentiveRate[p.token] ?? 0n) + big(p.rate));
      }
      const pt = {
        bucket: r.bucket,
        blockNumber: r.blockNumber,
        blockTimestamp: r.blockTimestamp,
        weight,
        voteSupply: big(r.voteSupply),
        weightFlow: null,
        feeYield: null,
        incentiveRate,
        yieldPerWeight: null,
      };
      const st = countsAt.has(r.bucket) ? countsAt.get(r.bucket).get(gauge) ?? { allocators: 0, allocated: 0n, relayAllocators: 0, relayAllocated: 0n, sumSquares: 0n } : null;
      pt.allocators = st ? st.allocators : null;
      pt.allocatedAmount = st ? st.allocated : null;
      pt.relayAllocatedAmount = st && relayTokens ? st.relayAllocated : null;
      pt.relayAllocators = st && relayTokens ? st.relayAllocators : null;
      // no allocation on the gauge: concentration is undefined, carried as 0 (no one to crowd)
      pt.allocationHhi = st ? BigInt(hhiBps(st) ?? 0) : null;
      if (prev && prev.bucket === r.bucket - HOUR) {
        const prevPoint = pointOf(prev.gaugeState.point);
        pt.weightFlow = weight - resolvePoint(prevPoint, t, slopeChangesOf(gauge, prevPoint, slopes)).weight;
        pt.feeYield = {
          [t0]: big(r.fees.rewardPerVotingPower0) - big(prev.fees.rewardPerVotingPower0),
          [t1]: big(r.fees.rewardPerVotingPower1) - big(prev.fees.rewardPerVotingPower1),
        };
        const supply = big(r.voteSupply);
        // Zero vote supply: yield per weight is undefined (nobody to pay); the point carries {}.
        pt.yieldPerWeight = {};
        if (supply > 0n) {
          const from = BigInt(prev.blockTimestamp);
          const y = { ...pt.feeYield };
          for (const p of known) {
            const lo = BigInt(p.start) > from ? BigInt(p.start) : from;
            const hi = BigInt(p.end) < t ? BigInt(p.end) : t;
            if (hi > lo) y[p.token] = (y[p.token] ?? 0n) + (big(p.rate) * (hi - lo) * 10n ** 6n) / supply;
          }
          pt.yieldPerWeight = y;
        }
      }
      points.push(pt);
      prev = r;
    }
    out.set(gauge, points);
  }
  return out;
}

export const TIMEFRAMES = Object.freeze({ "1h": 3600, "4h": 14400, "1d": 86400, "1w": 604800 });

const aggLevel = (vals) => ({ o: vals[0], h: vals.reduce((a, b) => (b > a ? b : a)), l: vals.reduce((a, b) => (b < a ? b : a)), c: vals.at(-1) });
const aggFlow = (vals) => ({ sum: vals.reduce((a, b) => a + b, 0n) });

function aggregateValues(kind, vals, oneHour) {
  if (oneHour) return { v: vals[0] }; // the bucket is one hour: o = h = l = c = sum
  if (kind === "level") return aggLevel(vals);
  if (kind === "flow") return aggFlow(vals);
  return { c: vals.at(-1) };
}

/**
 * Candles of one gauge for one timeframe, built from the hourly points only
 * (never sampled separately). 1w buckets start Thursday 00:00 UTC (unix weeks).
 * A series with no value in a bucket is absent from that candle. A bucket holding a
 * single hourly sample carries { v } instead of OHLC / sum / close.
 */
export function aggregate(points, tf) {
  const size = TIMEFRAMES[tf];
  const groups = new Map();
  for (const p of points) {
    const b = Math.floor(p.bucket / size) * size;
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(p);
  }
  const candles = [];
  for (const [bucket, ps] of groups) {
    const last = ps.at(-1);
    const c = { bucket, hours: ps.length, closeBlock: last.blockNumber, closeTimestamp: last.blockTimestamp, series: {} };
    for (const [name, meta] of Object.entries(SERIES_META)) {
      if (meta.tokens) {
        const tokens = new Set(ps.flatMap((p) => Object.keys(p[name] ?? {})));
        const per = {};
        for (const tok of tokens) {
          const vals = ps.map((p) => p[name]?.[tok]).filter((v) => v !== undefined);
          if (vals.length) per[tok] = aggregateValues(meta.kind, vals, ps.length === 1);
        }
        if (Object.keys(per).length || ps.some((p) => p[name] !== null)) c.series[name] = per;
      } else {
        const vals = ps.map((p) => p[name]).filter((v) => v !== null);
        if (vals.length) c.series[name] = aggregateValues(meta.kind, vals, ps.length === 1);
      }
    }
    candles.push(c);
  }
  return candles;
}

/** bigint -> string for JSON. */
export function serialize(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(serialize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, serialize(x)]));
  return v;
}
