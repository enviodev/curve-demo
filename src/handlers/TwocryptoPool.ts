import { TwocryptoPool, type EvmChainId } from "generated";
import {
  getPoolState,
  getPoolCoins,
  getTokenSymbol,
  getTokenDecimals,
} from "../effects.js";

// This contract is a standalone 2-coin Curve crypto pool with donation
// features. It is not deployed by any of the tracked factories, so the Pool
// entity must be initialized lazily on the first event we see, fetching coin
// metadata via RPC instead of from a deployment event.
const N_COINS = 2;

type EventLike = {
  chainId: number;
  srcAddress: string;
  block: { number: number; timestamp: number };
};

async function ensurePool(event: EventLike, context: any) {
  const chainId = event.chainId;
  const address = event.srcAddress;
  const poolId = `${chainId}_${address}`;

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
      coins.map((c) =>
        context.effect(getTokenDecimals, { chainId, address: c }),
      ),
    ),
  ]);

  const pool = {
    id: poolId,
    nCoins: N_COINS,
    coinAddresses: coins,
    coinSymbols: symbols,
    coinDecimals: decimals,
    lastPrices: Array(N_COINS - 1).fill(0n) as bigint[],
    priceScales: Array(N_COINS - 1).fill(0n) as bigint[],
    balances: Array(N_COINS).fill(0n) as bigint[],
    totalSwapCount: 0n,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  };
  context.Pool.set(pool);

  // Bump GlobalState pool count
  const globalId = `${chainId}`;
  const global = await context.GlobalState.get(globalId);
  context.GlobalState.set({
    id: globalId,
    chainId,
    totalPools: (global?.totalPools ?? 0) + 1,
    totalSwaps: global?.totalSwaps ?? 0n,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

  return pool;
}

// Refresh balances + lastPrices + priceScales from RPC after any event that
// mutates pool state (swap or liquidity action) and write them back to Pool.
async function refreshPoolState(
  event: EventLike,
  context: any,
  pool: { nCoins: number; totalSwapCount: bigint; [k: string]: unknown },
) {
  const { balances, lastPrices, priceScales } = await getPoolState(context, {
    chainId: event.chainId as EvmChainId,
    address: event.srcAddress,
    nCoins: pool.nCoins,
    blockNumber: event.block.number,
  });

  context.Pool.set({
    ...pool,
    balances,
    lastPrices,
    priceScales,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

  return { balances, lastPrices, priceScales };
}

// --- Swap event ---

TwocryptoPool.TokenExchange.handler(async ({ event, context }) => {
  const pool = await ensurePool(event, context);
  const chainId = event.chainId;
  const poolId = `${chainId}_${event.srcAddress}`;

  const { balances, lastPrices, priceScales } = await getPoolState(context, {
    chainId: chainId as EvmChainId,
    address: event.srcAddress,
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

  context.Pool.set({
    ...pool,
    lastPrices,
    priceScales,
    balances,
    totalSwapCount: pool.totalSwapCount + 1n,
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

// --- Liquidity events ---
//
// All five liquidity-mutating events fan into a single LiquidityEvent entity
// (discriminated by `kind`) and trigger a pool state refresh from RPC. We
// keep the same id format as Swap (chain_block_logIndex) so different event
// kinds emitted in the same tx never collide.

function liquidityEventId(event: EventLike & { logIndex: number }) {
  return `${event.chainId}_${event.block.number}_${event.logIndex}`;
}

TwocryptoPool.AddLiquidity.handler(async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: `${event.chainId}_${event.srcAddress}`,
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

TwocryptoPool.Donation.handler(async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: `${event.chainId}_${event.srcAddress}`,
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

TwocryptoPool.RemoveLiquidity.handler(async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: `${event.chainId}_${event.srcAddress}`,
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

TwocryptoPool.RemoveLiquidityOne.handler(async ({ event, context }) => {
  const pool = await ensurePool(event, context);
  const coinIndex = Number(event.params.coin_index);

  // Inflate the single-coin amount into a length-nCoins array so the entity
  // shape matches the multi-coin events.
  const tokenAmounts = Array(pool.nCoins).fill(0n) as bigint[];
  tokenAmounts[coinIndex] = event.params.coin_amount;

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: `${event.chainId}_${event.srcAddress}`,
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

TwocryptoPool.RemoveLiquidityImbalance.handler(async ({ event, context }) => {
  const pool = await ensurePool(event, context);

  context.LiquidityEvent.set({
    id: liquidityEventId(event),
    pool_id: `${event.chainId}_${event.srcAddress}`,
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
