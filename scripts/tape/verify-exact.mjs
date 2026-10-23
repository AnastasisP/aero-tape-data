// A5 verifier: pnpm tape:verify-exact -- --dir <tape-data> [--sample 50] [--seed n]
// Exactness: archived values equal a fresh read at the recorded block, to the wei.
//  a. `--sample` random gauge-state lines from the files on disk, each re-read alone
//  b. one random archived hour per chain, re-read whole (every gauge, leaf, root)
// Prints the sample so a failure can be replayed. Exit 1 on any mismatch.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { MULTICALL3, clientFor, multicallAt, withRetry } from "./client.mjs";
import { multicall3Abi } from "./abis.mjs";
import { gaugeCalls, gaugeRecordFrom, readHourSnapshot } from "./snapshot.mjs";
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
const lines = (rel) => readFileSync(join(store.dir, rel), "utf8").split("\n").filter(Boolean);
const onDisk = (prefix) =>
  Object.entries(manifest.files).filter(([rel]) => rel.includes(prefix) && existsSync(join(store.dir, rel)));

function compare(label, archived, fresh) {
  const a = JSON.stringify(archived);
  const f = JSON.stringify(fresh);
  if (a === f) return;
  const diff = Object.keys(archived).find((k) => JSON.stringify(archived[k]) !== JSON.stringify(fresh[k]));
  failures.push(`${label}: field "${diff}" archived ${JSON.stringify(archived[diff])} != fresh ${JSON.stringify(fresh[diff])}`);
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
    const res = await withRetry(() =>
      multicallAt(clientFor(chain), block, [
        { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
        ...gaugeCalls(leafVoter, g),
      ]),
    );
    const prov = { ...rec, blockTimestamp: Number(res[0]) };
    for (const k of Object.keys(prov)) if (!["schemaVersion", "chainId", "blockNumber", "blockTimestamp", "bucket", "source", "class"].includes(k)) delete prov[k];
    compare(`${chain.slug} ${rec.gauge} @${rec.blockNumber}`, rec, gaugeRecordFrom(prov, g, res.slice(1)).record);
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
  const snap = await withRetry(() =>
    readHourSnapshot(clientFor(chain), chain, files, BigInt(leaf.blockNumber), leaf.bucket, allKnown, allGauges),
  );
  compare(`${chain.slug} leaf-state @${leaf.blockNumber}`, leaf, snap.leaf);
  const archivedGauges = hourOf("gauge-state");
  if (archivedGauges.length !== snap.gauge.length) {
    failures.push(`${chain.slug} @${leaf.blockNumber}: ${archivedGauges.length} archived gauges != ${snap.gauge.length} fresh`);
  }
  const fresh = new Map(snap.gauge.map((r) => [r.gauge, r]));
  for (const r of archivedGauges) compare(`${chain.slug} ${r.gauge} @${r.blockNumber}`, r, fresh.get(r.gauge) ?? {});
  if (snap.root) {
    const [root] = hourOf("root-state");
    if (root) compare(`${chain.slug} root-state @${root.blockNumber}`, root, snap.root);
    else failures.push(`${chain.slug}: no root-state for hour ${leaf.bucket}`);
  }
  console.log(`${chain.slug}: hour ${new Date(leaf.bucket * 1000).toISOString()} re-read (${archivedGauges.length} gauges)`);
}

if (failures.length) {
  console.error(`\nA5 FAIL (seed ${startSeed}): ${failures.length} mismatch(es)`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA5 PASS (seed ${startSeed}): 0 mismatches`);
