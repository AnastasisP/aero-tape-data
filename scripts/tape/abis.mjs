// Minimal read ABIs for the tape, from dromos-labs/metadex-public V3/src/interfaces
// at the registry's pinned commit. Human-readable form, parsed by viem.
import { parseAbi } from "viem";

export const factoryRegistryAbi = parseAbi([
  "function targetFactories() view returns (address[])",
  "function gaugeFactories() view returns (address[])",
  "function factoryToTargetsLength(address) view returns (uint256)",
  "function factoryToTargets(address) view returns (address[])",
  "function factoryToGauges(address) view returns (address[])",
  "function targetFactoryToGaugeFactory(address) view returns (address)",
  "function gaugeToTarget(address) view returns (address)",
  "function targetToGauge(address) view returns (address)",
  "function gaugeToRewards(address) view returns (address)",
]);

export const poolFactoryIndexationAbi = parseAbi([
  "function poolsIndexLength() view returns (uint256)",
  "struct PoolData { address pool; uint48 creationTimestamp; }",
  "function poolsIndexPaginated(uint256 _start, uint256 _end) view returns (PoolData[])",
]);

export const leafVoterAbi = parseAbi([
  "function FACTORY_REGISTRY() view returns (address)",
  "function ZERO_GAUGE() view returns (address)",
  "function isActivated(address) view returns (bool)",
]);

export const multicall3Abi = parseAbi(["function getCurrentBlockTimestamp() view returns (uint256)"]);

const POINT = "struct Point { int128 bias; int128 slope; uint48 ts; uint128 permanentStakeBalance; }";

export const leafStateAbi = parseAbi([
  POINT,
  "function gaugeStates(address) view returns (uint128 ceiling, uint128 claimed, uint48 lastSettlement, bool isRegistered, bool isActivated, uint128 surplus, uint256 lastIndex, uint256 lastTimeIndex, Point point)",
  "function index() view returns (uint256)",
  "function timeIndex() view returns (uint256)",
  "function emissionsPerVP() view returns (uint256)",
  "function lastSettlement() view returns (uint48)",
  "function surplusAccrued() view returns (uint256)",
  "function chainStatus() view returns (uint8)",
  "function allocationCooldown() view returns (uint48)",
  "function maxGauges() view returns (uint256)",
  "function minIncentiveDuration() view returns (uint48)",
  "function localVotingEnabled() view returns (bool)",
  "function gaugeSlopeChanges(address, uint48) view returns (int128)",
]);

export const rewardsAbi = parseAbi([
  "function token0() view returns (address)",
  "function token1() view returns (address)",
  "function feeRewardPerVotingPower() view returns (uint256, uint256, uint256, uint256)",
  "function lastFeeUpdate() view returns (uint256)",
  "function bufferedFees0() view returns (uint256)",
  "function bufferedFees1() view returns (uint256)",
  "function lastPendingFees0() view returns (uint256)",
  "function lastPendingFees1() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function permanentStakeBalance() view returns (uint128)",
  "function incentiveCount() view returns (uint256)",
  "struct IncentiveProgram { address token; uint256 amount; uint256 rate; uint48 start; uint48 end; address creator; }",
  "function incentive(uint256) view returns (IncentiveProgram)",
]);

export const rootStateAbi = parseAbi([
  POINT,
  "function totalVotingPower() view returns (uint256)",
  "function supply() view returns (uint128)",
  "function permanentStakeBalance() view returns (uint128)",
  "function totalSupply() view returns (uint256)",
  "function totalPoint() view returns (int128 bias, int128 slope, uint48 ts, uint128 permanentStakeBalance)",
  "function index() view returns (uint256)",
  "function timeIndex() view returns (uint256)",
  "function emissionsPerVP() view returns (uint256)",
  "function lastGlobalSettlement() view returns (uint48)",
  "function allocationLifetime() view returns (uint48)",
  "function chains() view returns (uint256[])",
  "function chainStates(uint256) view returns (Point point, uint256 ceiling, uint256 totalRedeemed, uint256 reportedSurplus, uint256 cumulativeSuspendedSurplus, uint256 surplusSpent, uint256 lastIndex, uint256 lastTimeIndex, uint256 donatedBuffer, uint8 status)",
  "function emissionRate() view returns (uint256)",
  "function baseRate() view returns (uint232)",
  "function dynamicRate() view returns (uint256)",
  "function bandFloorPips() view returns (uint24)",
  "function bandCeilingPips() view returns (uint24)",
  "function ACTIVATION_TIMESTAMP() view returns (uint48)",
]);

export const feeCheckpointAbi = parseAbi([
  "function globalCheckpointIndex() view returns (uint256)",
  "struct GlobalPoint { int128 bias; int128 slope; uint48 ts; uint128 permanentStakeBalance; uint48 zeroSupplySeconds; }",
  "function globalRewardPointHistory(uint256) view returns (GlobalPoint)",
  "function feeRewardPerVotingPowerAt(uint256) view returns (uint256 feeReward0, uint256 feeReward1, uint256 feeReward0xTime, uint256 feeReward1xTime)",
]);

export const allocationAbi = parseAbi([
  "function totalSupply() view returns (uint256)",
  "function tokenByIndex(uint256) view returns (uint256)",
  "function allocationChainIds(uint256) view returns (uint256[])",
  "function allocatedGauges(uint256) view returns (address[])",
  "function allocations(uint256, address) view returns (uint128)",
]);

export const relayAbi = parseAbi([
  "function relayFactories() view returns (address[])",
  "function allRelaysLength() view returns (uint256)",
  "function allRelays(uint256, uint256) view returns (address[])",
  "struct RelayConfig { uint256 tokenId; uint256 minDeposit; uint256 keeperWindow; uint256 minWithdrawal; uint256 entrypointTimelock; uint48 lockWeeks; uint48 evacuationWindow; string name; string symbol; }",
  "function relayConfig() view returns (RelayConfig)",
  "function relayType() view returns (uint8)",
  "function ownerOf(uint256) view returns (address)",
]);

export const erc20Abi = parseAbi(["function decimals() view returns (uint8)", "function symbol() view returns (string)"]);
