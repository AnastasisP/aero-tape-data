// A7: economic lineage of every archived tape field. Hard line (goal §13): staker
// revenue = exchange revenue (FeeDistribution) + incentives (IncentiveStreaming).
// Never gross pool fees, never LP emissions.
//
// Evidence (metadex-public V3/src at the registry pin, and Base block 52984444):
//  - staker: VotingRewardsManager.earnedFees(uint256 _tokenId, ...) pays per veNFT
//    (VotingRewardsManager.sol:161); on-chain, rewards 0x09ad…a139 owes tokenIds
//    12164 / 4677 / 4679 non-zero AERO + USDC fees [M]. Incentive programs are claimed
//    per tokenId too (ClaimIncentives(uint256 indexed _tokenId, ...)).
//  - LP: gaugeStates.claimed grows by the emissions minted to the gauge
//    (LeafAllocationLibrary.sol:416, mintEmissions); V2Gauge.earned(address) is
//    "accrued emissions" per LP account (V2Gauge.sol:129); GaugeTape records the
//    gauge's rewardPerTokenStored (IGaugeTape) — LP side, not archived.

/** Sides. Only STAKER and WEIGHT may feed a staker-revenue series. */
export const SIDE = Object.freeze({
  STAKER: "staker-revenue",
  WEIGHT: "weight",
  LP: "lp-side",
  CONTEXT: "context",
});

const S = SIDE.STAKER;
const W = SIDE.WEIGHT;
const L = SIDE.LP;
const C = SIDE.CONTEXT;

const gaugeStateSides = (prefix) => ({
  [`${prefix}.ceiling`]: L,
  [`${prefix}.claimed`]: L,
  [`${prefix}.surplus`]: L,
  [`${prefix}.lastIndex`]: L,
  [`${prefix}.lastTimeIndex`]: L,
  [`${prefix}.lastSettlement`]: C,
  [`${prefix}.isRegistered`]: C,
  [`${prefix}.isActivated`]: C,
  [`${prefix}.point.bias`]: W,
  [`${prefix}.point.slope`]: W,
  [`${prefix}.point.ts`]: W,
  [`${prefix}.point.permanentStakeBalance`]: W,
});

/** metric -> field path (arrays as `[]`) -> side. Every archived field must be listed. */
export const FIELD_SIDES = Object.freeze({
  "gauge-state": {
    gauge: C,
    ...gaugeStateSides("gaugeState"),
    "fees.rewardPerVotingPower0": S,
    "fees.rewardPerVotingPower1": S,
    "fees.timeWeightedRewardPerVotingPower0": S,
    "fees.timeWeightedRewardPerVotingPower1": S,
    "fees.lastFeeUpdate": S,
    "fees.bufferedFees0": S,
    "fees.bufferedFees1": S,
    "fees.lastPendingFees0": S,
    "fees.lastPendingFees1": S,
    voteSupply: W,
    votePermanentStakeBalance: W,
    incentiveCount: S,
  },
  "gauge-registry": { gauge: C, pool: C, rewards: C, token0: C, token1: C },
  "incentive-program": {
    gauge: C,
    rewards: C,
    programId: S,
    token: S,
    amount: S,
    rate: S,
    start: S,
    end: S,
    creator: C,
  },
  "fee-checkpoint": {
    gauge: C,
    rewards: C,
    index: C,
    ts: C,
    feeReward0: S,
    feeReward1: S,
    feeReward0xTime: S,
    feeReward1xTime: S,
  },
  "allocation-change": { tokenId: C, gauge: C, allocated: W, kind: C },
  "gauge-slope-change": { gauge: C, boundary: C, slopeDelta: W },
  "relay-registry": { relay: C, factory: C, tokenId: C, relayType: C, name: C },
  "token-registry": { token: C, decimals: C, symbol: C },
  "token-leaf-state": { tokenId: C, kind: C, gone: C, lastAllocated: C, cooldownReduction: C, stakeEnd: W, isPermanent: W },
  "leaf-state": {
    leafVoter: C,
    ...gaugeStateSides("zeroGaugeState"),
    index: L,
    timeIndex: L,
    emissionsPerVP: L,
    lastSettlement: C,
    surplusAccrued: L,
    chainStatus: C,
    allocationCooldown: C,
    maxGauges: C,
    minIncentiveDuration: C,
    localVotingEnabled: C,
  },
  "root-state": {
    "votingEscrow.totalVotingPower": W,
    "votingEscrow.supply": W,
    "votingEscrow.permanentStakeBalance": W,
    "votingEscrow.totalSupply": C,
    "voter.totalPoint.bias": W,
    "voter.totalPoint.slope": W,
    "voter.totalPoint.ts": W,
    "voter.totalPoint.permanentStakeBalance": W,
    "voter.index": L,
    "voter.timeIndex": L,
    "voter.emissionsPerVP": L,
    "voter.lastGlobalSettlement": C,
    "voter.allocationLifetime": C,
    "chainStates[].chainId": C,
    "chainStates[].point.bias": W,
    "chainStates[].point.slope": W,
    "chainStates[].point.ts": W,
    "chainStates[].point.permanentStakeBalance": W,
    "chainStates[].ceiling": L,
    "chainStates[].totalRedeemed": L,
    "chainStates[].reportedSurplus": L,
    "chainStates[].cumulativeSuspendedSurplus": L,
    "chainStates[].surplusSpent": L,
    "chainStates[].lastIndex": L,
    "chainStates[].lastTimeIndex": L,
    "chainStates[].donatedBuffer": L,
    "chainStates[].status": C,
    "minter.emissionRate": L,
    "minter.baseRate": L,
    "minter.dynamicRate": L,
    "minter.bandFloorPips": L,
    "minter.bandCeilingPips": L,
    "minter.activationTimestamp": C,
  },
});

/** Names that are LP-side wherever they appear, archived or not. */
export const LP_SIDE_NAMES = Object.freeze([
  "rewardPerToken",
  "rewardPerTokenStored",
  "emissionsPerVP",
  "swapFees",
  "grossFees",
  "poolFees",
  "claimed",
  "ceiling",
]);

const PROVENANCE = new Set(["schemaVersion", "chainId", "blockNumber", "blockTimestamp", "bucket", "source", "class", "metric"]);

/** Leaf field paths of a record, arrays as `[]`, provenance excluded. */
export function fieldPaths(record, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(record)) {
    if (!prefix && PROVENANCE.has(k)) continue;
    const path = prefix ? `${prefix}.${k}` : k;
    if (Array.isArray(v)) {
      for (const item of v) {
        if (item && typeof item === "object") out.push(...fieldPaths(item, `${path}[]`));
        else out.push(`${path}[]`);
      }
    } else if (v && typeof v === "object") out.push(...fieldPaths(v, path));
    else out.push(path);
  }
  return [...new Set(out)];
}

export function sideOf(metric, path) {
  return FIELD_SIDES[metric]?.[path] ?? null;
}

/**
 * Throws unless every input of a staker-revenue series is STAKER or WEIGHT.
 * @param name   series name, for the message
 * @param inputs array of "metric:path"
 */
export function assertStakerRevenueInputs(name, inputs) {
  const bad = inputs.filter((i) => {
    const [metric, path] = i.split(":");
    const side = sideOf(metric, path);
    return side !== SIDE.STAKER && side !== SIDE.WEIGHT;
  });
  if (bad.length) throw new Error(`staker-revenue series "${name}" reads non-staker inputs: ${bad.join(", ")}`);
}

/**
 * The staker-revenue series of goal §5a and the archived inputs each one reads.
 * A new series is added here first; the lineage test then holds it to the rule.
 */
export const STAKER_REVENUE_SERIES = Object.freeze({
  "fee-revenue-rate": [
    "gauge-state:fees.rewardPerVotingPower0",
    "gauge-state:fees.rewardPerVotingPower1",
    "gauge-state:fees.lastFeeUpdate",
    "gauge-state:voteSupply",
  ],
  "incentive-rate": [
    "incentive-program:token",
    "incentive-program:rate",
    "incentive-program:start",
    "incentive-program:end",
  ],
  "yield-per-weight": [
    "gauge-state:fees.rewardPerVotingPower0",
    "gauge-state:fees.rewardPerVotingPower1",
    "incentive-program:rate",
    "incentive-program:start",
    "incentive-program:end",
    "gauge-state:gaugeState.point.bias",
    "gauge-state:gaugeState.point.slope",
    "gauge-state:gaugeState.point.ts",
    "gauge-state:gaugeState.point.permanentStakeBalance",
  ],
});
