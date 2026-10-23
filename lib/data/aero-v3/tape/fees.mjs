// Staker fee revenue of one veNFT on one gauge, ported from the contracts in bigint:
//   RewardsLogicLibrary.computeFeeRewards (closed global checkpoint intervals) and the
//   pending estimate in VotingRewardsManager.earnedFees (metadex-public V3/src at the
//   registry pin). Pure functions; every input is a chain read or an archived tape value.

export const FEE_ACCUMULATOR_PRECISION = 10n ** 24n; // ProtocolConstants

/**
 * @param user   (i) => { bias, slope, ts, permanent } user reward point i (bigint fields)
 * @param gcp    (i) => { ts, feeReward0, feeReward1, feeReward0xTime, feeReward1xTime } global
 *               checkpoint i; index 0 is the empty point (all zero)
 * @param p      { from, startUserCp, userCheckpointIndex, globalCheckpointIndex, maxCheckpoints,
 *                 accumulatorOrigin } (bigint)
 * @returns [reward0, reward1] (bigint)
 */
export function computeFeeRewards(user, gcp, p) {
  const atOrAfter = (lo, hi, ts) => {
    while (lo < hi) {
      const mid = lo + (hi - lo) / 2n;
      const midTs = gcp(mid).ts;
      if (midTs === ts) return mid;
      if (midTs < ts) lo = mid + 1n;
      else hi = mid;
    }
    return lo;
  };
  let currUserCp = p.startUserCp;
  let currGlobalCp = p.from;
  let maxCheckpoints = p.maxCheckpoints;
  let num0 = 0n;
  let num1 = 0n;
  while (currUserCp <= p.userCheckpointIndex) {
    if (maxCheckpoints === 0n) break;
    const up = user(currUserCp);
    const gcpStart = currGlobalCp > 0n ? currGlobalCp : atOrAfter(currGlobalCp, p.globalCheckpointIndex, up.ts);
    if (gcpStart >= p.globalCheckpointIndex) break;
    currGlobalCp =
      currUserCp >= p.userCheckpointIndex
        ? p.globalCheckpointIndex
        : atOrAfter(gcpStart, p.globalCheckpointIndex, user(currUserCp + 1n).ts);
    let activeEnd = currGlobalCp;
    if (up.permanent === 0n && up.bias > 0n) {
      const stakeEnd = up.ts + up.bias / up.slope;
      let activeEndTs = gcp(activeEnd).ts;
      if (activeEndTs > stakeEnd) {
        activeEnd = atOrAfter(gcpStart, currGlobalCp, stakeEnd);
        activeEndTs = gcp(activeEnd).ts;
      }
      if (activeEnd > 0n && activeEndTs >= stakeEnd) activeEnd--;
    }
    if ((up.permanent > 0n || up.bias > 0n) && gcpStart < activeEnd) {
      const [n0, n1] = priceFeeSpan(up, gcp(gcpStart), gcp(activeEnd), p.accumulatorOrigin);
      num0 += n0;
      num1 += n1;
    }
    maxCheckpoints--;
    if (currUserCp >= p.userCheckpointIndex) break;
    currUserCp++;
  }
  return [num0 / FEE_ACCUMULATOR_PRECISION, num1 / FEE_ACCUMULATOR_PRECISION];
}

/** RewardsLogicLibrary._priceFeeSpan + _decayingStakeNumerator. */
function priceFeeSpan(up, start, end, origin) {
  if (up.permanent > 0n) {
    return [up.permanent * (end.feeReward0 - start.feeReward0), up.permanent * (end.feeReward1 - start.feeReward1)];
  }
  if (up.bias > 0n) {
    const coeff = up.bias + up.slope * (up.ts - origin);
    const side = (dAcc, dAccX) => {
      const pos = coeff * dAcc;
      const neg = up.slope * dAccX;
      return pos <= neg ? 0n : pos - neg;
    };
    return [side(end.feeReward0 - start.feeReward0, end.feeReward0xTime - start.feeReward0xTime), side(end.feeReward1 - start.feeReward1, end.feeReward1xTime - start.feeReward1xTime)];
  }
  return [0n, 0n];
}

/**
 * The pending-fee estimate earnedFees adds when it reached the last user checkpoint
 * and fees were not yet updated in this block's second (VotingRewardsManager.sol:179-205).
 * @param s { reachedEnd, now, lastFeeUpdate, weight, pending0, pending1, buffered0, buffered1,
 *            lastPending0, lastPending1, emissionCap, supply } (bigint, reachedEnd boolean)
 */
export function pendingFeeEstimate(s) {
  if (!s.reachedEnd || s.lastFeeUpdate === s.now || s.weight === 0n) return [0n, 0n];
  const flush = s.pending0 > 0n || s.pending1 > 0n || ((s.buffered0 > 0n || s.buffered1 > 0n) && s.emissionCap > 0n);
  if (!flush || s.supply === 0n) return [0n, 0n];
  const inc0 = ((s.pending0 - s.lastPending0 + s.buffered0) * FEE_ACCUMULATOR_PRECISION) / s.supply;
  const inc1 = ((s.pending1 - s.lastPending1 + s.buffered1) * FEE_ACCUMULATOR_PRECISION) / s.supply;
  return [(s.weight * inc0) / FEE_ACCUMULATOR_PRECISION, (s.weight * inc1) / FEE_ACCUMULATOR_PRECISION];
}
