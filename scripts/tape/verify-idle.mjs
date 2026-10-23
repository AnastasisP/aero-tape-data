// A8 verifier: pnpm tape:verify-idle -- [--dir <tape-data>] [--block n]
// total VP = allocated VP + idle VP, each side rebuilt token by token, to the wei.
//  - total VP     = VotingEscrow.totalVotingPower, rebuilt as the sum over every veNFT
//                   (VotingEscrow enumeration) of contribution(committed, lastStakeEnd)
//                   from Voter.tokenStates
//  - allocated VP = sum over chains of Voter.chainStates(c).point resolved to t, rebuilt as
//                   the sum of contribution(allocationChainAmounts(id, c), lastStakeEnd)
//  - idle VP      = total - allocated (class D)
// Contribution and point resolution mirror AllocationLogicLibrary (points.mjs).
// With --dir, the block is the newest archived Base hour and the archived root-state
// values must equal the rebuilt ones. Voter.totalPoint is reported, not used: it trails
// the token sum by rounding dust (finding 2026-10-23, see the goal's A8 line).
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { MULTICALL3, clientFor, multicallAt, withRetry } from "./client.mjs";
import { multicall3Abi } from "./abis.mjs";
import { safeHead } from "./blocks.mjs";
import { boundariesBetween, contribution, resolvePoint } from "../../lib/data/aero-v3/tape/points.mjs";
import { TapeStore } from "./store.mjs";

const abi = parseAbi([
  "struct Point { int128 bias; int128 slope; uint48 ts; uint128 permanentStakeBalance; }",
  "function totalVotingPower() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function tokenByIndex(uint256) view returns (uint256)",
  "function totalPoint() view returns (int128 bias, int128 slope, uint48 ts, uint128 permanentStakeBalance)",
  "function totalSlopeChanges(uint48) view returns (int128)",
  "function chains() view returns (uint256[])",
  "function chainStates(uint256) view returns (Point point, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint256, uint8)",
  "function chainSlopeChanges(uint256, uint48) view returns (int128)",
  "function tokenStates(uint256) view returns (uint128 committed, uint48 lastStakeEnd, uint48 lastAllocated, bool isPermanent)",
  "function allocationChainIds(uint256) view returns (uint256[])",
  "function allocationChainAmounts(uint256, uint256) view returns (uint128)",
]);

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
const failures = [];
const CHUNK = Number(process.env.TAPE_IDLE_CHUNK ?? 2000); // calls per multicall: ~50k reads per run
const fmt = (wei) => (Number(wei / 10n ** 12n) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 });

const root = loadChains().find((c) => c.role === "root");
const rf = loadDeployments().files[`root-${root.slug}.json`].addresses;
const client = clientFor(root);

// The block: --block, else the newest archived Base hour (--dir), else the safe head.
let archived = null;
if (dir) {
  const store = new TapeStore(dir, { readOnly: true });
  const rels = Object.keys(store.manifest.files)
    .filter((f) => f.startsWith(`${root.chainId}/root-state/`) && existsSync(join(store.dir, f)))
    .sort();
  const last = rels.at(-1);
  if (last) archived = JSON.parse(readFileSync(join(store.dir, last), "utf8").trim().split("\n").at(-1));
}
const block = arg("block") ? BigInt(arg("block")) : archived ? BigInt(archived.blockNumber) : (await safeHead(client)).number;
const mc = (calls) => withRetry(() => multicallAt(client, block, calls, CHUNK));
const at = (address, functionName, args) => ({ address, abi, functionName, args });

const [t, totalVp, totalPoint, chainIds, nTokens] = await mc([
  { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
  at(rf.votingEscrow, "totalVotingPower"),
  at(rf.voter, "totalPoint"),
  at(rf.voter, "chains"),
  at(rf.votingEscrow, "totalSupply"),
]);
const states = await mc(chainIds.map((c) => at(rf.voter, "chainStates", [c])));

async function slopeChanges(fn, keyArgs, from) {
  const bs = boundariesBetween(from, t);
  if (!bs.length) return () => 0n;
  const vals = await mc(bs.map((b) => at(rf.voter, fn, [...keyArgs, Number(b)])));
  const m = new Map(bs.map((b, i) => [b, vals[i]]));
  return (b) => m.get(b) ?? 0n;
}
const asPoint = (p) => ({ bias: p.bias, slope: p.slope, ts: BigInt(p.ts), permanentStakeBalance: p.permanentStakeBalance });

const chainWeight = new Map();
for (const [i, c] of chainIds.entries()) {
  const point = asPoint(states[i][0]);
  chainWeight.set(c, resolvePoint(point, t, await slopeChanges("chainSlopeChanges", [c], point.ts)).weight);
}
const [tb, tsl, tts, tperm] = totalPoint;
const tp = asPoint({ bias: tb, slope: tsl, ts: tts, permanentStakeBalance: tperm });
const voterTotal = resolvePoint(tp, t, await slopeChanges("totalSlopeChanges", [], tp.ts)).weight;

// Token by token.
const ids = await mc(Array.from({ length: Number(nTokens) }, (_, i) => at(rf.votingEscrow, "tokenByIndex", [BigInt(i)])));
const tokenReads = await mc(ids.flatMap((id) => [at(rf.voter, "tokenStates", [id]), at(rf.voter, "allocationChainIds", [id])]));
let totalRebuilt = 0n;
const legs = [];
ids.forEach((id, i) => {
  const [committed, lastStakeEnd, , isPermanent] = tokenReads[2 * i];
  const k = contribution(committed, BigInt(lastStakeEnd), t, isPermanent);
  totalRebuilt += k.bias + k.perm;
  for (const c of tokenReads[2 * i + 1]) legs.push({ id, c, stakeEnd: BigInt(lastStakeEnd), isPermanent });
});
const amounts = await mc(legs.map((l) => at(rf.voter, "allocationChainAmounts", [l.id, l.c])));
const rebuilt = new Map(chainIds.map((c) => [c, 0n]));
legs.forEach((l, i) => {
  const k = contribution(amounts[i], l.stakeEnd, t, l.isPermanent);
  rebuilt.set(l.c, (rebuilt.get(l.c) ?? 0n) + k.bias + k.perm);
});

if (totalRebuilt !== totalVp) failures.push(`total: VotingEscrow ${totalVp} != token sum ${totalRebuilt} (residual ${totalVp - totalRebuilt})`);
let allocated = 0n;
for (const c of chainIds) {
  const residual = chainWeight.get(c) - (rebuilt.get(c) ?? 0n);
  allocated += chainWeight.get(c);
  console.log(`chain ${c}: allocated ${fmt(chainWeight.get(c))}, residual vs token legs ${residual} wei`);
  if (residual !== 0n) failures.push(`chain ${c}: residual ${residual} wei`);
}
const idle = totalVp - allocated;
if (idle < 0n) failures.push(`idle is negative: ${idle}`);
console.log(`total: ${fmt(totalVp)}, residual vs token sum ${totalVp - totalRebuilt} wei (${ids.length} veNFTs, ${legs.length} chain legs)`);
console.log(`Voter.totalPoint(t) trails the token sum by ${totalRebuilt - voterTotal} wei (reported, not used)`);
console.log(`Base block ${block} t=${t}: total ${fmt(totalVp)} = allocated ${fmt(allocated)} + idle ${fmt(idle)}`);

// The archived hour must hold the same values.
if (archived && BigInt(archived.blockNumber) === block) {
  if (archived.votingEscrow.totalVotingPower !== totalVp.toString()) failures.push(`archive ${archived.bucket}: totalVotingPower differs from the fresh read`);
  for (const cs of archived.chainStates) {
    const p = asPoint({ ...cs.point, bias: BigInt(cs.point.bias), slope: BigInt(cs.point.slope), permanentStakeBalance: BigInt(cs.point.permanentStakeBalance) });
    if (boundariesBetween(p.ts, BigInt(archived.blockTimestamp)).length) continue; // needs slope changes: covered by the live read above
    const w = resolvePoint(p, BigInt(archived.blockTimestamp), () => 0n).weight;
    if (w !== chainWeight.get(BigInt(cs.chainId))) failures.push(`archive ${archived.bucket} chain ${cs.chainId}: archived point resolves to ${w}, rebuilt ${chainWeight.get(BigInt(cs.chainId))}`);
  }
  console.log(`archive: hour ${new Date(archived.bucket * 1000).toISOString()} matches the rebuild`);
}

if (failures.length) {
  console.error(`\nA8 FAIL: ${failures.length} problem(s)`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nA8 PASS: residual 0 on total and on every chain");
