// The tape archiver (A3). One run = for each chain, every complete hour after the
// chain's cursor, read at the first block >= that hour, appended to the store.
//   node scripts/tape/archive.mjs --out <dir> [--max-hours 48] [--chains base,arc]
// First run starts at Minter.ACTIVATION_TIMESTAMP (read on-chain). A missed run is
// healed by the next one (archive-state reads at past blocks), up to --max-hours
// per chain per run. A chain whose RPC fails keeps the hours already written and is
// recorded as failed in state/all/run.json (data state Frozen); the other chains
// carry on and the run exits 0. Only a run where every chain fails exits 1
// (operator 2026-10-23: one chain's RPC must not fail the run).
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, withRetry } from "./client.mjs";
import { firstBlockAtOrAfter, safeHead } from "./blocks.mjs";
import { readHourSnapshot } from "./snapshot.mjs";
import { TapeStore } from "./store.mjs";
import { rootStateAbi } from "./abis.mjs";
import { allocationRows, readLeafAllocations, readLeafTokenStates, readRootTokenChains, tokenStateRows } from "./allocations.mjs";
import { SCHEMA_VERSION } from "./snapshot.mjs";

const HOUR = 3600;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const out = arg("out");
if (!out) {
  console.error("usage: node scripts/tape/archive.mjs --out <dir> [--max-hours 48] [--chains a,b]");
  process.exit(2);
}
const maxHours = Number(arg("max-hours", "48"));
const only = arg("chains")?.split(",");

const chains = loadChains().filter((c) => !only || only.includes(c.slug));
const { files } = loadDeployments();
const store = new TapeStore(out);
for (const r of store.repairs) console.log(`repair ${r}`);

// Activation is read once from the root chain's Minter, never hardcoded.
const root = loadChains().find((c) => c.role === "root");
const activation = Number(
  await clientFor(root).readContract({
    address: files[`root-${root.slug}.json`].addresses.minter,
    abi: rootStateAbi,
    functionName: "ACTIVATION_TIMESTAMP",
  }),
);

// Root token -> chains, per hour, shared by the chain loops (one root read per hour).
const rootClient = clientFor(root);
const rootHead = await safeHead(rootClient);
let rootLo = await rootClient.getBlock({ blockNumber: 0n });
const rootTokens = new Map();
function rootTokenChains(hour) {
  if (!rootTokens.has(hour)) {
    rootTokens.set(
      hour,
      withRetry(async () => {
        const b = await firstBlockAtOrAfter(rootClient, hour, rootLo, rootHead);
        if (b.number > rootLo.number) rootLo = b;
        return readRootTokenChains(rootClient, files[`root-${root.slug}.json`], b.number);
      }),
    );
  }
  return rootTokens.get(hour);
}

/**
 * Booked allocations of one chain-hour: root-listed tokens for this chain plus every token
 * already seen here. Returns the rows to append and the new state.
 */
async function allocationHour(store, chain, client, hour, block) {
  const tokenChains = await rootTokenChains(hour);
  const prevState = store.readState(chain.chainId, "allocations");
  const prev = prevState ? new Map(Object.entries(prevState.legs)) : null;
  const ids = new Set([...tokenChains].filter(([, cs]) => cs.includes(chain.chainId)).map(([id]) => id));
  for (const key of prev?.keys() ?? []) ids.add(key.split(":")[0]);
  const next = await withRetry(() => readLeafAllocations(client, files[`leaf-${chain.slug}.json`].addresses.leafVoter, block.number, ids));
  const prov = { schemaVersion: SCHEMA_VERSION, chainId: chain.chainId, blockNumber: Number(block.number), blockTimestamp: Number(block.timestamp), bucket: hour, source: "chain", class: "E" };
  return { rows: allocationRows(prov, prev, next), next };
}

/**
 * Leaf token states (A26) of one chain-hour: the same token set the allocations read
 * (root-listed for this chain plus tokens already seen here).
 */
async function tokenStateHour(store, chain, client, hour, block) {
  const tokenChains = await rootTokenChains(hour);
  const prevState = store.readState(chain.chainId, "token-states");
  const prev = prevState ? new Map(Object.entries(prevState.tokens)) : null;
  const ids = new Set([...tokenChains].filter(([, cs]) => cs.includes(chain.chainId)).map(([id]) => id));
  for (const id of prev?.keys() ?? []) ids.add(id);
  const next = await withRetry(() => readLeafTokenStates(client, files[`leaf-${chain.slug}.json`].addresses.leafVoter, block.number, ids));
  const prov = { schemaVersion: SCHEMA_VERSION, chainId: chain.chainId, blockNumber: Number(block.number), blockTimestamp: Number(block.timestamp), bucket: hour, source: "chain", class: "E" };
  return { rows: tokenStateRows(prov, prev, next), next };
}

const ALLOC = "allocation-change";
const TOKENS = "token-leaf-state";
/** Metrics added after a chain's first hour: each backfills from activation with its own cursor. */
const LATE_METRICS = [
  { metric: ALLOC, state: "allocations", read: allocationHour, save: (next) => ({ legs: Object.fromEntries(next) }) },
  { metric: TOKENS, state: "token-states", read: tokenStateHour, save: (next) => ({ tokens: Object.fromEntries(next) }) },
];
let failed = false;
const runStatus = {}; // chainId -> { ok, error?, cursor, headTimestamp }
// Chains run in parallel (separate RPCs); hours within a chain run in order. The
// store is synchronous, so appends from different chains never interleave mid-write.
await Promise.all(
  chains.map(async (chain) => {
    const client = clientFor(chain);
    let written = 0;
    try {
      const head = await safeHead(client);
      const lastComplete = Math.floor(Number(head.timestamp) / HOUR) * HOUR;
      const cursor = store.cursor(chain.chainId);
      let hour = cursor === null ? Math.ceil(activation / HOUR) * HOUR : cursor + HOUR;
      let lo = await client.getBlock({ blockNumber: 0n });
      const programs = store.programs(chain.chainId);
      const gauges = store.gauges(chain.chainId);
      const feeCps = store.feeCheckpoints(chain.chainId);
      const slopeKeys = store.slopeChanges(chain.chainId);
      const relayKeys = store.relays(chain.chainId);
      const tokenKeys = store.tokens(chain.chainId);
      const first = Math.ceil(activation / HOUR) * HOUR;
      // Backfill each late metric for hours the chain already has (its own cursor).
      for (const m of LATE_METRICS) {
        let mc = store.metricCursor(chain.chainId, m.metric);
        if (cursor === null || (mc ?? first - HOUR) >= cursor) continue;
        let blo = lo;
        for (let h = (mc ?? first - HOUR) + HOUR; h <= cursor && written < maxHours; h += HOUR) {
          const block = await withRetry(() => firstBlockAtOrAfter(client, h, blo, head));
          const { rows, next } = await m.read(store, chain, client, h, block);
          store.appendMetricHour(chain.chainId, m.metric, h, rows);
          store.writeState(chain.chainId, m.state, { bucket: h, ...m.save(next) });
          mc = h;
          blo = block;
          written++;
        }
        if (mc < cursor) hour = lastComplete + HOUR; // budget spent: new hours wait for the next run
      }
      for (; hour <= lastComplete && written < maxHours; hour += HOUR) {
        const block = await withRetry(() => firstBlockAtOrAfter(client, hour, lo, head));
        const snap = await withRetry(() => readHourSnapshot(client, chain, files, block.number, hour, programs, gauges, feeCps, slopeKeys, relayKeys, tokenKeys));
        const late = [];
        for (const m of LATE_METRICS) late.push({ m, ...(await m.read(store, chain, client, hour, block)) });
        const records = [snap.leaf, ...snap.registry, ...snap.gauge, ...snap.programs, ...snap.feeCheckpoints, ...snap.slopeChanges, ...snap.relays, ...snap.tokens, ...late.flatMap((x) => x.rows), ...(snap.root ? [snap.root] : [])];
        store.appendHour(chain.chainId, hour, records, snap.programs, snap.registry, snap.feeCheckpoints, LATE_METRICS.map((m) => m.metric));
        for (const x of late) store.writeState(chain.chainId, x.m.state, { bucket: hour, ...x.m.save(x.next) });
        for (const p of snap.programs) programs.set(p.rewards, Math.max(programs.get(p.rewards) ?? 0, p.programId));
        for (const g of snap.registry) gauges.set(g.gauge, [g.pool, g.rewards, g.token0, g.token1].join(","));
        for (const c of snap.feeCheckpoints) feeCps.set(c.rewards, Math.max(feeCps.get(c.rewards) ?? 0, c.index));
        for (const r of snap.slopeChanges) slopeKeys.add(`${r.gauge}:${r.boundary}`);
        for (const r of snap.relays) relayKeys.add(r.relay);
        for (const r of snap.tokens) tokenKeys.add(r.token);
        // block.timestamp < hour + 1h, or block is also the first block >= the next hour.
        lo = block;
        written++;
      }
      const behind = Math.max(0, (lastComplete - (store.cursor(chain.chainId) ?? lastComplete)) / HOUR);
      console.log(`${chain.slug}: +${written} hours, cursor ${store.cursor(chain.chainId)}, ${behind} hours behind, ${ALLOC} cursor ${store.metricCursor(chain.chainId, ALLOC)}, ${TOKENS} cursor ${store.metricCursor(chain.chainId, TOKENS)}`);
      runStatus[chain.chainId] = { ok: true, cursor: store.cursor(chain.chainId), headTimestamp: Number(head.timestamp) };
    } catch (err) {
      failed = true;
      runStatus[chain.chainId] = { ok: false, error: String(err.shortMessage ?? err.message).slice(0, 200), cursor: store.cursor(chain.chainId) };
      console.error(`${chain.slug}: FAILED after ${written} hours: ${err.shortMessage ?? err.message} ${err.details ?? ""}`.trim());
      if (process.env.TAPE_DEBUG) console.error(err);
    }
  }),
);
// The last run's outcome per chain, for the data state (Frozen when a chain's run failed).
const prevRun = store.readState("all", "run") ?? { chains: {} };
store.writeState("all", "run", { chains: { ...prevRun.chains, ...runStatus } });
const failedChains = Object.entries(runStatus).filter(([, r]) => !r.ok).map(([id]) => id);
if (failedChains.length) console.log(`frozen this run (RPC failure, recorded): ${failedChains.join(", ")}`);
process.exit(failed && failedChains.length === chains.length ? 1 : 0);
