import { createEffect, S } from "envio";
import type { EvmChainId, HandlerContext } from "generated";
import { type Chain, createPublicClient, http, parseAbi } from "viem";
import { mainnet, arbitrum } from "viem/chains";

// --- Multi-chain RPC via dRPC ---

const DRPC_NETWORKS: Record<number, { chain: Chain; network: string }> = {
  1: { chain: mainnet, network: "ethereum" },
  42161: { chain: arbitrum, network: "arbitrum" },
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
      const head = await getClient(chainId).getBlockNumber();
      return [chainId, Number(head) - 200];
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

    const results = await client.multicall({
      contracts: [...balanceCalls, ...priceCalls],
      ...(blockNumber !== undefined ? { blockNumber } : {}),
      allowFailure: false,
    });

    const balances = results.slice(0, input.nCoins) as bigint[];
    const priceResults = results.slice(input.nCoins) as bigint[];

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
  context: HandlerContext,
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
