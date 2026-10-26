// Emission band of the root Minter (goal §5c, A33), from the archived root-state minter
// fields. Minter._effectiveRate (metadex-public V3/src/minter/Minter.sol L333-346): with
// no dynamic rate the base rate holds; a dynamic rate below base is clamped up to
// floor = base - base x floorPips / MAX_PIPS, one at or above base down to
// ceiling = base + base x ceilingPips / MAX_PIPS (MAX_PIPS = 1e6, floor rounding).
// The recomputed effective rate must equal the archived emissionRate (tests, A33).

export const MAX_PIPS = 1_000_000n;

/**
 * @param minter { emissionRate, baseRate, dynamicRate, bandFloorPips, bandCeilingPips } as archived
 * @returns { baseRate, dynamicRate, floor, ceiling, effective, emissionRate } bigint, AERO wei per second
 */
export function emissionBand(minter) {
  const base = BigInt(minter.baseRate);
  const dynamic = BigInt(minter.dynamicRate);
  const floor = base - (base * BigInt(minter.bandFloorPips)) / MAX_PIPS;
  const ceiling = base + (base * BigInt(minter.bandCeilingPips)) / MAX_PIPS;
  let effective = base;
  if (dynamic !== 0n) effective = dynamic < base ? (dynamic > floor ? dynamic : floor) : dynamic < ceiling ? dynamic : ceiling;
  return { baseRate: base, dynamicRate: dynamic, floor, ceiling, effective, emissionRate: BigInt(minter.emissionRate) };
}
