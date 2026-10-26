// Incentive runway of a gauge (goal §5b, A30): for every incentive program on its rewards
// contract, what the program's own terms still schedule to stream and the balance the
// contract still holds for it. A schedule of committed programs, not a forecast: a new
// program changes it. Pure: no I/O.
//
// IncentiveStreaming (metadex-public V3/src at the registry pin): a program streams `rate`
// / PRECISION (1e18) token wei per second over [start, end) (RewardsLogicLibrary L139-143,
// ProtocolConstants PRECISION); remainingAmount(id) is its
// balance, debited by claims and sweeps (IncentiveStreaming L145-148), so it also holds
// streamed amounts not yet claimed.

/**
 * @param programs [{ programId, token, amount, rate, start, end }] (bigint amounts, number times)
 * @param remaining Map programId -> remainingAmount (bigint)
 * @param t unix seconds of the read block
 * @returns { programs: [...each with status, scheduledToStream, remaining], tokens: { [token]: { ratePerSecond (x 1e18), scheduledToStream, remaining, lastEnd } } }
 *          for programs not ended at t
 */
/** ProtocolConstants.PRECISION: `rate` is token wei per second x 1e18. */
export const RATE_PRECISION = 10n ** 18n;

export function incentiveRunway(programs, remaining, t) {
  const live = programs.filter((p) => p.end > t).sort((a, b) => a.end - b.end || a.programId - b.programId);
  const out = live.map((p) => {
    const from = Math.max(t, p.start);
    return {
      ...p,
      status: p.start <= t ? "streaming" : "scheduled",
      scheduledToStream: (p.rate * BigInt(p.end - from)) / RATE_PRECISION,
      remaining: remaining.get(p.programId) ?? 0n,
    };
  });
  const tokens = {};
  for (const p of out) {
    const k = (tokens[p.token] ??= { ratePerSecond: 0n, scheduledToStream: 0n, remaining: 0n, lastEnd: 0 });
    if (p.status === "streaming") k.ratePerSecond += p.rate;
    k.scheduledToStream += p.scheduledToStream;
    k.remaining += p.remaining;
    k.lastEnd = Math.max(k.lastEnd, p.end);
  }
  return { programs: out, tokens };
}
