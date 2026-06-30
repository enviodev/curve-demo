import { indexer } from "envio";

// veCRV vote-escrow locks + FeeDistributor protocol revenue (the fees paid out
// to veCRV lockers each week — 3CRV historically, crvUSD since 2024).

const FEE_TOKEN: Record<string, string> = {
  "0xa464e6dcda8ac41e03616f95f4bc98a13b8922dc": "3CRV",
  "0xd16d5ec345dd86fb63c6a9c43c517210f1027914": "crvUSD",
};

async function ensureVeCrvState(
  context: any,
  chainId: number,
  block: { number: number; timestamp: number },
): Promise<any> {
  const id = `${chainId}`;
  const existing = await context.VeCrvState.get(id);
  if (existing) return existing;
  const created = {
    id,
    chainId,
    totalLocked: 0n,
    lockCount: 0,
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  };
  context.VeCrvState.set(created);
  return created;
}

indexer.onEvent(
  { contract: "VotingEscrow", event: "Deposit" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const user = event.params.provider.toLowerCase();
    const id = `${chainId}_${user}`;
    const existing = await context.Lock.get(id);
    const isNew = !existing || !existing.isActive;
    const prevUnlock = existing?.unlockTime ?? 0n;
    context.Lock.set({
      id,
      chainId,
      user,
      lockedAmount: (existing?.lockedAmount ?? 0n) + event.params.value,
      unlockTime:
        event.params.locktime > prevUnlock ? event.params.locktime : prevUnlock,
      isActive: true,
      createdBlock: existing?.createdBlock ?? event.block.number,
      createdTimestamp: existing?.createdTimestamp ?? BigInt(event.block.timestamp),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
    if (isNew) {
      const s = await ensureVeCrvState(context, chainId, event.block);
      context.VeCrvState.set({
        ...s,
        lockCount: s.lockCount + 1,
        lastUpdatedBlock: event.block.number,
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  },
);

indexer.onEvent(
  { contract: "VotingEscrow", event: "Withdraw" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const user = event.params.provider.toLowerCase();
    const id = `${chainId}_${user}`;
    const existing = await context.Lock.get(id);
    if (!existing) return;
    context.Lock.set({
      ...existing,
      lockedAmount: 0n,
      isActive: false,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
    if (existing.isActive) {
      const s = await ensureVeCrvState(context, chainId, event.block);
      context.VeCrvState.set({
        ...s,
        lockCount: s.lockCount > 0 ? s.lockCount - 1 : 0,
        lastUpdatedBlock: event.block.number,
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  },
);

indexer.onEvent(
  { contract: "VotingEscrow", event: "Supply" },
  async ({ event, context }) => {
    const s = await ensureVeCrvState(context, event.chainId, event.block);
    context.VeCrvState.set({
      ...s,
      totalLocked: event.params.supply,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "FeeDistributor", event: "CheckpointToken" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dist = event.srcAddress.toLowerCase();
    context.FeeDistribution.set({
      id: `${chainId}_${event.block.number}_${event.logIndex}`,
      chainId,
      distributor: dist,
      token: FEE_TOKEN[dist] ?? "?",
      weekTime: event.params.time,
      tokens: event.params.tokens,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "FeeDistributor", event: "Claimed" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const dist = event.srcAddress.toLowerCase();
    context.FeeClaim.set({
      id: `${chainId}_${event.block.number}_${event.logIndex}`,
      chainId,
      distributor: dist,
      recipient: event.params.recipient.toLowerCase(),
      amount: event.params.amount,
      epoch: event.params.claim_epoch,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);
