// A49 verifier: pnpm tape:verify-gauges -- [--url https://aero-companion.vercel.app]
// Per chain, at the block of the served index's newest hour: the gauges the chain's
// FactoryRegistry / LeafVoter enumerate (universe.mjs, A2) == the gauges of the served
// index — none missing, none extra.
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, withRetry } from "./client.mjs";
import { readChainUniverse } from "./universe.mjs";

const i = process.argv.indexOf("--url");
const url = (i === -1 ? "https://aero-companion.vercel.app" : process.argv[i + 1]).replace(/\/$/, "");
const idx = await (await fetch(`${url}/api/tape?op=index&f=${Date.now()}`)).json();
const { files } = loadDeployments();
const failures = [];
for (const chain of loadChains()) {
  const served = idx.chains[String(chain.chainId)];
  if (!served) {
    failures.push(`${chain.slug}: not in the served index`);
    continue;
  }
  const blocks = Object.values(served.gauges).map((g) => g.latest?.blockNumber).filter(Boolean);
  const block = BigInt(Math.max(...blocks));
  const u = await withRetry(() => readChainUniverse(clientFor(chain), chain, files[`leaf-${chain.slug}.json`], block));
  const onChain = new Set(u.gauges.map((g) => g.gauge.toLowerCase()));
  const inIndex = new Set(Object.keys(served.gauges));
  const missing = [...onChain].filter((g) => !inIndex.has(g));
  const extra = [...inIndex].filter((g) => !onChain.has(g));
  // a gauge first seen on chain in the newest hour joins the index with the next archived hour
  if (missing.length || extra.length) failures.push(`${chain.slug} @${block}: missing ${missing.join(",") || "none"}; extra ${extra.join(",") || "none"}`);
  console.log(`${chain.slug} @${block}: ${onChain.size} gauges on chain, ${inIndex.size} in the index${missing.length || extra.length ? ` (missing ${missing.length}, extra ${extra.length})` : ""}`);
}
if (failures.length) {
  console.error(`\nA49 FAIL: ${failures.length} chain(s)\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.log("\nA49 PASS: the served index holds exactly the gauges each chain registers");
