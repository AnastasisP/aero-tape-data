// A27 verifier: pnpm tape:verify-decay -- [--url https://aero-companion.vercel.app] [--per-chain 3] [--weeks 12] [--seed n]
// For a seeded sample of gauges on every chain, the served decay calendar
// (/api/tape?op=decay-calendar) must equal a rebuild from fresh LeafVoter reads at the
// calendar's own block — the point, every gaugeSlopeChanges row and every derived weight,
// to the wei — and its weeks must add up (weightNow - Σ decayed == the last weightAt).
import { leafStateAbi } from "./abis.mjs";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { calendarBoundaries, decayCalendar } from "../../lib/data/aero-v3/tape/decay.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const url = arg("url", "https://aero-companion.vercel.app").replace(/\/$/, "");
const perChain = Number(arg("per-chain", "3"));
const weeks = Number(arg("weeks", "12"));
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

async function getJson(path) {
  return withRetry(async () => {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  });
}

const { files } = loadDeployments();
const index = await getJson("/api/tape?op=index");
const failures = [];
let checked = 0;
let rows = 0;
let nonzero = 0;

for (const chain of loadChains()) {
  const gauges = Object.keys(index.chains[String(chain.chainId)]?.gauges ?? {});
  if (!gauges.length) {
    failures.push(`${chain.slug}: no gauges in the tape index`);
    continue;
  }
  const pick = new Set();
  while (pick.size < Math.min(perChain, gauges.length)) pick.add(gauges[Math.floor(rand() * gauges.length)]);
  const leafVoter = files[`leaf-${chain.slug}.json`].addresses.leafVoter;
  const client = clientFor(chain);
  for (const gauge of pick) {
    const cal = await getJson(`/api/tape?op=decay-calendar&chainId=${chain.chainId}&gauge=${gauge}&weeks=${weeks}`);
    const block = BigInt(cal.blockNumber);
    const t = BigInt(cal.blockTimestamp);
    const [state] = await withRetry(() => multicallAt(client, block, [{ address: leafVoter, abi: leafStateAbi, functionName: "gaugeStates", args: [gauge] }]));
    const p = state[8];
    const point = { bias: p.bias, slope: p.slope, ts: BigInt(p.ts), permanentStakeBalance: p.permanentStakeBalance };
    const bs = calendarBoundaries(point.ts, t, weeks);
    const ch = bs.length
      ? await withRetry(() => multicallAt(client, block, bs.map((b) => ({ address: leafVoter, abi: leafStateAbi, functionName: "gaugeSlopeChanges", args: [gauge, Number(b)] }))))
      : [];
    const byB = new Map(bs.map((b, i) => [b, ch[i]]));
    const fresh = decayCalendar(point, t, weeks, (b) => byB.get(b) ?? 0n);
    const where = `${chain.slug} ${gauge} @${cal.blockNumber}`;
    const eq = (label, served, want) => {
      if (String(served) !== String(want)) failures.push(`${where} ${label}: served ${served} != fresh ${want}`);
    };
    eq("weightNow", cal.weightNow, fresh.weightNow);
    eq("permanent", cal.permanent, fresh.permanent);
    eq("decayingAfter", cal.decayingAfter, fresh.decayingAfter);
    eq("rows", cal.rows.length, fresh.rows.length);
    let sum = 0n;
    fresh.rows.forEach((r, i) => {
      const s = cal.rows[i] ?? {};
      eq(`row ${i} boundary`, s.boundary, r.boundary);
      eq(`row ${i} expiringSlope`, s.expiringSlope, r.expiringSlope);
      eq(`row ${i} weightAt`, s.weightAt, r.weightAt);
      eq(`row ${i} decayed`, s.decayed, r.decayed);
      sum += BigInt(s.decayed ?? 0);
      if (r.expiringSlope !== 0n) nonzero++;
      rows++;
    });
    if (cal.rows.length) eq("weeks add up", BigInt(cal.weightNow) - sum, cal.rows.at(-1).weightAt);
    if (cal.source !== "chain" || cal.chainId !== chain.chainId) failures.push(`${where}: provenance ${cal.source} ${cal.chainId}`);
    checked++;
  }
}

console.log(`seed ${startSeed}: ${checked} gauge calendars, ${rows} weekly rows (${nonzero} with stakes expiring) re-read at their blocks`);
if (failures.length) {
  console.error(`\nA27 FAIL (seed ${startSeed}): ${failures.length} mismatch(es)\n  ${failures.slice(0, 40).join("\n  ")}`);
  process.exit(1);
}
console.log("A27 PASS: every served calendar == fresh gaugeStates + gaugeSlopeChanges, to the wei");
