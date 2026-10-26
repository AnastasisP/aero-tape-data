// A35 verifier: pnpm tape:verify-tiers -- --dir <tape-data>
// For each chain, at the newest hour the token-tier metric covers, every archived token's
// tier replayed from the tape (and served in derived/v1/index.json) must equal a fresh
// TokenRegistry.tier(token) read at that hour's block.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, withRetry } from "./client.mjs";
import { TapeStore } from "./store.mjs";
import { readTokenTiers, replayTokenTiers } from "./tiers.mjs";

const i = process.argv.indexOf("--dir");
const dir = i === -1 ? undefined : process.argv[i + 1];
if (!dir) {
  console.error("usage: node scripts/tape/verify-tiers.mjs --dir <tape-data>");
  process.exit(2);
}
const store = new TapeStore(dir, { readOnly: true });
const { files } = loadDeployments();
const index = JSON.parse(readFileSync(join(dir, "derived", "v1", "index.json"), "utf8"));
const failures = [];
const rowsOf = (chainId, metric) =>
  Object.keys(store.manifest.files)
    .filter((f) => f.startsWith(`${chainId}/${metric}/`) && existsSync(join(store.dir, f)))
    .sort()
    .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
let checked = 0;
for (const chain of loadChains()) {
  const through = store.metricCursor(chain.chainId, "token-tier");
  if (through === null) {
    failures.push(`${chain.slug}: token-tier not archived`);
    continue;
  }
  const leaf = rowsOf(chain.chainId, "leaf-state").find((r) => r.bucket === through);
  const tape = replayTokenTiers(rowsOf(chain.chainId, "token-tier").filter((r) => r.bucket <= through));
  const fresh = await withRetry(() => readTokenTiers(clientFor(chain), files[`leaf-${chain.slug}.json`].addresses.tokenRegistry, BigInt(leaf.blockNumber), tape.keys()));
  for (const [token, t] of tape) {
    const want = fresh.get(token);
    const got = `${t.tierType},${t.weight},${t.flags}`;
    if (want !== got) failures.push(`${chain.slug} ${token} @${leaf.blockNumber}: tape ${got} != chain ${want}`);
    const served = index.chains[String(chain.chainId)]?.tokens?.[token]?.tier;
    if (served && `${served.tierType},${served.weight},${served.flags}` !== got) failures.push(`${chain.slug} ${token}: index ${JSON.stringify(served)} != tape ${got}`);
    checked++;
  }
  if (tape.size !== store.tokens(chain.chainId).size) failures.push(`${chain.slug}: ${tape.size} tiers for ${store.tokens(chain.chainId).size} archived tokens`);
  console.log(`${chain.slug} @${new Date(through * 1000).toISOString()}: ${tape.size} token tiers`);
}
if (failures.length) {
  console.error(`\nA35 FAIL: ${failures.length} problem(s)`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA35 PASS: ${checked} token tiers == fresh TokenRegistry.tier reads, tape and index`);
