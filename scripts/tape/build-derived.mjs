// Derived tape (class D): candles of every core series, every gauge, every timeframe,
// built from the raw tape on disk. Deterministic: rebuilding unchanged input writes
// identical files, so only the forming period's files change from hour to hour.
//   node scripts/tape/build-derived.mjs --dir <tape-data> [--prices]
// --prices marks each token priced / unpriced from the provider (prices.mjs) for the
// Unpriced data state; the tape itself never stores an estimated price.
// Output under <dir>/derived/v1:
//   <chainId>/<tf>/<period>.json   1h and 4h per UTC day, 1d per month, 1w per year
//   <chainId>/lp/<tf>/<period>.json LP-side pool context (A28), same periods, never staker revenue
//   <chainId>/emissions/<tf>/<period>.json gauge emission accounting (A29), LP-side, same periods
//   index.json                      gauges (tokens, pool, hours) and the market state
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { TapeStore } from "./store.mjs";
import { SERIES_META, TIMEFRAMES, aggregate, deriveHourly, serialize } from "../../lib/data/aero-v3/tape/series.mjs";
import { resolvePoint } from "../../lib/data/aero-v3/tape/points.mjs";
import { fetchPrices, priceKey } from "./prices.mjs";
import { chainMobility, globalSeries } from "../../lib/data/aero-v3/tape/global.mjs";
import { emissionBand } from "../../lib/data/aero-v3/tape/emissionBand.mjs";
import { replayTokenTiers } from "./tiers.mjs";
import { LP_SERIES_META, LP_SIDE, deriveLpHourly } from "../../lib/data/aero-v3/tape/lpSeries.mjs";
import { EMISSION_SERIES_META, deriveEmissionHourly } from "../../lib/data/aero-v3/tape/emissionSeries.mjs";

export const DERIVED_VERSION = "v1";
const PERIOD = { "1h": 10, "4h": 10, "1d": 7, "1w": 4 }; // ISO date prefix length per file

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: node scripts/tape/build-derived.mjs --dir <tape-data>");
  process.exit(2);
}
const store = new TapeStore(dir, { readOnly: true });
const out = join(dir, "derived", DERIVED_VERSION);
const chains = loadChains();
const rowsOf = (chainId, metrics) =>
  Object.keys(store.manifest.files)
    .filter((f) => metrics.some((m) => f.startsWith(`${chainId}/${m}/`)) && existsSync(join(store.dir, f)))
    .sort()
    .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

function writeJson(rel, value) {
  const abs = join(out, rel);
  mkdirSync(dirname(abs), { recursive: true });
  const text = JSON.stringify(value) + "\n";
  if (existsSync(abs) && readFileSync(abs, "utf8") === text) return false;
  writeFileSync(abs, text);
  return true;
}

const root = chains.find((c) => c.role === "root");
const relayRows = rowsOf(root.chainId, ["relay-registry"]);
const relayTokens = relayRows.length ? new Set(relayRows.map((r) => r.tokenId)) : null;
const index = { schemaVersion: 1, series: SERIES_META, lpSeries: LP_SERIES_META, emissionSeries: EMISSION_SERIES_META, timeframes: Object.keys(TIMEFRAMES), chains: {}, market: null };
let written = 0;

for (const chain of chains) {
  const rows = rowsOf(chain.chainId, ["gauge-state", "gauge-registry", "incentive-program", "allocation-change", "gauge-slope-change", "token-registry"]);
  const series = deriveHourly(rows, store.metricCursor(chain.chainId, "allocation-change"), relayTokens);
  const registry = new Map(rows.filter((r) => r.metric === "gauge-registry").map((r) => [r.gauge, r]));
  const gauges = {};
  const files = new Map(); // rel -> { gauge -> candles }
  for (const [gauge, points] of series) {
    const reg = registry.get(gauge);
    const last = points.at(-1);
    gauges[gauge] = {
      pool: reg?.pool ?? null,
      rewards: reg?.rewards ?? null,
      token0: reg?.token0 ?? null,
      token1: reg?.token1 ?? null,
      firstHour: points[0].bucket,
      lastHour: last.bucket,
      // the newest hour, for market-wide views (water level, A20): class D, token-native
      latest: serialize({ bucket: last.bucket, blockNumber: last.blockNumber, weight: last.weight, voteSupply: last.voteSupply, yieldPerWeight: last.yieldPerWeight, weightFlow: last.weightFlow, allocators: last.allocators, allocatedAmount: last.allocatedAmount, relayAllocatedAmount: last.relayAllocatedAmount }),
    };
    for (const tf of Object.keys(TIMEFRAMES)) {
      for (const c of aggregate(points, tf)) {
        const rel = `${chain.chainId}/${tf}/${new Date(c.bucket * 1000).toISOString().slice(0, PERIOD[tf])}.json`;
        if (!files.has(rel)) files.set(rel, {});
        (files.get(rel)[gauge] ??= []).push(c);
      }
    }
  }
  for (const [rel, byGauge] of files) {
    const [, tf, period] = rel.split("/");
    const doc = {
      schemaVersion: 1,
      chainId: chain.chainId,
      tf,
      period: period.replace(".json", ""),
      source: "chain",
      // Every candle carries closeBlock / closeTimestamp: the block of its last hourly sample.
      gauges: serialize(Object.fromEntries(Object.entries(byGauge).sort())),
    };
    if (writeJson(rel, doc)) written++;
  }
  // A28: LP-side context, its own files so no staker-revenue view reads it by accident.
  const lp = {};
  const lpFiles = new Map();
  const lpRows = rowsOf(chain.chainId, ["pool-state", "cl-liquidity"]);
  const lpPool = new Map(lpRows.filter((r) => r.metric === "pool-state").map((r) => [r.gauge, r]));
  for (const [gauge, points] of deriveLpHourly(lpRows)) {
    const r = lpPool.get(gauge);
    lp[gauge] = { pool: r.pool, poolType: r.poolType, tape: r.tape, firstHour: points[0].bucket, lastHour: points.at(-1).bucket };
    for (const tf of Object.keys(TIMEFRAMES)) {
      for (const c of aggregate(points, tf, LP_SERIES_META)) {
        const rel = `${chain.chainId}/lp/${tf}/${new Date(c.bucket * 1000).toISOString().slice(0, PERIOD[tf])}.json`;
        if (!lpFiles.has(rel)) lpFiles.set(rel, {});
        (lpFiles.get(rel)[gauge] ??= []).push(c);
      }
    }
  }
  for (const [rel, byGauge] of lpFiles) {
    const [, , tf, period] = rel.split("/");
    const doc = { schemaVersion: 1, chainId: chain.chainId, tf, period: period.replace(".json", ""), source: "chain", side: LP_SIDE, gauges: serialize(Object.fromEntries(Object.entries(byGauge).sort())) };
    if (writeJson(rel, doc)) written++;
  }
  // A29: gauge emission accounting (LP-side), its own files like the pool context.
  const emissionFiles = new Map();
  for (const [gauge, points] of deriveEmissionHourly(rows.filter((r) => r.metric === "gauge-state"))) {
    for (const tf of Object.keys(TIMEFRAMES)) {
      for (const c of aggregate(points, tf, EMISSION_SERIES_META)) {
        const rel = `${chain.chainId}/emissions/${tf}/${new Date(c.bucket * 1000).toISOString().slice(0, PERIOD[tf])}.json`;
        if (!emissionFiles.has(rel)) emissionFiles.set(rel, {});
        (emissionFiles.get(rel)[gauge] ??= []).push(c);
      }
    }
  }
  for (const [rel, byGauge] of emissionFiles) {
    const [, , tf, period] = rel.split("/");
    const doc = { schemaVersion: 1, chainId: chain.chainId, tf, period: period.replace(".json", ""), source: "chain", side: LP_SIDE, gauges: serialize(Object.fromEntries(Object.entries(byGauge).sort())) };
    if (writeJson(rel, doc)) written++;
  }
  index.chains[chain.chainId] = {
    slug: chain.slug,
    name: chain.name,
    cursor: store.cursor(chain.chainId),
    // for the readout's "reproduce" line: the contract every gauge-state read goes to
    leafVoter: loadDeployments().files[`leaf-${chain.slug}.json`].addresses.leafVoter.toLowerCase(),
    rpc: chain.rpcs[0],
    // display only: symbol and decimals of fee / incentive tokens (amounts stay in base units)
    // A35: the token's TokenRegistry tier at the newest hour it was read (absent before the metric)
    tokens: (() => {
      const tiers = replayTokenTiers(rowsOf(chain.chainId, ["token-tier"]));
      const through = store.metricCursor(chain.chainId, "token-tier");
      return Object.fromEntries(
        rows.filter((r) => r.metric === "token-registry").map((r) => {
          const t = tiers.get(r.token);
          return [r.token, { symbol: r.symbol, decimals: r.decimals, ...(t ? { tier: { tierType: t.tierType, weight: t.weight, flags: t.flags, through } } : {}) }];
        }),
      );
    })(),
    gauges,
    lp,
  };
}

// Global hourly series (A26): total, allocated, idle, mobile VP, per chain booked / mobile.
const mobility = {};
for (const chain of chains) {
  const through = Math.min(store.metricCursor(chain.chainId, "allocation-change") ?? -1, store.metricCursor(chain.chainId, "token-leaf-state") ?? -1);
  if (through < 0) continue;
  mobility[chain.chainId] = chainMobility(rowsOf(chain.chainId, ["allocation-change", "token-leaf-state", "leaf-state"]), through, relayTokens);
}
const global = globalSeries(rowsOf(root.chainId, ["root-state"]), mobility);
const byDay = new Map();
for (const g of global) {
  const day = new Date(g.bucket * 1000).toISOString().slice(0, 10);
  if (!byDay.has(day)) byDay.set(day, []);
  byDay.get(day).push(g);
}
for (const [day, points] of byDay) {
  if (writeJson(`global/1h/${day}.json`, { schemaVersion: 1, tf: "1h", period: day, source: "chain", class: "D", points: serialize(points) })) written++;
}
const newestGlobal = global.at(-1);

/** Newest migration-state row -> migrated, still locked in v2 outside the pile, migrated share (ppm). */
function migrationOf(r) {
  if (!r) return null;
  const migrated = BigInt(r.migratedLocked);
  const supply = BigInt(r.v2Supply);
  return { bucket: r.bucket, blockNumber: r.blockNumber, paidBasis: r.paidBasis, migratedLocked: r.migratedLocked, v2Supply: r.v2Supply, remainingLocked: (supply - migrated).toString(), migratedSharePpm: supply > 0n ? ((migrated * 1_000_000n) / supply).toString() : null };
}

// Market state at the newest root hour (goal §5c, §6): total, allocated, idle VP, chain budgets.
const rootRows = rowsOf(root.chainId, ["root-state"]);
const last = rootRows.at(-1);
if (last) {
  const t = BigInt(last.blockTimestamp);
  const pt = (p) => ({ bias: BigInt(p.bias), slope: BigInt(p.slope), ts: BigInt(p.ts), permanentStakeBalance: BigInt(p.permanentStakeBalance) });
  // A chain point crossing a week boundary needs chainSlopeChanges, which are not archived:
  // that chain's budget is left out (null) rather than guessed.
  const budgets = last.chainStates.map((c) => {
    const p = pt(c.point);
    const crosses = (p.ts / 604800n + 1n) * 604800n <= t && p.slope !== 0n;
    return { chainId: Number(c.chainId), status: c.status, allocated: crosses ? null : resolvePoint(p, t, () => 0n).weight.toString() };
  });
  const allocated = budgets.every((b) => b.allocated !== null) ? budgets.reduce((a, b) => a + BigInt(b.allocated), 0n) : null;
  const total = BigInt(last.votingEscrow.totalVotingPower);
  index.market = {
    bucket: last.bucket,
    blockNumber: last.blockNumber,
    blockTimestamp: last.blockTimestamp,
    chainId: root.chainId,
    source: "chain",
    class: "D",
    totalVotingPower: total.toString(),
    allocated: allocated?.toString() ?? null,
    idle: allocated === null ? null : (total - allocated).toString(),
    permanentStakeBalance: last.votingEscrow.permanentStakeBalance,
    stakedAmount: last.votingEscrow.supply,
    emissionRate: last.minter.emissionRate,
    chainBudgets: budgets,
    relays: relayRows.map((r) => ({ relay: r.relay, tokenId: r.tokenId, name: r.name, relayType: r.relayType })),
    // A26: allocated VP that can move now (cooldown elapsed), at the same hour when available
    mobile: newestGlobal && newestGlobal.bucket === last.bucket && newestGlobal.mobile !== null ? newestGlobal.mobile.toString() : null,
    // A33: the Minter's emission band (effective rate recomputed == emissionRate) and v2 migration progress
    emissionBand: serialize(emissionBand(last.minter)),
    migration: migrationOf(rowsOf(root.chainId, ["migration-state"]).at(-1)),
    // A32: mobile pressure = mobile / leaf-booked VP, ppm, same hour
    mobilePressurePpm: newestGlobal && newestGlobal.bucket === last.bucket && newestGlobal.mobilePressurePpm !== null ? newestGlobal.mobilePressurePpm.toString() : null,
    // A38: share of leaf-booked VP held by relay veNFTs, same hour
    relaySharePpm: newestGlobal && newestGlobal.bucket === last.bucket && newestGlobal.relaySharePpm !== null ? newestGlobal.relaySharePpm.toString() : null,
  };
}
// Last archiver run per chain (Frozen data state when it failed).
const run = store.readState("all", "run");
index.status = run?.chains ?? {};

if (process.argv.includes("--prices")) {
  const keys = [];
  for (const [cid, c] of Object.entries(index.chains)) for (const t of Object.keys(c.tokens)) keys.push([cid, priceKey(c.slug, t), t]);
  try {
    const prices = await fetchPrices(keys.map(([, k]) => k));
    for (const [cid, k, t] of keys) {
      const p = prices.get(k);
      const ok = p && (p.confidence ?? 0) >= 0.9;
      index.chains[cid].tokens[t] = { ...index.chains[cid].tokens[t], priced: Boolean(ok), priceProvider: ok ? p.provider : null, priceTimestamp: ok ? p.timestamp : null };
    }
    index.priceCheck = { ok: true, provider: "defillama" };
  } catch (err) {
    // provider down: tokens keep their previous flags; the state is Frozen for priced views
    index.priceCheck = { ok: false, provider: "defillama", error: String(err.message).slice(0, 200) };
  }
}
if (writeJson("index.json", index)) written++;
console.log(`derived: ${written} files written under ${out}`);
