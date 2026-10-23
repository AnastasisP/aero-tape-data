// A1 verifier: pnpm tape:verify-registry
// 1. every registry file maps to a chain in chains.json, and every chain has files
// 2. each chain's RPCs (every fallback) answer eth_chainId == the registered chainId
// 3. each registry file still hashes to the raw upstream file at the pinned commit
// 4. eth_getCode != "0x" for every address on its chain
//    - ROOT_SIDE_KEYS are checked on the root chain, and must equal the root adapter
//      registered for that leaf chain
//    - the zero address means "not set" upstream: listed, not checked
// Exit 1 on any failure. Upstream HEAD drift is reported, not failed (re-sync = new pin).
import {
  UPSTREAM_REPO,
  fetchJson,
  fetchText,
  loadChains,
  loadDeployments,
  rawUrl,
  ROOT_SIDE_KEYS,
  ZERO_ADDRESS,
  rpcsFor,
  sha256,
} from "./registry-lib.mjs";

const CONCURRENCY = 4;
const RETRIES = 3;
const failures = [];
const fail = (msg) => failures.push(msg);

async function rpc(url, method, params) {
  let lastErr;
  for (let attempt = 1; attempt <= RETRIES; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      if (body.error) throw new Error(`${body.error.code} ${body.error.message}`);
      return body.result;
    } catch (err) {
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * attempt));
    }
  }
  throw new Error(`${method} @ ${url}: ${lastErr.message}`);
}

async function pool(items, worker) {
  const queue = [...items];
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (queue.length) await worker(queue.shift());
    }),
  );
}

const chains = loadChains();
const deployments = loadDeployments();
const { commit } = deployments.source;
const files = Object.entries(deployments.files);
const bySlug = new Map(chains.map((c) => [c.slug, c]));

// 1. mapping
for (const [name, f] of files) if (!bySlug.has(f.chain)) fail(`${name}: unknown chain ${f.chain}`);
for (const c of chains) if (!files.some(([, f]) => f.chain === c.slug)) fail(`${c.slug}: no registry files`);

// Which chain each (file, key) address must have code on.
const root = chains.find((c) => c.role === "root");
const rootAdapters = files.find(([name]) => name === `rootadapters-${root.slug}.json`)?.[1].addresses ?? {};
const unset = [];
const targets = []; // { slug, addr, where }
for (const [name, f] of files) {
  for (const [key, addr] of Object.entries(f.addresses)) {
    const where = `${name}:${key}`;
    if (addr.toLowerCase() === ZERO_ADDRESS) {
      unset.push(where);
      continue;
    }
    if (ROOT_SIDE_KEYS.has(key)) {
      const expected = rootAdapters[`rootAdapter${bySlug.get(f.chain)?.chainId}`];
      if (expected?.toLowerCase() !== addr.toLowerCase()) fail(`${where}: ${addr} != registered root adapter ${expected}`);
      targets.push({ slug: root.slug, addr: addr.toLowerCase(), where });
      continue;
    }
    targets.push({ slug: f.chain, addr: addr.toLowerCase(), where });
  }
}

// 3. integrity vs upstream at the pinned commit
await pool(files, async ([name, f]) => {
  try {
    const got = sha256(await fetchText(rawUrl(commit, name)));
    if (got !== f.sha256) fail(`${name}: sha256 ${got} != pinned ${f.sha256}`);
  } catch (err) {
    fail(`${name}: upstream fetch failed: ${err.message}`);
  }
});

// 2 + 4. chain id and bytecode
let checked = 0;
await Promise.all(
  chains.map(async (chain) => {
    const [url, ...fallbacks] = rpcsFor(chain);
    for (const u of [url, ...fallbacks]) {
      try {
        const id = Number(BigInt(await rpc(u, "eth_chainId", [])));
        if (id !== chain.chainId) fail(`${chain.slug}: ${u} eth_chainId ${id} != ${chain.chainId}`);
      } catch (err) {
        fail(`${chain.slug}: ${err.message}`);
      }
    }
    const owners = new Map(); // lowercase address -> ["file:key", ...]
    for (const t of targets) {
      if (t.slug === chain.slug) owners.set(t.addr, [...(owners.get(t.addr) ?? []), t.where]);
    }
    await pool([...owners.keys()], async (addr) => {
      try {
        const code = await rpc(url, "eth_getCode", [addr, "latest"]);
        checked++;
        if (!code || code === "0x") fail(`${chain.slug} ${addr} (${owners.get(addr).join(", ")}): no bytecode`);
      } catch (err) {
        fail(`${chain.slug} ${addr}: ${err.message}`);
      }
    });
    console.log(`${chain.slug} (${chain.chainId}): ${owners.size} unique addresses`);
  }),
);

// drift notice
try {
  const head = await fetchJson(`https://api.github.com/repos/${UPSTREAM_REPO}/commits/main`);
  if (head.sha !== commit) console.log(`NOTICE upstream main is ${head.sha}, pinned ${commit}: re-sync and re-run A1`);
} catch (err) {
  console.log(`NOTICE could not read upstream HEAD: ${err.message}`);
}

if (failures.length) {
  console.error(`\nA1 FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`unset upstream (zero address, not checked): ${unset.join(", ") || "none"}`);
console.log(`\nA1 PASS: ${files.length} files @ ${commit}, ${checked} addresses with bytecode on ${chains.length} chains`);
