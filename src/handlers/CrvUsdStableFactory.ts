import { indexer } from "envio";
import { createPool } from "./factories.js";
import { getTokenSymbol } from "../effects.js";

// Curve's factory-crvusd stableswap factory (mainnet only,
// 0x4F8846Ae9380B90d2E71D5e3D042dff3E7ebb40d). Unlike the Stableswap-NG factory,
// its PlainPoolDeployed event CARRIES the pool address as the last arg, so no
// pool_list(pool_count()-1) resolution is needed. Its pools emit the same int128
// TokenExchange as Stableswap-NG pools, so we register them as `StableswapPool`
// and the existing StableswapNG swap handler indexes their swaps once the Pool
// entity exists: ensureStablePool returns the entity we create here, and
// refreshStableState keeps balances/A/virtualPrice/TVL current from the first
// swap onward.

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

indexer.contractRegister(
  { contract: "CrvUsdStableFactory", event: "PlainPoolDeployed" },
  async ({ event, context }) => {
    context.chain.StableswapPool.add(event.params.pool);
  },
);

indexer.onEvent(
  { contract: "CrvUsdStableFactory", event: "PlainPoolDeployed" },
  async ({ event, context }) => {
    // coins is a fixed address[4] padded with the zero address for pools with
    // fewer than 4 coins.
    const coins = event.params.coins.filter(
      (c) => c.toLowerCase() !== ZERO_ADDR,
    );

    // These factory pools are their own ERC20 LP token, so the pool address
    // carries the pool symbol (e.g. crvUSDUSDC-f).
    const symbol = (await context.effect(getTokenSymbol, {
      chainId: event.chainId,
      address: event.params.pool,
    })) as string;

    await createPool(context, {
      chainId: event.chainId,
      poolAddress: event.params.pool,
      lpTokenAddress: event.params.pool,
      coins,
      symbol,
      name: symbol,
      poolType: "STABLESWAP_NG",
      hasDonations: false,
      block: event.block,
    });
  },
);
