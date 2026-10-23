// A26 verifier: pnpm tape:verify-mobile -- --dir <tape-data>
// For each chain, at the newest hour both late metrics cover, the leaf-booked VP and the
// mobile VP from the tape (global.mjs chainMobility) must equal a token-by-token rebuild
// from fresh LeafVoter reads at that hour's block, to the wei.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, withRetry } from "./client.mjs";
import { readLeafAllocations, readLeafTokenStates, readRootTokenChains } from "./allocations.mjs";
import { TapeStore } from "./store.mjs";
import { chainMobility, isMobile } from "../../lib/data/aero-v3/tape/global.mjs";
import { contribution } from "../../lib/data/aero-v3/tape/points.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: node scripts/tape/verify-mobile.mjs --dir <tape-data>");
  process.exit(2);
}
const store = new TapeStore(dir, { readOnly: true });
const { files } = loadDeployments();
const chains = loadChains();
const root = chains.find((c) => c.role === "root");
const failures = [];
const rowsOf = (chainId, metrics) =>
  Object.keys(store.manifest.files)
    .filter((f) => metrics.some((m) => f.startsWith(`${chainId}/${m}/`)) && existsSync(join(store.dir, f)))
    .sort()
    .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

for (const chain of chains) {
  const through = Math.min(store.metricCursor(chain.chainId, "allocation-change") ?? -1, store.metricCursor(chain.chainId, "token-leaf-state") ?? -1);
  if (through < 0) {
    failures.push(`${chain.slug}: late metrics not archived`);
    continue;
  }
  const rows = rowsOf(chain.chainId, ["allocation-change", "token-leaf-state", "leaf-state"]);
  const tape = chainMobility(rows, through).get(through);
  const leafRow = rows.find((r) => r.metric === "leaf-state" && r.bucket === through);
  if (!tape || !leafRow) {
    failures.push(`${chain.slug}: no tape value at ${through}`);
    continue;
  }
  const client = clientFor(chain);
  const block = BigInt(leafRow.blockNumber);
  const leafVoter = files[`leaf-${chain.slug}.json`].addresses.leafVoter;
  // the token set the archiver reads: root-listed for this chain (root at the same hour) plus every token with tape rows
  const rootRow = rowsOf(root.chainId, ["leaf-state"]).find((r) => r.bucket === through);
  const tokenChains = await withRetry(() => readRootTokenChains(clientFor(root), files[`root-${root.slug}.json`], BigInt(rootRow.blockNumber)));
  const ids = new Set([...tokenChains].filter(([, cs]) => cs.includes(chain.chainId)).map(([id]) => id));
  for (const r of rows) if (r.tokenId) ids.add(r.tokenId);
  const legs = await withRetry(() => readLeafAllocations(client, leafVoter, block, ids));
  const states = await withRetry(() => readLeafTokenStates(client, leafVoter, block, ids));
  const perToken = new Map();
  for (const [key, amount] of legs) {
    const id = key.split(":")[0];
    perToken.set(id, (perToken.get(id) ?? 0n) + BigInt(amount));
  }
  let booked = 0n;
  let mobile = 0n;
  const t = leafRow.blockTimestamp;
  for (const [id, amount] of perToken) {
    const [lastAllocated, reduction, stakeEnd, perm] = states.get(id).split(",").map(Number);
    const k = contribution(amount, BigInt(stakeEnd), BigInt(t), perm === 1);
    booked += k.bias + k.perm;
    if (isMobile(t, lastAllocated, reduction, Number(leafRow.allocationCooldown))) mobile += k.bias + k.perm;
  }
  const ok = booked === tape.booked && mobile === tape.mobile;
  if (!ok) failures.push(`${chain.slug} @${through}: tape booked ${tape.booked} mobile ${tape.mobile} != chain booked ${booked} mobile ${mobile}`);
  console.log(`${chain.slug} @${new Date(through * 1000).toISOString()}: booked ${booked}, mobile ${mobile} ${ok ? "==" : "!="} tape`);
}

if (failures.length) {
  console.error(`\nA26 FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nA26 PASS: booked and mobile VP rebuilt token by token == the tape, every chain");
