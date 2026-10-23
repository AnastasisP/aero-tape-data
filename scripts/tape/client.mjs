// One viem client per registry chain. Public RPCs in fallback order (TAPE_RPC_<SLUG> overrides).
// Multicall3 is at the canonical address on all 7 chains (getCode checked 2026-10-23).
import { createPublicClient, defineChain, fallback, http } from "viem";
import { rpcsFor } from "./registry-lib.mjs";

export const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
/** Bytes per multicall batch. viem's default (1,024) is far too small for our reads. */
export const MULTICALL_BATCH_BYTES = 16_384;

export function clientFor(chain) {
  const urls = rpcsFor(chain);
  return createPublicClient({
    chain: defineChain({
      id: chain.chainId,
      name: chain.name,
      nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
      rpcUrls: { default: { http: urls } },
      contracts: { multicall3: { address: MULTICALL3 } },
    }),
    transport: fallback(
      urls.map((u) => http(u, { retryCount: 3, retryDelay: 500, timeout: 30_000 })),
      { retryCount: 1 },
    ),
    batch: { multicall: false },
  });
}

/**
 * Multicall at a pinned block; every call must succeed (allowFailure: false).
 * Splits into chunks so one huge read set never exceeds the RPC payload limit.
 */
export async function multicallAt(client, blockNumber, contracts, chunk = 500) {
  const out = [];
  for (let i = 0; i < contracts.length; i += chunk) {
    const part = await client.multicall({
      contracts: contracts.slice(i, i + chunk),
      blockNumber,
      allowFailure: false,
      batchSize: MULTICALL_BATCH_BYTES,
    });
    out.push(...part);
  }
  return out;
}

const ATTEMPTS = 4;

/** Retries a transient RPC failure with backoff (2s, 4s, 8s). Public endpoints drop requests. */
export async function withRetry(fn) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= ATTEMPTS) throw err;
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}
