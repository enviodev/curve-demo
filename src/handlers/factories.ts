import {
  TricryptoFactoryNG,
  TwocryptoFactoryNG,
  TwocryptoFactoryV1,
  type Pool,
} from "generated";
import { getTokenSymbol, getTokenDecimals } from "../effects.js";
import { ZERO, ensureAllPoolPairs, ensureToken } from "../pricing.js";

type CreatePoolArgs = {
  chainId: number;
  poolAddress: string;
  lpTokenAddress: string;
  coins: readonly string[];
  symbol: string;
  name: string;
  poolType: Pool["poolType"];
  hasDonations: boolean;
  block: { number: number; timestamp: number };
  txHash: string;
};

async function createPool(context: any, args: CreatePoolArgs) {
  const { chainId, poolAddress, coins, block } = args;
  const poolId = `${chainId}_${poolAddress.toLowerCase()}`;
  const nCoins = coins.length;

  const [symbols, decimals] = await Promise.all([
    Promise.all(
      coins.map((c) =>
        context.effect(getTokenSymbol, { chainId, address: c }) as Promise<string>,
      ),
    ),
    Promise.all(
      coins.map((c) =>
        context.effect(getTokenDecimals, { chainId, address: c }) as Promise<number>,
      ),
    ),
  ]);

  // Materialise Token entities for every coin so downstream handlers can
  // price them.
  for (let i = 0; i < nCoins; i++) {
    await ensureToken(context, chainId, coins[i]!, symbols[i]!, decimals[i]!, block);
  }

  const pool: Pool = {
    id: poolId,
    chainId,
    address: poolAddress.toLowerCase(),
    lpTokenAddress: args.lpTokenAddress.toLowerCase(),
    symbol: args.symbol,
    name: args.name,
    poolType: args.poolType,
    registry_id: undefined,
    nCoins,
    coinAddresses: coins.map((c) => c.toLowerCase()),
    coinSymbols: symbols,
    coinDecimals: decimals,
    lastPrices: Array(nCoins - 1).fill(0n),
    priceScales: Array(nCoins - 1).fill(0n),
    balances: Array(nCoins).fill(0n),
    totalSwapCount: 0n,
    totalVolumeUsd: ZERO,
    tvlUsd: undefined,
    hasDonations: args.hasDonations,
    isActive: true,
    deploymentBlock: block.number,
    deploymentTimestamp: BigInt(block.timestamp),
    deploymentTxHash: args.txHash,
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  };
  context.Pool.set(pool);

  await ensureAllPoolPairs(context, pool);

  // Update GlobalState
  const globalId = `${chainId}`;
  const existing = await context.GlobalState.get(globalId);
  context.GlobalState.set({
    id: globalId,
    chainId,
    totalPools: (existing?.totalPools ?? 0) + 1,
    totalSwaps: existing?.totalSwaps ?? 0n,
    totalVolumeUsd: existing?.totalVolumeUsd ?? ZERO,
    lastUpdatedBlock: block.number,
    lastUpdatedTimestamp: BigInt(block.timestamp),
  });
}

// --- Tricrypto Factory NG (3-coin pools) ---

TricryptoFactoryNG.TricryptoPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addCryptoPool(event.params.pool);
  },
);

TricryptoFactoryNG.TricryptoPoolDeployed.handler(async ({ event, context }) => {
  await createPool(context, {
    chainId: event.chainId,
    poolAddress: event.params.pool,
    lpTokenAddress: event.params.pool, // NG pools: pool contract is the LP token
    coins: event.params.coins,
    symbol: event.params.symbol,
    name: event.params.name,
    poolType: "TRICRYPTO_NG",
    hasDonations: false,
    block: event.block,
    txHash: event.transaction.hash,
  });
});

// --- Twocrypto Factory NG (2-coin pools) ---

TwocryptoFactoryNG.TwocryptoPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addCryptoPool(event.params.pool);
  },
);

TwocryptoFactoryNG.TwocryptoPoolDeployed.handler(async ({ event, context }) => {
  await createPool(context, {
    chainId: event.chainId,
    poolAddress: event.params.pool,
    lpTokenAddress: event.params.pool,
    coins: event.params.coins,
    symbol: event.params.symbol,
    name: event.params.name,
    poolType: "TWOCRYPTO_NG",
    hasDonations: false,
    block: event.block,
    txHash: event.transaction.hash,
  });
});

// --- Twocrypto Factory V1 (2-coin pools, older) ---
//
// The V1 factory's deploy event only carries the LP token address (the pool
// and LP token share the same contract). No name/symbol in the event, so we
// fetch the ERC20 symbol via RPC and reuse it as the pool name.

TwocryptoFactoryV1.CryptoPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addCryptoPool(event.params.token);
  },
);

TwocryptoFactoryV1.CryptoPoolDeployed.handler(async ({ event, context }) => {
  const symbol = (await context.effect(getTokenSymbol, {
    chainId: event.chainId,
    address: event.params.token,
  })) as string;

  await createPool(context, {
    chainId: event.chainId,
    poolAddress: event.params.token,
    lpTokenAddress: event.params.token,
    coins: event.params.coins,
    symbol,
    name: symbol,
    poolType: "CRYPTO_V1",
    hasDonations: false,
    block: event.block,
    txHash: event.transaction.hash,
  });
});
