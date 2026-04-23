import { CryptoPool, type EvmChainId, type PoolPrice } from "generated";
import { getPoolState } from "../effects.js";
import { tokenId } from "../constants.js";
import {
  computePricing,
  computeTvlUsd,
  pairIdForSwap,
} from "../pricing.js";

CryptoPool.TokenExchange.handler(async ({ event, context }) => {
  const chainId = event.chainId;
  const poolId = `${chainId}_${event.srcAddress.toLowerCase()}`;
  const pool = await context.Pool.get(poolId);
  if (!pool) {
    context.log.warn(`Pool ${poolId} not found — skipping swap`);
    return;
  }

  const address = event.srcAddress;
  const { balances, lastPrices, priceScales } = await getPoolState(context, {
    chainId: chainId as EvmChainId,
    address,
    nCoins: pool.nCoins,
    blockNumber: event.block.number,
  });

  const soldIdx = Number(event.params.sold_id);
  const boughtIdx = Number(event.params.bought_id);

  const pairId = pairIdForSwap(pool, soldIdx, boughtIdx);
  const pair = await context.PoolPair.get(pairId);
  if (!pair) {
    context.log.warn(`PoolPair ${pairId} not found — skipping pricing`);
    return;
  }

  const [mainToken, referenceToken] = await Promise.all([
    context.Token.get(pair.mainToken_id),
    context.Token.get(pair.referenceToken_id),
  ]);
  if (!mainToken || !referenceToken) {
    context.log.warn(`Missing Token entity for pair ${pairId} — skipping`);
    return;
  }

  const soldAddr = pool.coinAddresses[soldIdx]!;
  const boughtAddr = pool.coinAddresses[boughtIdx]!;
  const soldToken =
    soldAddr === mainToken.address
      ? mainToken
      : soldAddr === referenceToken.address
        ? referenceToken
        : await context.Token.get(tokenId(chainId, soldAddr));
  const boughtToken =
    boughtAddr === mainToken.address
      ? mainToken
      : boughtAddr === referenceToken.address
        ? referenceToken
        : await context.Token.get(tokenId(chainId, boughtAddr));
  if (!soldToken || !boughtToken) {
    context.log.warn(`Missing sold/bought Token for pool ${poolId}`);
    return;
  }

  const pricing = computePricing(
    chainId,
    pair,
    { main: mainToken, reference: referenceToken, sold: soldToken, bought: boughtToken },
    soldIdx,
    boughtIdx,
    event.params.tokens_sold,
    event.params.tokens_bought,
    event.params.fee,
    event.block,
  );

  for (const updated of pricing.tokenUpdates) {
    context.Token.set(updated);
  }

  const isRelevant =
    pricing.usdMainVolume !== undefined ||
    pricing.usdReferenceVolume !== undefined;

  const poolPrice: PoolPrice = {
    id: `${chainId}_${event.block.number}_${event.logIndex}`,
    chainId,
    pool_id: poolId,
    poolPair_id: pair.id,
    priceType: "TOKEN_EXCHANGE",
    soldId: soldIdx,
    boughtId: boughtIdx,
    tokensSold: pricing.tokensSoldDecimal,
    tokensBought: pricing.tokensBoughtDecimal,
    price: pricing.price,
    blockNumber: event.block.number,
    timestamp: BigInt(event.block.timestamp),
    txHash: event.transaction.hash,
    logIndex: event.logIndex,
    isRelevant,
    buyer: event.params.buyer,
    fee: pricing.feeDecimal,
    usdMainPrice: pricing.usdMainPrice,
    usdMainVolume: pricing.usdMainVolume,
    usdReferencePrice: pricing.usdReferencePrice,
    usdReferenceVolume: pricing.usdReferenceVolume,
    usdFee: pricing.usdFee,
  };
  context.PoolPrice.set(poolPrice);

  // Refresh Pool with new balances / price state and recompute TVL.
  const allTokens = await Promise.all(
    pool.coinAddresses.map((addr) => context.Token.get(tokenId(chainId, addr))),
  );
  const tvlUsd = computeTvlUsd(
    { ...pool, balances },
    allTokens,
  );

  context.Pool.set({
    ...pool,
    lastPrices,
    priceScales,
    balances,
    totalSwapCount: pool.totalSwapCount + 1n,
    tvlUsd,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

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
