// A48 verifier: pnpm tape:verify-timeframes -- [--url https://aero-companion.vercel.app] [--per-chain 3] [--seed n]
// For sampled gauges on every chain, every served 4h / 1d / 1w candle must equal the
// aggregation of the served 1h candles it covers, computed here independently of
// series.mjs: a level is open / high / low / close of the hourly values, a flow their sum,
// a count the last value; a bucket with one hour carries { v }; token series per token.
// Also closeBlock / closeTimestamp (the last hour's) and hours (the hour count).
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}
const url = arg("url", "https://aero-companion.vercel.app").replace(/\/$/, "");
const perChain = Number(arg("per-chain", "3"));
let seed = Number(arg("seed", String(Math.floor(Math.random() * 2 ** 31))));
const startSeed = seed;
function rand() {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const get = async (q) => {
  for (let i = 0; ; i++) {
    const r = await fetch(`${url}/api/tape?${q}`);
    if (r.ok) return r.json();
    if (i >= 3) throw new Error(`${q}: HTTP ${r.status}`);
    await new Promise((s) => setTimeout(s, 2000 * (i + 1)));
  }
};
const SIZE = { "4h": 14400, "1d": 86400, "1w": 604800 };
const hourValue = (v) => (v && "v" in v ? BigInt(v.v) : null);
const agg = (kind, vals, oneHour) => {
  if (oneHour) return { v: String(vals[0]) };
  if (kind === "level") return { o: String(vals[0]), h: String(vals.reduce((a, b) => (b > a ? b : a))), l: String(vals.reduce((a, b) => (b < a ? b : a))), c: String(vals.at(-1)) };
  if (kind === "flow") return { sum: String(vals.reduce((a, b) => a + b, 0n)) };
  return { c: String(vals.at(-1)) };
};
// served counts keep numbers; compare as strings
const norm = (x) => JSON.stringify(x, (_, v) => (typeof v === "number" ? String(v) : v));

const idx = await get(`op=index&f=${Date.now()}`);
const meta = idx.series;
const failures = [];
let candles = 0;
for (const [chainId, chain] of Object.entries(idx.chains)) {
  const gauges = Object.keys(chain.gauges);
  const pick = new Set();
  while (pick.size < Math.min(perChain, gauges.length)) pick.add(gauges[Math.floor(rand() * gauges.length)]);
  for (const gauge of pick) {
    const h = (await get(`op=series&chainId=${chainId}&gauge=${gauge}&tf=1h`)).candles;
    for (const tf of Object.keys(SIZE)) {
      const served = (await get(`op=series&chainId=${chainId}&gauge=${gauge}&tf=${tf}`)).candles;
      const groups = new Map();
      for (const c of h) {
        const b = Math.floor(c.bucket / SIZE[tf]) * SIZE[tf];
        if (!groups.has(b)) groups.set(b, []);
        groups.get(b).push(c);
      }
      for (const s of served) {
        const ps = groups.get(s.bucket) ?? [];
        const where = `chain ${chainId} ${gauge} ${tf} @${s.bucket}`;
        if (!ps.length) {
          failures.push(`${where}: no 1h candles`);
          continue;
        }
        const last = ps.at(-1);
        const want = { hours: ps.length, closeBlock: last.closeBlock, closeTimestamp: last.closeTimestamp, series: {} };
        for (const [name, m] of Object.entries(meta)) {
          if (m.tokens) {
            const present = ps.filter((p) => name in p.series);
            if (!present.length) continue;
            const tokens = [...new Set(present.flatMap((p) => Object.keys(p.series[name])))].sort();
            const per = {};
            for (const t of tokens) {
              const vals = ps.map((p) => hourValue(p.series[name]?.[t])).filter((v) => v !== null);
              if (vals.length) per[t] = agg(m.kind, vals, ps.length === 1);
            }
            want.series[name] = per;
          } else {
            const vals = ps.map((p) => hourValue(p.series[name])).filter((v) => v !== null);
            if (vals.length) want.series[name] = agg(m.kind, vals, ps.length === 1);
          }
        }
        const got = { hours: s.hours, closeBlock: s.closeBlock, closeTimestamp: s.closeTimestamp, series: Object.fromEntries(Object.entries(s.series).map(([k, v]) => [k, v && typeof v === "object" && !("v" in v || "o" in v || "sum" in v || "c" in v) ? Object.fromEntries(Object.entries(v).sort()) : v])) };
        const sortSeries = (o) => ({ ...o, series: Object.fromEntries(Object.entries(o.series).sort()) });
        if (norm(sortSeries(got)) !== norm(sortSeries(want))) {
          failures.push(`${where}: served ${norm(sortSeries(got)).slice(0, 300)} != 1h aggregate ${norm(sortSeries(want)).slice(0, 300)}`);
        }
        candles++;
      }
    }
  }
}
console.log(`seed ${startSeed}: ${candles} 4h / 1d / 1w candles checked against their 1h candles on ${Object.keys(idx.chains).length} chains`);
if (failures.length) {
  console.error(`\nA48 FAIL: ${failures.length} problem(s)\n  ${failures.slice(0, 10).join("\n  ")}`);
  process.exit(1);
}
console.log("A48 PASS: every coarser candle == the aggregation of its 1h candles, exact strings");
