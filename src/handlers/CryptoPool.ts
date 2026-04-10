import { CryptoPool, type EvmChainId } from "generated";
import { getPoolState } from "../effects.js";

CryptoPool.TokenExchange.handler(async ({ event, context }) => {
  const chainId = event.chainId;
  const poolId = `${chainId}_${event.srcAddress}`;
  const pool = await context.Pool.get(poolId);
  if (!pool) {
    context.log.warn(`Pool ${poolId} not found — skipping swap`);
    return;
  }

  const address = event.srcAddress;

  // Single effect fetches balances, last_prices, and price_scale for all coins
  const { balances, lastPrices, priceScales } = await getPoolState(context, {
    chainId: chainId as EvmChainId,
    address,
    nCoins: pool.nCoins,
    blockNumber: event.block.number,
  });

  const soldIdx = Number(event.params.sold_id);
  const boughtIdx = Number(event.params.bought_id);

  context.Swap.set({
    id: `${chainId}_${event.block.number}_${event.logIndex}`,
    pool_id: poolId,
    buyer: event.params.buyer,
    soldTokenIndex: soldIdx,
    soldTokenSymbol: pool.coinSymbols[soldIdx] ?? "???",
    soldAmount: event.params.tokens_sold,
    soldDecimals: pool.coinDecimals[soldIdx] ?? 18,
    boughtTokenIndex: boughtIdx,
    boughtTokenSymbol: pool.coinSymbols[boughtIdx] ?? "???",
    boughtAmount: event.params.tokens_bought,
    boughtDecimals: pool.coinDecimals[boughtIdx] ?? 18,
    fee: event.params.fee,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
    lastPrices,
    priceScales,
  });

  // Update Pool state
  context.Pool.set({
    ...pool,
    lastPrices,
    priceScales,
    balances,
    totalSwapCount: pool.totalSwapCount + 1n,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

  // Update GlobalState swap count
  const globalId = `${chainId}`;
  const global = await context.GlobalState.get(globalId);
  if (global) {
    context.GlobalState.set({
      ...global,
      totalSwaps: global.totalSwaps + 1n,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  }
});
