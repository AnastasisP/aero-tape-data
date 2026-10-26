// A9: the tape record contract. Every record carries provenance (goal §4, A9); the
// archiver refuses to append a record that breaks it, and verify-archive re-checks
// recent files. Plain JS, no dependencies, shared by scripts and tests.
import { loadChains } from "./registry-lib.mjs";

export const TAPE_SCHEMA_VERSION = 1;
export const TAPE_CLASSES = new Set(["E", "D", "P", "S"]);
export const TAPE_METRICS = new Set(["gauge-state", "gauge-registry", "incentive-program", "fee-checkpoint", "allocation-change", "gauge-slope-change", "relay-registry", "token-registry", "token-leaf-state", "leaf-state", "root-state", "pool-state"]);
const SOURCE = /^chain(\+price:[a-z0-9][a-z0-9-]*)?$/;
const ADDRESS = /^0x[0-9a-f]{40}$/;
const UINT = /^[0-9]+$/;
const INT = /^-?[0-9]+$/;

const CHAIN_IDS = new Set(loadChains().map((c) => c.chainId));

const isPosInt = (v) => Number.isSafeInteger(v) && v > 0;

/** Fields each metric must carry beyond provenance, with their kind. */
const REQUIRED = {
  "gauge-state": { gauge: "address", gaugeState: "object", fees: "object", voteSupply: "uint", incentiveCount: "uint" },
  "gauge-registry": { gauge: "address", pool: "address", rewards: "address", token0: "address", token1: "address" },
  "incentive-program": { gauge: "address", rewards: "address", programId: "posint", token: "address", amount: "uint", rate: "uint", start: "int", end: "int" },
  "fee-checkpoint": { gauge: "address", rewards: "address", index: "posint", ts: "posint", feeReward0: "uint", feeReward1: "uint", feeReward0xTime: "uint", feeReward1xTime: "uint" },
  "allocation-change": { tokenId: "uintstr", gauge: "address", allocated: "uint", kind: "kind" },
  "gauge-slope-change": { gauge: "address", boundary: "posint", slopeDelta: "int" },
  "relay-registry": { relay: "address", factory: "address", tokenId: "uintstr", relayType: "int" },
  "token-registry": { token: "address" },
  "token-leaf-state": { tokenId: "uintstr", kind: "kind", lastAllocated: "int", cooldownReduction: "int", stakeEnd: "int" },
  "leaf-state": { leafVoter: "address", zeroGaugeState: "object", index: "uint", emissionsPerVP: "uint", allocationCooldown: "posint" },
  "root-state": { votingEscrow: "object", voter: "object", chainStates: "array", minter: "object" },
  "pool-state": { gauge: "address", pool: "address", poolType: "pooltype", tape: "address", token0: "address", token1: "address", balance0: "uint", balance1: "uint", cumulativeFee0: "uint", cumulativeFee1: "uint", cumulativeVolume0: "uint", cumulativeVolume1: "uint", swapCount: "int", lastSwapTimestamp: "int" },
};

function kindOk(kind, v) {
  switch (kind) {
    case "address":
      return typeof v === "string" && ADDRESS.test(v);
    case "uint":
      return typeof v === "string" && UINT.test(v);
    case "int":
      return Number.isSafeInteger(v) || (typeof v === "string" && INT.test(v));
    case "posint":
      return isPosInt(v);
    case "uintstr":
      return typeof v === "string" && UINT.test(v) && v !== "0";
    case "kind":
      return v === "full" || v === "delta";
    case "pooltype":
      return v === "v2" || v === "cl";
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    default:
      return false;
  }
}

/** Amounts must never be JS numbers above 2^53: walk the record for unsafe numbers. */
function unsafeNumbers(v, path, out) {
  if (typeof v === "number" && (!Number.isSafeInteger(v) || !Number.isFinite(v))) out.push(path);
  else if (Array.isArray(v)) v.forEach((x, i) => unsafeNumbers(x, `${path}[${i}]`, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) unsafeNumbers(x, `${path}.${k}`, out);
  return out;
}

/** @returns list of problems; empty = the record satisfies the A9 contract. */
export function recordProblems(r) {
  const p = [];
  if (r === null || typeof r !== "object") return ["not an object"];
  if (r.schemaVersion !== TAPE_SCHEMA_VERSION) p.push(`schemaVersion ${r.schemaVersion}`);
  if (!CHAIN_IDS.has(r.chainId)) p.push(`chainId ${r.chainId} not in the registry`);
  if (!isPosInt(r.blockNumber)) p.push(`blockNumber ${r.blockNumber}`);
  if (!isPosInt(r.blockTimestamp)) p.push(`blockTimestamp ${r.blockTimestamp}`);
  if (!isPosInt(r.bucket) || r.bucket % 3600 !== 0) p.push(`bucket ${r.bucket} is not an hour`);
  // The sample for hour H is read at the first block >= H, so it is never before H.
  else if (isPosInt(r.blockTimestamp) && r.blockTimestamp < r.bucket) p.push(`blockTimestamp before bucket`);
  if (typeof r.source !== "string" || !SOURCE.test(r.source)) p.push(`source ${r.source}`);
  if (!TAPE_CLASSES.has(r.class)) p.push(`class ${r.class}`);
  if (r.class === "P" && !String(r.source).includes("+price:")) p.push("class P without a price source");
  if (r.class !== "P" && String(r.source).includes("+price:")) p.push("price source on a non-P record");
  if (!TAPE_METRICS.has(r.metric)) p.push(`metric ${r.metric}`);
  for (const [field, kind] of Object.entries(REQUIRED[r.metric] ?? {})) {
    if (!kindOk(kind, r[field])) p.push(`${r.metric}.${field} is not ${kind}`);
  }
  for (const path of unsafeNumbers(r, "", [])) p.push(`unsafe number at ${path || "."}`);
  return p;
}

export function assertRecord(r) {
  const p = recordProblems(r);
  if (p.length) throw new Error(`tape schema: ${r?.metric ?? "?"} record: ${p.join("; ")}`);
}
