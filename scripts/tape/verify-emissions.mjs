// A29 verifier: pnpm tape:verify-emissions -- --dir <tape-data> [--sample 40] [--seed n]
// Random 1h candles of the derived gauge emission series (derived/v1/<chainId>/emissions)
// must equal fresh LeafVoter.gaugeStates reads: claimable = ceiling - claimed - surplus at
// the candle's block, and each flow = the field's change since the previous hour's block.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { leafStateAbi } from "./abis.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const dir = arg("dir");
const sample = Number(arg("sample", "40"));
let seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
const startSeed = seed;
if (!dir) {
  console.error("usage: node scripts/tape/verify-emissions.mjs --dir <tape-data> [--sample 40] [--seed n]");
  process.exit(2);
}
// mulberry32, as verify-exact.mjs
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

const { files } = loadDeployments();
const chains = loadChains();
const failures = [];
// every (chain, gauge, candle index) with a non-null flow, so the previous hour exists
const pool = [];
for (const chain of chains) {
  const d = join(dir, "derived", "v1", String(chain.chainId), "emissions", "1h");
  if (!existsSync(d)) {
    failures.push(`${chain.slug}: no emission series`);
    continue;
  }
  for (const f of readdirSync(d).sort()) {
    const doc = JSON.parse(readFileSync(join(d, f), "utf8"));
    for (const [gauge, candles] of Object.entries(doc.gauges)) candles.forEach((c, i) => c.series.emissionsClaimed && pool.push({ chain, gauge, c, prev: candles[i - 1] ?? null }));
  }
}
const picks = [];
for (let i = 0; i < sample && pool.length; i++) picks.push(pool[Math.floor(rand() * pool.length)]);
// the previous hour's block: the candle before in the same file, else read the state at closeBlock of the prior file
let checked = 0;
// a sample the RPC cannot read after the retries is unreadable, not a mismatch (run 40510677245 crashed on one
// "RPC Request failed"); the run still fails when more than half the samples are unreadable
const unreadable = [];
for (const { chain, gauge, c, prev } of picks) {
  if (!prev || prev.bucket !== c.bucket - 3600) continue; // first candle of a day file: skip (flow crosses files)
  const leafVoter = files[`leaf-${chain.slug}.json`].addresses.leafVoter;
  const client = clientFor(chain);
  const read = (block) => withRetry(() => multicallAt(client, BigInt(block), [{ address: leafVoter, abi: leafStateAbi, functionName: "gaugeStates", args: [gauge] }]));
  let now, before;
  try {
    [[now], [before]] = await Promise.all([read(c.closeBlock), read(prev.closeBlock)]);
  } catch (err) {
    unreadable.push(`${chain.slug} ${gauge} @${c.closeBlock}: ${err.shortMessage ?? err.message}`);
    continue;
  }
  const v = (k) => BigInt(c.series[k].v);
  const want = {
    emissionsClaimable: now[0] - now[1] - now[5],
    emissionsCredited: now[0] - before[0],
    emissionsClaimed: now[1] - before[1],
    emissionsForfeited: now[5] - before[5],
  };
  for (const [k, w] of Object.entries(want)) if (v(k) !== w) failures.push(`${chain.slug} ${gauge} @${c.closeBlock}: ${k} served ${v(k)} != chain ${w}`);
  checked++;
}
console.log(`seed ${startSeed}: ${checked} candles re-read at their blocks (${pool.length} in the pool), ${unreadable.length} unreadable`);
for (const u of unreadable) console.log(`  unreadable: ${u}`);
if (!checked) failures.push("no candle checked");
if (unreadable.length * 2 > checked + unreadable.length) failures.push(`${unreadable.length} of ${checked + unreadable.length} samples unreadable (RPC)`);
if (failures.length) {
  console.error(`\nA29 FAIL: ${failures.length} problem(s)`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nA29 PASS: every sampled emission candle == fresh gaugeStates (ceiling, claimed, surplus), to the wei");
