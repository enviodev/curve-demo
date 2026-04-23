import { BigDecimal, type Token, type Pool, type PoolPair } from "generated";
import { isStablecoin, tokenId } from "./constants.js";

// A precomputed $1 used for stablecoins. bignumber.js is immutable so we can
// reuse a single instance.
export const ONE_USD = new BigDecimal(1);
export const ZERO = new BigDecimal(0);

/**
 * Ensure a Token entity exists for (chainId, address). If we haven't seen it
 * before, create it — stablecoins are seeded with usdPrice = $1; everything
 * else starts with usdPrice = undefined and will be priced lazily on the
 * first swap involving it and a priced token.
 */
export async function ensureToken(
  context: any,
  chainId: number,
  address: string,
  symbol: string,
  decimals: number,
  block: { number: number; timestamp: number },
): Promise<Token> {
  const id = tokenId(chainId, address);
  const existing = await context.Token.get(id);
  if (existing) return existing;

  const stable = isStablecoin(chainId, address);
  const token: Token = {
    id,
    chainId,
    address: address.toLowerCase(),
    symbol,
    decimals,
    isStablecoin: stable,
    usdPrice: stable ? ONE_USD : undefined,
    priceSource: stable ? "STABLECOIN" : undefined,
    lastPricedBlock: stable ? block.number : undefined,
    lastPricedTimestamp: stable ? BigInt(block.timestamp) : undefined,
  };
  context.Token.set(token);
  return token;
}

/**
 * Ensure a PoolPair entity exists for (pool, mainIdx, refIdx). Curve
 * cryptoswap pools treat coin 0 as the reference (pricing unit), so we create
 * one PoolPair per non-base coin: (1, 0) for twocrypto, plus (2, 0) for
 * tricrypto.
 */
export function poolPairId(poolId: string, mainIdx: number, refIdx: number) {
  return `${poolId}_${mainIdx}_${refIdx}`;
}

export async function ensurePoolPair(
  context: any,
  pool: Pool,
  mainIdx: number,
  refIdx: number,
): Promise<PoolPair> {
  const id = poolPairId(pool.id, mainIdx, refIdx);
  const existing = await context.PoolPair.get(id);
  if (existing) return existing;

  const mainAddr = pool.coinAddresses[mainIdx];
  const refAddr = pool.coinAddresses[refIdx];
  if (!mainAddr || !refAddr) {
    throw new Error(
      `Pool ${pool.id} missing coin address at index ${mainIdx} or ${refIdx}`,
    );
  }

  const pair: PoolPair = {
    id,
    pool_id: pool.id,
    mainTokenIndex: mainIdx,
    referenceTokenIndex: refIdx,
    mainToken_id: tokenId(pool.chainId, mainAddr),
    referenceToken_id: tokenId(pool.chainId, refAddr),
  };
  context.PoolPair.set(pair);
  return pair;
}

/**
 * Seed the PoolPair entities for a pool. For cryptoswap pools we always
 * treat coin 0 as the reference. 2-coin → 1 pair; 3-coin → 2 pairs.
 */
export async function ensureAllPoolPairs(context: any, pool: Pool) {
  for (let i = 1; i < pool.nCoins; i++) {
    await ensurePoolPair(context, pool, i, 0);
  }
}

/**
 * Convert a raw bigint amount with a given number of decimals into a
 * BigDecimal (human-readable units). Curve emits token amounts as uint256
 * in the token's native decimals, so we divide by 10^decimals.
 */
export function toDecimal(amount: bigint, decimals: number): BigDecimal {
  return new BigDecimal(amount.toString()).dividedBy(
    new BigDecimal(10).pow(decimals),
  );
}

export type PricingResult = {
  price: BigDecimal;
  usdMainPrice: BigDecimal | undefined;
  usdMainVolume: BigDecimal | undefined;
  usdReferencePrice: BigDecimal | undefined;
  usdReferenceVolume: BigDecimal | undefined;
  usdFee: BigDecimal | undefined;
  tokensSoldDecimal: BigDecimal;
  tokensBoughtDecimal: BigDecimal;
  feeDecimal: BigDecimal | undefined;
  // Updated token entities to persist. May be empty if nothing changed.
  tokenUpdates: Token[];
};

/**
 * Core pricing computation for a single TokenExchange swap.
 *
 * Given the pool pair (main, reference), the sold/bought coin indices, the
 * swap amounts, and the current Token entities:
 *
 *  - Compute the swap-implied price (main per reference or vice versa).
 *  - If only one side has a usdPrice, derive the other side's price from the
 *    swap ratio and return an updated Token entity to persist.
 *  - Compute usd_main_volume and usd_reference_volume from the (possibly
 *    newly derived) usd prices.
 *  - Compute usd_fee if the main token has a USD price and a fee was emitted.
 *
 * Everything is best-effort — if neither coin has a known price, USD fields
 * are undefined and `isRelevant = false`.
 */
export function computePricing(
  chainId: number,
  pair: PoolPair,
  tokens: {
    main: Token;
    reference: Token;
    sold: Token;
    bought: Token;
  },
  soldIdx: number,
  boughtIdx: number,
  tokensSold: bigint,
  tokensBought: bigint,
  fee: bigint | undefined,
  block: { number: number; timestamp: number },
): PricingResult {
  const tokensSoldDecimal = toDecimal(tokensSold, tokens.sold.decimals);
  const tokensBoughtDecimal = toDecimal(tokensBought, tokens.bought.decimals);

  // The "price" field on PoolPrice is main-per-reference: how many units of
  // reference token per unit of main token. We compute it from the swap's
  // directional exchange rate.
  //
  // If sold == main: main was sold, reference was bought
  //   price = tokensBought / tokensSold = reference per main
  // If sold == reference: reference was sold, main was bought
  //   price = tokensSold / tokensBought = reference per main
  let price = ZERO;
  if (
    tokensSoldDecimal.isGreaterThan(0) &&
    tokensBoughtDecimal.isGreaterThan(0)
  ) {
    if (soldIdx === pair.mainTokenIndex) {
      price = tokensBoughtDecimal.dividedBy(tokensSoldDecimal);
    } else {
      price = tokensSoldDecimal.dividedBy(tokensBoughtDecimal);
    }
  }

  // Derive missing usdPrice from the swap. We trust a priced side and
  // propagate to the unpriced side via the swap ratio.
  const tokenUpdates: Token[] = [];
  let soldUsdPrice = tokens.sold.usdPrice;
  let boughtUsdPrice = tokens.bought.usdPrice;

  if (
    soldUsdPrice !== undefined &&
    boughtUsdPrice === undefined &&
    tokensBoughtDecimal.isGreaterThan(0)
  ) {
    // bought_usd = (tokens_sold × sold_usd) / tokens_bought
    boughtUsdPrice = tokensSoldDecimal
      .multipliedBy(soldUsdPrice)
      .dividedBy(tokensBoughtDecimal);
    if (!tokens.bought.isStablecoin) {
      tokenUpdates.push({
        ...tokens.bought,
        usdPrice: boughtUsdPrice,
        priceSource: "DERIVED",
        lastPricedBlock: block.number,
        lastPricedTimestamp: BigInt(block.timestamp),
      });
    }
  } else if (
    boughtUsdPrice !== undefined &&
    soldUsdPrice === undefined &&
    tokensSoldDecimal.isGreaterThan(0)
  ) {
    // sold_usd = (tokens_bought × bought_usd) / tokens_sold
    soldUsdPrice = tokensBoughtDecimal
      .multipliedBy(boughtUsdPrice)
      .dividedBy(tokensSoldDecimal);
    if (!tokens.sold.isStablecoin) {
      tokenUpdates.push({
        ...tokens.sold,
        usdPrice: soldUsdPrice,
        priceSource: "DERIVED",
        lastPricedBlock: block.number,
        lastPricedTimestamp: BigInt(block.timestamp),
      });
    }
  } else if (soldUsdPrice !== undefined && boughtUsdPrice !== undefined) {
    // Both already priced — refresh the non-stablecoin, non-reference side
    // from the current swap. This keeps derived prices current as liquidity
    // conditions shift, matching the "update on every swap" approach used by
    // the Uniswap V3/V4 indexers.
    const candidate =
      tokens.sold.priceSource === "DERIVED" &&
      tokensSoldDecimal.isGreaterThan(0) &&
      tokensBoughtDecimal.isGreaterThan(0) &&
      boughtUsdPrice !== undefined
        ? "sold"
        : tokens.bought.priceSource === "DERIVED" &&
            tokensSoldDecimal.isGreaterThan(0) &&
            tokensBoughtDecimal.isGreaterThan(0)
          ? "bought"
          : null;
    if (candidate === "sold") {
      const refreshed = tokensBoughtDecimal
        .multipliedBy(boughtUsdPrice)
        .dividedBy(tokensSoldDecimal);
      soldUsdPrice = refreshed;
      tokenUpdates.push({
        ...tokens.sold,
        usdPrice: refreshed,
        priceSource: "DERIVED",
        lastPricedBlock: block.number,
        lastPricedTimestamp: BigInt(block.timestamp),
      });
    } else if (candidate === "bought") {
      const refreshed = tokensSoldDecimal
        .multipliedBy(soldUsdPrice)
        .dividedBy(tokensBoughtDecimal);
      boughtUsdPrice = refreshed;
      tokenUpdates.push({
        ...tokens.bought,
        usdPrice: refreshed,
        priceSource: "DERIVED",
        lastPricedBlock: block.number,
        lastPricedTimestamp: BigInt(block.timestamp),
      });
    }
  }

  // Volumes — main and reference are the pair's canonical (main, reference)
  // tokens, regardless of swap direction. If main == sold, main volume is
  // tokens_sold; else it's tokens_bought.
  const mainVolumeAmount =
    soldIdx === pair.mainTokenIndex ? tokensSoldDecimal : tokensBoughtDecimal;
  const referenceVolumeAmount =
    soldIdx === pair.referenceTokenIndex
      ? tokensSoldDecimal
      : tokensBoughtDecimal;

  const mainUsdPrice =
    pair.mainTokenIndex === soldIdx ? soldUsdPrice : boughtUsdPrice;
  const referenceUsdPrice =
    pair.referenceTokenIndex === soldIdx ? soldUsdPrice : boughtUsdPrice;

  const usdMainVolume =
    mainUsdPrice !== undefined
      ? mainVolumeAmount.multipliedBy(mainUsdPrice)
      : undefined;
  const usdReferenceVolume =
    referenceUsdPrice !== undefined
      ? referenceVolumeAmount.multipliedBy(referenceUsdPrice)
      : undefined;

  // Fees in Curve cryptoswap pools are charged in units of the main token
  // (the non-base coin). We convert using main's decimals.
  let feeDecimal: BigDecimal | undefined;
  let usdFee: BigDecimal | undefined;
  if (fee !== undefined && fee > 0n) {
    feeDecimal = toDecimal(fee, tokens.main.decimals);
    if (mainUsdPrice !== undefined) {
      usdFee = feeDecimal.multipliedBy(mainUsdPrice);
    }
  }

  return {
    price,
    usdMainPrice: mainUsdPrice,
    usdMainVolume,
    usdReferencePrice: referenceUsdPrice,
    usdReferenceVolume,
    usdFee,
    tokensSoldDecimal,
    tokensBoughtDecimal,
    feeDecimal,
    tokenUpdates,
  };
}

/**
 * Pick the PoolPair for a swap. Curve cryptoswap pools always reference coin
 * 0, so the "main" coin is the non-base side. For cross-pair swaps in
 * tricrypto (coin 1 ↔ coin 2, neither being coin 0), we default to the
 * sold-side coin as main.
 */
export function pairIdForSwap(
  pool: Pool,
  soldIdx: number,
  boughtIdx: number,
): string {
  if (soldIdx === 0) return poolPairId(pool.id, boughtIdx, 0);
  if (boughtIdx === 0) return poolPairId(pool.id, soldIdx, 0);
  return poolPairId(pool.id, soldIdx, 0);
}

/**
 * Recompute the Pool's tvl_usd from current balances + token USD prices.
 * Returns undefined if any coin lacks a usdPrice.
 */
export function computeTvlUsd(
  pool: Pool,
  tokens: (Token | undefined)[],
): BigDecimal | undefined {
  let total = ZERO;
  for (let i = 0; i < pool.nCoins; i++) {
    const t = tokens[i];
    const bal = pool.balances[i];
    const dec = pool.coinDecimals[i];
    if (!t || t.usdPrice === undefined || bal === undefined || dec === undefined)
      return undefined;
    total = total.plus(toDecimal(bal, dec).multipliedBy(t.usdPrice));
  }
  return total;
}
