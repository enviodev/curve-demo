import { createEffect, S } from "envio";
import type { EvmChainId, EvmOnEventContext } from "envio";
import { type Chain, createPublicClient, http, parseAbi } from "viem";
import {
  mainnet,
  arbitrum,
  optimism,
  base,
  polygon,
  gnosis,
  bsc,
  fantom,
  fraxtal,
  sonic,
  avalanche,
} from "viem/chains";

// --- Multi-chain RPC via dRPC ---

const DRPC_NETWORKS: Record<number, { chain: Chain; network: string }> = {
  1: { chain: mainnet, network: "ethereum" },
  42161: { chain: arbitrum, network: "arbitrum" },
  10: { chain: optimism, network: "optimism" },
  8453: { chain: base, network: "base" },
  137: { chain: polygon, network: "polygon" },
  100: { chain: gnosis, network: "gnosis" },
  56: { chain: bsc, network: "bsc" },
  250: { chain: fantom, network: "fantom" },
  252: { chain: fraxtal, network: "fraxtal" },
  146: { chain: sonic, network: "sonic" },
  43114: { chain: avalanche, network: "avalanche" },
};

function makeClient(chainId: number) {
  const { chain, network } = DRPC_NETWORKS[chainId]!;
  const url = `https://lb.drpc.org/ogrpc?network=${network}&dkey=${process.env.ENVIO_DRPC_API_KEY}`;
  return createPublicClient({ chain, transport: http(url, { batch: true }) });
}

const clients = Object.fromEntries(
  Object.keys(DRPC_NETWORKS).map((id) => [id, makeClient(Number(id))]),
) as Record<number, ReturnType<typeof createPublicClient>>;

function getClient(chainId: number) {
  const c = clients[chainId];
  if (!c) throw new Error(`No RPC client for chain ${chainId}`);
  return c;
}

type MulticallResult =
  | { status: "success"; result: unknown }
  | { status: "failure" };

// A multicall that transparently falls back to individual eth_calls when
// multicall3 is unavailable — e.g. historical blocks before multicall3 was
// deployed (Ethereum block 14353601, mid-2022). Always returns allowFailure
// style { status } entries so a reverted read never throws.
async function safeMulticall(
  client: ReturnType<typeof createPublicClient>,
  contracts: any[],
  blockNumber?: bigint,
): Promise<MulticallResult[]> {
  try {
    return (await client.multicall({
      contracts,
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      allowFailure: true,
    })) as MulticallResult[];
  } catch {
    return await Promise.all(
      contracts.map((c) =>
        (
          client.readContract({
            ...c,
            ...(blockNumber !== undefined ? { blockNumber } : {}),
          }) as Promise<unknown>
        )
          .then((result) => ({ status: "success" as const, result }))
          .catch(() => ({ status: "failure" as const })),
      ),
    );
  }
}

// --- ABIs ---

// Single ABI with overloads so viem's multicall can type a heterogeneous batch
const poolAbi = parseAbi([
  "function balances(uint256 i) view returns (uint256)",
  "function last_prices() view returns (uint256)",
  "function last_prices(uint256 k) view returns (uint256)",
  "function price_scale() view returns (uint256)",
  "function price_scale(uint256 k) view returns (uint256)",
  "function coins(uint256 i) view returns (address)",
]);

const erc20Abi = parseAbi([
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
]);

// --- Chain backfill end blocks ---
//
// At module init we snapshot each chain's head and subtract 200 blocks. While
// the indexer is processing blocks below this threshold ("backfill"), pool
// state is far enough in the past that we can safely query the *latest* state
// from the RPC and cache it without a per-block cache key. Once the indexer
// catches up to the head, we switch to explicit per-block queries.

export const chainBackfillEndBlock = Object.fromEntries(
  await Promise.all(
    Object.keys(DRPC_NETWORKS).map(async (id) => {
      const chainId = Number(id);
      try {
        const head = await getClient(chainId).getBlockNumber();
        return [chainId, Number(head) - 200];
      } catch {
        // RPC unavailable at startup (missing/invalid ENVIO_DRPC_API_KEY or a
        // transient outage). Fall back to 0 so handler modules still load —
        // this disables the backfill read-through cache (getPoolState then
        // always queries at an explicit block) but keeps results correct.
        return [chainId, 0];
      }
    }),
  ),
) as Record<EvmChainId, number>;

// --- Combined pool state (balances + last_prices + price_scale) ---

/**
 * Fetches balances, last_prices, and price_scale for every coin in a pool in
 * a single effect. For 2-coin pools last_prices/price_scale are nullary; for
 * 3-coin pools they take an index k in [0, nCoins - 1).
 *
 * Prefer the `getPoolState` wrapper below over calling this effect directly —
 * the wrapper decides whether to pass an explicit `blockNumber` based on
 * whether we are still in backfill or indexing at the head.
 */
const getPoolStateEffect = createEffect(
  {
    name: "getPoolState",
    input: S.tuple((s) => ({
      address: s.item(0, S.string),
      chainId: s.item(1, S.number),
      nCoins: s.item(2, S.number),
      blockNumber: s.item(3, S.optional(S.number)),
    })),
    output: S.schema({
      balances: S.array(S.bigint),
      lastPrices: S.array(S.bigint),
      priceScales: S.array(S.bigint),
      validAt: S.number,
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const address = input.address as `0x${string}`;
    const blockNumber =
      input.blockNumber !== undefined ? BigInt(input.blockNumber) : undefined;

    const balanceCalls = Array.from({ length: input.nCoins }, (_, i) => ({
      address,
      abi: poolAbi,
      functionName: "balances",
      args: [BigInt(i)],
    }));

    // 3-coin pools: last_prices(k)/price_scale(k) for k = 0..nCoins-2
    // 2-coin pools: nullary last_prices()/price_scale()
    const priceCalls =
      input.nCoins === 3
        ? [
            { address, abi: poolAbi, functionName: "last_prices", args: [0n] },
            { address, abi: poolAbi, functionName: "last_prices", args: [1n] },
            { address, abi: poolAbi, functionName: "price_scale", args: [0n] },
            { address, abi: poolAbi, functionName: "price_scale", args: [1n] },
          ]
        : [
            { address, abi: poolAbi, functionName: "last_prices" },
            { address, abi: poolAbi, functionName: "price_scale" },
          ];

    const results = await safeMulticall(
      client,
      [...balanceCalls, ...priceCalls],
      blockNumber,
    );
    const asBig = (r: MulticallResult): bigint =>
      r && r.status === "success" ? (r.result as bigint) : 0n;
    const balances = results.slice(0, input.nCoins).map(asBig);
    const priceResults = results.slice(input.nCoins).map(asBig);

    let lastPrices: bigint[];
    let priceScales: bigint[];
    if (input.nCoins === 3) {
      lastPrices = [priceResults[0]!, priceResults[1]!];
      priceScales = [priceResults[2]!, priceResults[3]!];
    } else {
      lastPrices = [priceResults[0]!];
      priceScales = [priceResults[1]!];
    }

    // `validAt` is the chain's backfill-end block at the moment this effect
    // ran. When a future call reads this from cache and finds validAt below
    // the requested block, it must re-query with an explicit block number.
    const validAt =
      input.blockNumber !== undefined
        ? input.blockNumber
        : (chainBackfillEndBlock[input.chainId as EvmChainId] ?? 0);

    return { balances, lastPrices, priceScales, validAt };
  },
);

/**
 * Wrapper around `getPoolStateEffect` that:
 *  - During backfill (block < chain's backfillEndBlock): calls the effect
 *    *without* a block number so the result is cached per-pool.
 *  - At the head: calls with an explicit block number for precise state.
 *  - Invalidates stale cache hits: if a cached response comes back with
 *    `validAt < blockNumber`, re-runs the effect with an explicit block
 *    number. This handles the case where a previous run cached pool state
 *    during backfill and a later run is now indexing past that point.
 */
export async function getPoolState(
  context: EvmOnEventContext,
  args: {
    chainId: EvmChainId;
    address: string;
    nCoins: number;
    blockNumber: number;
  },
) {
  const backfillEndBlock = chainBackfillEndBlock[args.chainId] ?? 0;
  const baseInput = {
    chainId: args.chainId as number,
    address: args.address,
    nCoins: args.nCoins,
  };

  if (args.blockNumber < backfillEndBlock) {
    const result = await context.effect(getPoolStateEffect, {
      ...baseInput,
      blockNumber: undefined,
    });
    if (result.validAt >= args.blockNumber) {
      return result;
    }
    // Cached entry was produced under an earlier (smaller) backfill window
    // and is now stale relative to the block we're processing. Re-query
    // with an explicit block number.
  }

  return await context.effect(getPoolStateEffect, {
    ...baseInput,
    blockNumber: args.blockNumber,
  });
}

// --- Pool coin discovery ---

/**
 * Fetches the `coins` array for a Curve crypto pool. Used to lazily initialize
 * Pool entities for standalone pools that aren't deployed via a tracked
 * factory (the factory deployment events would otherwise carry this data).
 */
export const getPoolCoins = createEffect(
  {
    name: "getPoolCoins",
    input: S.schema({
      chainId: S.number,
      address: S.string,
      nCoins: S.number,
    }),
    output: S.array(S.string),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const calls = Array.from({ length: input.nCoins }, (_, i) => ({
      address: input.address as `0x${string}`,
      abi: poolAbi,
      functionName: "coins",
      args: [BigInt(i)],
    }));
    const results = await client.multicall({
      contracts: calls,
      allowFailure: false,
    });
    // viem narrows the multicall return type from the first matching overload
    // in `poolAbi`, which is `balances` -> uint256. The actual call here is
    // `coins(uint256) -> address`, so cast through unknown.
    return results as unknown as string[];
  },
);

// --- CRYPTO_V1 factory: resolve pool from LP token ---
//
// The old crypto factory (0xF18056Bb, "factory-crypto") deploys the pool and
// its LP token as SEPARATE contracts; CryptoPoolDeployed carries only the LP
// token. The LP token's `minter()` is the pool that actually emits
// TokenExchange, so we read it to register/track the real pool.
const minterAbi = parseAbi(["function minter() view returns (address)"]);

/**
 * Resolve the real pool address for a CRYPTO_V1 LP token by reading minter().
 * Called directly (not via the Effect API) because contractRegister has no
 * effect caller — mirrors resolveLatestStablePool. Returns the lowercased pool
 * address, or undefined if the read reverts.
 */
export async function resolveCryptoPoolFromToken(
  chainId: number,
  token: string,
  blockNumber: number,
): Promise<string | undefined> {
  try {
    const client = getClient(chainId);
    const pool = (await client.readContract({
      address: token as `0x${string}`,
      abi: minterAbi,
      functionName: "minter",
      blockNumber: BigInt(blockNumber),
    })) as string;
    return pool.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Effect-wrapped form of resolveCryptoPoolFromToken for use inside event
 * handlers (which double-run in preload and must route RPC through the Effect
 * API). Mirrors resolveStablePoolEffect.
 */
export const resolveCryptoPoolEffect = createEffect(
  {
    name: "resolveCryptoPool",
    input: S.schema({
      chainId: S.number,
      token: S.string,
      blockNumber: S.number,
    }),
    output: S.union([S.string, null]),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const addr = await resolveCryptoPoolFromToken(
      input.chainId,
      input.token,
      input.blockNumber,
    );
    return addr ?? null;
  },
);

// crvUSD PriceAggregator — system-wide crvUSD price (~1e18 = $1). Used to stamp
// the peg price at the moment of each PegKeeper action. Resilient: returns "0"
// if the read reverts (e.g. an archive gap) so the handler treats it as unknown.
const CRVUSD_AGGREGATOR = "0x18672b1b0c623a30089A280Ed9256379fb0E4E62";
const crvUsdAggregatorAbi = parseAbi(["function price() view returns (uint256)"]);

export const getCrvUsdPegPrice = createEffect(
  {
    name: "getCrvUsdPegPrice",
    input: S.schema({ chainId: S.number, blockNumber: S.number }),
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    try {
      const client = getClient(input.chainId);
      const price = await client.readContract({
        address: CRVUSD_AGGREGATOR as `0x${string}`,
        abi: crvUsdAggregatorAbi,
        functionName: "price",
        blockNumber: BigInt(input.blockNumber),
      });
      return (price as bigint).toString();
    } catch {
      return "0";
    }
  },
);

// --- ERC20 metadata ---

export const getTokenSymbol = createEffect(
  {
    name: "getTokenSymbol",
    input: S.schema({ chainId: S.number, address: S.string }),
    output: S.string,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    try {
      const raw = await getClient(input.chainId).readContract({
        address: input.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "symbol",
      });
      // Strip null bytes and other characters Postgres can't store in text columns
      return raw.replace(/\0/g, "").trim() || "???";
    } catch {
      return "???";
    }
  },
);

export const getTokenDecimals = createEffect(
  {
    name: "getTokenDecimals",
    input: S.schema({ chainId: S.number, address: S.string }),
    output: S.number,
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    try {
      const decimals = await getClient(input.chainId).readContract({
        address: input.address as `0x${string}`,
        abi: erc20Abi,
        functionName: "decimals",
      });
      return Number(decimals);
    } catch {
      return 18;
    }
  },
);

// ============================================================
// Stableswap-NG
// ============================================================

// Stableswap-NG factory (doubles as registry) per chain.
export const STABLE_NG_FACTORY: Record<number, string> = {
  1: "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf",
  42161: "0x9AF14D26075f142eb3F292D5065EB3faa646167b",
  10: "0x5eeE3091f747E60a045a2E715a4c71e600e31F6E",
  8453: "0xd2002373543Ce3527023C75e7518C274A51ce712",
  137: "0x1764ee18e8B3ccA4787249Ceb249356192594585",
  100: "0xbC0797015fcFc47d9C1856639CaE50D0e69FbEE8",
  56: "0xd7E72f3615aa65b92A4DBdC211E296a35512988B",
  250: "0xe61Fb97Ef6eBFBa12B36Ffd7be785c1F5A2DE66b",
  252: "0xd2002373543Ce3527023C75e7518C274A51ce712",
  146: "0x7C2085419BE6a04f4ad88ea91bC9F5C6E6C463D8",
  43114: "0x1764ee18e8B3ccA4787249Ceb249356192594585",
};

const stableFactoryAbi = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256 i) view returns (address)",
  "function get_coins(address pool) view returns (address[])",
  "function get_decimals(address pool) view returns (uint256[])",
  "function is_meta(address pool) view returns (bool)",
]);

const stablePoolAbi = parseAbi([
  "function A() view returns (uint256)",
  "function balances(uint256 i) view returns (uint256)",
  "function get_virtual_price() view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
]);

/**
 * Resolve the address of the pool just deployed by a Stableswap-NG factory.
 * The deploy events (PlainPoolDeployed/MetaPoolDeployed) don't carry the pool
 * address, so we read pool_list(pool_count()-1) at the deploy block. Called
 * directly (not via the Effect API) because contractRegister has no effect
 * caller. NOTE: assumes one deploy per (factory, block); a same-block multi
 * deploy would resolve every event to the last pool.
 */
export async function resolveLatestStablePool(
  chainId: number,
  factory: string,
  blockNumber: number,
): Promise<string | undefined> {
  try {
    const client = getClient(chainId);
    const f = factory as `0x${string}`;
    const count = (await client.readContract({
      address: f,
      abi: stableFactoryAbi,
      functionName: "pool_count",
      blockNumber: BigInt(blockNumber),
    })) as bigint;
    if (count === 0n) return undefined;
    const pool = (await client.readContract({
      address: f,
      abi: stableFactoryAbi,
      functionName: "pool_list",
      args: [count - 1n],
      blockNumber: BigInt(blockNumber),
    })) as string;
    return pool.toLowerCase();
  } catch {
    return undefined;
  }
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/** Pool metadata (coins, decimals, meta flag, symbol/name) via the factory. */
export const getStablePoolMeta = createEffect(
  {
    name: "getStablePoolMeta",
    input: S.schema({ chainId: S.number, address: S.string }),
    output: S.schema({
      coins: S.array(S.string),
      decimals: S.array(S.number),
      isMeta: S.boolean,
      symbol: S.string,
      name: S.string,
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const factory = STABLE_NG_FACTORY[input.chainId]!;
    const f = factory as `0x${string}`;
    const pool = input.address as `0x${string}`;
    const [coins, decimals, isMeta, symbol, name] = await Promise.all([
      client.readContract({ address: f, abi: stableFactoryAbi, functionName: "get_coins", args: [pool] }) as Promise<readonly string[]>,
      client.readContract({ address: f, abi: stableFactoryAbi, functionName: "get_decimals", args: [pool] }) as Promise<readonly bigint[]>,
      (client.readContract({ address: f, abi: stableFactoryAbi, functionName: "is_meta", args: [pool] }) as Promise<boolean>).catch(() => false),
      (client.readContract({ address: pool, abi: stablePoolAbi, functionName: "symbol" }) as Promise<string>).catch(() => "???"),
      (client.readContract({ address: pool, abi: stablePoolAbi, functionName: "name" }) as Promise<string>).catch(() => ""),
    ]);
    // get_coins/get_decimals return MAX_COINS-sized arrays padded with zeros.
    const coinList = coins.filter((c) => c.toLowerCase() !== ZERO_ADDRESS);
    const decList = decimals.slice(0, coinList.length).map((d) => Number(d));
    return {
      coins: coinList.map((c) => c.toLowerCase()),
      decimals: decList,
      isMeta,
      symbol,
      name,
    };
  },
);

/** Pool state (balances, A, virtual price, LP supply). */
export const getStablePoolState = createEffect(
  {
    name: "getStablePoolState",
    input: S.tuple((s) => ({
      address: s.item(0, S.string),
      chainId: s.item(1, S.number),
      nCoins: s.item(2, S.number),
      blockNumber: s.item(3, S.optional(S.number)),
    })),
    output: S.schema({
      balances: S.array(S.bigint),
      a: S.bigint,
      virtualPrice: S.bigint,
      totalSupply: S.bigint,
      validAt: S.number,
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const address = input.address as `0x${string}`;
    const blockNumber =
      input.blockNumber !== undefined ? BigInt(input.blockNumber) : undefined;
    const balanceCalls = Array.from({ length: input.nCoins }, (_, i) => ({
      address,
      abi: stablePoolAbi,
      functionName: "balances",
      args: [BigInt(i)],
    }));
    // A freshly-deployed (empty) pool reverts get_virtual_price (D / 0 supply),
    // and pre-2022 blocks predate multicall3 — safeMulticall tolerates both.
    const results = await safeMulticall(
      client,
      [
        ...balanceCalls,
        { address, abi: stablePoolAbi, functionName: "A" },
        { address, abi: stablePoolAbi, functionName: "get_virtual_price" },
        { address, abi: stablePoolAbi, functionName: "totalSupply" },
      ],
      blockNumber,
    );
    const val = (i: number): bigint => {
      const r = results[i];
      return r && r.status === "success" ? (r.result as bigint) : 0n;
    };
    const balances = Array.from({ length: input.nCoins }, (_, i) => val(i));
    return {
      balances,
      a: val(input.nCoins),
      virtualPrice: val(input.nCoins + 1),
      totalSupply: val(input.nCoins + 2),
      validAt:
        input.blockNumber !== undefined
          ? input.blockNumber
          : (chainBackfillEndBlock[input.chainId as EvmChainId] ?? 0),
    };
  },
);

/**
 * Wrapper around `getStablePoolState` mirroring `getPoolState`: during backfill
 * it reads pool state ONCE per pool (no block number in the cache key, so every
 * historical event reuses it); at the head it reads with an explicit block. A
 * stale cross-run cache hit (validAt < requested block) re-queries precisely.
 * Balances are event-sourced in the handler, so in practice this read just keeps
 * A + virtual price current — but doing it once per pool instead of once per
 * pool per day is what removes the backfill RPC bottleneck.
 */
export async function getStablePoolStateCached(
  context: EvmOnEventContext,
  args: {
    chainId: EvmChainId;
    address: string;
    nCoins: number;
    blockNumber: number;
  },
) {
  const backfillEndBlock = chainBackfillEndBlock[args.chainId] ?? 0;
  const baseInput = {
    chainId: args.chainId as number,
    address: args.address,
    nCoins: args.nCoins,
  };
  if (args.blockNumber < backfillEndBlock) {
    const result = await context.effect(getStablePoolState, {
      ...baseInput,
      blockNumber: undefined,
    });
    if (result.validAt >= args.blockNumber) return result;
  }
  return await context.effect(getStablePoolState, {
    ...baseInput,
    blockNumber: args.blockNumber,
  });
}

/**
 * Resolve the pool deployed at `blockNumber` via pool_list(pool_count()-1).
 * Effect-wrapped form of resolveLatestStablePool for use inside event handlers
 * (which double-run in preload and must route RPC through the Effect API).
 */
export const resolveStablePoolEffect = createEffect(
  {
    name: "resolveStablePool",
    input: S.schema({ chainId: S.number, blockNumber: S.number }),
    output: S.union([S.string, null]),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const factory = STABLE_NG_FACTORY[input.chainId];
    if (!factory) return null;
    const addr = await resolveLatestStablePool(
      input.chainId,
      factory,
      input.blockNumber,
    );
    return addr ?? null;
  },
);

// ============================================================
// Legacy stableswap (registry-listed pools)
// ============================================================

// Curve Main Registry per chain (hand-deployed legacy pools).
export const LEGACY_REGISTRY: Record<number, string> = {
  1: "0x90E00ACe148ca3b23Ac1bC8C240C2a7Dd9c2d7f5",
};

const legacyRegistryAbi = parseAbi([
  "function get_coins(address pool) view returns (address[8])",
  "function get_decimals(address pool) view returns (uint256[8])",
  "function get_lp_token(address pool) view returns (address)",
]);

/**
 * Legacy pool metadata via the Main Registry (coins/decimals) + the pool's
 * LP token (symbol/name). Legacy pools keep their LP token in a separate
 * contract, so symbol/name come from there rather than the pool itself.
 */
export const getLegacyPoolMeta = createEffect(
  {
    name: "getLegacyPoolMeta",
    input: S.schema({ chainId: S.number, address: S.string }),
    output: S.schema({
      coins: S.array(S.string),
      decimals: S.array(S.number),
      symbol: S.string,
      name: S.string,
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    // LegacyStablePool now runs on every chain the OLD metapool factory covers,
    // but the Main Registry (source of this metadata) only exists on mainnet.
    // Off-mainnet legacy pools are the factory's, and their Pool entity is
    // created on deploy — so this effect is only reached for them if that
    // creation was skipped. Return empty (caller then skips) instead of
    // dereferencing a missing registry address.
    const regAddr = LEGACY_REGISTRY[input.chainId];
    if (!regAddr) return { coins: [], decimals: [], symbol: "", name: "" };
    const reg = regAddr as `0x${string}`;
    const pool = input.address as `0x${string}`;
    const [coins, decimals, lp] = await Promise.all([
      client.readContract({ address: reg, abi: legacyRegistryAbi, functionName: "get_coins", args: [pool] }) as Promise<readonly string[]>,
      client.readContract({ address: reg, abi: legacyRegistryAbi, functionName: "get_decimals", args: [pool] }) as Promise<readonly bigint[]>,
      (client.readContract({ address: reg, abi: legacyRegistryAbi, functionName: "get_lp_token", args: [pool] }) as Promise<string>).catch(() => ZERO_ADDRESS),
    ]);
    const coinList = coins.filter((c) => c.toLowerCase() !== ZERO_ADDRESS);
    const decList = decimals.slice(0, coinList.length).map((d) => Number(d));
    let symbol = "";
    let name = "";
    if (lp.toLowerCase() !== ZERO_ADDRESS) {
      symbol = await (client.readContract({ address: lp as `0x${string}`, abi: stablePoolAbi, functionName: "symbol" }) as Promise<string>).catch(() => "");
      name = await (client.readContract({ address: lp as `0x${string}`, abi: stablePoolAbi, functionName: "name" }) as Promise<string>).catch(() => "");
    }
    return {
      coins: coinList.map((c) => c.toLowerCase()),
      decimals: decList,
      symbol,
      name,
    };
  },
);

// ============================================================
// OLD stableswap metapool factory (pre-NG)
// ============================================================
//
// Curve's original ("metapool") stableswap factory. Its pools share the exact
// legacy int128 TokenExchange interface with registry-listed pools, so they are
// registered as `LegacyStablePool` and indexed by the LegacyStableswap swap
// handler. The factory itself mirrors the Stableswap-NG factory (address-less
// deploy events resolved via pool_list(pool_count()-1)) EXCEPT that its
// get_coins/get_decimals return FIXED-size arrays (address[4]/uint256[4]) padded
// with the zero address — the NG factory uses dynamic address[]/uint256[]. So it
// needs a separate ABI, but pool_count/pool_list are identical, which is why
// `resolveLatestStablePool` is reused directly. Fraxtal (252) and Sonic (146)
// have no old factory and are intentionally absent.
export const OLD_METAPOOL_FACTORY: Record<number, string> = {
  1: "0xb9fc157394af804a3578134a6585c0dc9cc990d4",
  137: "0x722272d36ef0da72ff51c5a65db7b870e2e8d4ee",
  250: "0x686d67265703d1f124c45e33d47d794c566889ba",
  42161: "0xb17b674D9c5CB2e441F8e196a2f048A81355d031",
  43114: "0xb17b674D9c5CB2e441F8e196a2f048A81355d031",
  10: "0x2db0E83599a91b508Ac268a6197b8B14F5e72840",
  100: "0xD19Baeadc667Cf2015e395f2B08668Ef120f41F5",
  8453: "0x3093f9B57A428F3EB6285a589cb35bEA6e78c336",
  56: "0xEfDE221f306152971D8e9f181bFe998447975810",
};

// FIXED-array getters (address[4]/uint256[4]) — the defining difference from the
// NG factory. is_meta/get_base_pool are read best-effort to flag metapools.
const oldFactoryAbi = parseAbi([
  "function pool_count() view returns (uint256)",
  "function pool_list(uint256 i) view returns (address)",
  "function get_coins(address pool) view returns (address[4])",
  "function get_decimals(address pool) view returns (uint256[4])",
  "function get_n_coins(address pool) view returns (uint256)",
  "function get_base_pool(address pool) view returns (address)",
  "function is_meta(address pool) view returns (bool)",
]);

/**
 * Pool metadata via the OLD metapool factory. Mirrors `getStablePoolMeta` but
 * decodes the fixed 4-slot get_coins/get_decimals arrays (padded with the zero
 * address) and derives `isMeta` from is_meta / a non-zero base_pool rather than
 * trusting a single getter. symbol/name come from the pool itself (these factory
 * pools are their own ERC20 LP token).
 */
export const getOldFactoryPoolMeta = createEffect(
  {
    name: "getOldFactoryPoolMeta",
    input: S.schema({ chainId: S.number, address: S.string }),
    output: S.schema({
      coins: S.array(S.string),
      decimals: S.array(S.number),
      isMeta: S.boolean,
      symbol: S.string,
      name: S.string,
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const client = getClient(input.chainId);
    const factory = OLD_METAPOOL_FACTORY[input.chainId];
    if (!factory) {
      return { coins: [], decimals: [], isMeta: false, symbol: "", name: "" };
    }
    const f = factory as `0x${string}`;
    const pool = input.address as `0x${string}`;
    const [coins, decimals, basePool, isMetaFlag, symbol, name] =
      await Promise.all([
        client.readContract({ address: f, abi: oldFactoryAbi, functionName: "get_coins", args: [pool] }) as Promise<readonly string[]>,
        client.readContract({ address: f, abi: oldFactoryAbi, functionName: "get_decimals", args: [pool] }) as Promise<readonly bigint[]>,
        (client.readContract({ address: f, abi: oldFactoryAbi, functionName: "get_base_pool", args: [pool] }) as Promise<string>).catch(() => ZERO_ADDRESS),
        (client.readContract({ address: f, abi: oldFactoryAbi, functionName: "is_meta", args: [pool] }) as Promise<boolean>).catch(() => false),
        (client.readContract({ address: pool, abi: stablePoolAbi, functionName: "symbol" }) as Promise<string>).catch(() => "???"),
        (client.readContract({ address: pool, abi: stablePoolAbi, functionName: "name" }) as Promise<string>).catch(() => ""),
      ]);
    // get_coins/get_decimals return MAX_COINS(=4)-sized arrays padded with zeros.
    const coinList = coins.filter((c) => c.toLowerCase() !== ZERO_ADDRESS);
    const decList = decimals.slice(0, coinList.length).map((d) => Number(d));
    const hasBasePool = basePool.toLowerCase() !== ZERO_ADDRESS;
    return {
      coins: coinList.map((c) => c.toLowerCase()),
      decimals: decList,
      isMeta: isMetaFlag || hasBasePool,
      symbol,
      name,
    };
  },
);

/**
 * Resolve the pool just deployed by the OLD metapool factory at `blockNumber`.
 * Effect-wrapped form (handlers double-run in preload and must route RPC through
 * the Effect API). Reuses `resolveLatestStablePool` — pool_count/pool_list are
 * byte-for-byte identical to the NG factory.
 */
export const resolveOldFactoryPoolEffect = createEffect(
  {
    name: "resolveOldFactoryPool",
    input: S.schema({ chainId: S.number, blockNumber: S.number }),
    output: S.union([S.string, null]),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const factory = OLD_METAPOOL_FACTORY[input.chainId];
    if (!factory) return null;
    const addr = await resolveLatestStablePool(
      input.chainId,
      factory,
      input.blockNumber,
    );
    return addr ?? null;
  },
);

// ============================================================
// Metapool underlying-coin resolution (TokenExchangeUnderlying)
// ============================================================
//
// `exchange_underlying` routes a trade through the metapool's base pool, so the
// TokenExchangeUnderlying event's sold_id/bought_id are UNDERLYING indices:
// index 0 is the metapool's own coin[0] (its non-base coin, e.g. FRAX), and
// indices 1.. are the BASE pool's coins (e.g. DAI/USDC/USDT for a 3pool base).
// To map indices → real tokens we must resolve the base pool and its coins.
//
// There are THREE on-chain flavors (all verified on mainnet):
//   1. Registry / hand-deployed old metapools (e.g. GUSD 0x4f0626..):
//        base_pool()  (lowercase Vyper storage getter) works.
//   2. OLD metapool-FACTORY pools (e.g. FRAX3CRV 0xd632.., MIM 0x5a6a..):
//        base_pool()/BASE_POOL() BOTH revert — the base pool is only exposed by
//        the factory's get_base_pool(pool).
//   3. Stableswap-NG metapools (e.g. 0x579a..):
//        BASE_POOL()  (UPPERCASE — NG stores it as a public immutable, and Vyper
//        preserves the declared casing in the getter name).
// We probe all three sources in one allowFailure batch and take the first
// non-zero result. The base pool's own coins are then read via coins(uint256),
// which is lowercase on every plain/base pool (legacy 3pool and NG alike).
const metapoolAbi = parseAbi([
  "function base_pool() view returns (address)",
  "function BASE_POOL() view returns (address)",
  "function get_base_pool(address pool) view returns (address)",
]);

/**
 * Resolve a stableswap metapool's flattened UNDERLYING coin list + decimals for
 * TokenExchangeUnderlying: `[coin0, ...baseCoins]`, aligned to the event's
 * underlying indices. coin0/coin0Decimals are supplied by the caller (already on
 * the Pool entity → no extra RPC). Everything is best-effort: if no base pool is
 * found (the pool isn't actually a metapool) we return just `[coin0]`, and the
 * handler then treats any base-coin index as out-of-range and skips the swap.
 * cache:true — the mapping is immutable per pool. Reads at `latest` (base pool +
 * its coins never change), matching getStablePoolMeta.
 */
export const getMetapoolUnderlyingCoins = createEffect(
  {
    name: "getMetapoolUnderlyingCoins",
    input: S.schema({
      chainId: S.number,
      address: S.string,
      coin0: S.string,
      coin0Decimals: S.number,
    }),
    output: S.schema({
      coins: S.array(S.string),
      decimals: S.array(S.number),
    }),
    cache: true,
    rateLimit: false,
  },
  async ({ input }) => {
    const coin0 = input.coin0.toLowerCase();
    const fallback = { coins: [coin0], decimals: [input.coin0Decimals] };
    try {
      const client = getClient(input.chainId);
      const pool = input.address as `0x${string}`;

      // Probe every known base-pool getter in one allowFailure batch.
      const resolveCalls: any[] = [
        { address: pool, abi: metapoolAbi, functionName: "base_pool" },
        { address: pool, abi: metapoolAbi, functionName: "BASE_POOL" },
      ];
      const oldFactory = OLD_METAPOOL_FACTORY[input.chainId];
      if (oldFactory) {
        resolveCalls.push({
          address: oldFactory as `0x${string}`,
          abi: metapoolAbi,
          functionName: "get_base_pool",
          args: [pool],
        });
      }
      const resolved = await safeMulticall(client, resolveCalls);
      let basePool: string | undefined;
      for (const r of resolved) {
        if (r.status === "success") {
          const a = (r.result as string | undefined)?.toLowerCase();
          if (a && a !== ZERO_ADDRESS) {
            basePool = a;
            break;
          }
        }
      }
      if (!basePool) return fallback;

      // Base pool coins via coins(uint256) (lowercase on every plain/base pool).
      // Read 0..7 and stop at the first revert/zero (caps at MAX_COINS).
      const base = basePool as `0x${string}`;
      const coinResults = await safeMulticall(
        client,
        Array.from({ length: 8 }, (_, i) => ({
          address: base,
          abi: poolAbi,
          functionName: "coins",
          args: [BigInt(i)],
        })),
      );
      const baseCoins: string[] = [];
      for (const r of coinResults) {
        if (r.status !== "success") break;
        const a = (r.result as string | undefined)?.toLowerCase();
        if (!a || a === ZERO_ADDRESS) break;
        baseCoins.push(a);
      }

      // Base coin decimals (best-effort; default 18).
      const decResults = await safeMulticall(
        client,
        baseCoins.map((c) => ({
          address: c as `0x${string}`,
          abi: erc20Abi,
          functionName: "decimals",
        })),
      );
      const baseDecimals = decResults.map((r) =>
        r.status === "success" ? Number(r.result as bigint | number) : 18,
      );

      return {
        coins: [coin0, ...baseCoins],
        decimals: [input.coin0Decimals, ...baseDecimals],
      };
    } catch {
      return fallback;
    }
  },
);
