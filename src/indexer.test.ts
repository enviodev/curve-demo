import { describe, it, expect } from "vitest";
import { TestHelpers } from "generated";
const { MockDb, TricryptoFactoryNG } = TestHelpers;

describe("TricryptoFactoryNG pool deployment", () => {
  it("creates a Pool entity and updates GlobalState", async () => {
    const mockDb = MockDb.createMockDb();
    const event =
      TricryptoFactoryNG.TricryptoPoolDeployed.createMockEvent({
        pool: "0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B",
        name: "TricryptoUSDC",
        symbol: "crvUSDCWBTCWETH",
        weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        coins: [
          "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
          "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
          "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        ],
        math: "0x0000000000000000000000000000000000000000",
        salt: "0x0000000000000000000000000000000000000000000000000000000000000000",
        packed_precisions: 0n,
        packed_A_gamma: 0n,
        packed_fee_params: 0n,
        packed_rebalancing_params: 0n,
        packed_prices: 0n,
        deployer: "0x0000000000000000000000000000000000000000",
      });

    const mockDbUpdated =
      await TricryptoFactoryNG.TricryptoPoolDeployed.processEvent({
        event,
        mockDb,
      });

    const pool = mockDbUpdated.entities.Pool.get(
      `${event.chainId}_0x7F86Bf177Dd4F3494b841a37e810A34dD56c829B`
    );
    expect(pool).toBeDefined();
    expect(pool?.nCoins).toBe(3);
    expect(pool?.coinAddresses).toHaveLength(3);

    const global = mockDbUpdated.entities.GlobalState.get(`${event.chainId}`);
    expect(global).toBeDefined();
    expect(global?.totalPools).toBe(1);
    expect(global?.totalSwaps).toBe(0n);
  });
});
