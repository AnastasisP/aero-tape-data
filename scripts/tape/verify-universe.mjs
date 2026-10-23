// A2 verifier: pnpm tape:verify-universe
// Per chain, at one pinned block: pool count from every factory's own index equals
// poolsIndexLength(), the index set equals the FactoryRegistry target set (0 missing,
// 0 extra), every published pool factory is registered, and every gauge maps to a
// universe pool. Exit 1 on any problem.
import { loadChains, loadDeployments } from "./registry-lib.mjs";
import { clientFor } from "./client.mjs";
import { readChainUniverse, universeProblems } from "./universe.mjs";

const chains = loadChains();
const { files } = loadDeployments();
const failures = [];

await Promise.all(
  chains.map(async (chain) => {
    try {
      const leaf = files[`leaf-${chain.slug}.json`];
      const poolsFile = files[`pools-${chain.slug}.json`]?.addresses ?? {};
      const published = [poolsFile.volatilePoolFactory, poolsFile.stablePoolFactory].filter(Boolean);
      const u = await readChainUniverse(clientFor(chain), chain, leaf);
      const problems = universeProblems(u, published);
      const perFactory = u.factories.map((f) => `${f.address.slice(0, 8)} ${f.indexedCount}/${f.poolsIndexLength}`).join(", ");
      const active = u.gauges.filter((g) => g.activated).length;
      console.log(
        `${chain.slug} @${u.blockNumber}: ${u.factories.length} factories [${perFactory}], ${u.pools.length} pools, ${u.gauges.length} gauges (${active} activated)`,
      );
      for (const p of problems) failures.push(`${chain.slug}: ${p}`);
    } catch (err) {
      failures.push(`${chain.slug}: ${err.shortMessage ?? err.message}`);
    }
  }),
);

if (failures.length) {
  console.error(`\nA2 FAIL: ${failures.length} problem(s)`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`\nA2 PASS: count parity on ${chains.length} chains, 0 missing, 0 extra`);
