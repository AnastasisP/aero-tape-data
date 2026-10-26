// A40 verifier: pnpm tape:verify-history -- [--url https://aero-companion.vercel.app] [--owner 0x…] [--seed n]
// The served position history (/api/position?op=history) of a real owner must equal, at a
// sampled hour per chain, a token-by-token rebuild from fresh LeafVoter.allocations and
// tokenStates of the owner's veNFTs at that hour's block (VP per leg = _contribution).
import { parseAbi } from "viem";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, withRetry } from "./client.mjs";
import { readLeafAllocations, readLeafTokenStates } from "./allocations.mjs";
import { contribution } from "../../lib/data/aero-v3/tape/points.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const url = arg("url", "https://aero-companion.vercel.app").replace(/\/$/, "");
let seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
const startSeed = seed;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const getJson = (path) =>
  withRetry(async () => {
    const res = await fetch(`${url}${path}`);
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  });
const { files } = loadDeployments();
const chains = loadChains();
const root = chains.find((c) => c.role === "root");

let owner = arg("owner");
if (!owner) {
  // a token with allocations on Base, and its owner today
  const raw = await fetch(`https://raw.githubusercontent.com/AnastasisP/aero-tape-data/derived/derived/v1/8453/alloc/${Math.floor(rand() * 64)}.json`).then((r) => r.json());
  const ids = Object.entries(raw.tokens).filter(([, e]) => e.legs.length).map(([id]) => id);
  const id = ids[Math.floor(rand() * ids.length)];
  const ve = files[`root-${root.slug}.json`].addresses.votingEscrow;
  owner = await clientFor(root).readContract({ address: ve, abi: parseAbi(["function ownerOf(uint256) view returns (address)"]), functionName: "ownerOf", args: [BigInt(id)] });
  console.log(`owner ${owner} (of veNFT ${id})`);
}
const h = await getJson(`/api/position?op=history&address=${owner}&days=7`);
const failures = [];
let points = 0;
const samples = [];
for (const [chainId, c] of Object.entries(h.chains)) {
  if (!c.points.length) continue;
  // one hour with VP booked (when there is one) and one hour at random
  const nz = c.points.filter((p) => p.total !== "0");
  if (nz.length) samples.push([chainId, nz[Math.floor(rand() * nz.length)]]);
  samples.push([chainId, c.points[Math.floor(rand() * c.points.length)]]);
}
for (const [chainId, p] of samples) {
  const chain = chains.find((x) => String(x.chainId) === chainId);
  const client = clientFor(chain);
  const leafVoter = files[`leaf-${chain.slug}.json`].addresses.leafVoter;
  const block = BigInt(p.blockNumber);
  const ts = (await withRetry(() => client.getBlock({ blockNumber: block }))).timestamp;
  const ids = new Set(h.tokenIds);
  const legs = await withRetry(() => readLeafAllocations(client, leafVoter, block, ids));
  const states = await withRetry(() => readLeafTokenStates(client, leafVoter, block, ids));
  const gauges = {};
  let total = 0n;
  for (const [key, amount] of legs) {
    const [id, g] = key.split(":");
    const s = states.get(id);
    if (!s) continue;
    const [, , end, perm] = s.split(",").map(Number);
    const k = contribution(BigInt(amount), BigInt(end), ts, perm === 1);
    const vp = k.bias + k.perm;
    if (vp === 0n) continue;
    gauges[g] = ((gauges[g] ? BigInt(gauges[g]) : 0n) + vp).toString();
    total += vp;
  }
  const served = Object.fromEntries(Object.entries(p.gauges).filter(([, v]) => v !== "0"));
  const same = JSON.stringify(Object.entries(served).sort()) === JSON.stringify(Object.entries(gauges).sort()) && String(total) === (p.total === "0" ? "0" : p.total);
  if (!same) failures.push(`chain ${chainId} @${p.blockNumber}: served ${JSON.stringify(served)} total ${p.total} != chain ${JSON.stringify(gauges)} total ${total}`);
  console.log(`chain ${chainId} @${new Date(p.bucket * 1000).toISOString()}: ${Object.keys(gauges).length} gauges, total ${total} ${same ? "==" : "!="} served`);
  points++;
}
if (!points) failures.push("no history point for this owner");
if (failures.length) {
  console.error(`\nA40 FAIL (seed ${startSeed}): ${failures.length} problem(s)\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log(`\nA40 PASS (seed ${startSeed}): ${h.tokenIds.length} veNFTs, ${points} sampled hours == fresh LeafVoter reads, to the wei`);
