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

// Legacy Curve tricrypto pool (e.g. tricrypto2 on mainnet, USDT/WBTC/WETH)
// deployed manually rather than via a factory. TokenExchange event has the
// old 5-field signature (no fee, no packed_price_scale). 3-coin pool;
// initialized lazily on the first event.
const N_COINS = 3;

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

  const [symbols, decimals] = await Promise.all([
    Promise.all(
      coins.map((c) => context.effect(getTokenSymbol, { chainId, address: c })),
    ),
    Promise.all(
      coins.map((c) => context.effect(getTokenDecimals, { chainId, address: c })),
    ),
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

  // Legacy tricrypto pools keep the LP token in a separate contract. We
  // don't track it here — leave lpTokenAddress = pool address as a
  // best-effort placeholder (downstream consumers who care can resolve
  // via `Pool.token()` RPC).
  const pool: Pool = {
    id: poolId,
    chainId,
    address: address.toLowerCase(),
    lpTokenAddress: address.toLowerCase(),
    symbol: "",
    name: "",
    poolType: "TRICRYPTO_LEGACY",
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
    hasDonations: false,
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

indexer.onEvent(
  { contract: "LegacyTricryptoPool", event: "TokenExchange" },
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
  if (!mainToken || !referenceToken) return;

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

  // Legacy event has no `fee` field, so pass undefined.
  const pricing = computePricing(
    chainId,
    pair,
    { main: mainToken, reference: referenceToken, sold: soldToken, bought: boughtToken },
    soldIdx,
    boughtIdx,
    event.params.tokens_sold,
    event.params.tokens_bought,
    undefined,
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
    fee: undefined,
    usdMainPrice: pricing.usdMainPrice,
    usdMainVolume: pricing.usdMainVolume,
    usdReferencePrice: pricing.usdReferencePrice,
    usdReferenceVolume: pricing.usdReferenceVolume,
    usdFee: undefined,
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
