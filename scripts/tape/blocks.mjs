// Block lookup by time. A tape sample for hour H is read at the FIRST block whose
// timestamp is >= H, so the sample is reproducible from (chainId, blockNumber) alone.

/** Head block at the "safe" tag (reorg-resistant), latest as fallback for RPCs without it. */
export async function safeHead(client) {
  try {
    return await client.getBlock({ blockTag: "safe" });
  } catch {
    return client.getBlock({ blockTag: "latest" });
  }
}

/**
 * Smallest block number n with timestamp(n) >= ts.
 * Invariant during the search: timestamp(lo) < ts <= timestamp(hi).
 *
 * @param client viem public client
 * @param ts     target unix seconds
 * @param lo     a block with timestamp < ts ({ number, timestamp }, bigint fields)
 * @param hi     a block with timestamp >= ts
 */
export async function firstBlockAtOrAfter(client, ts, lo, hi) {
  const target = BigInt(ts);
  if (hi.timestamp < target) throw new Error(`hi block ${hi.number} is before ${ts}`);
  if (lo.timestamp >= target) return lo;
  let step = 0;
  while (hi.number - lo.number > 1n) {
    let guess;
    // Alternate interpolation (fast on regular block times) with bisection (bounded worst case).
    if (step++ % 2 === 0 && hi.timestamp > lo.timestamp) {
      guess = lo.number + ((target - lo.timestamp) * (hi.number - lo.number)) / (hi.timestamp - lo.timestamp);
    } else {
      guess = (lo.number + hi.number) / 2n;
    }
    if (guess <= lo.number) guess = lo.number + 1n;
    if (guess >= hi.number) guess = hi.number - 1n;
    const b = await client.getBlock({ blockNumber: guess });
    if (b.timestamp >= target) hi = b;
    else lo = b;
  }
  return hi;
}
