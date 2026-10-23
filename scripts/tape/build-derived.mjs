// Derived tape (class D): candles of every core series, every gauge, every timeframe,
// built from the raw tape on disk. Deterministic: rebuilding unchanged input writes
// identical files, so only the forming period's files change from hour to hour.
//   node scripts/tape/build-derived.mjs --dir <tape-data> [--prices]
// --prices marks each token priced / unpriced from the provider (prices.mjs) for the
// Unpriced data state; the tape itself never stores an estimated price.
// Output under <dir>/derived/v1:
//   <chainId>/<tf>/<period>.json   1h and 4h per UTC day, 1d per month, 1w per year
//   index.json                      gauges (tokens, pool, hours) and the market state
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { TapeStore } from "./store.mjs";
import { SERIES_META, TIMEFRAMES, aggregate, deriveHourly, serialize } from "../../lib/data/aero-v3/tape/series.mjs";
import { resolvePoint } from "../../lib/data/aero-v3/tape/points.mjs";
import { fetchPrices, priceKey } from "./prices.mjs";

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
const index = { schemaVersion: 1, series: SERIES_META, timeframes: Object.keys(TIMEFRAMES), chains: {}, market: null };
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
      latest: serialize({ bucket: last.bucket, blockNumber: last.blockNumber, weight: last.weight, voteSupply: last.voteSupply, yieldPerWeight: last.yieldPerWeight }),
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
  index.chains[chain.chainId] = {
    slug: chain.slug,
    name: chain.name,
    cursor: store.cursor(chain.chainId),
    // for the readout's "reproduce" line: the contract every gauge-state read goes to
    leafVoter: loadDeployments().files[`leaf-${chain.slug}.json`].addresses.leafVoter.toLowerCase(),
    rpc: chain.rpcs[0],
    // display only: symbol and decimals of fee / incentive tokens (amounts stay in base units)
    tokens: Object.fromEntries(rows.filter((r) => r.metric === "token-registry").map((r) => [r.token, { symbol: r.symbol, decimals: r.decimals }])),
    gauges,
  };
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
