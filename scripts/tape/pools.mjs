// A28: LP-side pool context per gauge-hour. The pool's own token balances (TVL in token
// units) and the pool tape's running cumulatives (fees, volume, MEV volume and fees, swap
// count). LP-side: these are what the pool's LPs and the protocol see, NEVER staker
// revenue (goal §13; lineage.mjs classifies every field LP or context, policy guard 7).
//
// Which tape: a V2 pool's factory exposes poolTape() (IPoolFactory), a CL pool's factory
// clPoolTape() (ICLFactory). The two accumulators() share a selector but not a layout,
// so the pool type decides the ABI. A target with no factory, no tape, or a failing read
// at this block (not yet deployed, not a pool) gets no record: the same rule on re-read,
// so verify-exact reproduces the skip set.
import { clLiquidityAbi, clPoolTapeAbi, poolMetaAbi, poolTapeAbi } from "./abis.mjs";
import { softMulticallAt as softMulticall } from "./client.mjs";
import { ser } from "./snapshot.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const lc = (a) => a.toLowerCase();

const ACC_FIELDS = [
  "cumulativeFee0",
  "cumulativeFee1",
  "cumulativeVolume0",
  "cumulativeVolume1",
  "cumulativeMevVolume0",
  "cumulativeMevVolume1",
  "cumulativeMevFee0",
  "cumulativeMevFee1",
];

/**
 * The pool-state record. `acc` is the decoded accumulators() result of either tape
 * (V2: positional tuple, CL: struct). Pure, so tests and verifiers share it.
 */
export function poolRecordFrom(prov, p, acc, balance0, balance1) {
  const v = Array.isArray(acc)
    ? Object.fromEntries([...ACC_FIELDS, "lastSwapTimestamp", "swapCount"].map((k, i) => [k, acc[i]]))
    : acc;
  return ser({
    ...prov,
    metric: "pool-state",
    gauge: p.gauge,
    pool: p.pool,
    poolType: p.poolType,
    tape: p.tape,
    token0: p.token0,
    token1: p.token1,
    balance0,
    balance1,
    ...Object.fromEntries(ACC_FIELDS.map((k) => [k, v[k]])),
    lastSwapTimestamp: Number(v.lastSwapTimestamp),
    swapCount: Number(v.swapCount),
  });
}

/**
 * Pool targets of the gauges at one block: each gauge's pool, its tokens and its tape
 * (factory clPoolTape() -> CL, else poolTape() -> V2). A pool without readable factory /
 * tokens / tape is left out.
 * @returns {Promise<{ entries: Array<{ gauge: string, pool: string }>, targets: Array<{ pool, factory, token0, token1, poolType, tape }> }>}
 */
async function resolveTargets(client, block, gauges) {
  const entries = [...gauges.entries()].map(([gauge, links]) => ({ gauge, pool: links.split(",")[0] })).sort((a, b) => (a.gauge < b.gauge ? -1 : 1));
  const pools = [...new Set(entries.map((e) => e.pool))];
  const meta = await softMulticall(
    client,
    block,
    pools.flatMap((pool) => ["factory", "token0", "token1"].map((fn) => ({ address: pool, abi: poolMetaAbi, functionName: fn }))),
  );
  const info = new Map();
  pools.forEach((pool, i) => {
    const [f, t0, t1] = meta.slice(3 * i, 3 * i + 3);
    if (f.ok && t0.ok && t1.ok) info.set(pool, { factory: lc(f.value), token0: lc(t0.value), token1: lc(t1.value) });
  });
  const factories = [...new Set([...info.values()].map((x) => x.factory))].sort();
  const ft = await softMulticall(
    client,
    block,
    factories.flatMap((f) => ["clPoolTape", "poolTape"].map((fn) => ({ address: f, abi: poolMetaAbi, functionName: fn }))),
  );
  const tapeOf = new Map();
  factories.forEach((f, i) => {
    const [cl, v2] = ft.slice(2 * i, 2 * i + 2);
    if (cl.ok && lc(cl.value) !== ZERO) tapeOf.set(f, { poolType: "cl", tape: lc(cl.value) });
    else if (v2.ok && lc(v2.value) !== ZERO) tapeOf.set(f, { poolType: "v2", tape: lc(v2.value) });
  });
  const targets = pools.filter((p) => info.has(p) && tapeOf.has(info.get(p).factory)).map((pool) => ({ pool, ...info.get(pool), ...tapeOf.get(info.get(pool).factory) }));
  return { entries, targets };
}

/**
 * pool-state records of one chain-hour.
 * @param gauges Map gauge -> "pool,rewards,token0,token1" (the archived gauge registry)
 * @returns {Promise<{ rows: Array<Record<string, any>>, skipped: number }>} skipped = gauges whose target has no readable pool tape here
 */
export async function readPoolStates(client, block, prov, gauges) {
  const { entries, targets } = await resolveTargets(client, block, gauges);
  const reads = await softMulticall(
    client,
    block,
    targets.flatMap((t) => [
      { address: t.tape, abi: t.poolType === "cl" ? clPoolTapeAbi : poolTapeAbi, functionName: "accumulators", args: [t.pool] },
      { address: t.token0, abi: poolMetaAbi, functionName: "balanceOf", args: [t.pool] },
      { address: t.token1, abi: poolMetaAbi, functionName: "balanceOf", args: [t.pool] },
    ]),
  );
  const state = new Map();
  targets.forEach((t, i) => {
    const [acc, b0, b1] = reads.slice(3 * i, 3 * i + 3);
    if (acc.ok && b0.ok && b1.ok) state.set(t.pool, { t, acc: acc.value, b0: b0.value, b1: b1.value });
  });
  const rows = [];
  let skipped = 0;
  for (const e of entries) {
    const s = state.get(e.pool);
    if (!s) {
      skipped++;
      continue;
    }
    rows.push(poolRecordFrom(prov, { gauge: e.gauge, pool: e.pool, poolType: s.t.poolType, tape: s.t.tape, token0: s.t.token0, token1: s.t.token1 }, s.acc, s.b0, s.b1));
  }
  return { rows, skipped };
}

/**
 * cl-liquidity records of one chain-hour (A31): for every gauge whose pool is a CL pool
 * (resolveTargets), the pool's in-range liquidity() and stakedLiquidity(). Context only,
 * LP-side: the staked share says how much of the active liquidity is staked in the gauge
 * (staked LPs forgo swap fees for emissions), never staker revenue. A pool whose reads
 * fail at this block gets no record (same rule on re-read).
 * @returns {Promise<{ rows: Array<Record<string, any>> }>}
 */
export async function readClLiquidity(client, block, prov, gauges) {
  const { entries, targets } = await resolveTargets(client, block, gauges);
  const cl = targets.filter((t) => t.poolType === "cl");
  const reads = await softMulticall(
    client,
    block,
    cl.flatMap((t) => [
      { address: t.pool, abi: clLiquidityAbi, functionName: "stakedLiquidity" },
      { address: t.pool, abi: clLiquidityAbi, functionName: "liquidity" },
    ]),
  );
  const state = new Map();
  cl.forEach((t, i) => {
    const [st, li] = reads.slice(2 * i, 2 * i + 2);
    if (st.ok && li.ok) state.set(t.pool, { stakedLiquidity: st.value, liquidity: li.value });
  });
  const rows = entries
    .filter((e) => state.has(e.pool))
    .map((e) => ser({ ...prov, metric: "cl-liquidity", gauge: e.gauge, pool: e.pool, stakedLiquidity: state.get(e.pool).stakedLiquidity, liquidity: state.get(e.pool).liquidity }));
  return { rows };
}
