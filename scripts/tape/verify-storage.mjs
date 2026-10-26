// A46 verifier: pnpm tape:verify-storage -- --dir <data-branch checkout> --since-size <KB> --since-v1 <KB> --since <ISO time>
// 1. aero-tape-data's `derived` branch is a single commit (replaced each run, no history).
// 2. Since the baseline, the repository size (GitHub API, KB) grew by at most 1.5 x the raw
//    v1 bytes added (du of <dir>/v1, KB), and at least 24 h have passed (GitHub recomputes
//    the size lazily).
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const arg = (n) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
const dir = arg("dir");
const sinceSize = Number(arg("since-size"));
const sinceV1 = Number(arg("since-v1"));
const since = Date.parse(arg("since") ?? "");
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8" }));
const failures = [];
const commits = gh("repos/AnastasisP/aero-tape-data/commits?sha=derived&per_page=2");
if (commits.length !== 1) failures.push(`derived branch has ${commits.length}+ commits, want 1`);
const size = gh("repos/AnastasisP/aero-tape-data").size;
const v1 = Number(execFileSync("du", ["-sk", join(dir, "v1")], { encoding: "utf8" }).split("\t")[0]);
const hours = (Date.now() - since) / 3_600_000;
const grew = size - sinceSize;
const raw = v1 - sinceV1;
console.log(`derived commits: ${commits.length}; repo ${sinceSize} -> ${size} KB (+${grew}); raw v1 ${sinceV1} -> ${v1} KB (+${raw}); ${hours.toFixed(1)} h since the baseline`);
if (hours < 24) failures.push(`only ${hours.toFixed(1)} h since the baseline; the size check needs 24 h`);
else if (grew > 1.5 * Math.max(raw, 1)) failures.push(`repo grew ${grew} KB > 1.5 x raw ${raw} KB`);
if (failures.length) {
  console.error(`\nA46 ${hours < 24 && failures.length === 1 && commits.length === 1 ? "PENDING" : "FAIL"}: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nA46 PASS: derived is one commit; repo growth within 1.5 x the raw tape");
