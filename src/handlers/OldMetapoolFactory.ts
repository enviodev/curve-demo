import { indexer, type Pool } from "envio";
import {
  OLD_METAPOOL_FACTORY,
  resolveLatestStablePool,
  resolveOldFactoryPoolEffect,
  getOldFactoryPoolMeta,
  getStablePoolState,
  getTokenSymbol,
} from "../effects.js";
import { ZERO, ensureToken } from "../pricing.js";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

// Curve's OLD stableswap metapool factory (pre-NG). Its PlainPoolDeployed /
// MetaPoolDeployed events carry NO pool address, so — exactly like the NG
// factory — the just-deployed pool is resolved via pool_list(pool_count()-1) at
// the deploy block. These are LEGACY int128-TokenExchange pools, identical on
// the wire to the registry-listed legacy pools, so we register them as
// `LegacyStablePool` and the existing LegacyStableswap TokenExchange handler
// indexes their swaps (it early-returns once the Pool entity exists, so it never
// falls back to the mainnet-only Main Registry for these factory pools).

type Block = { number: number; timestamp: number };

// --- Dynamic registration ---------------------------------------------------

async function registerLatest({ event, context }: any) {
  const factory = OLD_METAPOOL_FACTORY[event.chainId];
  if (!factory) return;
  const pool = await resolveLatestStablePool(
    event.chainId,
    factory,
    event.block.number,
  );
  if (pool && pool !== ZERO_ADDR) context.chain.LegacyStablePool.add(pool);
}

indexer.contractRegister(
  { contract: "MetapoolFactory", event: "PlainPoolDeployed" },
  registerLatest,
);
indexer.contractRegister(
  { contract: "MetapoolFactory", event: "MetaPoolDeployed" },
  registerLatest,
);

// --- Pool entity creation ---------------------------------------------------

// Create (or fetch) the Pool entity for an old-factory pool. Called at deploy
// time so every pool appears immediately, even before its first trade.
async function ensureOldFactoryPool(
  chainId: number,
  address: string,
  block: Block,
  context: any,
): Promise<Pool | undefined> {
  const poolId = `${chainId}_${address.toLowerCase()}`;
  const existing = await context.Pool.get(poolId);
  if (existing) return existing;

  const meta = await context.effect(getOldFactoryPoolMeta, { chainId, address });
  const nCoins = meta.coins.length;
  if (nCoins === 0) return undefined; // not a resolvable factory pool

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
    lpTokenAddress: address.toLowerCase(), // factory pool is its own LP token
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
  const addr = await context.effect(resolveOldFactoryPoolEffect, {
    chainId: event.chainId,
    blockNumber: event.block.number,
  });
  if (!addr) return;
  await ensureOldFactoryPool(event.chainId, addr, event.block, context);
}

indexer.onEvent(
  { contract: "MetapoolFactory", event: "PlainPoolDeployed" },
  handleDeploy,
);
indexer.onEvent(
  { contract: "MetapoolFactory", event: "MetaPoolDeployed" },
  handleDeploy,
);
