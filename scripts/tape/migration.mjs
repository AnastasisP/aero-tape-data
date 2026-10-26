// v2 -> v3 migration progress (goal §5c, A33), read on the root chain only. Migration
// (metadex-public V3/src/migration/Migration.sol): depositVeNFT adds the v2 lock amount to
// paidBasis (L125) and merges the v2 veNFT into MIGRATION_TOKEN_ID on the v2 escrow (L130);
// depositLiquid adds to paidBasis too (L160). So the v2 AERO still locked outside the
// migration pile = V2_ESCROW.supply() - locked(MIGRATION_TOKEN_ID).amount.
import { parseAbi } from "viem";
import { multicallAt } from "./client.mjs";
import { ser } from "./snapshot.mjs";

const migrationAbi = parseAbi([
  "function paidBasis() view returns (uint256)",
  "function MIGRATION_TOKEN_ID() view returns (uint256)",
  "function V2_ESCROW() view returns (address)",
]);
// v2 LockedBalance has three fields (the isPermanent gap, memory aero-locked-abi-ispermanent-gap)
const v2EscrowAbi = parseAbi([
  "function supply() view returns (uint256)",
  "struct LockedBalance { int128 amount; uint256 end; bool isPermanent; }",
  "function locked(uint256) view returns (LockedBalance)",
]);

/**
 * migration-state record of one root-chain hour; [] on leaf chains or a root without a
 * migration contract in the registry.
 */
export async function readMigrationState(client, files, chain, block, prov) {
  if (chain.role !== "root") return [];
  const migration = files[`migration-${chain.slug}.json`]?.addresses.aerodromeMigration;
  if (!migration) return [];
  const [paidBasis, tokenId, v2Escrow] = await multicallAt(client, block, ["paidBasis", "MIGRATION_TOKEN_ID", "V2_ESCROW"].map((functionName) => ({ address: migration, abi: migrationAbi, functionName })));
  const [v2Supply, pile] = await multicallAt(client, block, [
    { address: v2Escrow, abi: v2EscrowAbi, functionName: "supply" },
    { address: v2Escrow, abi: v2EscrowAbi, functionName: "locked", args: [tokenId] },
  ]);
  return [
    ser({
      ...prov,
      metric: "migration-state",
      migration: migration.toLowerCase(),
      v2Escrow: v2Escrow.toLowerCase(),
      migrationTokenId: tokenId,
      paidBasis,
      migratedLocked: pile.amount,
      v2Supply,
    }),
  ];
}
