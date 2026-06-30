import { indexer } from "envio";

// scrvUSD savings vault (ERC4626): deposit crvUSD, earn borrower interest.
// Track aggregate supply (net assets/shares) + per-depositor positions. The
// implied savings rate is totalAssets/totalShares (price per share) over time.

async function ensureSavingsVault(
  context: any,
  chainId: number,
  address: string,
  block: { number: number; timestamp: number },
): Promise<any> {
  const id = `${chainId}_${address}`;
  const existing = await context.SavingsVault.get(id);
  if (existing) return existing;
  const created = {
    id,
    chainId,
    address,
    totalAssets: 0n,
    totalShares: 0n,
    depositorCount: 0,
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  };
  context.SavingsVault.set(created);
  return created;
}

indexer.onEvent(
  { contract: "ScrvUsdVault", event: "Deposit" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const vaultAddr = event.srcAddress.toLowerCase();
    const vault = await ensureSavingsVault(context, chainId, vaultAddr, event.block);
    const user = event.params.owner.toLowerCase();
    const posId = `${chainId}_${vaultAddr}_${user}`;
    const existing = await context.SavingsPosition.get(posId);
    const isNew = !existing || !existing.isActive;
    context.SavingsPosition.set({
      id: posId,
      chainId,
      vault_id: vault.id,
      user,
      shares: (existing?.shares ?? 0n) + event.params.shares,
      isActive: true,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
    context.SavingsVault.set({
      ...vault,
      totalAssets: vault.totalAssets + event.params.assets,
      totalShares: vault.totalShares + event.params.shares,
      depositorCount: vault.depositorCount + (isNew ? 1 : 0),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "ScrvUsdVault", event: "Withdraw" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const vaultAddr = event.srcAddress.toLowerCase();
    const vault = await ensureSavingsVault(context, chainId, vaultAddr, event.block);
    const user = event.params.owner.toLowerCase();
    const posId = `${chainId}_${vaultAddr}_${user}`;
    const existing = await context.SavingsPosition.get(posId);
    const newShares = (existing?.shares ?? 0n) - event.params.shares;
    const closing = newShares <= 0n;
    context.SavingsPosition.set({
      id: posId,
      chainId,
      vault_id: vault.id,
      user,
      shares: closing ? 0n : newShares,
      isActive: !closing,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
    const newAssets = vault.totalAssets - event.params.assets;
    const wasActive = existing?.isActive ?? false;
    context.SavingsVault.set({
      ...vault,
      totalAssets: newAssets > 0n ? newAssets : 0n,
      totalShares: vault.totalShares - event.params.shares,
      depositorCount: vault.depositorCount - (wasActive && closing ? 1 : 0),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);
