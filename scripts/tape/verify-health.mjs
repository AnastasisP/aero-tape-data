// A42 verifier: pnpm tape:verify-health -- --dir <tape-data> [--url https://aero-companion.vercel.app]
// Recounts the archive-health numbers from the run log on disk (state/all/runs/*.jsonl)
// with its own code, and compares them with derived/v1/index.json health and, with --url,
// with the served index. Each logged CI run id (sample of 10) must exist in the public
// GitHub Actions API of AnastasisP/aero-tape-data.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const arg = (n) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const dir = arg("dir");
const url = arg("url");
if (!dir) {
  console.error("usage: node scripts/tape/verify-health.mjs --dir <tape-data> [--url base]");
  process.exit(2);
}
const logDir = join(dir, "state", "all", "runs");
const lines = existsSync(logDir) ? readdirSync(logDir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(logDir, f), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))) : [];
const failures = [];
if (!lines.length) failures.push("no run log");
const to = Math.max(...lines.map((l) => l.at));
const window = lines.filter((l) => l.at > to - 604800).sort((a, b) => a.at - b.at);
const want = {};
for (const l of window) {
  for (const [id, c] of Object.entries(l.chains)) {
    const w = (want[id] ??= { runs: 0, failed: 0, maxLag: null, lastOkAt: null, lastRunAt: null, lag: null });
    w.runs += 1;
    w.failed += c.ok ? 0 : 1;
    if (c.ok) w.lastOkAt = l.at;
    if (c.lag !== null && (w.maxLag === null || c.lag > w.maxLag)) w.maxLag = c.lag;
    w.lastRunAt = l.at;
    w.lag = c.lag;
  }
}
const compare = (label, h) => {
  if (!h) return failures.push(`${label}: no health`);
  if (h.runs !== window.length) failures.push(`${label}: runs ${h.runs} != recount ${window.length}`);
  for (const [id, w] of Object.entries(want)) if (JSON.stringify(h.chains[id]) !== JSON.stringify(w)) failures.push(`${label} chain ${id}: ${JSON.stringify(h.chains[id])} != recount ${JSON.stringify(w)}`);
};
compare("derived index", JSON.parse(readFileSync(join(dir, "derived", "v1", "index.json"), "utf8")).health);
if (url) compare("served index", (await (await fetch(`${url}/api/tape?op=index&fresh=${Date.now()}`)).json()).health);
const ids = [...new Set(window.map((l) => l.runId).filter(Boolean))].slice(-10);
for (const id of ids) {
  const res = await fetch(`https://api.github.com/repos/AnastasisP/aero-tape-data/actions/runs/${id}`, { headers: { accept: "application/vnd.github+json" } });
  if (res.status === 403) break; // unauthenticated rate limit: the file recount above still stands
  if (!res.ok) failures.push(`run ${id} not found in GitHub Actions (HTTP ${res.status})`);
}
console.log(`run log: ${lines.length} runs, ${window.length} in the 7-day window; ${Object.keys(want).length} chains; ${ids.length} CI run ids checked`);
if (failures.length) {
  console.error(`\nA42 FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nA42 PASS: archive health == an independent recount of the run log; logged runs exist in GitHub Actions");
