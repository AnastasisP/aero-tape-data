// A3 verifier: pnpm tape:verify-archive -- --dir <tape-data checkout> [--offline]
// 1. integrity: every manifest file hashes to its recorded sha256 (read-only)
// 2. continuity: for each chain, every hour from max(activation, cursor - 7d) to the
//    cursor has exactly one leaf-state sample (no gap, no duplicate)
// 3. freshness (skipped with --offline): each chain's cursor is at most MAX_LAG_HOURS
//    behind the chain's safe head
// 4. append-only: in the working tree, no tape file has a deleted line vs HEAD
//    (git diff --numstat), and with --history no commit ever deleted a tape line
// 5. A13 order: the first commit that adds a tape file is later than the
//    pre-registration commit
// 6. A9 schema: every line of the day files from the last SCHEMA_DAYS days satisfies
//    scripts/tape/schema.mjs (older files were checked when they were written)
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadChains } from "./registry-lib.mjs";
import { clientFor } from "./client.mjs";
import { safeHead } from "./blocks.mjs";
import { STORE_VERSION, TapeStore, dayOf } from "./store.mjs";
import { recordProblems } from "./schema.mjs";

const HOUR = 3600;
const WINDOW_HOURS = 7 * 24;
const MAX_LAG_HOURS = 3;
const SCHEMA_DAYS = 2;
// specs/goal/PREREG-tape-measurement.md was added in this commit (tape/A13).
const PREREG = { commit: "4b39a58ceca95f52009300301ac957d073543191", committedAt: 1792755753 };

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}
const dir = arg("dir");
const offline = process.argv.includes("--offline");
const history = process.argv.includes("--history");
if (!dir) {
  console.error("usage: node scripts/tape/verify-archive.mjs --dir <tape-data> [--offline] [--history]");
  process.exit(2);
}

const failures = [];
const fail = (m) => failures.push(m);
const git = (...a) => execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });

// 1. integrity
let store;
try {
  store = new TapeStore(dir, { readOnly: true });
} catch (err) {
  console.error(`A3 FAIL: ${err.message}`);
  process.exit(1);
}
const { manifest } = store;

// 2. continuity, from the leaf-state files (one line per chain-hour)
const chains = loadChains();
const activation = (() => {
  // The root-state samples carry Minter.ACTIVATION_TIMESTAMP; use the first one found.
  const root = chains.find((c) => c.role === "root");
  const rel = Object.keys(manifest.files).find((f) => f.startsWith(`${root.chainId}/root-state/`));
  if (!rel) return null;
  const first = readFileSync(join(store.dir, rel), "utf8").split("\n")[0];
  return Number(JSON.parse(first).minter.activationTimestamp);
})();
if (activation === null) fail("no root-state sample: cannot read the activation time");

for (const chain of chains) {
  const cursor = store.cursor(chain.chainId);
  if (cursor === null) {
    fail(`${chain.slug}: no samples`);
    continue;
  }
  const seen = new Map();
  for (const rel of Object.keys(manifest.files).filter((f) => f.startsWith(`${chain.chainId}/leaf-state/`))) {
    for (const line of readFileSync(join(store.dir, rel), "utf8").split("\n")) {
      if (!line) continue;
      const b = JSON.parse(line).bucket;
      seen.set(b, (seen.get(b) ?? 0) + 1);
    }
  }
  const from = Math.max(Math.ceil((activation ?? cursor) / HOUR) * HOUR, cursor - WINDOW_HOURS * HOUR);
  const gaps = [];
  for (let h = from; h <= cursor; h += HOUR) {
    const n = seen.get(h) ?? 0;
    if (n === 0) gaps.push(h);
    if (n > 1) fail(`${chain.slug}: hour ${h} sampled ${n} times`);
  }
  if (gaps.length) fail(`${chain.slug}: ${gaps.length} missing hours, first ${new Date(gaps[0] * 1000).toISOString()}`);
  console.log(`${chain.slug}: ${(cursor - from) / HOUR + 1} hours checked to ${new Date(cursor * 1000).toISOString()}`);
}

// 6. schema on recent files
{
  const newest = Math.max(0, ...Object.values(manifest.cursors));
  const since = dayOf(newest - SCHEMA_DAYS * 86400);
  let checked = 0;
  for (const rel of Object.keys(manifest.files).filter((f) => f.slice(-16, -6) >= since)) {
    readFileSync(join(store.dir, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line) return;
        checked++;
        const p = recordProblems(JSON.parse(line));
        if (p.length) fail(`schema: ${rel}:${i + 1}: ${p.join("; ")}`);
      });
  }
  console.log(`schema: ${checked} records since ${since}`);
}

// 6. schema on recent files
{
  const newest = Math.max(0, ...Object.values(manifest.cursors));
  const since = dayOf(newest - SCHEMA_DAYS * 86400);
  let checked = 0;
  for (const rel of Object.keys(manifest.files).filter((f) => f.slice(-16, -6) >= since)) {
    readFileSync(join(store.dir, rel), "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!line) return;
        checked++;
        const p = recordProblems(JSON.parse(line));
        if (p.length) fail(`schema: ${rel}:${i + 1}: ${p.join("; ")}`);
      });
  }
  console.log(`schema: ${checked} records since ${since}`);
}

// 3. freshness. A chain whose last archive run failed on its RPC is Frozen: reported,
//    not failed (its hours resume, gap-free, when the RPC answers again).
const lastRun = store.readState("all", "run")?.chains ?? {};
if (!offline) {
  await Promise.all(
    chains.map(async (chain) => {
      const cursor = store.cursor(chain.chainId);
      if (cursor === null) return;
      if (lastRun[chain.chainId] && !lastRun[chain.chainId].ok) {
        console.log(`${chain.slug}: frozen (last run: ${lastRun[chain.chainId].error ?? "RPC failure"}); cursor ${new Date(cursor * 1000).toISOString()}`);
        return;
      }
      try {
        const head = await safeHead(clientFor(chain));
        const lag = (Math.floor(Number(head.timestamp) / HOUR) * HOUR - cursor) / HOUR;
        if (lag > MAX_LAG_HOURS) fail(`${chain.slug}: cursor is ${lag} hours behind the chain head`);
      } catch (err) {
        fail(`${chain.slug}: head read failed: ${err.shortMessage ?? err.message}`);
      }
    }),
  );
}

// 4. append-only
if (existsSync(join(dir, ".git"))) {
  const deleted = (out) =>
    out
      .split("\n")
      .map((l) => l.split("\t"))
      .filter(([, del, path]) => path?.startsWith(`${STORE_VERSION}/`) && path.endsWith(".jsonl") && del !== "0");
  const hasHead = (() => {
    try {
      git("rev-parse", "--verify", "HEAD");
      return true;
    } catch {
      return false;
    }
  })();
  if (hasHead) {
    for (const [, , path] of deleted(git("diff", "--numstat", "HEAD", "--", STORE_VERSION))) fail(`append-only: ${path} lost lines vs HEAD`);
    if (history) {
      for (const [, , path] of deleted(git("log", "--numstat", "--format=", "--", STORE_VERSION))) fail(`append-only: a commit deleted lines in ${path}`);
    }
    // 5. A13 order
    const firstAdd = git("log", "--reverse", "--diff-filter=A", "--format=%ct", "--", STORE_VERSION).split("\n")[0];
    if (firstAdd && Number(firstAdd) <= PREREG.committedAt) fail(`A13: first tape commit (${firstAdd}) is not after the pre-registration`);
  }
} else {
  console.log("note: not a git checkout, append-only and A13 checks skipped");
}

if (failures.length) {
  console.error(`\nA3 FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA3 PASS: ${Object.keys(manifest.files).length} files intact, no gaps${offline ? "" : ", fresh"}`);
