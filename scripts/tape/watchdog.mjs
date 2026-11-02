// OPS-2 — archive watchdog, separate from the archive job. Opens or updates one GitHub issue when nothing has been
// saved to `data` for 2 h or the last 2 archive runs on main did not succeed; closes it on recovery.
//   node scripts/tape/watchdog.mjs [--force-stale] [--force-healthy] [--force-boundary]
// Needs GH_TOKEN and GITHUB_REPOSITORY; the gh CLI is on every GitHub runner.
import { execFileSync } from "node:child_process";

const repo = process.env.GITHUB_REPOSITORY ?? "AnastasisP/aero-tape-data";
const TITLE = "Archive watchdog: the tape is not being saved";
const MAX_SAVE_AGE_SECONDS = 2 * 3600;
const gh = (...args) => execFileSync("gh", args, { encoding: "utf8" }).trim();

const now = Math.floor(Date.now() / 1000);
const savedAt = gh("api", `repos/${repo}/branches/data`, "--jq", ".commit.commit.committer.date");
const saveAge = now - Math.floor(Date.parse(savedAt) / 1000);
const runs = JSON.parse(gh("run", "list", "-R", repo, "--workflow", "archive.yml", "--branch", "main", "--status", "completed", "-L", "2", "--json", "databaseId,conclusion,createdAt"));

const problems = [];
if (saveAge > MAX_SAVE_AGE_SECONDS) problems.push(`Nothing saved to \`data\` for ${(saveAge / 3600).toFixed(1)} h (last save ${savedAt}).`);
const bad = runs.filter((r) => r.conclusion !== "success");
if (runs.length < 2 || bad.length === runs.length) problems.push(`The last ${runs.length} archive runs did not succeed: ${runs.map((r) => `${r.databaseId} ${r.conclusion}`).join(", ")}.`);
// OPS-4: from 00:45 UTC on Thursday, every chain has the first hour after the week boundary
const WEEK = 7 * 86400;
const SETTLE_SECONDS = 45 * 60;
const forcedBoundary = process.argv.includes("--force-boundary") ? now : null;
const boundary = forcedBoundary ?? Math.floor((now - SETTLE_SECONDS) / WEEK) * WEEK;
const manifest = JSON.parse(execFileSync("gh", ["api", "-H", "Accept: application/vnd.github.raw", `repos/${repo}/contents/v1/manifest.json?ref=data`], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
const before = Object.entries(manifest.cursors).filter(([, cursor]) => cursor < boundary);
if (before.length) problems.push(`Week boundary ${new Date(boundary * 1000).toISOString()} not crossed by: ${before.map(([id, cursor]) => `${id} (cursor ${cursor})`).join(", ")}.`);
if (process.argv.includes("--force-stale")) problems.push("Forced stale state (dry run of the watchdog).");
const unhealthy = !process.argv.includes("--force-healthy") && problems.length > 0;

const [open] = JSON.parse(gh("issue", "list", "-R", repo, "--state", "open", "--search", `"${TITLE}" in:title`, "--json", "number,title")).filter((i) => i.title === TITLE);
const body = `@AnastasisP\n\n${problems.join("\n")}\n\nChecked ${new Date(now * 1000).toISOString()}. Runs: https://github.com/${repo}/actions/workflows/archive.yml`;
if (unhealthy && open) {
  gh("issue", "edit", String(open.number), "-R", repo, "--body", body);
  console.log(`updated issue #${open.number}:\n${problems.join("\n")}`);
} else if (unhealthy) {
  console.log(`opened ${gh("issue", "create", "-R", repo, "--title", TITLE, "--body", body)}:\n${problems.join("\n")}`);
} else if (open) {
  gh("issue", "close", String(open.number), "-R", repo, "--comment", `Recovered ${new Date(now * 1000).toISOString()}: last save ${savedAt}.`);
  console.log(`closed issue #${open.number}`);
} else {
  console.log(`healthy: last save ${savedAt}, last runs ${runs.map((r) => r.conclusion).join(", ")}`);
}
