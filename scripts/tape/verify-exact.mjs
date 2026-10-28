// A5 verifier: pnpm tape:verify-exact -- --dir <tape-data> [--sample 50] [--seed n]
// Exactness: archived values equal a fresh read at the recorded block, to the wei.
//  a. `--sample` random gauge-state lines from the files on disk, each re-read alone
//  b. one random archived hour per chain, re-read whole (every gauge, leaf, root)
//  c. `--sample` random pool-state lines (A28, LP-side context), each pool re-read alone
//  d. `--sample` random cl-liquidity lines (A31), each pool re-read alone
//  e. up to 10 random migration-state lines (A33), re-read at their blocks
// Prints the sample so a failure can be replayed. Exit 1 on any mismatch. A read the RPC
// cannot serve (drpc Robinhood "Unknown state") is reported as unverified, not as a
// mismatch; exit 1 too when more than half of the sampled reads went unverified.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { MULTICALL3, clientFor, multicallAt, withRetry } from "./client.mjs";
import { multicall3Abi } from "./abis.mjs";
import { gaugeCalls, gaugeRecordFrom, readHourSnapshot } from "./snapshot.mjs";
import { readClLiquidity, readPoolStates } from "./pools.mjs";
import { readMigrationState } from "./migration.mjs";
import { TapeStore } from "./store.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const dir = arg("dir");
const sampleSize = Number(arg("sample", "50"));
let seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
if (!dir) {
  console.error("usage: node scripts/tape/verify-exact.mjs --dir <tape-data> [--sample 50] [--seed n]");
  process.exit(2);
}
// mulberry32: a seeded PRNG, so --seed replays the same sample.
const rand = () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const startSeed = seed;

const store = new TapeStore(dir, { readOnly: true });
const { manifest } = store;
const chains = loadChains();
const byId = new Map(chains.map((c) => [c.chainId, c]));
const { files } = loadDeployments();
const failures = [];
const unverified = [];
let attempted = 0;
/** One fresh read: its result, or null (recorded as unverified) when the RPC cannot serve it. */
async function fresh(label, read) {
  attempted++;
  try {
    return await withRetry(read);
  } catch (err) {
    unverified.push(`${label}: ${String(err.details ?? err.shortMessage ?? err.message).slice(0, 120)}`);
    return null;
  }
}
const lines = (rel) => readFileSync(join(store.dir, rel), "utf8").split("\n").filter(Boolean);
const onDisk = (prefix) =>
  Object.entries(manifest.files).filter(([rel]) => rel.includes(prefix) && existsSync(join(store.dir, rel)));

function compare(label, archived, fresh) {
  const a = JSON.stringify(archived);
  const f = JSON.stringify(fresh);
  if (a === f) return true;
  const diff = Object.keys(archived).find((k) => JSON.stringify(archived[k]) !== JSON.stringify(fresh[k]));
  failures.push(`${label}: field "${diff}" archived ${JSON.stringify(archived[diff])} != fresh ${JSON.stringify(fresh[diff])}`);
  return false;
}

/** One gauge-state record re-read alone at its block (pinned multicall), or null when the RPC cannot serve it. */
async function readGaugeRecord(rec) {
  const chain = byId.get(rec.chainId);
  const links = manifest.gauges[rec.chainId]?.[rec.gauge]?.split(",");
  if (!links) return null;
  const g = { gauge: rec.gauge, pool: links[0], rewards: links[1] };
  const leafVoter = files[`leaf-${chain.slug}.json`].addresses.leafVoter;
  const res = await withRetry(() =>
    multicallAt(clientFor(chain), BigInt(rec.blockNumber), [{ address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" }, ...gaugeCalls(leafVoter, g)]),
  ).catch(() => null);
  if (!res) return null;
  const prov = { ...rec, blockTimestamp: Number(res[0]) };
  for (const k of Object.keys(prov)) if (!["schemaVersion", "chainId", "blockNumber", "blockTimestamp", "bucket", "source", "class"].includes(k)) delete prov[k];
  return gaugeRecordFrom(prov, g, res.slice(1)).record;
}

/**
 * A mismatch is confirmed before it counts (archive run 40614095805, 2026-10-28): a public RPC answered a
 * pinned read of block 53142127 with later state (block.number matched, the incentive count was the one
 * created 19 h later, which the archive's own program rows date). Two more reads of the same point: a
 * mismatch stands only when all fresh reads agree with each other and differ from the archive; otherwise the
 * RPC was inconsistent and the point is unverified (still bounded by the more-than-half rule).
 */
async function confirmGauge(label, archived, firstFresh) {
  if (JSON.stringify(archived) === JSON.stringify(firstFresh)) return;
  const again = [await readGaugeRecord(archived), await readGaugeRecord(archived)];
  const freshes = [firstFresh, ...again].map((r) => JSON.stringify(r));
  if (again.some((r) => r === null) || new Set(freshes).size > 1 || freshes.includes(JSON.stringify(archived))) {
    unverified.push(`${label}: RPC inconsistent across 3 reads of the same block`);
    return;
  }
  compare(label, archived, firstFresh);
}

// a. random gauge-state points
const gaugeFiles = onDisk("/gauge-state/");
const totalLines = gaugeFiles.reduce((n, [, m]) => n + m.lines, 0);
const picks = new Map(); // rel -> Set(line index)
for (let i = 0; i < sampleSize && totalLines > 0; i++) {
  let k = Math.floor(rand() * totalLines);
  for (const [rel, m] of gaugeFiles) {
    if (k < m.lines) {
      (picks.get(rel) ?? picks.set(rel, new Set()).get(rel)).add(k);
      break;
    }
    k -= m.lines;
  }
}
let points = 0;
for (const [rel, idxs] of picks) {
  const all = lines(rel);
  for (const i of idxs) {
    const rec = JSON.parse(all[i]);
    const chain = byId.get(rec.chainId);
    const links = manifest.gauges[rec.chainId]?.[rec.gauge]?.split(",");
    if (!links) {
      failures.push(`${rel}:${i + 1}: gauge ${rec.gauge} not in the manifest registry`);
      continue;
    }
    const g = { gauge: rec.gauge, pool: links[0], rewards: links[1] };
    const leafVoter = files[`leaf-${chain.slug}.json`].addresses.leafVoter;
    const block = BigInt(rec.blockNumber);
    const res = await fresh(`${chain.slug} ${rec.gauge} @${rec.blockNumber}`, () =>
      multicallAt(clientFor(chain), block, [
        { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
        ...gaugeCalls(leafVoter, g),
      ]),
    );
    if (!res) continue;
    const prov = { ...rec, blockTimestamp: Number(res[0]) };
    for (const k of Object.keys(prov)) if (!["schemaVersion", "chainId", "blockNumber", "blockTimestamp", "bucket", "source", "class"].includes(k)) delete prov[k];
    await confirmGauge(`${chain.slug} ${rec.gauge} @${rec.blockNumber}`, rec, gaugeRecordFrom(prov, g, res.slice(1)).record);
    points++;
  }
}
console.log(`seed ${startSeed}: ${points} gauge points re-read`);

// b. one whole hour per chain
for (const chain of chains) {
  const leafFiles = onDisk(`${chain.chainId}/leaf-state/`).filter(([rel]) => rel.startsWith(`${chain.chainId}/`));
  if (!leafFiles.length) continue;
  const [rel] = leafFiles[Math.floor(rand() * leafFiles.length)];
  const leafLines = lines(rel);
  const leaf = JSON.parse(leafLines[Math.floor(rand() * leafLines.length)]);
  const hourOf = (metric) =>
    onDisk(`${chain.chainId}/${metric}/`)
      .filter(([r]) => r.startsWith(`${chain.chainId}/`))
      .flatMap(([r]) => lines(r).map((l) => JSON.parse(l)))
      .filter((r) => r.bucket === leaf.bucket);
  const allKnown = new Map(Object.entries(manifest.programs[chain.chainId] ?? {}).map(([k]) => [k, Infinity]));
  const allGauges = new Map(Object.entries(manifest.gauges[chain.chainId] ?? {}).map(([k]) => [k, "*"]));
  const snap = await fresh(`${chain.slug} hour @${leaf.blockNumber}`, () =>
    readHourSnapshot(clientFor(chain), chain, files, BigInt(leaf.blockNumber), leaf.bucket, allKnown, allGauges),
  );
  if (!snap) continue;
  compare(`${chain.slug} leaf-state @${leaf.blockNumber}`, leaf, snap.leaf);
  const archivedGauges = hourOf("gauge-state");
  if (archivedGauges.length !== snap.gauge.length) {
    failures.push(`${chain.slug} @${leaf.blockNumber}: ${archivedGauges.length} archived gauges != ${snap.gauge.length} fresh`);
  }
  const freshGauges = new Map(snap.gauge.map((r) => [r.gauge, r]));
  for (const r of archivedGauges) await confirmGauge(`${chain.slug} ${r.gauge} @${r.blockNumber}`, r, freshGauges.get(r.gauge) ?? {});
  if (snap.root) {
    const [root] = hourOf("root-state");
    if (root) compare(`${chain.slug} root-state @${root.blockNumber}`, root, snap.root);
    else failures.push(`${chain.slug}: no root-state for hour ${leaf.bucket}`);
  }
  console.log(`${chain.slug}: hour ${new Date(leaf.bucket * 1000).toISOString()} re-read (${archivedGauges.length} gauges)`);
}

// c. random pool-state points (A28): same reader, one gauge, at the recorded block
const poolFiles = onDisk("/pool-state/");
const poolLines = poolFiles.flatMap(([rel]) => lines(rel).map((l, i) => ({ rel, i, l })));
let poolPoints = 0;
for (let n = 0; n < sampleSize && poolLines.length; n++) {
  const { rel, i, l } = poolLines[Math.floor(rand() * poolLines.length)];
  const rec = JSON.parse(l);
  const chain = byId.get(rec.chainId);
  const prov = { schemaVersion: rec.schemaVersion, chainId: rec.chainId, blockNumber: rec.blockNumber, blockTimestamp: rec.blockTimestamp, bucket: rec.bucket, source: rec.source, class: rec.class };
  const read = await fresh(`${chain.slug} pool ${rec.pool} @${rec.blockNumber}`, () => readPoolStates(clientFor(chain), BigInt(rec.blockNumber), prov, new Map([[rec.gauge, `${rec.pool},,,`]])));
  poolPoints++;
  if (!read) continue;
  const { rows } = read;
  if (rows.length !== 1) failures.push(`${rel}:${i + 1}: pool ${rec.pool} has no readable tape at ${rec.blockNumber}`);
  else compare(`${chain.slug} pool ${rec.pool} @${rec.blockNumber}`, rec, rows[0]);
}
console.log(`${poolPoints} pool-state points re-read`);

// d. random cl-liquidity points (A31): same reader, one gauge, at the recorded block
const clLines = onDisk("/cl-liquidity/").flatMap(([rel]) => lines(rel).map((l, i) => ({ rel, i, l })));
let clPoints = 0;
for (let n = 0; n < sampleSize && clLines.length; n++) {
  const { rel, i, l } = clLines[Math.floor(rand() * clLines.length)];
  const rec = JSON.parse(l);
  const chain = byId.get(rec.chainId);
  const prov = { schemaVersion: rec.schemaVersion, chainId: rec.chainId, blockNumber: rec.blockNumber, blockTimestamp: rec.blockTimestamp, bucket: rec.bucket, source: rec.source, class: rec.class };
  const read = await fresh(`${chain.slug} cl ${rec.pool} @${rec.blockNumber}`, () => readClLiquidity(clientFor(chain), BigInt(rec.blockNumber), prov, new Map([[rec.gauge, `${rec.pool},,,`]])));
  clPoints++;
  if (!read) continue;
  if (read.rows.length !== 1) failures.push(`${rel}:${i + 1}: CL pool ${rec.pool} has no liquidity read at ${rec.blockNumber}`);
  else compare(`${chain.slug} cl ${rec.pool} @${rec.blockNumber}`, rec, read.rows[0]);
}
console.log(`${clPoints} cl-liquidity points re-read`);

// e. random migration-state points (A33): same reader, at the recorded block
const migLines = onDisk("/migration-state/").flatMap(([rel]) => lines(rel).map((l, i) => ({ rel, i, l })));
let migPoints = 0;
for (let n = 0; n < Math.min(10, sampleSize) && migLines.length; n++) {
  const { rel, i, l } = migLines[Math.floor(rand() * migLines.length)];
  const rec = JSON.parse(l);
  const chain = byId.get(rec.chainId);
  const prov = { schemaVersion: rec.schemaVersion, chainId: rec.chainId, blockNumber: rec.blockNumber, blockTimestamp: rec.blockTimestamp, bucket: rec.bucket, source: rec.source, class: rec.class };
  const rows = await fresh(`${chain.slug} migration @${rec.blockNumber}`, () => readMigrationState(clientFor(chain), files, chain, BigInt(rec.blockNumber), prov));
  migPoints++;
  if (!rows) continue;
  if (rows.length !== 1) failures.push(`${rel}:${i + 1}: no migration state at ${rec.blockNumber}`);
  else compare(`${chain.slug} migration @${rec.blockNumber}`, rec, rows[0]);
}
console.log(`${migPoints} migration-state points re-read`);

if (unverified.length) {
  console.log(`\n${unverified.length} of ${attempted} reads unverified (RPC could not serve them):`);
  for (const u of unverified.slice(0, 20)) console.log(`  ~ ${u}`);
}
if (unverified.length * 2 > attempted) failures.push(`${unverified.length} of ${attempted} reads unverified: too few points checked`);
if (failures.length) {
  console.error(`\nA5 FAIL (seed ${startSeed}): ${failures.length} mismatch(es)`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA5 PASS (seed ${startSeed}): 0 mismatches in ${attempted - unverified.length} verified reads`);
