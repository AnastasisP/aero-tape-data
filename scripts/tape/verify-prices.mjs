// A15 verifier: pnpm tape:verify-prices -- --dir <tape-data>
// Every fee and incentive token in the tape either has a price from the provider
// (confidence >= MIN_CONFIDENCE, timestamp within MAX_AGE) or is listed as unpriced, in
// which case its class-P values show "—". The v3 AERO price is verified against the
// chain: it must be within TOLERANCE of the spot price of the v3 AERO/USDC volatile pool
// with the most AERO reserve among the archived Base gauges' pools, read at the first
// block at or after the provider's price timestamp.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { firstBlockAtOrAfter, safeHead } from "./blocks.mjs";
import { TapeStore } from "./store.mjs";
import { fetchPrices, priceKey } from "./prices.mjs";

const MIN_CONFIDENCE = 0.9;
const MAX_AGE = 3 * 3600;
const TOLERANCE = 0.02;
const USDC_BASE = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // Circle USDC on Base

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: node scripts/tape/verify-prices.mjs --dir <tape-data>");
  process.exit(2);
}
const store = new TapeStore(dir, { readOnly: true });
const chains = loadChains();
const failures = [];
const rowsOf = (chainId, metric) =>
  Object.keys(store.manifest.files)
    .filter((f) => f.startsWith(`${chainId}/${metric}/`) && existsSync(join(store.dir, f)))
    .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

// Tokens: fee tokens of every gauge, every incentive token.
const keys = new Map(); // key -> [chain slug, role]
for (const c of chains) {
  for (const r of rowsOf(c.chainId, "gauge-registry")) for (const t of [r.token0, r.token1]) keys.set(priceKey(c.slug, t), "fee");
  for (const r of rowsOf(c.chainId, "incentive-program")) keys.set(priceKey(c.slug, r.token), "incentive");
}
const prices = await fetchPrices([...keys.keys()]);
const nowTs = Math.max(...[...prices.values()].map((p) => p.timestamp), 0);
const unpriced = [];
for (const k of keys.keys()) {
  const p = prices.get(k);
  if (!p || (p.confidence ?? 0) < MIN_CONFIDENCE || nowTs - p.timestamp > MAX_AGE) unpriced.push(k);
}
const perChain = {};
for (const k of keys.keys()) {
  const c = k.split(":")[0];
  perChain[c] ??= [0, 0];
  perChain[c][0]++;
  if (!unpriced.includes(k)) perChain[c][1]++;
}
console.log(`tokens: ${keys.size}, priced ${keys.size - unpriced.length}; per chain ${JSON.stringify(Object.fromEntries(Object.entries(perChain).map(([c, [n, p]]) => [c, `${p}/${n}`])))}`);
console.log(`unpriced (class-P values show "—"): ${unpriced.join(", ") || "none"}`);

// v3 AERO against the chain.
const root = chains.find((c) => c.role === "root");
const aero = loadDeployments().files[`root-${root.slug}.json`].addresses.token.toLowerCase();
const aeroPrice = prices.get(priceKey(root.slug, aero));
if (!aeroPrice || unpriced.includes(priceKey(root.slug, aero))) {
  failures.push(`v3 AERO ${aero} has no verified provider price`);
} else {
  const pools = rowsOf(root.chainId, "gauge-registry").filter(
    (r) => (r.token0 === aero && r.token1 === USDC_BASE) || (r.token1 === aero && r.token0 === USDC_BASE),
  );
  const client = clientFor(root);
  // Compare at the provider's own price time: the first block at or after its timestamp.
  const head = await safeHead(client);
  const { number: block } = await withRetry(() =>
    firstBlockAtOrAfter(client, aeroPrice.timestamp, { number: head.number - 100000n, timestamp: head.timestamp - 200000n }, head),
  );
  const abi = parseAbi(["function getReserves() view returns (uint256, uint256, uint256)", "function targetToFactory(address) view returns (address)"]);
  const files = loadDeployments().files;
  const volatileFactory = files[`pools-${root.slug}.json`].addresses.volatilePoolFactory.toLowerCase();
  const registry = files[`leaf-${root.slug}.json`].addresses.factoryRegistry;
  let best = null;
  for (const r of pools) {
    try {
      const [factory] = await withRetry(() => multicallAt(client, block, [{ address: registry, abi, functionName: "targetToFactory", args: [r.pool] }]));
      if (factory.toLowerCase() !== volatileFactory) continue; // x*y=k spot only
      const [[r0, r1]] = await withRetry(() => multicallAt(client, block, [{ address: r.pool, abi, functionName: "getReserves" }]));
      const [aeroRes, usdcRes] = r.token0 === aero ? [r0, r1] : [r1, r0];
      if (!best || aeroRes > best.aeroRes) best = { pool: r.pool, aeroRes, usdcRes };
    } catch (err) {
      failures.push(`pool ${r.pool}: ${err.shortMessage ?? err.message}`);
    }
  }
  if (!best) failures.push("no v3 AERO/USDC volatile pool among the archived Base gauges");
  else {
    // USDC 6 decimals, AERO 18: price = usdc/1e6 / (aero/1e18)
    const spot = Number((best.usdcRes * 10n ** 12n * 10n ** 6n) / best.aeroRes) / 1e6;
    const diff = Math.abs(spot - aeroPrice.price) / spot;
    console.log(`v3 AERO: ${aeroPrice.provider} $${aeroPrice.price} (confidence ${aeroPrice.confidence}) vs pool ${best.pool} spot $${spot.toFixed(6)} at block ${block}: ${(diff * 100).toFixed(2)}%`);
    if (diff > TOLERANCE) failures.push(`v3 AERO provider price is ${(diff * 100).toFixed(2)}% off the on-chain spot`);
  }
}

if (failures.length) {
  console.error(`\nA15 FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nA15 PASS: v3 AERO price verified against the chain; every token priced or listed unpriced");
