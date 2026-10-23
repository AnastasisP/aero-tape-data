// The tape universe for one chain at one pinned block: every pool target factory,
// every pool, every gauge. Source of truth = the leaf FactoryRegistry (the set the
// GaugeManager registers against) cross-checked with each factory's own pool index.
//
// Contract facts (metadex-public V3/src at the registry pin):
//   - PoolFactory._createPool calls FactoryRegistry.registerTarget(pool) (PoolFactory.sol:341)
//   - GaugeManager registers every gauge in FactoryRegistry.registerGauge, then LeafVoter
//     (GaugeManager.sol:120-121); registerGauge requires the target to be recorded and its
//     factory linked to the gauge factory (FactoryRegistry.sol:315)
//   - poolsIndexPaginated(_start, _end): start inclusive, end exclusive, reverts if end <= start
import { factoryRegistryAbi, leafVoterAbi, multicall3Abi, poolFactoryIndexationAbi } from "./abis.mjs";
import { MULTICALL3, multicallAt } from "./client.mjs";

const PAGE = 200n;
const lc = (a) => a.toLowerCase();

async function poolsIndexLengthOrNull(client, factory, blockNumber) {
  try {
    return await client.readContract({
      address: factory,
      abi: poolFactoryIndexationAbi,
      functionName: "poolsIndexLength",
      blockNumber,
    });
  } catch {
    return null; // not a PoolFactoryIndexation (e.g. a CL factory)
  }
}

/**
 * @param client       viem public client for the chain
 * @param chain        registry chain entry ({ slug, chainId, ... })
 * @param leafFile     the chain's leaf-<slug>.json registry entry
 * @param blockNumber  optional pinned block; latest if omitted
 */
export async function readChainUniverse(client, chain, leafFile, blockNumber) {
  const block = blockNumber ?? (await client.getBlockNumber());
  const leafVoter = leafFile.addresses.leafVoter;
  const registry = leafFile.addresses.factoryRegistry;

  const [blockTimestamp, voterRegistry, zeroGauge, targetFactories, gaugeFactories] = await multicallAt(
    client,
    block,
    [
      { address: MULTICALL3, abi: multicall3Abi, functionName: "getCurrentBlockTimestamp" },
      { address: leafVoter, abi: leafVoterAbi, functionName: "FACTORY_REGISTRY" },
      { address: leafVoter, abi: leafVoterAbi, functionName: "ZERO_GAUGE" },
      { address: registry, abi: factoryRegistryAbi, functionName: "targetFactories" },
      { address: registry, abi: factoryRegistryAbi, functionName: "gaugeFactories" },
    ],
  );

  const factories = [];
  const pools = [];
  for (const factory of targetFactories) {
    const [registryTargets, gaugeFactory] = await multicallAt(client, block, [
      { address: registry, abi: factoryRegistryAbi, functionName: "factoryToTargets", args: [factory] },
      { address: registry, abi: factoryRegistryAbi, functionName: "targetFactoryToGaugeFactory", args: [factory] },
    ]);
    const indexLength = await poolsIndexLengthOrNull(client, factory, block);
    const indexed = [];
    if (indexLength !== null) {
      for (let start = 0n; start < indexLength; start += PAGE) {
        const end = start + PAGE > indexLength ? indexLength : start + PAGE;
        const page = await client.readContract({
          address: factory,
          abi: poolFactoryIndexationAbi,
          functionName: "poolsIndexPaginated",
          args: [start, end],
          blockNumber: block,
        });
        indexed.push(...page);
      }
    }
    factories.push({
      address: lc(factory),
      gaugeFactory: lc(gaugeFactory),
      poolsIndexLength: indexLength === null ? null : Number(indexLength),
      indexedCount: indexed.length,
      registryCount: registryTargets.length,
      registryTargets: registryTargets.map(lc),
      indexedTargets: indexed.map((p) => lc(p.pool)),
    });
    const created = new Map(indexed.map((p) => [lc(p.pool), p.creationTimestamp]));
    for (const t of registryTargets) {
      pools.push({ pool: lc(t), factory: lc(factory), creationTimestamp: created.get(lc(t)) ?? null });
    }
  }

  const gauges = [];
  for (const gf of gaugeFactories) {
    const [list] = await multicallAt(client, block, [
      { address: registry, abi: factoryRegistryAbi, functionName: "factoryToGauges", args: [gf] },
    ]);
    const reads = list.flatMap((g) => [
      { address: registry, abi: factoryRegistryAbi, functionName: "gaugeToTarget", args: [g] },
      { address: registry, abi: factoryRegistryAbi, functionName: "gaugeToRewards", args: [g] },
      { address: leafVoter, abi: leafVoterAbi, functionName: "isActivated", args: [g] },
    ]);
    const res = await multicallAt(client, block, reads);
    list.forEach((g, i) => {
      gauges.push({
        gauge: lc(g),
        gaugeFactory: lc(gf),
        pool: lc(res[3 * i]),
        rewards: lc(res[3 * i + 1]),
        activated: res[3 * i + 2],
      });
    });
  }

  return {
    chainId: chain.chainId,
    slug: chain.slug,
    blockNumber: Number(block),
    blockTimestamp: Number(blockTimestamp),
    leafVoter: lc(leafVoter),
    factoryRegistry: lc(registry),
    voterFactoryRegistry: lc(voterRegistry),
    zeroGauge: lc(zeroGauge),
    gaugeFactories: gaugeFactories.map(lc),
    factories,
    pools,
    gauges,
  };
}

/**
 * A2 parity rules over one chain's universe. Returns a list of problems (empty = pass).
 * @param u           output of readChainUniverse
 * @param publishedFactories  pool factory addresses named in pools-<slug>.json
 */
export function universeProblems(u, publishedFactories) {
  const p = [];
  if (u.voterFactoryRegistry !== u.factoryRegistry) {
    p.push(`LeafVoter.FACTORY_REGISTRY ${u.voterFactoryRegistry} != registry ${u.factoryRegistry}`);
  }
  const targetSet = new Set(u.factories.map((f) => f.address));
  for (const f of publishedFactories.map(lc)) {
    if (!targetSet.has(f)) p.push(`published factory ${f} is not a registered target factory`);
  }
  for (const f of u.factories) {
    if (f.poolsIndexLength === null) {
      p.push(`target factory ${f.address} has no poolsIndexLength(): cannot prove count parity`);
      continue;
    }
    if (f.indexedCount !== f.poolsIndexLength) p.push(`${f.address}: indexed ${f.indexedCount} != poolsIndexLength ${f.poolsIndexLength}`);
    const idx = new Set(f.indexedTargets);
    const reg = new Set(f.registryTargets);
    if (idx.size !== f.indexedTargets.length) p.push(`${f.address}: duplicate pools in index`);
    const missing = [...idx].filter((x) => !reg.has(x));
    const extra = [...reg].filter((x) => !idx.has(x));
    if (missing.length) p.push(`${f.address}: ${missing.length} indexed pools not in registry (${missing.slice(0, 3).join(", ")})`);
    if (extra.length) p.push(`${f.address}: ${extra.length} registry pools not in index (${extra.slice(0, 3).join(", ")})`);
  }
  const poolSet = new Set(u.pools.map((x) => x.pool));
  const seenPool = new Set();
  for (const g of u.gauges) {
    if (!poolSet.has(g.pool)) p.push(`gauge ${g.gauge} target ${g.pool} is not in the pool universe`);
    if (seenPool.has(g.pool)) p.push(`pool ${g.pool} has more than one gauge`);
    seenPool.add(g.pool);
    const f = u.factories.find((x) => x.address === u.pools.find((q) => q.pool === g.pool)?.factory);
    if (f && f.gaugeFactory !== g.gaugeFactory) p.push(`gauge ${g.gauge}: factory link mismatch`);
  }
  return p;
}
