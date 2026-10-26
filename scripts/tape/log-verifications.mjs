// A52: append the verifiers' verdicts of finished archiver runs to the tape's working state,
// state/all/verifications/<yyyy-mm-dd>.jsonl, one line per run, from the GitHub Actions API
// (step conclusions of the "archive" job). Runs at the start of each archiver run, so the
// log covers every finished run whatever its own outcome (one run behind).
//   node scripts/tape/log-verifications.mjs --out tape-data      (needs GITHUB_REPOSITORY, gh)
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TapeStore } from "./store.mjs";

/** Verifier steps of archive.yml by the prefix of their name. */
export const VERIFIER_STEPS = {
  integrity: "Verify (integrity",
  exactness: "Exactness",
  idle: "Idle reconciliation",
  parity: "Protocol parity",
  emissions: "Gauge emissions",
  health: "Archive health",
  freshness: "Freshness",
};

/** One log line from a run and its jobs (GitHub API shapes). */
export function verificationLine(run, jobs) {
  const steps = jobs.flatMap((j) => j.steps ?? []);
  const verdicts = Object.fromEntries(
    Object.entries(VERIFIER_STEPS).map(([k, prefix]) => {
      const s = steps.find((x) => x.name.startsWith(prefix));
      return [k, s ? s.conclusion : null];
    }),
  );
  return { runId: String(run.id), at: Math.floor(Date.parse(run.created_at) / 1000), event: run.event, conclusion: run.conclusion, verdicts };
}

const isMain = process.argv[1]?.endsWith("log-verifications.mjs");
if (isMain) {
  const i = process.argv.indexOf("--out");
  const out = i === -1 ? null : process.argv[i + 1];
  const repo = process.env.GITHUB_REPOSITORY ?? "AnastasisP/aero-tape-data";
  if (!out) {
    console.error("usage: node scripts/tape/log-verifications.mjs --out <tape-data>");
    process.exit(2);
  }
  const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
  const dir = join(out, "state", "all", "verifications");
  const logged = new Set(
    existsSync(dir) ? readdirSync(dir).flatMap((f) => readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l).runId)) : [],
  );
  const store = new TapeStore(out);
  const runs = gh(`repos/${repo}/actions/workflows/archive.yml/runs?per_page=20&status=completed`).workflow_runs.reverse();
  let n = 0;
  for (const run of runs) {
    if (logged.has(String(run.id)) || String(run.id) === process.env.GITHUB_RUN_ID) continue;
    const jobs = gh(`repos/${repo}/actions/runs/${run.id}/jobs`).jobs;
    const line = verificationLine(run, jobs);
    store.appendStateLog("all", "verifications", new Date(line.at * 1000).toISOString().slice(0, 10), line);
    n++;
  }
  console.log(`verification log: ${n} run(s) added`);
}
