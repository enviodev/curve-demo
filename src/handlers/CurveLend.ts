import { indexer, BigDecimal } from "envio";
import { getTokenSymbol, getTokenDecimals } from "../effects.js";
import { tokenId } from "../constants.js";
import { ensureToken, toDecimal } from "../pricing.js";

// crvUSD/Lend controllers occasionally emit a max-uint256 sentinel for
// collateral/debt (special accounts). Treat any absurd value as 0 so it never
// pollutes a per-user loan or a market aggregate.
const SANE_MAX = 2n ** 200n;
const sane = (x: bigint): bigint => (x >= SANE_MAX ? 0n : x);

// Daily per-market snapshot, keyed by chainId_controller_day. set() overwrites
// the day's row with the latest market state (last-write-wins per day).
async function upsertMarketSnapshot(
  context: any,
  market: any,
  block: { number: number; timestamp: number },
) {
  const day = Math.floor(block.timestamp / 86400);
  context.MarketSnapshot.set({
    id: `${market.chainId}_${market.controller}_${day}`,
    chainId: market.chainId,
    market_id: market.id,
    day,
    timestamp: BigInt(block.timestamp),
    blockNumber: block.number,
    totalDebt: market.totalDebt,
    totalCollateral: market.totalCollateral,
    totalDebtUsd: market.totalDebtUsd,
    nLoans: market.nLoans,
    rate: market.rate,
  });
}

// Curve Lend (one-way lending markets). The OneWayLendingFactory's NewVault
// event carries every address, so the Controller + LLAMMA AMM are registered
// directly. The Controller's UserState event is the canonical per-user state
// (collateral, debt, soft-liquidation band range n1..n2); Borrow/Repay/
// Liquidate form the position lifecycle. The same engine is reused for crvUSD
// mint markets (different registration factory, identical Controller/AMM).

// --- Registration -----------------------------------------------------------

indexer.contractRegister(
  { contract: "OneWayLendingFactory", event: "NewVault" },
  async ({ event, context }) => {
    context.chain.LendController.add(event.params.controller);
    context.chain.LendAMM.add(event.params.amm);
    context.chain.LendVault.add(event.params.vault);
  },
);

indexer.onEvent(
  { contract: "OneWayLendingFactory", event: "NewVault" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const controller = event.params.controller.toLowerCase();
    const collateral = event.params.collateral_token.toLowerCase();
    const borrowed = event.params.borrowed_token.toLowerCase();

    const [colSym, colDec, borSym, borDec] = await Promise.all([
      context.effect(getTokenSymbol, { chainId, address: collateral }),
      context.effect(getTokenDecimals, { chainId, address: collateral }),
      context.effect(getTokenSymbol, { chainId, address: borrowed }),
      context.effect(getTokenDecimals, { chainId, address: borrowed }),
    ]);
    await ensureToken(context, chainId, collateral, colSym, colDec, event.block);
    await ensureToken(context, chainId, borrowed, borSym, borDec, event.block);

    context.Market.set({
      id: `${chainId}_${controller}`,
      chainId,
      marketType: "LEND",
      controller,
      amm: event.params.amm.toLowerCase(),
      vault: event.params.vault.toLowerCase(),
      collateralToken_id: tokenId(chainId, collateral),
      borrowedToken_id: tokenId(chainId, borrowed),
      monetaryPolicy: event.params.monetary_policy.toLowerCase(),
      priceOracle: event.params.price_oracle.toLowerCase(),
      totalDebt: 0n,
      totalCollateral: 0n,
      totalDebtUsd: undefined,
      totalCollateralUsd: undefined,
      totalSupplied: 0n,
      totalSuppliedUsd: undefined,
      nLoans: 0,
      rate: undefined,
      createdBlock: event.block.number,
      createdTimestamp: BigInt(event.block.timestamp),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

// --- crvUSD mint markets (same engine, different registration factory) ------

const CRVUSD: Record<number, string> = {
  1: "0xf939e0a03fb07f59a73314e73794be0e57ac1b4e",
};

indexer.contractRegister(
  { contract: "CrvUsdControllerFactory", event: "AddMarket" },
  async ({ event, context }) => {
    context.chain.LendController.add(event.params.controller);
    context.chain.LendAMM.add(event.params.amm);
  },
);

indexer.onEvent(
  { contract: "CrvUsdControllerFactory", event: "AddMarket" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const controller = event.params.controller.toLowerCase();
    const collateral = event.params.collateral.toLowerCase();
    const borrowed = CRVUSD[chainId];
    if (!borrowed) return;

    const [colSym, colDec] = await Promise.all([
      context.effect(getTokenSymbol, { chainId, address: collateral }),
      context.effect(getTokenDecimals, { chainId, address: collateral }),
    ]);
    await ensureToken(context, chainId, collateral, colSym, colDec, event.block);
    await ensureToken(context, chainId, borrowed, "crvUSD", 18, event.block);

    context.Market.set({
      id: `${chainId}_${controller}`,
      chainId,
      marketType: "CRVUSD_MINT",
      controller,
      amm: event.params.amm.toLowerCase(),
      vault: undefined,
      collateralToken_id: tokenId(chainId, collateral),
      borrowedToken_id: tokenId(chainId, borrowed),
      monetaryPolicy: event.params.monetary_policy.toLowerCase(),
      priceOracle: undefined,
      totalDebt: 0n,
      totalCollateral: 0n,
      totalDebtUsd: undefined,
      totalCollateralUsd: undefined,
      totalSupplied: 0n,
      totalSuppliedUsd: undefined,
      nLoans: 0,
      rate: undefined,
      createdBlock: event.block.number,
      createdTimestamp: BigInt(event.block.timestamp),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

// --- Per-user position state (canonical) ------------------------------------

indexer.onEvent(
  { contract: "LendController", event: "UserState" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const controller = event.srcAddress.toLowerCase();
    const marketId = `${chainId}_${controller}`;
    const market = await context.Market.get(marketId);
    if (!market) return;

    const user = event.params.user.toLowerCase();
    const loanId = `${marketId}_${user}`;
    const existing = await context.Loan.get(loanId);
    const oldDebt = existing?.debt ?? 0n;
    const oldCollateral = existing?.collateral ?? 0n;
    const newDebt = sane(event.params.debt);
    const newCollateral = sane(event.params.collateral);
    const closed = newDebt === 0n && newCollateral === 0n;

    const [colTok, borTok] = await Promise.all([
      context.Token.get(market.collateralToken_id),
      context.Token.get(market.borrowedToken_id),
    ]);
    const collateralUsd =
      colTok?.usdPrice !== undefined
        ? toDecimal(newCollateral, colTok.decimals).multipliedBy(colTok.usdPrice)
        : undefined;
    const debtUsd =
      borTok?.usdPrice !== undefined
        ? toDecimal(newDebt, borTok.decimals).multipliedBy(borTok.usdPrice)
        : undefined;

    if (closed && existing) {
      context.Loan.set({
        ...existing,
        collateral: 0n,
        debt: 0n,
        collateralUsd: undefined,
        debtUsd: undefined,
        n1: event.params.n1,
        n2: event.params.n2,
        isActive: false,
        lastUpdatedBlock: event.block.number,
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    } else if (!closed) {
      context.Loan.set({
        id: loanId,
        chainId,
        market_id: marketId,
        user,
        collateral: newCollateral,
        debt: newDebt,
        collateralUsd,
        debtUsd,
        n1: event.params.n1,
        n2: event.params.n2,
        liquidationDiscount: event.params.liquidation_discount,
        isActive: true,
        createdBlock: existing?.createdBlock ?? event.block.number,
        createdTimestamp: existing?.createdTimestamp ?? BigInt(event.block.timestamp),
        lastUpdatedBlock: event.block.number,
        lastUpdatedTimestamp: BigInt(event.block.timestamp),
      });
    }

    // Maintain market aggregates (and USD totals) from the per-user delta.
    const wasActive = existing?.isActive ?? false;
    const nowActive = !closed;
    const nLoansDelta = (nowActive ? 1 : 0) - (wasActive ? 1 : 0);
    const totalDebt = market.totalDebt + (newDebt - oldDebt);
    const totalCollateral =
      market.totalCollateral + (newCollateral - oldCollateral);
    const updatedMarket = {
      ...market,
      totalDebt,
      totalCollateral,
      totalDebtUsd:
        borTok?.usdPrice !== undefined
          ? toDecimal(totalDebt, borTok.decimals).multipliedBy(borTok.usdPrice)
          : undefined,
      totalCollateralUsd:
        colTok?.usdPrice !== undefined
          ? toDecimal(totalCollateral, colTok.decimals).multipliedBy(
              colTok.usdPrice,
            )
          : undefined,
      nLoans: market.nLoans + nLoansDelta,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    };
    context.Market.set(updatedMarket);
    await upsertMarketSnapshot(context, updatedMarket, event.block);
  },
);

// --- Position lifecycle events ----------------------------------------------

function loanEventId(event: { chainId: number; block: { number: number }; logIndex: number }) {
  return `${event.chainId}_${event.block.number}_${event.logIndex}`;
}

indexer.onEvent(
  { contract: "LendController", event: "Borrow" },
  async ({ event, context }) => {
    context.LoanEvent.set({
      id: loanEventId(event),
      chainId: event.chainId,
      market_id: `${event.chainId}_${event.srcAddress.toLowerCase()}`,
      user: event.params.user.toLowerCase(),
      kind: "BORROW",
      collateralChange: event.params.collateral_increase,
      debtChange: event.params.loan_increase,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "LendController", event: "Repay" },
  async ({ event, context }) => {
    context.LoanEvent.set({
      id: loanEventId(event),
      chainId: event.chainId,
      market_id: `${event.chainId}_${event.srcAddress.toLowerCase()}`,
      user: event.params.user.toLowerCase(),
      kind: "REPAY",
      collateralChange: event.params.collateral_decrease,
      debtChange: event.params.loan_decrease,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "LendController", event: "RemoveCollateral" },
  async ({ event, context }) => {
    context.LoanEvent.set({
      id: loanEventId(event),
      chainId: event.chainId,
      market_id: `${event.chainId}_${event.srcAddress.toLowerCase()}`,
      user: event.params.user.toLowerCase(),
      kind: "REMOVE_COLLATERAL",
      collateralChange: event.params.collateral_decrease,
      debtChange: 0n,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "LendController", event: "Liquidate" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const marketId = `${chainId}_${event.srcAddress.toLowerCase()}`;
    const user = event.params.user.toLowerCase();
    const liquidator = event.params.liquidator.toLowerCase();

    context.Liquidation.set({
      id: loanEventId(event),
      chainId,
      market_id: marketId,
      user,
      liquidator,
      collateralReceived: event.params.collateral_received,
      stablecoinReceived: event.params.stablecoin_received,
      debt: event.params.debt,
      isSelf: user === liquidator,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
    context.LoanEvent.set({
      id: `${loanEventId(event)}_liq`,
      chainId,
      market_id: marketId,
      user,
      kind: "LIQUIDATE",
      collateralChange: event.params.collateral_received,
      debtChange: event.params.debt,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);

// --- Borrow rate (from the LLAMMA) ------------------------------------------

indexer.onEvent(
  { contract: "LendAMM", event: "SetRate" },
  async ({ event, context }) => {
    const amm = event.srcAddress.toLowerCase();
    const markets = await context.Market.getWhere({ amm: { _eq: amm } });
    const market = markets[0];
    if (!market) return;
    context.Market.set({
      ...market,
      rate: event.params.rate,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

// --- LLAMMA soft-liquidation trades -----------------------------------------

indexer.onEvent(
  { contract: "LendAMM", event: "TokenExchange" },
  async ({ event, context }) => {
    const amm = event.srcAddress.toLowerCase();
    const markets = await context.Market.getWhere({ amm: { _eq: amm } });
    const market = markets[0];
    if (!market) return;
    context.AmmSwap.set({
      id: `${event.chainId}_${event.block.number}_${event.logIndex}`,
      chainId: event.chainId,
      market_id: market.id,
      buyer: event.params.buyer.toLowerCase(),
      soldId: Number(event.params.sold_id),
      boughtId: Number(event.params.bought_id),
      tokensSold: event.params.tokens_sold,
      tokensBought: event.params.tokens_bought,
      blockNumber: event.block.number,
      timestamp: BigInt(event.block.timestamp),
    });
  },
);

// --- Lend vault (lender / supply side, ERC4626) -----------------------------

async function vaultMarket(context: any, vault: string) {
  const markets = await context.Market.getWhere({ vault: { _eq: vault } });
  return markets[0];
}

indexer.onEvent(
  { contract: "LendVault", event: "Deposit" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const vault = event.srcAddress.toLowerCase();
    const market = await vaultMarket(context, vault);
    if (!market) return;
    const user = event.params.owner.toLowerCase();
    const posId = `${chainId}_${vault}_${user}`;
    const existing = await context.VaultPosition.get(posId);
    context.VaultPosition.set({
      id: posId,
      chainId,
      market_id: market.id,
      user,
      shares: (existing?.shares ?? 0n) + event.params.shares,
      isActive: true,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
    context.Market.set({
      ...market,
      totalSupplied: market.totalSupplied + event.params.assets,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "LendVault", event: "Withdraw" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const vault = event.srcAddress.toLowerCase();
    const market = await vaultMarket(context, vault);
    if (!market) return;
    const user = event.params.owner.toLowerCase();
    const posId = `${chainId}_${vault}_${user}`;
    const existing = await context.VaultPosition.get(posId);
    const newShares = (existing?.shares ?? 0n) - event.params.shares;
    context.VaultPosition.set({
      id: posId,
      chainId,
      market_id: market.id,
      user,
      shares: newShares > 0n ? newShares : 0n,
      isActive: newShares > 0n,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
    const newSupplied = market.totalSupplied - event.params.assets;
    context.Market.set({
      ...market,
      totalSupplied: newSupplied > 0n ? newSupplied : 0n,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);
