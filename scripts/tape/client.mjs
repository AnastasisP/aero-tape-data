// One viem client per registry chain. Public RPCs in fallback order (TAPE_RPC_<SLUG> overrides).
// Multicall3 is at the canonical address on all 7 chains (getCode checked 2026-10-23).
import { createPublicClient, defineChain, fallback, http, parseAbi } from "viem";
import { rpcsFor } from "./registry-lib.mjs";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";

export function clientFor(chain) {
  const urls = rpcsFor(chain);
  return createPublicClient({
    chain: defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: urls } },
      contracts: { multicall3: { address: MULTICALL3 } },
      custom: { blockNumber: chain.blockNumber },
    }),
    transport: fallback(
      urls.map((u) => http(u, { retryCount: 3, retryDelay: 500, timeout: 30_000 })),
      { retryCount: 1 },
    ),
    batch: { multicall: false },
  });
}

const pinAbi = parseAbi(["function getBlockNumber() view returns (uint256)", "function getCurrentBlockTimestamp() view returns (uint256)"]);
const headerTimestamps = new WeakMap(); // client -> Map block -> timestamp

/**
 * The call that proves which block executed a request, and the value it must return.
 * block.number where it is this chain's block; on Nitro chains (chains.json "l1") it is
 * the parent chain's, so the block timestamp from the header is checked instead (blocks
 * sharing one second are not told apart there).
 */
async function pinFor(client, blockNumber) {
  if (client.chain?.custom?.blockNumber !== "l1") return { call: { address: MULTICALL3, abi: pinAbi, functionName: "getBlockNumber" }, expect: blockNumber, what: "block" };
  if (!headerTimestamps.has(client)) headerTimestamps.set(client, new Map());
  const cache = headerTimestamps.get(client);
  if (!cache.has(blockNumber)) cache.set(blockNumber, (await client.getBlock({ blockNumber })).timestamp);
  return { call: { address: MULTICALL3, abi: pinAbi, functionName: "getCurrentBlockTimestamp" }, expect: cache.get(blockNumber), what: "block timestamp" };
}

/** Calls per eth_call: about what one 16 KB viem batch held before the block check. */
export const CALLS_PER_REQUEST = 80;
const PARALLEL_REQUESTS = 6;
const REQUEST_ATTEMPTS = 6;

/**
 * Multicall at a pinned block. Each eth_call also reads its own block number (block
 * timestamp on Nitro chains, pinFor) in the same execution and throws when the node ran
 * it at any other block (withRetry retries): a load-balanced public RPC answered historical calls with a later block's state
 * (2026-10-25, two false A5 FAILs), which the archiver would store under the asked block.
 * One viem request per chunk (batchSize 0), so every eth_call carries its own check.
 * @returns per call: the result (allowFailure false, a revert throws) or { ok, value }
 */
async function pinnedMulticall(client, blockNumber, contracts, allowFailure) {
  const pin = await pinFor(client, blockNumber);
  const chunks = [];
  for (let i = 0; i < contracts.length; i += CALLS_PER_REQUEST) chunks.push(contracts.slice(i, i + CALLS_PER_REQUEST));
  const out = new Array(chunks.length);
  let next = 0;
  const request = async (chunk) => {
    const res = await client.multicall({ contracts: [pin.call, ...chunk], blockNumber, allowFailure, batchSize: 0 });
    // allowFailure turns a failed eth_call into a failure per call: the pin read exposes it
    if (allowFailure && res[0].status !== "success") throw new Error(`${pin.what} read failed at ${blockNumber}: ${res[0].error?.details ?? res[0].error?.shortMessage ?? res[0].error}`);
    const at = allowFailure ? res[0].result : res[0];
    if (at !== pin.expect) throw new Error(`RPC executed the call at ${pin.what} ${at}, asked block ${blockNumber} (${pin.what} ${pin.expect})`);
    return allowFailure ? res.slice(1).map((r) => ({ ok: r.status === "success", value: r.result })) : res.slice(1);
  };
  const worker = async () => {
    for (let k = next++; k < chunks.length; k = next++) {
      // Retried per request: drpc Robinhood routes about half of past-block calls to nodes
      // without that state ("Unknown state", 2026-10-26), so a reader with several requests
      // rarely got all of them through one outer withRetry attempt.
      for (let attempt = 1; ; attempt++) {
        try {
          out[k] = await request(chunks[k]);
          break;
        } catch (err) {
          if (attempt >= REQUEST_ATTEMPTS || /revert/i.test(String(err.shortMessage ?? err.message))) throw err;
          await new Promise((r) => setTimeout(r, 250 * 2 ** attempt));
        }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLEL_REQUESTS, chunks.length) }, worker));
  return out.flat();
}

/** Multicall at a pinned block; every call must succeed. */
export function multicallAt(client, blockNumber, contracts) {
  return pinnedMulticall(client, blockNumber, contracts, false);
}

/** Multicall at a pinned block that keeps going past reverts: [{ ok, value }]. RPC errors still throw. */
export function softMulticallAt(client, blockNumber, contracts) {
  return pinnedMulticall(client, blockNumber, contracts, true);
}

const ATTEMPTS = 6;

/**
 * Retries a transient RPC failure with backoff (2, 4, 8, 16, 32 s; at most 60 s). Public
 * endpoints drop or rate-limit requests, more so from shared CI runner addresses.
 */
export async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, Math.min(60_000, 1000 * 2 ** attempt)));
    }
  }
}
