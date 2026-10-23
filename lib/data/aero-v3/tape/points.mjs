// Decaying-weight arithmetic, mirroring the contracts in bigint (metadex-public V3/src
// at the registry pin). Pure functions: no I/O.

export const WEEK = 604800n; // ProtocolConstants.WEEK
export const MAXTIME = 126144000n; // ProtocolConstants.MAXTIME = 4 * 365 days

const max0 = (x) => (x > 0n ? x : 0n);

/**
 * A token's contribution to a point, AllocationLogicLibrary._contribution (L1471).
 * @returns { bias, slope, perm } as bigint
 */
export function contribution(allocated, stakeEnd, t, isPermanent) {
  if (isPermanent) return { bias: 0n, slope: 0n, perm: allocated };
  if (stakeEnd <= t) return { bias: 0n, slope: 0n, perm: 0n };
  const slope = allocated / MAXTIME;
  return { bias: slope * (stakeEnd - t), slope, perm: 0n };
}

/**
 * A stored point resolved to time t, as AllocationLogicLibrary (L963-989) does: decay to
 * each week boundary in (ts, t], apply that boundary's slope change, then the trailing
 * partial segment. All arguments bigint.
 *
 * @param point        { bias, slope, ts, permanentStakeBalance }
 * @param t            target unix seconds (>= point.ts)
 * @param slopeChange  boundary -> bigint (the scheduled slope reduction at that boundary)
 * @returns { bias, slope, weight } where weight = bias + permanentStakeBalance
 */
export function resolvePoint(point, t, slopeChange) {
  let { bias, slope } = point;
  let cursor = point.ts;
  if (t < cursor) throw new Error(`resolvePoint: t ${t} before point.ts ${cursor}`);
  for (let boundary = (cursor / WEEK + 1n) * WEEK; boundary <= t; boundary += WEEK) {
    bias = max0(bias - slope * (boundary - cursor));
    slope = max0(slope - slopeChange(boundary));
    cursor = boundary;
  }
  bias = max0(bias - slope * (t - cursor));
  return { bias, slope, weight: bias + point.permanentStakeBalance };
}

/** Week boundaries in (from, to]. bigint. */
export function boundariesBetween(from, to) {
  const out = [];
  for (let b = (from / WEEK + 1n) * WEEK; b <= to; b += WEEK) out.push(b);
  return out;
}
