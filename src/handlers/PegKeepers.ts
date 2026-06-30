import { BigDecimal, indexer } from "envio";
import { getCrvUsdPegPrice } from "../effects";

// crvUSD PegKeepers (v2). Each keeper provides crvUSD into its stable pool when
// crvUSD trades above peg and withdraws below; `debt` (net provided) is a direct
// peg-pressure signal. Provide/Withdraw actions are stamped with the live crvUSD
// price read from the PriceAggregator at that block.

const PEG_KEEPERS: Record<string, string> = {
  "0x9201da0d97caaaff53f01b2fb56767c7072de340": "USDC",
  "0xfb726f57d251ab5c731e5c64ed4f5f94351ef9f3": "USDT",
  "0x3fa20eaa107de08b38a8734063d605d5842fe09c": "pyUSD",
  "0x338cb2d827112d989a861cde87cd9ffd913a1f9d": "frxUSD",
  "0x53876b157decf04389eed66c7c29d73863f8c50b": "GHO",
};

const E18 = new BigDecimal("1000000000000000000");

async function ensurePegKeeper(
  context: any,
  chainId: number,
  address: string,
  block: { number: number; timestamp: number },
): Promise<any> {
  const id = `${chainId}_${address}`;
  const existing = await context.PegKeeper.get(id);
  if (existing) return existing;
  const created = {
    id,
    chainId,
    address,
    stablecoin: PEG_KEEPERS[address] ?? "?",
    debt: 0n,
    totalProvided: 0n,
    totalWithdrawn: 0n,
    totalProfit: 0n,
    actionCount: 0,
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  };
  context.PegKeeper.set(created);
  return created;
}

async function pegPriceAt(
  context: any,
  chainId: number,
  blockNumber: number,
): Promise<BigDecimal | undefined> {
  const raw = await context.effect(getCrvUsdPegPrice, { chainId, blockNumber });
  return raw && raw !== "0" ? new BigDecimal(raw).div(E18) : undefined;
}

async function recordAction(
  context: any,
  event: any,
  pk: any,
  kind: string,
  amount: bigint,
  pegPrice: BigDecimal | undefined,
): Promise<void> {
  context.PegKeeperAction.set({
    id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
    chainId: event.chainId,
    pegKeeper_id: pk.id,
    kind,
    amount,
    pegPrice,
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
  });
}

indexer.onEvent(
  { contract: "PegKeeper", event: "Provide" },
  async ({ event, context }) => {
    const addr = event.srcAddress.toLowerCase();
    const pk = await ensurePegKeeper(context, event.chainId, addr, event.block);
    const price = await pegPriceAt(context, event.chainId, event.block.number);
    await recordAction(context, event, pk, "PROVIDE", event.params.amount, price);
    context.PegKeeper.set({
      ...pk,
      debt: pk.debt + event.params.amount,
      totalProvided: pk.totalProvided + event.params.amount,
      actionCount: pk.actionCount + 1,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "PegKeeper", event: "Withdraw" },
  async ({ event, context }) => {
    const addr = event.srcAddress.toLowerCase();
    const pk = await ensurePegKeeper(context, event.chainId, addr, event.block);
    const price = await pegPriceAt(context, event.chainId, event.block.number);
    await recordAction(context, event, pk, "WITHDRAW", event.params.amount, price);
    const debt = pk.debt - event.params.amount;
    context.PegKeeper.set({
      ...pk,
      debt: debt > 0n ? debt : 0n,
      totalWithdrawn: pk.totalWithdrawn + event.params.amount,
      actionCount: pk.actionCount + 1,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "PegKeeper", event: "Profit" },
  async ({ event, context }) => {
    const addr = event.srcAddress.toLowerCase();
    const pk = await ensurePegKeeper(context, event.chainId, addr, event.block);
    await recordAction(context, event, pk, "PROFIT", event.params.lp_amount, undefined);
    context.PegKeeper.set({
      ...pk,
      totalProfit: pk.totalProfit + event.params.lp_amount,
      actionCount: pk.actionCount + 1,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);
