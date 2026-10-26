// Decay calendar of a gauge (goal §5b, A27): the weight on g scheduled to expire, week by
// week, if nothing is allocated or removed. Deterministic future of the stored point and the
// contract's own gaugeSlopeChanges; never a forecast of what allocators do. Pure, bigint.
import { WEEK, boundariesBetween, resolvePoint } from "./points.mjs";

/** The boundaries a calendar needs gaugeSlopeChanges for: (point.ts, the last listed one]. bigint. */
export function calendarBoundaries(pointTs, t, weeks) {
  return boundariesBetween(pointTs, (t / WEEK + BigInt(weeks)) * WEEK);
}

/**
 * @param point        { bias, slope, ts, permanentStakeBalance } — LeafVoter.gaugeStates(g).point
 * @param t            the read's block timestamp (>= point.ts)
 * @param weeks        how many upcoming week boundaries to list
 * @param slopeChange  boundary -> bigint, gaugeSlopeChanges(g, boundary) for every boundary
 *                     in calendarBoundaries(point.ts, t, weeks)
 * @returns { weightNow, permanent, rows: [{ boundary, expiringSlope, weightAt, decayed }], decayingAfter }
 *          decayed = weight lost in the week ending at boundary (from t for the first row);
 *          expiringSlope = the slope that stops decaying at boundary (stakes ending there);
 *          decayingAfter = decaying (non-permanent) weight still on g after the last row
 */
export function decayCalendar(point, t, weeks, slopeChange) {
  const weightNow = resolvePoint(point, t, slopeChange).weight;
  const rows = [];
  let prev = weightNow;
  let last = null;
  for (const boundary of boundariesBetween(t, (t / WEEK + BigInt(weeks)) * WEEK)) {
    last = resolvePoint(point, boundary, slopeChange);
    rows.push({ boundary, expiringSlope: slopeChange(boundary), weightAt: last.weight, decayed: prev - last.weight });
    prev = last.weight;
  }
  return { weightNow, permanent: point.permanentStakeBalance, rows, decayingAfter: last ? last.bias : weightNow - point.permanentStakeBalance };
}
