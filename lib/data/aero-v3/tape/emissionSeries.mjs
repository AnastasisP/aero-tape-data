// A29: gauge emission accounting per gauge, derived hourly from archived gauge-state rows
// (LeafVoter.gaugeStates). Emissions are paid to the LPs staked in the gauge: LP-side,
// NEVER staker revenue (goal §13). Kept apart from SERIES_META like lpSeries.mjs.
//
// LeafAllocationLibrary (metadex-public V3/src at the registry pin):
//  - ceiling: the gauge's settled cumulative reward share, after its cap (L1216)
//  - claimed: emissions minted to the gauge (L416)
//  - surplus: emissions the gauge forfeited (idle gauge, early exit; L634)
//  - claimable = ceiling - claimed - surplus (L414)
// All three only move when the gauge settles (an interaction), so the series are class S.
import { HOUR } from "./series.mjs";
import { LP_SIDE } from "./lpSeries.mjs";

export const EMISSION_SERIES_META = Object.freeze({
  emissionsCredited: { kind: "flow", unit: "AERO wei", class: "S", side: LP_SIDE, formula: "delta of LeafVoter.gaugeStates(g).ceiling over the hour (settled reward share, after the gauge cap)" },
  emissionsClaimed: { kind: "flow", unit: "AERO wei", class: "S", side: LP_SIDE, formula: "delta of LeafVoter.gaugeStates(g).claimed over the hour (minted to the gauge for its staked LPs)" },
  emissionsForfeited: { kind: "flow", unit: "AERO wei", class: "S", side: LP_SIDE, formula: "delta of LeafVoter.gaugeStates(g).surplus over the hour (forfeited by the gauge)" },
  emissionsClaimable: { kind: "level", unit: "AERO wei", class: "S", side: LP_SIDE, formula: "ceiling - claimed - surplus at the sample block" },
});

const big = (s) => BigInt(s);
/** Delta of a cumulative, null when it went backwards: never guessed. */
const delta = (now, before) => (now >= before ? now - before : null);

/**
 * @param rows gauge-state rows of one chain, any order
 * @returns Map gauge -> hourly points, ascending by bucket. A flow is null on a gauge's
 *          first hour, after a gap, or when a cumulative went back.
 */
export function deriveEmissionHourly(rows) {
  const byGauge = new Map();
  for (const r of rows.filter((x) => x.metric === "gauge-state").sort((a, b) => a.bucket - b.bucket)) {
    if (!byGauge.has(r.gauge)) byGauge.set(r.gauge, []);
    byGauge.get(r.gauge).push(r);
  }
  const out = new Map();
  for (const [gauge, list] of byGauge) {
    const points = [];
    let prev = null;
    for (const r of list) {
      const s = r.gaugeState;
      const pt = {
        bucket: r.bucket,
        blockNumber: r.blockNumber,
        blockTimestamp: r.blockTimestamp,
        emissionsCredited: null,
        emissionsClaimed: null,
        emissionsForfeited: null,
        emissionsClaimable: big(s.ceiling) - big(s.claimed) - big(s.surplus),
      };
      if (prev && prev.bucket === r.bucket - HOUR) {
        pt.emissionsCredited = delta(big(s.ceiling), big(prev.gaugeState.ceiling));
        pt.emissionsClaimed = delta(big(s.claimed), big(prev.gaugeState.claimed));
        pt.emissionsForfeited = delta(big(s.surplus), big(prev.gaugeState.surplus));
      }
      points.push(pt);
      prev = r;
    }
    out.set(gauge, points);
  }
  return out;
}
