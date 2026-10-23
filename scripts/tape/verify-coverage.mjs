// A4 verifier: pnpm tape:verify-coverage -- --dir <tape-data>
// Every core series (series.mjs SERIES_META) exists for every gauge, every hour from the
// gauge's first archived hour to the chain cursor, and as a candle in every 1h / 4h / 1d /
// 1w bucket of that window. Flows need two consecutive hours, so they start one hour later.
// Days older than the sparse window may be absent from disk: coverage then starts at the
// oldest day present, and the verifier says so.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains } from "./registry-lib.mjs";
import { TapeStore } from "./store.mjs";
import { ALLOCATION_SERIES, HOUR, SERIES_META, TIMEFRAMES, aggregate, deriveHourly } from "../../lib/data/aero-v3/tape/series.mjs";

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
if (!dir) {
  console.error("usage: node scripts/tape/verify-coverage.mjs --dir <tape-data>");
  process.exit(2);
}
const store = new TapeStore(dir, { readOnly: true });
const METRICS = ["gauge-state", "gauge-registry", "incentive-program", "allocation-change", "gauge-slope-change"];
const failures = [];
let cells = 0;

// Relay-owned veNFTs, from the root chain's relay-registry rows.
const rootChain = loadChains().find((c) => c.role === "root");
const relayRows = Object.keys(store.manifest.files)
  .filter((f) => f.startsWith(`${rootChain.chainId}/relay-registry/`) && existsSync(join(store.dir, f)))
  .flatMap((f) => readFileSync(join(store.dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
const relayTokens = relayRows.length ? new Set(relayRows.map((r) => r.tokenId)) : null;

for (const chain of loadChains()) {
  const cursor = store.cursor(chain.chainId);
  if (cursor === null) {
    failures.push(`${chain.slug}: no samples`);
    continue;
  }
  const rows = [];
  for (const rel of Object.keys(store.manifest.files).sort()) {
    const [cid, metric] = rel.split("/");
    if (cid !== String(chain.chainId) || !METRICS.includes(metric)) continue;
    const abs = join(store.dir, rel);
    if (!existsSync(abs)) continue;
    for (const l of readFileSync(abs, "utf8").split("\n")) if (l) rows.push(JSON.parse(l));
  }
  const allocThrough = store.metricCursor(chain.chainId, "allocation-change");
  const series = deriveHourly(rows, allocThrough, relayTokens);
  let missing = 0;
  const miss = (m) => {
    missing++;
    if (missing <= 5) failures.push(`${chain.slug}: ${m}`);
  };
  for (const [gauge, points] of series) {
    const first = points[0].bucket;
    const at = new Map(points.map((p) => [p.bucket, p]));
    for (let h = first; h <= cursor; h += HOUR) {
      const p = at.get(h);
      for (const name of Object.keys(SERIES_META)) {
        cells++;
        const isFlow = name === "weightFlow" || name === "feeYield" || name === "yieldPerWeight";
        if (isFlow && h === first) continue;
        const allocSeries = ALLOCATION_SERIES.includes(name);
        if (allocSeries && (allocThrough === null || h > allocThrough)) {
          miss(`${gauge} ${name} @${h}: allocation-change processed only to ${allocThrough}`);
          continue;
        }
        if (!p || p[name] === null || p[name] === undefined) miss(`${gauge} ${name} missing @${new Date(h * 1000).toISOString()}`);
      }
    }
    for (const tf of Object.keys(TIMEFRAMES)) {
      const size = TIMEFRAMES[tf];
      const candles = new Map(aggregate(points, tf).map((c) => [c.bucket, c]));
      for (let b = Math.floor(first / size) * size; b <= cursor; b += size) {
        cells++;
        const c = candles.get(b);
        if (!c) miss(`${gauge} ${tf} candle missing @${b}`);
        else if (!("weight" in c.series)) miss(`${gauge} ${tf} candle @${b} has no weight`);
      }
    }
  }
  if (missing > 5) failures.push(`${chain.slug}: ... ${missing - 5} more`);
  console.log(`${chain.slug}: ${series.size} gauges, ${missing} missing cells, allocation-change through ${allocThrough === null ? "none" : new Date(allocThrough * 1000).toISOString()}`);
}

if (failures.length) {
  console.error(`\nA4 FAIL: ${failures.length} problem(s) over ${cells} cells`);
  for (const f of failures.slice(0, 40)) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA4 PASS: ${cells} gauge x series x timeframe cells, 100% covered`);
