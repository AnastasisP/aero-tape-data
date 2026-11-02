// R-ECON4 verifier: node scripts/tape/verify-served-parity.mjs --dir <tape-data> [--gauges 8] [--hours 24]
// A6 proves our claim pricing; this proves the SERVED series. Over the last 24 archived Base hours, on the heaviest gauges:
//  - Σ served 1h feeYield == Δ feeRewardPerVotingPower() at the two blocks, residual 0
//  - where a relay's permanent position sits on the gauge with a paying program, Δ earnedIncentives is within 2% of
//    weight × Σ served incentive part. The contract integrates over its own checkpoints and the tape samples hourly, so
//    this part is an accuracy bound (ECON-4 measured 0.0005% to 0.76%), never an equality. A claim in the window skips it.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { TapeStore } from "./store.mjs";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
};
const dir = arg("dir");
const GAUGES = Number(arg("gauges", "8"));
const HOURS = Number(arg("hours", "24"));
if (!dir) {
  console.error("usage: node scripts/tape/verify-served-parity.mjs --dir <tape-data> [--gauges 8] [--hours 24]");
  process.exit(2);
}
const abi = parseAbi([
  "function feeRewardPerVotingPower() view returns (uint256, uint256, uint256, uint256)",
  "function earnedIncentives(uint256, uint256, uint256) view returns (uint256)",
  "function allocations(uint256, address) view returns (uint256)",
]);
const MAX = 2n ** 256n - 1n;
const root = loadChains().find((c) => c.role === "root");
const leafVoter = loadDeployments().files[`leaf-${root.slug}.json`].addresses.leafVoter;
const client = clientFor(root);
const store = new TapeStore(dir, { readOnly: true });
const links = store.manifest.gauges[root.chainId];
const index = JSON.parse(readFileSync(join(dir, "derived/v1/index.json"), "utf8"));
const chain = index.chains[String(root.chainId)];
const end = chain.cursor;
const start = end - HOURS * 3600;
const hourly = new Map();
const hourDir = join(dir, `derived/v1/${root.chainId}/1h`);
for (const f of existsSync(hourDir) ? readdirSync(hourDir) : []) {
  const day = Date.parse(f.slice(0, 10)) / 1000;
  if (day + 86400 <= start || day > end) continue;
  for (const [g, cs] of Object.entries(JSON.parse(readFileSync(join(hourDir, f), "utf8")).gauges)) hourly.set(g, [...(hourly.get(g) ?? []), ...cs]);
}
const value = (v) => BigInt(v?.v ?? v?.c ?? 0);
const relays = (index.market?.relays ?? []).map((r) => BigInt(r.tokenId));
const heavy = Object.entries(chain.gauges).sort((a, b) => (BigInt(b[1].latest?.weight ?? 0) > BigInt(a[1].latest?.weight ?? 0) ? 1 : -1)).slice(0, GAUGES);
const failures = [];
let feePairs = 0;
let incentivePairs = 0;
let skipped = 0;
let worst = 0;
for (const [gauge, info] of heavy) {
  const cs = (hourly.get(gauge) ?? []).filter((c) => c.bucket > start && c.bucket <= end).sort((a, b) => a.bucket - b.bucket);
  const last = cs.at(-1);
  const before = (hourly.get(gauge) ?? []).find((c) => c.bucket === start);
  if (cs.length !== HOURS || !before) {
    failures.push(`${gauge}: ${cs.length} of ${HOURS} hours served`);
    continue;
  }
  const rewards = links[gauge].split(",")[1];
  const read = (block, fn, args = []) => withRetry(() => multicallAt(client, BigInt(block), [{ address: rewards, abi, functionName: fn, args }]));
  const [[a]] = [await read(before.closeBlock, "feeRewardPerVotingPower")];
  const [[b]] = [await read(last.closeBlock, "feeRewardPerVotingPower")];
  for (const [i, token] of [info.token0, info.token1].entries()) {
    if (!token) continue;
    const served = cs.reduce((s, c) => s + value(c.series.feeYield?.[token]), 0n);
    feePairs++;
    if (served !== b[i] - a[i]) failures.push(`${gauge} ${token}: Σ served feeYield ${served} != chain Δ ${b[i] - a[i]}`);
  }
  const paying = (info.programs ?? []).filter((p) => p.start <= before.closeTimestamp && p.end >= last.closeTimestamp);
  const tokensDone = new Set();
  for (const p of paying) {
    const token = p.token.toLowerCase();
    if (tokensDone.has(token)) continue;
    tokensDone.add(token);
    const [weights] = [await withRetry(() => multicallAt(client, BigInt(last.closeBlock), relays.map((id) => ({ address: leafVoter, abi, functionName: "allocations", args: [id, gauge] }))))];
    const k = weights.findIndex((w, i) => w > 0n && relays[i] !== undefined);
    if (k < 0) {
      skipped++;
      continue;
    }
    const id = relays[k];
    // the served incentive part is per token: it sums every program of the token that overlaps the window, so the chain
    // side sums them too (program 10 starting inside the window read as 30.6% off, 2026-11-02). A program not yet
    // created at the first block has earned 0 there.
    const overlapping = (info.programs ?? []).filter((o) => o.token.toLowerCase() === token && o.start < last.closeTimestamp && o.end > before.closeTimestamp);
    let e1 = 0n;
    let e2 = 0n;
    for (const o of overlapping) {
      if (o.start <= before.closeTimestamp) e1 += (await read(before.closeBlock, "earnedIncentives", [id, BigInt(o.programId), MAX]))[0];
      e2 += (await read(last.closeBlock, "earnedIncentives", [id, BigInt(o.programId), MAX]))[0];
    }
    if (e2 <= e1) {
      skipped++;
      continue;
    }
    const part = cs.reduce((s, c) => s + value(c.series.yieldPerWeight?.[token]) - value(c.series.feeYield?.[token]), 0n);
    const want = (part * weights[k]) / 10n ** 24n;
    const off = Math.abs(Number(e2 - e1 - want)) / Number(e2 - e1);
    incentivePairs++;
    worst = Math.max(worst, off);
    if (off > 0.02) failures.push(`${gauge} programs ${overlapping.map((o) => o.programId).join("+")} token ${id}: Δ earnedIncentives ${e2 - e1} vs served ${want} (${(off * 100).toFixed(3)}%)`);
  }
}
console.log(`${heavy.length} gauges over ${HOURS} h: ${feePairs} fee pairs exact checks, ${incentivePairs} incentive pairs (worst ${(worst * 100).toFixed(3)}%), ${skipped} skipped`);
if (failures.length) {
  console.error(`\nR-ECON4 FAIL:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
if (!feePairs) {
  console.error("R-ECON4 FAIL: nothing compared");
  process.exit(1);
}
console.log("\nR-ECON4 PASS: Σ served feeYield equals the chain's accumulator; served incentives are within 2% of earnedIncentives");
