// A30 verifier: pnpm tape:verify-runway -- [--url https://aero-companion.vercel.app] [--per-chain 6] [--seed n]
// For a seeded sample of gauges on every chain (gauges with incentive programs first), the
// served incentive runway (/api/tape?op=incentive-runway) must equal a rebuild from fresh
// incentiveCount / incentive(id) / remainingAmount(id) reads at the runway's own block, to
// the wei, and its per-token totals must add up over its programs.
import { parseAbi } from "viem";
import { loadChains } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { incentiveRunway } from "../../lib/data/aero-v3/tape/runway.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const url = arg("url", "https://aero-companion.vercel.app").replace(/\/$/, "");
const perChain = Number(arg("per-chain", "6"));
let seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
const startSeed = seed;
// mulberry32, as verify-exact.mjs
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const abi = parseAbi([
  "function incentiveCount() view returns (uint256)",
  "struct IncentiveProgram { address token; uint256 amount; uint256 rate; uint48 start; uint48 end; address creator; }",
  "function incentive(uint256) view returns (IncentiveProgram)",
  "function remainingAmount(uint256) view returns (uint256)",
]);
const getJson = (path) =>
  withRetry(async () => {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  });

const index = await getJson("/api/tape?op=index");
const failures = [];
let checked = 0;
let programs = 0;
for (const chain of loadChains()) {
  const gauges = Object.entries(index.chains[String(chain.chainId)]?.gauges ?? {});
  // gauges whose newest hour has an incentive rate, then any others
  const withIncentives = gauges.filter(([, g]) => Object.keys(g.latest?.yieldPerWeight ?? {}).length).map(([k]) => k);
  const pool = withIncentives.length >= perChain ? withIncentives : gauges.map(([k]) => k);
  const pick = new Set();
  while (pick.size < Math.min(perChain, pool.length)) pick.add(pool[Math.floor(rand() * pool.length)]);
  const client = clientFor(chain);
  for (const gauge of pick) {
    const served = await getJson(`/api/tape?op=incentive-runway&chainId=${chain.chainId}&gauge=${gauge}`);
    const block = BigInt(served.blockNumber);
    const rewards = served.rewards;
    const [count] = await withRetry(() => multicallAt(client, block, [{ address: rewards, abi, functionName: "incentiveCount" }]));
    const ids = Array.from({ length: Number(count) }, (_, i) => i + 1);
    const reads = ids.length
      ? await withRetry(() => multicallAt(client, block, ids.flatMap((id) => [{ address: rewards, abi, functionName: "incentive", args: [BigInt(id)] }, { address: rewards, abi, functionName: "remainingAmount", args: [BigInt(id)] }])))
      : [];
    const fresh = incentiveRunway(
      ids.map((programId, i) => ({ programId, token: reads[2 * i].token.toLowerCase(), amount: reads[2 * i].amount, rate: reads[2 * i].rate, start: Number(reads[2 * i].start), end: Number(reads[2 * i].end) })),
      new Map(ids.map((id, i) => [id, reads[2 * i + 1]])),
      served.blockTimestamp,
    );
    const where = `${chain.slug} ${gauge} @${served.blockNumber}`;
    const eq = (label, a, b) => String(a) !== String(b) && failures.push(`${where} ${label}: served ${a} != fresh ${b}`);
    eq("incentiveCount", served.incentiveCount, count);
    eq("programs", served.programs.length, fresh.programs.length);
    fresh.programs.forEach((p, i) => {
      const s = served.programs[i] ?? {};
      for (const k of ["programId", "token", "amount", "rate", "start", "end", "status", "scheduledToStream", "remaining"]) eq(`program ${p.programId} ${k}`, s[k], p[k]);
      programs++;
    });
    eq("tokens", Object.keys(served.tokens).sort().join(), Object.keys(fresh.tokens).sort().join());
    for (const [t, v] of Object.entries(fresh.tokens)) for (const k of ["ratePerSecond", "scheduledToStream", "remaining", "lastEnd"]) eq(`token ${t} ${k}`, served.tokens[t]?.[k], v[k]);
    checked++;
  }
}
console.log(`seed ${startSeed}: ${checked} gauge runways, ${programs} live programs re-read at their blocks`);
if (!programs) failures.push("no live program in the sample");
if (failures.length) {
  console.error(`\nA30 FAIL (seed ${startSeed}): ${failures.length} mismatch(es)\n  ${failures.slice(0, 40).join("\n  ")}`);
  process.exit(1);
}
console.log("A30 PASS: every served runway == fresh incentive(id) + remainingAmount(id), to the wei");
