import { describe, it, expect } from "vitest";
import { createTestIndexer } from "envio";

describe("TricryptoFactoryNG pool deployment", () => {
  it("creates Pool, Token and PoolPair entities and updates GlobalState", async () => {
    const indexer = createTestIndexer();

    await indexer.process({
      chains: {
        1: {
          simulate: [
            {
              contract: "TricryptoFactoryNG",
              event: "TricryptoPoolDeployed",
              params: {
                pool: "0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B",
                name: "TricryptoUSDC",
                symbol: "crvUSDCWBTCWETH",
                weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
                coins: [
                  "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC
                  "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", // WBTC
                  "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
                ],
                math: "0x0000000000000000000000000000000000000000",
                salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
                packed_precisions: 0n,
                packed_A_gamma: 0n,
                packed_fee_params: 0n,
                packed_rebalancing_params: 0n,
                packed_prices: 0n,
                deployer: "0x0000000000000000000000000000000000000000",
              },
            },
          ],
        },
      },
    });

    const chainId = 1;
    const poolAddress = "0x7f86bf177dd4f3494b841a37e810a34dd56c829b"; // lower-cased id

    const pool = await indexer.Pool.getOrThrow(`${chainId}_${poolAddress}`);
    expect(pool.nCoins).toBe(3);
    expect(pool.coinAddresses).toHaveLength(3);
    expect(pool.poolType).toBe("TRICRYPTO_NG");
    expect(pool.symbol).toBe("crvUSDCWBTCWETH");

    const global = await indexer.GlobalState.getOrThrow(`${chainId}`);
    expect(global.totalPools).toBe(1);
    expect(global.totalSwaps).toBe(0n);

    // Stablecoin coin 0 (USDC) should be seeded with $1 usdPrice
    const usdc = await indexer.Token.getOrThrow(
      `${chainId}_0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`,
    );
    expect(usdc.isStablecoin).toBe(true);
    expect(usdc.priceSource).toBe("STABLECOIN");
    expect(usdc.usdPrice?.toString()).toBe("1");

    // WBTC should be created but unpriced
    const wbtc = await indexer.Token.getOrThrow(
      `${chainId}_0x2260fac5e5542a773aa44fbcfedf7c193bc2c599`,
    );
    expect(wbtc.isStablecoin).toBe(false);
    expect(wbtc.usdPrice).toBeUndefined();

    // Two PoolPairs should exist: (main=1, ref=0) and (main=2, ref=0)
    const pair1 = await indexer.PoolPair.getOrThrow(
      `${chainId}_${poolAddress}_1_0`,
    );
    expect(pair1.mainTokenIndex).toBe(1);
    expect(pair1.referenceTokenIndex).toBe(0);

    const pair2 = await indexer.PoolPair.getOrThrow(
      `${chainId}_${poolAddress}_2_0`,
    );
    expect(pair2.mainTokenIndex).toBe(2);
    expect(pair2.referenceTokenIndex).toBe(0);
  });
});
