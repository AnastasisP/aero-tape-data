// Token tiers (goal §5b, A35): TokenRegistry.tier(token) of every archived fee / incentive
// token, per chain-hour, as delta rows (a full snapshot first, then only changed tokens).
// ITokenRegistry (metadex-public V3/src/interfaces/tokenRegistry): tierType (0 =
// unclassified), weight (1..MAX_WEIGHT, 0 = unresolved), flags (governance bitmask).
// Context only: a governance classification, never an amount.
import { parseAbi } from "viem";
import { multicallAt } from "./client.mjs";

const tierAbi = parseAbi(["function tier(address) view returns (uint8 tierType, uint8 weight, uint240 flags)"]);

/** Map token -> "tierType,weight,flags" at one block. */
export async function readTokenTiers(client, registry, block, tokens) {
  const list = [...tokens].sort();
  if (!list.length) return new Map();
  const res = await multicallAt(client, block, list.map((t) => ({ address: registry, abi: tierAbi, functionName: "tier", args: [t] })));
  return new Map(list.map((t, i) => [t, `${res[i][0]},${res[i][1]},${res[i][2]}`]));
}

/**
 * token-tier rows for one chain-hour: every token on a full snapshot (no previous state),
 * else only tokens whose tier changed or that are new.
 * @param prev Map token -> "tierType,weight,flags" or null
 */
export function tokenTierRows(prov, prev, next) {
  const row = (token, v, kind) => {
    const [tierType, weight, flags] = v.split(",");
    return { ...prov, metric: "token-tier", kind, token, tierType: Number(tierType), weight: Number(weight), flags };
  };
  const out = [];
  for (const [t, v] of [...next].sort()) {
    if (prev === null) out.push(row(t, v, "full"));
    else if (prev.get(t) !== v) out.push(row(t, v, "delta"));
  }
  return out;
}

/** Replays token-tier rows into Map token -> { tierType, weight, flags, blockNumber, bucket }. */
export function replayTokenTiers(rows) {
  let state = new Map();
  let fullBucket = null;
  for (const r of [...rows].sort((a, b) => a.bucket - b.bucket)) {
    if (r.kind === "full" && r.bucket !== fullBucket) {
      state = new Map();
      fullBucket = r.bucket;
    }
    state.set(r.token, { tierType: r.tierType, weight: r.weight, flags: r.flags, blockNumber: r.blockNumber, bucket: r.bucket });
  }
  return state;
}
