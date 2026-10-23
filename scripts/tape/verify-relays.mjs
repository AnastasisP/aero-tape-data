// A16 verifier: pnpm tape:verify-relays -- --dir <tape-data>
// Relay attribution of allocated VP, checked against the chain:
//  1. the archived relay-registry equals every relay of every factory in the root
//     RelayFactoryRegistry at the newest archived Base hour
//  2. each relay owns its veNFT there (VotingEscrow.ownerOf(tokenId) == relay)
//  3. on every chain, the relay legs of the replayed booked allocations at that chain's
//     newest processed hour equal LeafVoter.allocations read at that hour's block
// relay + non-relay = allocated holds by construction (series.mjs); these checks make
// the relay label and the relay amounts exact.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { relayAbi } from "./abis.mjs";
import { readLeafAllocations, replayAllocations } from "./allocations.mjs";
import { TapeStore } from "./store.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: node scripts/tape/verify-relays.mjs --dir <tape-data>");
  process.exit(2);
}
const store = new TapeStore(dir, { readOnly: true });
const { files } = loadDeployments();
const chains = loadChains();
const root = chains.find((c) => c.role === "root");
const failures = [];
const rowsOf = (chainId, metric) =>
  Object.keys(store.manifest.files)
    .filter((f) => f.startsWith(`${chainId}/${metric}/`) && existsSync(join(store.dir, f)))
    .sort()
    .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const lastBlockAt = (chainId, bucket) => {
  const r = rowsOf(chainId, "leaf-state").find((x) => x.bucket === bucket);
  return r ? BigInt(r.blockNumber) : null;
};

// 1 + 2 at the newest archived Base hour.
const relayRows = rowsOf(root.chainId, "relay-registry");
const rootBlock = lastBlockAt(root.chainId, store.cursor(root.chainId));
const rc = clientFor(root);
const mc = (client, block, calls) => withRetry(() => multicallAt(client, block, calls, 2000));
const registry = files[`relayfactoryregistry-${root.slug}.json`].addresses.relayFactoryRegistry;
const [factories] = await mc(rc, rootBlock, [{ address: registry, abi: relayAbi, functionName: "relayFactories" }]);
const live = [];
for (const f of factories) {
  const [n] = await mc(rc, rootBlock, [{ address: f, abi: relayAbi, functionName: "allRelaysLength" }]);
  if (n > 0n) live.push(...(await mc(rc, rootBlock, [{ address: f, abi: relayAbi, functionName: "allRelays", args: [0n, n] }]))[0].map((r) => r.toLowerCase()));
}
const archived = new Set(relayRows.map((r) => r.relay));
for (const r of live) if (!archived.has(r)) failures.push(`relay ${r} is not in the archive`);
for (const r of archived) if (!live.includes(r)) failures.push(`archived relay ${r} is not in any factory`);
const owners = await mc(
  rc,
  rootBlock,
  relayRows.map((r) => ({ address: files[`root-${root.slug}.json`].addresses.votingEscrow, abi: relayAbi, functionName: "ownerOf", args: [BigInt(r.tokenId)] })),
);
relayRows.forEach((r, i) => {
  if (owners[i].toLowerCase() !== r.relay) failures.push(`relay ${r.relay}: veNFT ${r.tokenId} is owned by ${owners[i]}`);
});
console.log(`relays: ${relayRows.length} archived, ${live.length} live at Base block ${rootBlock}, owners checked`);

// 3. relay legs per chain.
const relayTokens = new Set(relayRows.map((r) => r.tokenId));
for (const chain of chains) {
  const through = store.metricCursor(chain.chainId, "allocation-change");
  if (through === null) {
    failures.push(`${chain.slug}: no allocation data`);
    continue;
  }
  const state = replayAllocations(rowsOf(chain.chainId, "allocation-change"));
  const block = lastBlockAt(chain.chainId, through);
  const fresh = await withRetry(() => readLeafAllocations(clientFor(chain), files[`leaf-${chain.slug}.json`].addresses.leafVoter, block, relayTokens));
  const replayed = new Map([...state].filter(([k]) => relayTokens.has(k.split(":")[0])));
  let legs = 0;
  for (const [k, v] of fresh) {
    legs++;
    if (replayed.get(k) !== v) failures.push(`${chain.slug} ${k}: replayed ${replayed.get(k)} != chain ${v}`);
  }
  for (const k of replayed.keys()) if (!fresh.has(k)) failures.push(`${chain.slug} ${k}: replayed but not on chain`);
  console.log(`${chain.slug}: ${legs} relay legs at block ${block} match the replay`);
}

if (failures.length) {
  console.error(`\nA16 FAIL: ${failures.length} problem(s)`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nA16 PASS: relay set complete, veNFTs owned by their relays, relay legs exact");
