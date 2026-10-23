// Booked gauge allocations per veNFT, read token by token. Events cannot give this
// exactly: GaugesAllocated carries the REQUESTED allocation ("unroutable gauges may be
// redirected, so booked weight can differ", ILeafVoter). The booked truth is
// LeafVoter.allocations(tokenId, gauge) over LeafVoter.allocatedGauges(tokenId).
// Leaf allocations come only from root dispatch (local voting is off), so the tokens to
// read on chain c are the ones whose root allocationChainIds include c, plus every token
// already seen on c (covers a deallocation still in flight).
import { allocationAbi } from "./abis.mjs";
import { multicallAt } from "./client.mjs";

const CHUNK = 2000;
const at = (address, functionName, args) => ({ address, abi: allocationAbi, functionName, args });

/** Map tokenId (string) -> chainIds (number[]) from the root Voter, at `block`. */
export async function readRootTokenChains(client, rootFile, block) {
  const ve = rootFile.addresses.votingEscrow;
  const voter = rootFile.addresses.voter;
  const [n] = await multicallAt(client, block, [at(ve, "totalSupply")]);
  const ids = await multicallAt(client, block, Array.from({ length: Number(n) }, (_, i) => at(ve, "tokenByIndex", [BigInt(i)])), CHUNK);
  const chains = await multicallAt(client, block, ids.map((id) => at(voter, "allocationChainIds", [id])), CHUNK);
  return new Map(ids.map((id, i) => [id.toString(), chains[i].map(Number)]));
}

/**
 * Booked allocations on one leaf chain at `block`.
 * @returns Map `${tokenId}:${gauge}` -> allocated (decimal string), only allocated > 0
 */
export async function readLeafAllocations(client, leafVoter, block, tokenIds) {
  const ids = [...tokenIds];
  const gauges = await multicallAt(client, block, ids.map((id) => at(leafVoter, "allocatedGauges", [BigInt(id)])), CHUNK);
  const legs = ids.flatMap((id, i) => gauges[i].map((g) => ({ id, gauge: g.toLowerCase() })));
  const amounts = await multicallAt(client, block, legs.map((l) => at(leafVoter, "allocations", [BigInt(l.id), l.gauge])), CHUNK);
  const out = new Map();
  legs.forEach((l, i) => {
    if (amounts[i] > 0n) out.set(`${l.id}:${l.gauge}`, amounts[i].toString());
  });
  return out;
}

export { allocationRows, allocatorCounts, gaugeAllocationStats, replayAllocations } from "../../lib/data/aero-v3/tape/allocations.mjs";
