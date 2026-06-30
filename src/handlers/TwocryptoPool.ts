import { indexer, type EvmChainId, type Pool, type PoolPrice } from "envio";
import {
  getPoolState,
  getPoolCoins,
  getTokenSymbol,
  getTokenDecimals,
} from "../effects.js";
import { tokenId } from "../constants.js";
import {
  ZERO,
  computePricing,
  computeTvlUsd,
  ensureAllPoolPairs,
  ensureToken,
  pairIdForSwap,
} from "../pricing.js";

// Standalone 2-coin Curve crypto pool with donation features, not deployed
// by any tracked factory. Pool entity is initialized lazily on the first
// event we see, fetching coin metadata via RPC.
const N_COINS = 2;

type EventLike = {
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: { number: number; timestamp: number };
  transaction: { hash: string };
};

async function ensurePool(event: EventLike, context: any): Promise<Pool> {
  const chainId = event.chainId;
  const address = event.srcAddress;
  const poolId = `${chainId}_${address.toLowerCase()}`;

  const existing = await context.Pool.get(poolId);
  if (existing) return existing;

  const coins = (await context.effect(getPoolCoins, {
    chainId,
    address,
    nCoins: N_COINS,
  })) as string[];

  const [symbols, decimals, poolSymbol] = await Promise.all([
    Promise.all(
      coins.map((c) => context.effect(getTokenSymbol, { chainId, address: c })),
    ),
    Promise.all(
      coins.map((c) => context.effect(getTokenDecimals, { chainId, address: c })),
    ),
    context.effect(getTokenSymbol, { chainId, address }) as Promise<string>,
  ]);

  for (let i = 0; i < N_COINS; i++) {
    await ensureToken(
      context,
      chainId,
      coins[i]!,
      symbols[i]!,
      decimals[i]!,
      event.block,
    );
  }

  const pool: Pool = {
    id: poolId,
    chainId,
    address: address.toLowerCase(),
    lpTokenAddress: address.toLowerCase(),
    symbol: poolSymbol,
    name: poolSymbol,
    poolType: "TWOCRYPTO_STANDALONE",
    registry_id: undefined,
    nCoins: N_COINS,
    coinAddresses: coins.map((c) => c.toLowerCase()),
    coinSymbols: symbols,
    coinDecimals: decimals,
    lastPrices: Array(N_COINS - 1).fill(0n),
    priceScales: Array(N_COINS - 1).fill(0n),
    balances: Array(N_COINS).fill(0n),
    totalSwapCount: 0n,
    totalVolumeUsd: ZERO,
    tvlUsd: undefined,
    hasDonations: true,
    isActive: true,
    deploymentBlock: event.block.number,
    deploymentTimestamp: BigInt(event.block.timestamp),
    deploymentTxHash: event.transaction.hash,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  };
  context.Pool.set(pool);
  await ensureAllPoolPairs(context, pool);

  const globalId = `${chainId}`;
  const global = await context.GlobalState.get(globalId);
  context.GlobalState.set({
    id: globalId,
    chainId,
    totalPools: (global?.totalPools ?? 0) + 1,
    totalSwaps: global?.totalSwaps ?? 0n,
    totalVolumeUsd: global?.totalVolumeUsd ?? ZERO,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

  return pool;
}

// Refresh balances + lastPrices + priceScales from RPC after any event that
// mutates pool state and write them back. Also recomputes TVL when possible.
async function refreshPoolState(
  event: EventLike,
  context: any,
  pool: Pool,
) {
  const { balances, lastPrices, priceScales } = await getPoolState(context, {
    chainId: event.chainId as EvmChainId,
    address: event.srcAddress,
    nCoins: pool.nCoins,
    blockNumber: event.block.number,
  });

  const allTokens = await Promise.all(
    pool.coinAddresses.map((addr) =>
      context.Token.get(tokenId(event.chainId, addr)),
    ),
  );
  const tvlUsd = computeTvlUsd({ ...pool, balances }, allTokens);

  context.Pool.set({
    ...pool,
    balances,
    lastPrices,
    priceScales,
    tvlUsd,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

  return { balances, lastPrices, priceScales };
}

// --- Swap event ---

indexer.onEvent(
  { contract: "TwocryptoPool", event: "TokenExchange" },
  async ({ event, context }) => {
  const pool = await ensurePool(event, context);
  const chainId = event.chainId;
  const poolId = pool.id;

  const { balances, lastPrices, priceScales } = await getPoolState(context, {
    chainId: chainId as EvmChainId,
    address: event.srcAddress,
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
    context.log.warn(`Missing Token entity for pair ${pairId}`);
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
  if (!soldToken || !boughtToken) return;

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
    isRelevant:
      pricing.usdMainVolume !== undefined ||
      pricing.usdReferenceVolume !== undefined,
    buyer: event.params.buyer,
    fee: pricing.feeDecimal,
    usdMainPrice: pricing.usdMainPrice,
    usdMainVolume: pricing.usdMainVolume,
    usdReferencePrice: pricing.usdReferencePrice,
    usdReferenceVolume: pricing.usdReferenceVolume,
    usdFee: pricing.usdFee,
  };
  context.PoolPrice.set(poolPrice);

  const allTokens = await Promise.all(
    pool.coinAddresses.map((addr) => context.Token.get(tokenId(chainId, addr))),
  );
  const tvlUsd = computeTvlUsd({ ...pool, balances }, allTokens);

  const swapVolume = pricing.usdVolume ?? ZERO;

  context.Pool.set({
    ...pool,
    lastPrices,
    priceScales,
    balances,
    totalSwapCount: pool.totalSwapCount + 1n,
    totalVolumeUsd: pool.totalVolumeUsd.plus(swapVolume),
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
      totalVolumeUsd: global.totalVolumeUsd.plus(swapVolume),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  }
});

// --- Liquidity events ---
//
// All five liquidity-mutating events fan into a single LiquidityEvent entity
// (discriminated by `kind`) and trigger a pool state refresh from RPC.

function liquidityEventId(event: EventLike) {
  return `${event.chainId}_${event.block.number}_${event.logIndex}`;
}

indexer.onEvent(
  { contract: "TwocryptoPool", event: "AddLiquidity" },
  async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: pool.id,
    kind: "ADD",
    provider: event.params.provider,
    tokenAmounts: [...event.params.token_amounts],
    lpSupply: event.params.token_supply,
    lpBurned: undefined,
    coinIndex: undefined,
    fee: event.params.fee,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  await refreshPoolState(event, context, pool);
});

indexer.onEvent(
  { contract: "TwocryptoPool", event: "Donation" },
  async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: pool.id,
    kind: "DONATION",
    provider: event.params.donor,
    tokenAmounts: [...event.params.token_amounts],
    lpSupply: undefined,
    lpBurned: undefined,
    coinIndex: undefined,
    fee: undefined,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  await refreshPoolState(event, context, pool);
});

indexer.onEvent(
  { contract: "TwocryptoPool", event: "RemoveLiquidity" },
  async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: pool.id,
    kind: "REMOVE",
    provider: event.params.provider,
    tokenAmounts: [...event.params.token_amounts],
    lpSupply: event.params.token_supply,
    lpBurned: undefined,
    coinIndex: undefined,
    fee: undefined,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  await refreshPoolState(event, context, pool);
});

indexer.onEvent(
  { contract: "TwocryptoPool", event: "RemoveLiquidityOne" },
  async ({ event, context }) => {
  const pool = await ensurePool(event, context);
  const coinIndex = Number(event.params.coin_index);

  // Inflate the single-coin amount into a length-nCoins array so the entity
  // shape matches the multi-coin events.
  const tokenAmounts = Array(pool.nCoins).fill(0n) as bigint[];
  tokenAmounts[coinIndex] = event.params.coin_amount;

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: pool.id,
    kind: "REMOVE_ONE",
    provider: event.params.provider,
    tokenAmounts,
    lpSupply: undefined,
    lpBurned: event.params.token_amount,
    coinIndex,
    fee: event.params.approx_fee,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  await refreshPoolState(event, context, pool);
});

indexer.onEvent(
  { contract: "TwocryptoPool", event: "RemoveLiquidityImbalance" },
  async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: pool.id,
    kind: "REMOVE_IMBALANCE",
    provider: event.params.provider,
    tokenAmounts: [...event.params.token_amounts],
    lpSupply: undefined,
    lpBurned: event.params.lp_token_amount,
    coinIndex: undefined,
    fee: event.params.approx_fee,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });

  await refreshPoolState(event, context, pool);
});
