// One hourly tape sample for one chain at one pinned block. Raw class-E reads only:
// no derived value, no price. Every record carries the A9 provenance fields.
import { erc20Abi, factoryRegistryAbi, feeCheckpointAbi, leafStateAbi, multicall3Abi, relayAbi, rewardsAbi, rootStateAbi } from "./abis.mjs";
import { MULTICALL3, multicallAt } from "./client.mjs";
import { boundariesBetween } from "../../lib/data/aero-v3/tape/points.mjs";

export const SCHEMA_VERSION = 1;
const ZERO_GAUGE = "0x0000000000000000000000000000000000000000"; // ProtocolConstants.ZERO_GAUGE

const lc = (a) => a.toLowerCase();

/** bigint -> decimal string, recursively. JSON has no bigint and floats would lose wei. */
export function ser(v) {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(ser);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}

const point = (p) => ({ bias: p.bias, slope: p.slope, ts: p.ts, permanentStakeBalance: p.permanentStakeBalance });

function gaugeState(r) {
  const [ceiling, claimed, lastSettlement, isRegistered, isActivated, surplus, lastIndex, lastTimeIndex, p] = r;
  return { ceiling, claimed, lastSettlement, isRegistered, isActivated, surplus, lastIndex, lastTimeIndex, point: point(p) };
}

/** Gauges registered in the leaf FactoryRegistry at `block`, with their pool and rewards contract. */
export async function readGaugeSet(client, leafFile, block) {
  const registry = leafFile.addresses.factoryRegistry;
  const [gaugeFactories] = await multicallAt(client, block, [
    { address: registry, abi: factoryRegistryAbi, functionName: "gaugeFactories" },
  ]);
  const lists = await multicallAt(
    client,
    block,
    gaugeFactories.map((gf) => ({ address: registry, abi: factoryRegistryAbi, functionName: "factoryToGauges", args: [gf] })),
  );
  const gauges = lists.flat();
  const links = await multicallAt(
    client,
    block,
    gauges.flatMap((g) => [
      { address: registry, abi: factoryRegistryAbi, functionName: "gaugeToTarget", args: [g] },
      { address: registry, abi: factoryRegistryAbi, functionName: "gaugeToRewards", args: [g] },
    ]),
  );
  return gauges.map((g, i) => ({ gauge: lc(g), pool: lc(links[2 * i]), rewards: lc(links[2 * i + 1]) }));
}

const GAUGE_READS = 1; // gaugeStates
const REWARD_FNS = [
  "token0",
  "token1",
  "feeRewardPerVotingPower",
  "lastFeeUpdate",
  "bufferedFees0",
  "bufferedFees1",
  "lastPendingFees0",
  "lastPendingFees1",
  "totalSupply",
  "permanentStakeBalance",
  "incentiveCount",
];

export const GAUGE_CALL_COUNT = GAUGE_READS + REWARD_FNS.length;

/** The multicall reads behind one gauge-state record. g = { gauge, rewards }. */
export function gaugeCalls(leafVoter, g) {
  return [
    { address: leafVoter, abi: leafStateAbi, functionName: "gaugeStates", args: [g.gauge] },
    ...REWARD_FNS.map((fn) => ({ address: g.rewards, abi: rewardsAbi, functionName: fn })),
  ];
}

/**
 * Builds the gauge-state record from the results of gaugeCalls().
 * @returns { record, links, incentiveCount }
 */
export function gaugeRecordFrom(prov, g, r) {
  const rv = Object.fromEntries(REWARD_FNS.map((fn, j) => [fn, r[GAUGE_READS + j]]));
  const [f0, f1, tw0, tw1] = rv.feeRewardPerVotingPower;
  const links = { pool: g.pool, rewards: g.rewards, token0: lc(rv.token0), token1: lc(rv.token1) };
  const record = ser({
    ...prov,
    metric: "gauge-state",
    gauge: g.gauge,
    gaugeState: gaugeState(r[0]),
    fees: {
      rewardPerVotingPower0: f0,
      rewardPerVotingPower1: f1,
      timeWeightedRewardPerVotingPower0: tw0,
      timeWeightedRewardPerVotingPower1: tw1,
      lastFeeUpdate: rv.lastFeeUpdate,
      bufferedFees0: rv.bufferedFees0,
      bufferedFees1: rv.bufferedFees1,
      lastPendingFees0: rv.lastPendingFees0,
      lastPendingFees1: rv.lastPendingFees1,
    },
    voteSupply: rv.totalSupply,
    votePermanentStakeBalance: rv.permanentStakeBalance,
    incentiveCount: rv.incentiveCount,
  });
  return { record, links, incentiveCount: Number(rv.incentiveCount) };
}

/**
 * @param client      viem client for the chain
 * @param chain       registry chain entry
 * @param files       registry deployment files
 * @param block       pinned block number (bigint)
 * @param bucket      the hour this sample stands for (unix seconds, multiple of 3600)
 * @param knownPrograms Map rewards -> highest incentive program id already archived
 * @param knownGauges   Map gauge -> links key ("pool,rewards,token0,token1") already archived
 * @param knownFeeCps   Map rewards -> highest fee checkpoint index already archived
 * @param knownSlopeChanges Set of "gauge:boundary" already archived
 * @param knownRelays   Set of relay addresses already archived (root chain only)
 * @param knownTokens   Set of token addresses whose symbol / decimals are archived
 * @returns { blockTimestamp, gauge, leaf, root|null, programs, registry, feeCheckpoints }.
 *          `registry` holds a gauge-registry record for each gauge that is new or whose links changed.
 */
export async function readHourSnapshot(client, chain, files, block, bucket, knownPrograms, knownGauges, knownFeeCps = new Map(), knownSlopeChanges = new Set(), knownRelays = new Set(), knownTokens = new Set()) {
  const leaf = files[`leaf-${chain.slug}.json`];
  const leafVoter = leaf.addresses.leafVoter;
  const gauges = await readGaugeSet(client, leaf, block);

  const leafFns = [
    "index",
    "timeIndex",
    "emissionsPerVP",
    "lastSettlement",
    "surplusAccrued",
    "chainStatus",
    "allocationCooldown",
    "maxGauges",
    "minIncentiveDuration",
    "localVotingEnabled",
  ];
  const head = [
    { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
    { address: leafVoter, abi: leafStateAbi, functionName: "gaugeStates", args: [ZERO_GAUGE] },
    ...leafFns.map((fn) => ({ address: leafVoter, abi: leafStateAbi, functionName: fn })),
  ];
  const perGauge = gauges.flatMap((g) => gaugeCalls(leafVoter, g));
  const res = await multicallAt(client, block, [...head, ...perGauge]);
  const blockTimestamp = Number(res[0]);
  const prov = {
    schemaVersion: SCHEMA_VERSION,
    chainId: chain.chainId,
    blockNumber: Number(block),
    blockTimestamp,
    bucket,
    source: "chain",
    class: "E",
  };

  const leafVals = Object.fromEntries(leafFns.map((fn, i) => [fn, res[2 + i]]));
  const leafRecord = ser({ ...prov, metric: "leaf-state", leafVoter: lc(leafVoter), zeroGaugeState: gaugeState(res[1]), ...leafVals });

  const base = head.length;
  const gaugeRecords = [];
  const registryRecords = [];
  const programReads = [];
  gauges.forEach((g, i) => {
    const r = res.slice(base + i * GAUGE_CALL_COUNT, base + (i + 1) * GAUGE_CALL_COUNT);
    const { record, links, incentiveCount } = gaugeRecordFrom(prov, g, r);
    if (knownGauges.get(g.gauge) !== Object.values(links).join(",")) {
      registryRecords.push(ser({ ...prov, metric: "gauge-registry", gauge: g.gauge, ...links }));
    }
    gaugeRecords.push(record);
    // Program ids are 1..incentiveCount (`_programId = ++incentiveCount`, IncentiveStreaming.sol:67).
    const known = knownPrograms.get(g.rewards) ?? 0;
    for (let id = known + 1; id <= incentiveCount; id++) programReads.push({ g, id });
  });

  const programs = [];
  if (programReads.length) {
    const pr = await multicallAt(
      client,
      block,
      programReads.map(({ g, id }) => ({ address: g.rewards, abi: rewardsAbi, functionName: "incentive", args: [BigInt(id)] })),
    );
    programReads.forEach(({ g, id }, i) => {
      const p = pr[i];
      programs.push(
        ser({
          ...prov,
          metric: "incentive-program",
          gauge: g.gauge,
          rewards: g.rewards,
          programId: id,
          token: lc(p.token),
          amount: p.amount,
          rate: p.rate,
          start: p.start,
          end: p.end,
          creator: lc(p.creator),
        }),
      );
    });
  }

  const root = chain.role === "root" ? await readRootState(client, files, chain, block, prov) : null;
  const feeCheckpoints = await readFeeCheckpoints(client, block, prov, gauges, knownFeeCps);
  const slopeChanges = await readSlopeChanges(client, block, prov, leafVoter, gaugeRecords, knownSlopeChanges);
  const relays = chain.role === "root" ? await readRelays(client, files, chain, block, prov, knownRelays) : [];
  // Fee tokens of every gauge (new or already archived) and the tokens of new programs.
  const linkTokens = [...knownGauges.values()].flatMap((k) => k.split(",").slice(2));
  const candidates = [...linkTokens, ...registryRecords.flatMap((r) => [r.token0, r.token1]), ...programs.map((p) => p.token)];
  const fresh = new Set(candidates.filter((t) => t && !knownTokens.has(t)));
  const tokens = await readTokens(client, block, prov, [...fresh].sort());
  return { blockTimestamp, gauge: gaugeRecords, leaf: leafRecord, root, programs, registry: registryRecords, feeCheckpoints, slopeChanges, relays, tokens };
}

/**
 * Symbol and decimals of fee and incentive tokens, once per token (display scale only;
 * every amount stays in base units). A token whose ERC-20 reads fail is archived with
 * decimals null rather than guessed.
 */
async function readTokens(client, block, prov, tokens) {
  if (!tokens.length) return [];
  const res = await client.multicall({
    contracts: tokens.flatMap((t) => [
      { address: t, abi: erc20Abi, functionName: "decimals" },
      { address: t, abi: erc20Abi, functionName: "symbol" },
    ]),
    blockNumber: block,
    allowFailure: true,
    batchSize: 16_384,
  });
  return tokens.map((t, i) => {
    const d = res[2 * i];
    const sym = res[2 * i + 1];
    return ser({ ...prov, metric: "token-registry", token: t, decimals: d.status === "success" ? Number(d.result) : null, symbol: sym.status === "success" ? String(sym.result).slice(0, 32) : null });
  });
}

/**
 * Relays new since the last archive: every relay of every factory in the root
 * RelayFactoryRegistry, with the veNFT it allocates (relayConfig().tokenId). A relay's
 * veNFT is created with the relay, so the relay set of today labels every past hour too.
 */
async function readRelays(client, files, chain, block, prov, known) {
  const registry = files[`relayfactoryregistry-${chain.slug}.json`].addresses.relayFactoryRegistry;
  const [factories] = await multicallAt(client, block, [{ address: registry, abi: relayAbi, functionName: "relayFactories" }]);
  const out = [];
  for (const factory of factories) {
    const [n] = await multicallAt(client, block, [{ address: factory, abi: relayAbi, functionName: "allRelaysLength" }]);
    if (n === 0n) continue;
    const [relays] = await multicallAt(client, block, [{ address: factory, abi: relayAbi, functionName: "allRelays", args: [0n, n] }]);
    const fresh = relays.filter((r) => !known.has(lc(r)));
    if (!fresh.length) continue;
    const res = await multicallAt(
      client,
      block,
      fresh.flatMap((r) => [
        { address: r, abi: relayAbi, functionName: "relayConfig" },
        { address: r, abi: relayAbi, functionName: "relayType" },
      ]),
    );
    fresh.forEach((r, i) => {
      out.push(ser({ ...prov, metric: "relay-registry", relay: lc(r), factory: lc(factory), tokenId: res[2 * i].tokenId.toString(), relayType: res[2 * i + 1], name: res[2 * i].name }));
    });
  }
  return out;
}

/**
 * Scheduled slope reductions a decaying gauge point crosses before the sample time:
 * gaugeSlopeChanges(g, boundary) for every week boundary in (point.ts, t]. Needed to
 * resolve W_g exactly (points.mjs resolvePoint). A past boundary's value is final, so
 * each (gauge, boundary) is archived once.
 */
async function readSlopeChanges(client, block, prov, leafVoter, gaugeRecords, known) {
  const wanted = [];
  for (const r of gaugeRecords) {
    if (r.gaugeState.point.slope === "0") continue;
    for (const b of boundariesBetween(BigInt(r.gaugeState.point.ts), BigInt(prov.blockTimestamp))) {
      if (!known.has(`${r.gauge}:${b}`)) wanted.push({ gauge: r.gauge, boundary: Number(b) });
    }
  }
  if (!wanted.length) return [];
  const res = await multicallAt(
    client,
    block,
    wanted.map((w) => ({ address: leafVoter, abi: leafStateAbi, functionName: "gaugeSlopeChanges", args: [w.gauge, w.boundary] })),
  );
  return wanted.map((w, i) => ser({ ...prov, metric: "gauge-slope-change", gauge: w.gauge, boundary: w.boundary, slopeDelta: res[i] }));
}

/**
 * New global reward checkpoints of each gauge's rewards contract: the point's ts and the
 * fee accumulator snapshot at that index (what earnedFees prices, RewardsLogicLibrary
 * _priceFeeSpan). Only checkpoints with ts < the block's timestamp are final: the newest
 * one may still be overwritten by a later transaction in the same second
 * (VotingRewardsManager._createGlobalRewardPoints), so it waits for the next hour.
 */
async function readFeeCheckpoints(client, block, prov, gauges, knownFeeCps) {
  const counts = await multicallAt(
    client,
    block,
    gauges.map((g) => ({ address: g.rewards, abi: feeCheckpointAbi, functionName: "globalCheckpointIndex" })),
  );
  const wanted = [];
  gauges.forEach((g, i) => {
    for (let idx = (knownFeeCps.get(g.rewards) ?? 0) + 1; idx <= Number(counts[i]); idx++) wanted.push({ g, idx });
  });
  if (!wanted.length) return [];
  const res = await multicallAt(
    client,
    block,
    wanted.flatMap(({ g, idx }) => [
      { address: g.rewards, abi: feeCheckpointAbi, functionName: "globalRewardPointHistory", args: [BigInt(idx)] },
      { address: g.rewards, abi: feeCheckpointAbi, functionName: "feeRewardPerVotingPowerAt", args: [BigInt(idx)] },
    ]),
  );
  const out = [];
  const stopped = new Set();
  wanted.forEach(({ g, idx }, i) => {
    const point = res[2 * i];
    if (stopped.has(g.rewards) || point.ts >= prov.blockTimestamp) {
      stopped.add(g.rewards); // ts strictly increases with the index: everything after waits too
      return;
    }
    const [feeReward0, feeReward1, feeReward0xTime, feeReward1xTime] = res[2 * i + 1];
    out.push(
      ser({ ...prov, metric: "fee-checkpoint", gauge: g.gauge, rewards: g.rewards, index: idx, ts: point.ts, feeReward0, feeReward1, feeReward0xTime, feeReward1xTime }),
    );
  });
  return out;
}

async function readRootState(client, files, chain, block, prov) {
  const rf = files[`root-${chain.slug}.json`].addresses;
  const ve = rf.votingEscrow;
  const voter = rf.voter;
  const minter = rf.minter;
  const calls = [
    [ve, "totalVotingPower"],
    [ve, "supply"],
    [ve, "permanentStakeBalance"],
    [ve, "totalSupply"],
    [voter, "totalPoint"],
    [voter, "index"],
    [voter, "timeIndex"],
    [voter, "emissionsPerVP"],
    [voter, "lastGlobalSettlement"],
    [voter, "allocationLifetime"],
    [voter, "chains"],
    [minter, "emissionRate"],
    [minter, "baseRate"],
    [minter, "dynamicRate"],
    [minter, "bandFloorPips"],
    [minter, "bandCeilingPips"],
    [minter, "ACTIVATION_TIMESTAMP"],
  ];
  const r = await multicallAt(
    client,
    block,
    calls.map(([address, functionName]) => ({ address, abi: rootStateAbi, functionName })),
  );
  const v = Object.fromEntries(calls.map(([, fn], i) => [fn, r[i]]));
  const chainIds = v.chains;
  const cs = await multicallAt(
    client,
    block,
    chainIds.map((id) => ({ address: voter, abi: rootStateAbi, functionName: "chainStates", args: [id] })),
  );
  const [tb, ts, tt, tp] = v.totalPoint;
  return ser({
    ...prov,
    metric: "root-state",
    votingEscrow: { totalVotingPower: v.totalVotingPower, supply: v.supply, permanentStakeBalance: v.permanentStakeBalance, totalSupply: v.totalSupply },
    voter: {
      totalPoint: { bias: tb, slope: ts, ts: tt, permanentStakeBalance: tp },
      index: v.index,
      timeIndex: v.timeIndex,
      emissionsPerVP: v.emissionsPerVP,
      lastGlobalSettlement: v.lastGlobalSettlement,
      allocationLifetime: v.allocationLifetime,
    },
    chainStates: chainIds.map((id, i) => {
      const [p, ceiling, totalRedeemed, reportedSurplus, cumulativeSuspendedSurplus, surplusSpent, lastIndex, lastTimeIndex, donatedBuffer, status] = cs[i];
      return { chainId: id, point: point(p), ceiling, totalRedeemed, reportedSurplus, cumulativeSuspendedSurplus, surplusSpent, lastIndex, lastTimeIndex, donatedBuffer, status };
    }),
    minter: {
      emissionRate: v.emissionRate,
      baseRate: v.baseRate,
      dynamicRate: v.dynamicRate,
      bandFloorPips: v.bandFloorPips,
      bandCeilingPips: v.bandCeilingPips,
      activationTimestamp: v.ACTIVATION_TIMESTAMP,
    },
  });
}
