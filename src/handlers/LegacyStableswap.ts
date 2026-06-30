import { indexer, BigDecimal, type Pool, type EvmChainId } from "envio";
import {
  getLegacyPoolMeta,
  getStablePoolState,
  getStablePoolStateCached,
  getTokenSymbol,
} from "../effects.js";
import { tokenId } from "../constants.js";
import {
  ZERO,
  ensureToken,
  toDecimal,
  computeTvlUsd,
  deriveAndApplySwapPrice,
  upsertDailySnapshot,
} from "../pricing.js";

// Legacy stableswap pools (3pool, sUSD, etc.) are listed in the Main Registry,
// whose PoolAdded event carries the pool address — so registration is direct
// (no pool_list resolution needed). Coins/decimals come from the registry;
// swaps share the int128 TokenExchange signature with Stableswap-NG.

type Block = { number: number; timestamp: number };

indexer.contractRegister(
  { contract: "MainRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    context.chain.LegacyStablePool.add(event.params.pool);
  },
);

async function ensureLegacyPool(
  chainId: number,
  address: string,
  block: Block,
  context: any,
): Promise<Pool | undefined> {
  const poolId = `${chainId}_${address.toLowerCase()}`;
  const existing = await context.Pool.get(poolId);
  if (existing) return existing;

  const meta = await context.effect(getLegacyPoolMeta, { chainId, address });
  const nCoins = meta.coins.length;
  if (nCoins === 0) return undefined;

  const symbols: string[] = await Promise.all(
    meta.coins.map((c: string) =>
      context.effect(getTokenSymbol, { chainId, address: c }),
    ),
  );
  for (let i = 0; i < nCoins; i++) {
    await ensureToken(
      context,
      chainId,
      meta.coins[i]!,
      symbols[i]!,
      meta.decimals[i]!,
      block,
    );
  }

  const state = await context.effect(getStablePoolState, {
    address,
    chainId,
    nCoins,
    blockNumber: block.number,
  });

  const pool: Pool = {
    id: poolId,
    chainId,
    address: address.toLowerCase(),
    lpTokenAddress: address.toLowerCase(),
    symbol: meta.symbol || symbols.join("/"),
    name: meta.name,
    poolType: "STABLESWAP",
    registry_id: undefined,
    nCoins,
    coinAddresses: meta.coins,
    coinSymbols: symbols,
    coinDecimals: meta.decimals,
    lastPrices: [],
    priceScales: [],
    a: state.a,
    virtualPrice: state.virtualPrice,
    isMetaPool: false,
    basePool: undefined,
    balances: state.balances,
    totalSwapCount: 0n,
    totalVolumeUsd: ZERO,
    tvlUsd: undefined,
    hasDonations: false,
    isActive: true,
    deploymentBlock: block.number,
    deploymentTimestamp: BigInt(block.timestamp),
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  };
  context.Pool.set(pool);

  const globalId = `${chainId}`;
  const global = await context.GlobalState.get(globalId);
  context.GlobalState.set({
    id: globalId,
    chainId,
    totalPools: (global?.totalPools ?? 0) + 1,
    totalSwaps: global?.totalSwaps ?? 0n,
    totalVolumeUsd: global?.totalVolumeUsd ?? ZERO,
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  });

  return pool;
}

// Create the pool entity as soon as the registry lists it.
indexer.onEvent(
  { contract: "MainRegistry", event: "PoolAdded" },
  async ({ event, context }) => {
    await ensureLegacyPool(
      event.chainId,
      event.params.pool,
      event.block,
      context,
    );
  },
);

indexer.onEvent(
  { contract: "LegacyStablePool", event: "TokenExchange" },
  async ({ event, context }) => {
    const pool = await ensureLegacyPool(
      event.chainId,
      event.srcAddress,
      event.block,
      context,
    );
    if (!pool) return;
    const chainId = event.chainId;

    const soldIdx = Number(event.params.sold_id);
    const boughtIdx = Number(event.params.bought_id);
    const soldAddr = pool.coinAddresses[soldIdx];
    const boughtAddr = pool.coinAddresses[boughtIdx];
    if (!soldAddr || !boughtAddr) return;

    const [soldTok, boughtTok] = await Promise.all([
      context.Token.get(tokenId(chainId, soldAddr)),
      context.Token.get(tokenId(chainId, boughtAddr)),
    ]);
    const soldDec = soldTok?.decimals ?? pool.coinDecimals[soldIdx] ?? 18;
    const boughtDec = boughtTok?.decimals ?? pool.coinDecimals[boughtIdx] ?? 18;
    const tokensSoldDecimal = toDecimal(event.params.tokens_sold, soldDec);
    const tokensBoughtDecimal = toDecimal(event.params.tokens_bought, boughtDec);

    let volumeUsd: BigDecimal | undefined;
    if (soldTok?.usdPrice !== undefined) {
      volumeUsd = tokensSoldDecimal.multipliedBy(soldTok.usdPrice);
    } else if (boughtTok?.usdPrice !== undefined) {
      volumeUsd = tokensBoughtDecimal.multipliedBy(boughtTok.usdPrice);
    }

    if (soldTok && boughtTok) {
      deriveAndApplySwapPrice(
        context,
        soldTok,
        boughtTok,
        tokensSoldDecimal,
        tokensBoughtDecimal,
        event.block,
      );
    }

    context.Swap.set({
      id: `${chainId}_${event.block.number}_${event.logIndex}`,
      chainId,
      pool_id: pool.id,
      buyer: event.params.buyer,
      soldId: soldIdx,
      boughtId: boughtIdx,
      tokensSold: event.params.tokens_sold,
      tokensBought: event.params.tokens_bought,
      tokensSoldDecimal,
      tokensBoughtDecimal,
      volumeUsd,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
      logIndex: event.logIndex,
    });

    // Refresh on-chain state and recompute TVL (cached once per pool in backfill).
    const state = await getStablePoolStateCached(context, {
      chainId: chainId as EvmChainId,
      address: event.srcAddress,
      nCoins: pool.nCoins,
      blockNumber: event.block.number,
    });
    const tokens = await Promise.all(
      pool.coinAddresses.map((addr) =>
        context.Token.get(tokenId(chainId, addr)),
      ),
    );
    const tvlUsd = computeTvlUsd({ ...pool, balances: state.balances }, tokens);
    const swapVol = volumeUsd ?? ZERO;
    const finalPool = {
      ...pool,
      balances: state.balances,
      a: state.a,
      virtualPrice: state.virtualPrice,
      tvlUsd,
      totalSwapCount: pool.totalSwapCount + 1n,
      totalVolumeUsd: pool.totalVolumeUsd.plus(swapVol),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    };
    context.Pool.set(finalPool);
    await upsertDailySnapshot(context, finalPool, event.block, swapVol, 1);

    const globalId = `${chainId}`;
    const global = await context.GlobalState.get(globalId);
    if (global) {
      context.GlobalState.set({
        ...global,
        totalSwaps: global.totalSwaps + 1n,
        totalVolumeUsd: global.totalVolumeUsd.plus(swapVol),
        lastUpdatedBlock: event.block.number,
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }
  },
);
