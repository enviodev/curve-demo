import { indexer, BigDecimal, type Pool } from "envio";
import {
  STABLE_NG_FACTORY,
  resolveLatestStablePool,
  resolveStablePoolEffect,
  getStablePoolMeta,
  getStablePoolState,
  getTokenSymbol,
} from "../effects.js";
import { tokenId } from "../constants.js";
import { ZERO, ensureToken, toDecimal, computeTvlUsd } from "../pricing.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// --- Dynamic registration ---------------------------------------------------
//
// PlainPoolDeployed / MetaPoolDeployed carry no pool address, so we resolve the
// just-deployed pool via pool_list(pool_count()-1) at the deploy block and
// register it so its swap/liquidity events get indexed.

async function registerLatest({ event, context }: any) {
  const factory = STABLE_NG_FACTORY[event.chainId];
  if (!factory) return;
  const pool = await resolveLatestStablePool(
    event.chainId,
    factory,
    event.block.number,
  );
  if (pool && pool !== ZERO_ADDR) context.chain.StableswapPool.add(pool);
}

indexer.contractRegister(
  { contract: "StableswapFactoryNG", event: "PlainPoolDeployed" },
  registerLatest,
);
indexer.contractRegister(
  { contract: "StableswapFactoryNG", event: "MetaPoolDeployed" },
  registerLatest,
);

// --- Pool entity creation ---------------------------------------------------

type Block = { number: number; timestamp: number };

// Create (or fetch) the Pool entity for an explicit pool address. Called both
// at deploy time (so every pool appears immediately, even before any trade)
// and lazily from swap/liquidity handlers as a safety net.
async function ensureStablePool(
  chainId: number,
  address: string,
  block: Block,
  txHash: string,
  context: any,
): Promise<Pool | undefined> {
  const poolId = `${chainId}_${address.toLowerCase()}`;
  const existing = await context.Pool.get(poolId);
  if (existing) return existing;

  const meta = await context.effect(getStablePoolMeta, { chainId, address });
  const nCoins = meta.coins.length;
  if (nCoins === 0) return undefined; // not a resolvable Curve pool

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
    lpTokenAddress: address.toLowerCase(), // NG pool is its own LP token
    symbol: meta.symbol,
    name: meta.name,
    poolType: meta.isMeta ? "STABLESWAP_NG_META" : "STABLESWAP_NG",
    registry_id: undefined,
    nCoins,
    coinAddresses: meta.coins,
    coinSymbols: symbols,
    coinDecimals: meta.decimals,
    lastPrices: [],
    priceScales: [],
    a: state.a,
    virtualPrice: state.virtualPrice,
    isMetaPool: meta.isMeta,
    basePool: undefined,
    balances: state.balances,
    totalSwapCount: 0n,
    totalVolumeUsd: ZERO,
    tvlUsd: undefined,
    hasDonations: false,
    isActive: true,
    deploymentBlock: block.number,
    deploymentTimestamp: BigInt(block.timestamp),
    deploymentTxHash: txHash,
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

// Deploy handlers — resolve the address-less deploy and create the Pool now.
async function handleDeploy({ event, context }: any) {
  const addr = await context.effect(resolveStablePoolEffect, {
    chainId: event.chainId,
    blockNumber: event.block.number,
  });
  if (!addr) return;
  await ensureStablePool(
    event.chainId,
    addr,
    event.block,
    event.transaction.hash,
    context,
  );
}

indexer.onEvent(
  { contract: "StableswapFactoryNG", event: "PlainPoolDeployed" },
  handleDeploy,
);
indexer.onEvent(
  { contract: "StableswapFactoryNG", event: "MetaPoolDeployed" },
  handleDeploy,
);

// --- Pool state refresh -----------------------------------------------------

type StableEvent = {
  chainId: number;
  srcAddress: string;
  logIndex: number;
  block: Block;
  transaction: { hash: string };
};

async function refreshStableState(
  event: StableEvent,
  context: any,
  pool: Pool,
): Promise<void> {
  const state = await context.effect(getStablePoolState, {
    address: event.srcAddress,
    chainId: event.chainId,
    nCoins: pool.nCoins,
    blockNumber: event.block.number,
  });
  const tokens = await Promise.all(
    pool.coinAddresses.map((addr) =>
      context.Token.get(tokenId(event.chainId, addr)),
    ),
  );
  const tvlUsd = computeTvlUsd({ ...pool, balances: state.balances }, tokens);
  context.Pool.set({
    ...pool,
    balances: state.balances,
    a: state.a,
    virtualPrice: state.virtualPrice,
    tvlUsd,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });
}

function liquidityEventId(event: StableEvent) {
  return `${event.chainId}_${event.block.number}_${event.logIndex}`;
}

// --- Swaps ------------------------------------------------------------------

indexer.onEvent(
  { contract: "StableswapPool", event: "TokenExchange" },
  async ({ event, context }) => {
    const pool = await ensureStablePool(
      event.chainId,
      event.srcAddress,
      event.block,
      event.transaction.hash,
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

    // Best-effort USD volume: value the priced side of the trade.
    let volumeUsd: BigDecimal | undefined;
    if (soldTok?.usdPrice !== undefined) {
      volumeUsd = tokensSoldDecimal.multipliedBy(soldTok.usdPrice);
    } else if (boughtTok?.usdPrice !== undefined) {
      volumeUsd = tokensBoughtDecimal.multipliedBy(boughtTok.usdPrice);
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
      txHash: event.transaction.hash,
      logIndex: event.logIndex,
    });

    await refreshStableState(event, context, pool);

    const updated = await context.Pool.get(pool.id);
    const swapVol = volumeUsd ?? ZERO;
    if (updated) {
      context.Pool.set({
        ...updated,
        totalSwapCount: updated.totalSwapCount + 1n,
        totalVolumeUsd: updated.totalVolumeUsd.plus(swapVol),
      });
    }

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

// --- Liquidity --------------------------------------------------------------

async function recordLiquidity(
  event: StableEvent,
  context: any,
  kind: "ADD" | "REMOVE" | "REMOVE_ONE" | "REMOVE_IMBALANCE",
  provider: string,
  tokenAmounts: bigint[],
  lpSupply: bigint | undefined,
  lpBurned: bigint | undefined,
  coinIndex: number | undefined,
) {
  const pool = await ensureStablePool(
    event.chainId,
    event.srcAddress,
    event.block,
    event.transaction.hash,
    context,
  );
  if (!pool) return;
  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: pool.id,
    kind,
    provider,
    tokenAmounts,
    lpSupply,
    lpBurned,
    coinIndex,
    fee: undefined,
    timestamp: BigInt(event.block.timestamp),
    blockNumber: event.block.number,
    txHash: event.transaction.hash,
  });
  await refreshStableState(event, context, pool);
}

indexer.onEvent(
  { contract: "StableswapPool", event: "AddLiquidity" },
  async ({ event, context }) => {
    await recordLiquidity(
      event,
      context,
      "ADD",
      event.params.provider,
      [...event.params.token_amounts],
      event.params.token_supply,
      undefined,
      undefined,
    );
  },
);

indexer.onEvent(
  { contract: "StableswapPool", event: "RemoveLiquidity" },
  async ({ event, context }) => {
    await recordLiquidity(
      event,
      context,
      "REMOVE",
      event.params.provider,
      [...event.params.token_amounts],
      event.params.token_supply,
      undefined,
      undefined,
    );
  },
);

indexer.onEvent(
  { contract: "StableswapPool", event: "RemoveLiquidityOne" },
  async ({ event, context }) => {
    const pool = await context.Pool.get(
      `${event.chainId}_${event.srcAddress.toLowerCase()}`,
    );
    const coinIndex = Number(event.params.token_id);
    const n = pool?.nCoins ?? coinIndex + 1;
    const tokenAmounts = Array(n).fill(0n) as bigint[];
    if (coinIndex >= 0 && coinIndex < n) {
      tokenAmounts[coinIndex] = event.params.coin_amount;
    }
    await recordLiquidity(
      event,
      context,
      "REMOVE_ONE",
      event.params.provider,
      tokenAmounts,
      event.params.token_supply,
      event.params.token_amount,
      coinIndex,
    );
  },
);

indexer.onEvent(
  { contract: "StableswapPool", event: "RemoveLiquidityImbalance" },
  async ({ event, context }) => {
    await recordLiquidity(
      event,
      context,
      "REMOVE_IMBALANCE",
      event.params.provider,
      [...event.params.token_amounts],
      event.params.token_supply,
      undefined,
      undefined,
    );
  },
);
