import {
  TricryptoFactoryNG,
  TwocryptoFactoryNG,
  TwocryptoFactoryV1,
} from "generated";
import { getTokenSymbol, getTokenDecimals } from "../effects.js";

async function createPool(
  event: { chainId: number; block: { number: number; timestamp: number }; params: { pool?: string; token?: string; coins: readonly string[] } },
  context: any,
  nCoins: number
) {
  const chainId = event.chainId;
  const poolAddress = (event.params as any).pool ?? (event.params as any).token;
  const coins = event.params.coins;

  const [symbols, decimals] = await Promise.all([
    Promise.all(coins.map((c) => context.effect(getTokenSymbol, { chainId, address: c }))),
    Promise.all(coins.map((c) => context.effect(getTokenDecimals, { chainId, address: c }))),
  ]);

  context.Pool.set({
    id: `${chainId}_${poolAddress}`,
    nCoins,
    coinAddresses: [...coins],
    coinSymbols: symbols,
    coinDecimals: decimals,
    lastPrices: Array(nCoins - 1).fill(0n),
    priceScales: Array(nCoins - 1).fill(0n),
    balances: Array(nCoins).fill(0n),
    totalSwapCount: 0n,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });

  // Update GlobalState
  const globalId = `${chainId}`;
  const existing = await context.GlobalState.get(globalId);
  context.GlobalState.set({
    id: globalId,
    chainId,
    totalPools: (existing?.totalPools ?? 0) + 1,
    totalSwaps: existing?.totalSwaps ?? 0n,
    lastUpdatedBlock: event.block.number,
    lastUpdatedTimestamp: BigInt(event.block.timestamp),
  });
}

// --- Tricrypto Factory NG (3-coin pools) ---

TricryptoFactoryNG.TricryptoPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addCryptoPool(event.params.pool);
  }
);

TricryptoFactoryNG.TricryptoPoolDeployed.handler(
  async ({ event, context }) => {
    await createPool(event as any, context, 3);
  }
);

// --- Twocrypto Factory NG (2-coin pools) ---

TwocryptoFactoryNG.TwocryptoPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addCryptoPool(event.params.pool);
  }
);

TwocryptoFactoryNG.TwocryptoPoolDeployed.handler(
  async ({ event, context }) => {
    await createPool(event as any, context, 2);
  }
);

// --- Twocrypto Factory V1 (2-coin pools, older) ---

TwocryptoFactoryV1.CryptoPoolDeployed.contractRegister(
  ({ event, context }) => {
    context.addCryptoPool(event.params.token);
  }
);

TwocryptoFactoryV1.CryptoPoolDeployed.handler(async ({ event, context }) => {
  await createPool(
    { ...event, params: { ...event.params, pool: event.params.token } } as any,
    context,
    2
  );
});
