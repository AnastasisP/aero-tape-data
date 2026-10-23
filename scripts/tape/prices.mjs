// Class-P inputs: USD prices from DeFiLlama's free coins API (no key). Every price
// carries its provider, timestamp and confidence; a token without one has no price
// (the UI shows "—"), never a fallback.
export const PRICE_PROVIDER = "defillama";
const BASE = "https://coins.llama.fi";
const BATCH = 80;

/** "<llama chain>:<address>" for a registry chain slug. */
export function priceKey(slug, address) {
  return `${slug}:${address.toLowerCase()}`;
}

async function getJson(url) {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": "aero-tape" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (attempt >= 4) throw new Error(`${url.slice(0, 80)}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1000 * 2 ** attempt));
    }
  }
}

/**
 * Prices for many tokens, now or at a unix time.
 * @returns Map key -> { price, timestamp, confidence, symbol, decimals, provider }
 */
export async function fetchPrices(keys, at = null) {
  const out = new Map();
  const list = [...new Set(keys)];
  for (let i = 0; i < list.length; i += BATCH) {
    const part = list.slice(i, i + BATCH).join(",");
    const url = at === null ? `${BASE}/prices/current/${part}` : `${BASE}/prices/historical/${at}/${part}`;
    const { coins } = await getJson(url);
    for (const [k, v] of Object.entries(coins ?? {})) out.set(k.toLowerCase(), { ...v, provider: PRICE_PROVIDER });
  }
  return out;
}
