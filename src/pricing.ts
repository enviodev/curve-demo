import { BigDecimal, type Token, type Pool, type PoolPair } from "envio";
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

  // crvUSD is Curve's own $1-pegged stablecoin and the borrowed asset for every
  // Lend / mint market; recognise it by symbol so it is priced $1 on every chain
  // (the per-chain address list can't keep up with bridged deployments).
  const stable = isStablecoin(chainId, address) || symbol === "crvUSD";
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
  // Consolidated per-swap USD volume to attribute to the pool / globalstate.
  // Defined as the average of main and reference USD legs when both exist
  // (matching Uniswap V4's trackedAmountUSD/2 convention, which avoids
  // double-counting the two sides of a single trade). Falls back to
  // whichever side is defined; undefined if neither is.
  usdVolume: BigDecimal | undefined;
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

  let usdVolume: BigDecimal | undefined;
  if (usdMainVolume !== undefined && usdReferenceVolume !== undefined) {
    usdVolume = usdMainVolume.plus(usdReferenceVolume).dividedBy(2);
  } else if (usdMainVolume !== undefined) {
    usdVolume = usdMainVolume;
  } else if (usdReferenceVolume !== undefined) {
    usdVolume = usdReferenceVolume;
  }

  return {
    price,
    usdMainPrice: mainUsdPrice,
    usdMainVolume,
    usdReferencePrice: referenceUsdPrice,
    usdReferenceVolume,
    usdFee,
    usdVolume,
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
// A Curve pool holds coins pegged to a common unit (all ~$1, all ~BTC, all
// ~gold, and even crypto pools balance to ~equal value per coin), so one coin's
// USD value should never dwarf the others. If a single illiquid coin is
// mispriced by the swap graph (e.g. XAUM at $25M), cap its contribution at this
// multiple of the median coin value so it can't inflate the pool's TVL to
// billions. Healthy pools (values within a small band) are unaffected.
const MAX_COIN_VALUE_RATIO = new BigDecimal("50");

export function computeTvlUsd(
  pool: Pool,
  tokens: (Token | undefined)[],
): BigDecimal | undefined {
  const values: BigDecimal[] = [];
  for (let i = 0; i < pool.nCoins; i++) {
    const t = tokens[i];
    const bal = pool.balances[i];
    const dec = pool.coinDecimals[i];
    if (!t || t.usdPrice === undefined || bal === undefined || dec === undefined)
      return undefined;
    values.push(toDecimal(bal, dec).multipliedBy(t.usdPrice));
  }
  if (values.length === 0) return ZERO;
  const sorted = [...values].sort((a, b) => a.comparedTo(b) ?? 0);
  const median = sorted[Math.floor(sorted.length / 2)] ?? ZERO;
  const cap = median.multipliedBy(MAX_COIN_VALUE_RATIO);
  let total = ZERO;
  for (const v of values) {
    total = total.plus(
      median.isGreaterThan(0) && v.isGreaterThan(cap) ? cap : v,
    );
  }
  return total;
}

/**
 * Price-graph step: derive the USD price of the unpriced (or previously-derived)
 * side of a swap from the priced side, and persist it on the Token. Cycle-safe —
 * never overwrites a stablecoin anchor, and only propagates from a known price.
 * `tokens*Decimal` are human-unit (decimal-normalized) amounts.
 */
// Guards that keep the swap-derived price graph from being corrupted by
// rounding-dust or imbalanced trades (the cause of e.g. an LP token being priced
// at ~$108M and inflating a metapool's TVL to billions):
//  - MIN_AMOUNT: ignore trades where either leg is dust in token units, so a
//    5e-7-token leg can't imply an astronomical price.
//  - MIN_SWAP_USD: only price off trades that move a meaningful amount of value.
//  - MAX_PRICE_RATIO: never let a single trade move a token's existing price by
//    more than 20x — normal volatility passes, garbage is rejected.
const MIN_AMOUNT = new BigDecimal("0.000001");
const MIN_SWAP_USD = new BigDecimal("10");
const MAX_PRICE_RATIO = new BigDecimal("20");

export function deriveAndApplySwapPrice(
  context: any,
  sold: Token,
  bought: Token,
  tokensSoldDecimal: BigDecimal,
  tokensBoughtDecimal: BigDecimal,
  block: { number: number; timestamp: number },
): void {
  if (
    tokensSoldDecimal.isLessThan(MIN_AMOUNT) ||
    tokensBoughtDecimal.isLessThan(MIN_AMOUNT)
  ) {
    return;
  }
  const soldP = sold.usdPrice;
  const boughtP = bought.usdPrice;

  const apply = (token: Token, price: BigDecimal) => {
    if (!price.isGreaterThan(0) || !price.isFinite()) return;
    // Reject outliers relative to the token's current price (first price passes).
    if (token.usdPrice !== undefined && token.usdPrice.isGreaterThan(0)) {
      const ratio = price.dividedBy(token.usdPrice);
      if (
        ratio.isGreaterThan(MAX_PRICE_RATIO) ||
        ratio.isLessThan(ONE_USD.dividedBy(MAX_PRICE_RATIO))
      ) {
        return;
      }
    }
    context.Token.set({
      ...token,
      usdPrice: price,
      priceSource: "DERIVED",
      lastPricedBlock: block.number,
      lastPricedTimestamp: BigInt(block.timestamp),
    });
  };

  if (
    soldP !== undefined &&
    !bought.isStablecoin &&
    (boughtP === undefined || bought.priceSource === "DERIVED")
  ) {
    if (tokensSoldDecimal.multipliedBy(soldP).isLessThan(MIN_SWAP_USD)) return;
    apply(
      bought,
      tokensSoldDecimal.multipliedBy(soldP).dividedBy(tokensBoughtDecimal),
    );
  } else if (
    boughtP !== undefined &&
    !sold.isStablecoin &&
    (soldP === undefined || sold.priceSource === "DERIVED")
  ) {
    if (tokensBoughtDecimal.multipliedBy(boughtP).isLessThan(MIN_SWAP_USD)) return;
    apply(
      sold,
      tokensBoughtDecimal.multipliedBy(boughtP).dividedBy(tokensSoldDecimal),
    );
  }
}

/**
 * Value a pool's own LP token from its TVL / supply, so that when that LP token
 * is itself a coin in a metapool (e.g. crvRenWSBTC inside the tBTC metapool) the
 * metapool's TVL is computed correctly instead of using a swap-derived guess.
 * Only touches non-stablecoin tokens that already exist (i.e. are used elsewhere).
 */
export async function priceLpToken(
  context: any,
  pool: Pool,
  totalSupply: bigint,
  tvlUsd: BigDecimal | undefined,
  block: { number: number; timestamp: number },
): Promise<void> {
  if (tvlUsd === undefined || totalSupply <= 0n) return;
  const lpTok = await context.Token.get(
    tokenId(pool.chainId, pool.lpTokenAddress),
  );
  if (!lpTok || lpTok.isStablecoin) return;
  const price = tvlUsd.dividedBy(toDecimal(totalSupply, 18));
  if (!price.isGreaterThan(0) || !price.isFinite()) return;
  context.Token.set({
    ...lpTok,
    usdPrice: price,
    // POOL_LP is authoritative (TVL / supply) — deriveAndApplySwapPrice only
    // overwrites DERIVED prices, so a metapool swap can't clobber this with a
    // bad guess (the 3Crv-reads-$11 regression).
    priceSource: "POOL_LP",
    lastPricedBlock: block.number,
    lastPricedTimestamp: BigInt(block.timestamp),
  });
}

/**
 * Upsert the pool's daily snapshot (TVL / virtual price / balances + accumulated
 * volume and swap count). Keyed by chainId_poolAddress_day so a day's row is
 * updated in place as more events land.
 */
export async function upsertDailySnapshot(
  context: any,
  pool: Pool,
  block: { number: number; timestamp: number },
  addedVolumeUsd: BigDecimal,
  swapInc: number,
): Promise<void> {
  const day = Math.floor(block.timestamp / 86400);
  const id = `${pool.chainId}_${pool.address}_${day}`;
  const existing = await context.PoolSnapshot.get(id);
  if (existing) {
    context.PoolSnapshot.set({
      ...existing,
      timestamp: BigInt(block.timestamp),
      blockNumber: block.number,
      tvlUsd: pool.tvlUsd,
      virtualPrice: pool.virtualPrice,
      balances: pool.balances,
      volumeUsd: existing.volumeUsd.plus(addedVolumeUsd),
      swapCount: existing.swapCount + swapInc,
    });
  } else {
    context.PoolSnapshot.set({
      id,
      chainId: pool.chainId,
      pool_id: pool.id,
      day,
      timestamp: BigInt(block.timestamp),
      blockNumber: block.number,
      tvlUsd: pool.tvlUsd,
      virtualPrice: pool.virtualPrice,
      balances: pool.balances,
      volumeUsd: addedVolumeUsd,
      swapCount: swapInc,
    });
  }
}
