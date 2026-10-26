// A6 verifier: pnpm tape:verify-parity -- --dir <tape-data> [--tokens 25] [--seed n]
// Protocol parity: staker fee revenue rebuilt from the tape equals the protocol's own
// earnedFees(tokenId, ...) for real veNFTs, exact in token units.
//  - block B = the newest archived Base hour
//  - from the tape: every fee checkpoint (index, ts, accumulator snapshot) of the gauge's
//    rewards contract, and the gauge-state at B (lastFeeUpdate, buffers, vote supply)
//  - from the chain at B, per veNFT only: claim cursor, user reward points, weight at B,
//    and the gauge's pendingFees / emissionCap (the inputs of the pending estimate)
//  - window = from the token's last claim (or first checkpoint) to B, as earnedFees prices it
// Tokens: veNFTs with an allocation on Base, sampled with a seeded PRNG.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseAbi } from "viem";
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor, multicallAt, withRetry } from "./client.mjs";
import { TapeStore } from "./store.mjs";
import { computeFeeRewards, pendingFeeEstimate } from "../../lib/data/aero-v3/tape/fees.mjs";

const abi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function tokenByIndex(uint256) view returns (uint256)",
  "function allocationChainIds(uint256) view returns (uint256[])",
  "function allocatedGauges(uint256) view returns (address[])",
  "struct ClaimState { uint64 lastGlobalCp; uint64 lastUserCp; }",
  "function feeClaimState(uint256) view returns (ClaimState)",
  "function userRewardCheckpointIndex(uint256) view returns (uint256)",
  "struct UserPoint { int128 bias; int128 slope; uint48 ts; uint128 permanent; }",
  "function userRewardPointHistory(uint256, uint256) view returns (UserPoint)",
  "function globalCheckpointIndex() view returns (uint256)",
  "function ACCUMULATOR_ORIGIN() view returns (uint256)",
  "function earnedFees(uint256, uint256) view returns (uint256, uint256)",
  "function balanceOfNFTAt(uint256, uint256) view returns (uint256)",
  "function gaugeFactory() view returns (address)",
  "function pendingFees() view returns (uint256, uint256)",
  "function emissionCap(address) view returns (uint128)",
]);
const MAX_CPS = 1000n;

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const dir = arg("dir");
const wantTokens = Number(arg("tokens", "25"));
let seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
const startSeed = seed;
if (!dir) {
  console.error("usage: node scripts/tape/verify-parity.mjs --dir <tape-data> [--tokens 25] [--seed n]");
  process.exit(2);
}
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const root = loadChains().find((c) => c.role === "root");
const { files } = loadDeployments();
const rf = files[`root-${root.slug}.json`].addresses;
const leafVoter = files[`leaf-${root.slug}.json`].addresses.leafVoter;
const client = clientFor(root);
const store = new TapeStore(dir, { readOnly: true });
const cid = root.chainId;
const rows = (metric) =>
  Object.keys(store.manifest.files)
    .filter((f) => f.startsWith(`${cid}/${metric}/`) && existsSync(join(store.dir, f)))
    .sort()
    .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));

// The tape side.
const leafRows = rows("leaf-state");
const bRow = leafRows.at(-1);
const block = BigInt(bRow.blockNumber);
const now = BigInt(bRow.blockTimestamp);
const gaugeAtB = new Map(rows("gauge-state").filter((r) => r.bucket === bRow.bucket).map((r) => [r.gauge, r]));
const cps = new Map(); // rewards -> Map(index -> checkpoint)
for (const r of rows("fee-checkpoint")) {
  if (!cps.has(r.rewards)) cps.set(r.rewards, new Map());
  cps.get(r.rewards).set(BigInt(r.index), {
    ts: BigInt(r.ts),
    feeReward0: BigInt(r.feeReward0),
    feeReward1: BigInt(r.feeReward1),
    feeReward0xTime: BigInt(r.feeReward0xTime),
    feeReward1xTime: BigInt(r.feeReward1xTime),
  });
}
const ZERO_CP = { ts: 0n, feeReward0: 0n, feeReward1: 0n, feeReward0xTime: 0n, feeReward1xTime: 0n };
console.log(`tape: Base hour ${new Date(bRow.bucket * 1000).toISOString()} block ${block}, fee checkpoints for ${cps.size} gauges`);

// Tokens with a Base allocation.
const mc = (calls) => withRetry(() => multicallAt(client, block, calls));
const at = (address, functionName, args) => ({ address, abi, functionName, args });
const [n] = await mc([at(rf.votingEscrow, "totalSupply")]);
const ids = await mc(Array.from({ length: Number(n) }, (_, i) => at(rf.votingEscrow, "tokenByIndex", [BigInt(i)])));
const chainsOf = await mc(ids.map((id) => at(rf.voter, "allocationChainIds", [id])));
const onBase = ids.filter((_, i) => chainsOf[i].some((c) => c === BigInt(cid)));
for (let i = onBase.length - 1; i > 0; i--) {
  const j = Math.floor(rand() * (i + 1));
  [onBase[i], onBase[j]] = [onBase[j], onBase[i]];
}

const failures = [];
const compared = new Set();
let pairs = 0;
let skipped = 0;
for (const id of onBase) {
  if (compared.size >= wantTokens) break;
  const [gauges] = await mc([at(leafVoter, "allocatedGauges", [id])]);
  for (const gaugeAddr of gauges) {
    const gauge = gaugeAddr.toLowerCase();
    const links = store.manifest.gauges[cid]?.[gauge]?.split(",");
    const g = gaugeAtB.get(gauge);
    if (!links || !g) {
      skipped++;
      continue;
    }
    const rewards = links[1];
    const [claim, userIdx, gIdx, origin, earned, weight, gf, pending] = await mc([
      at(rewards, "feeClaimState", [id]),
      at(rewards, "userRewardCheckpointIndex", [id]),
      at(rewards, "globalCheckpointIndex"),
      at(rewards, "ACCUMULATOR_ORIGIN"),
      at(rewards, "earnedFees", [id, MAX_CPS]),
      at(rewards, "balanceOfNFTAt", [id, now]),
      at(rewards, "gaugeFactory"),
      at(gauge, "pendingFees"),
    ]);
    const [cap] = await mc([at(gf, "emissionCap", [gauge])]);
    const tapeCps = cps.get(rewards) ?? new Map();
    let missing = false;
    for (let i = 1n; i <= gIdx; i++) if (!tapeCps.has(i)) missing = true;
    if (missing) {
      skipped++; // a checkpoint at or after B's second is not final yet; next hour
      continue;
    }
    const startUserCp = claim.lastUserCp === 0n ? 1n : BigInt(claim.lastUserCp);
    const idxs = [];
    for (let i = startUserCp; i <= userIdx; i++) idxs.push(i);
    const points = await mc(idxs.map((i) => at(rewards, "userRewardPointHistory", [id, i])));
    const userMap = new Map(idxs.map((i, k) => [i, points[k]]));
    const user = (i) => {
      const u = userMap.get(i);
      return { bias: u.bias, slope: u.slope, ts: BigInt(u.ts), permanent: u.permanent };
    };
    const [c0, c1] = computeFeeRewards(user, (i) => (i === 0n ? ZERO_CP : tapeCps.get(i)), {
      from: BigInt(claim.lastGlobalCp),
      startUserCp,
      userCheckpointIndex: userIdx,
      globalCheckpointIndex: gIdx,
      maxCheckpoints: MAX_CPS,
      accumulatorOrigin: origin,
    });
    const [p0, p1] = pendingFeeEstimate({
      reachedEnd: MAX_CPS >= userIdx + 1n - startUserCp,
      now,
      lastFeeUpdate: BigInt(g.fees.lastFeeUpdate),
      weight,
      pending0: pending[0],
      pending1: pending[1],
      buffered0: BigInt(g.fees.bufferedFees0),
      buffered1: BigInt(g.fees.bufferedFees1),
      lastPending0: BigInt(g.fees.lastPendingFees0),
      lastPending1: BigInt(g.fees.lastPendingFees1),
      emissionCap: cap,
      supply: BigInt(g.voteSupply),
    });
    const ours = [c0 + p0, c1 + p1];
    pairs++;
    compared.add(id);
    const ok = ours[0] === earned[0] && ours[1] === earned[1];
    if (!ok) failures.push(`token ${id} gauge ${gauge}: tape (${ours[0]}, ${ours[1]}) != earnedFees (${earned[0]}, ${earned[1]})`);
    console.log(`${ok ? "=" : "≠"} token ${id} gauge ${gauge.slice(0, 10)}: earnedFees (${earned[0]}, ${earned[1]}) closed (${c0}, ${c1}) pending (${p0}, ${p1})`);
  }
}

if (compared.size < Math.min(20, wantTokens)) failures.push(`only ${compared.size} tokens compared (need >= 20); ${skipped} pairs skipped`);
if (failures.length) {
  console.error(`\nA6 FAIL (seed ${startSeed}): ${failures.length} problem(s)`);
  for (const f of failures.slice(0, 30)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA6 PASS (seed ${startSeed}): ${compared.size} veNFTs, ${pairs} token-gauge pairs, exact; ${skipped} pairs skipped`);
