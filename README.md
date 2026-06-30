# Curve Finance Multichain Indexer

A comprehensive [Envio HyperIndex](https://envio.dev) indexer for the entire
[Curve Finance](https://curve.finance) protocol across **11 chains** — pools,
swaps, crvUSD, Curve Lend, gauges, veCRV, fees and peg stability — served over
both a GraphQL API (Postgres) and a columnar analytics store (ClickHouse).

It is designed to be an open, real-time, multichain alternative to Curve's
internal `prices.curve.finance`, and to expose data that service does not — most
notably **per-user crvUSD / Curve Lend health, soft-liquidation bands and
position history**.

## What it indexes

| Domain | Coverage |
| --- | --- |
| **Stableswap-NG** | Plain + meta pools on all 11 chains — swaps, liquidity, balances, virtual price, TVL |
| **Legacy stableswap** | 3pool, sUSD, BTC/ETH and other registry pools (Ethereum) |
| **Crypto pools** | Tricrypto-NG, Twocrypto-NG/V1 and standalone pools — oracle pricing |
| **crvUSD mint** | Markets, **per-user loans** (collateral/debt, soft-liq band range `n1..n2`), borrow/repay/liquidate events, liquidations |
| **Curve Lend** | One-way lending markets on 5 chains — borrow **and** supply side (lender vault positions, utilisation) |
| **LLAMMA** | Soft-liquidation AMM trades for both crvUSD and Lend |
| **scrvUSD** | Savings vault (ERC-4626) supply + per-depositor positions |
| **PegKeepers** | The 5 v2 keepers — provide/withdraw/profit + the live crvUSD peg price |
| **Gauges** | `GaugeController` weights, staked LP, working supply, votes (CRV emissions) |
| **veCRV** | Per-user locks, total locked supply |
| **Fees** | `FeeDistributor` weekly distributions + claims (protocol revenue) |
| **Pricing** | Swap-derived USD price graph + daily pool/market snapshots |

**Chains:** Ethereum, Arbitrum, Optimism, Base, Polygon, Gnosis, BSC, Fantom,
Fraxtal, Sonic, Avalanche.

## Architecture highlights

- **Shared Controller + LLAMMA engine** — crvUSD mint and Curve Lend use the same
  contract design, so one handler set (`src/handlers/CurveLend.ts`) powers both;
  they differ only in the registering factory.
- **USD price graph** — token prices propagate across swaps from known
  stablecoins, so pool TVL and trade volume are valued without external oracles.
- **Event-sourced pool balances** — stableswap balances are derived from event
  amounts on every swap/liquidity event; the authoritative on-chain read (A +
  virtual price + reconcile) is throttled to once per pool per day.
- **Resilient RPC** — `safeMulticall` falls back to individual `eth_call`s for
  historical blocks before multicall3 (Ethereum block 14353601).

## Storage: Postgres + ClickHouse

Every entity is dual-written to **both** backends (see the `storage:` block in
`config.yaml`):

- **Postgres** serves the GraphQL API (via Hasura) at http://localhost:8080
- **ClickHouse** is a columnar store for heavy analytical queries

`pnpm dev` auto-provisions Postgres, Hasura **and** ClickHouse as local Docker
containers — no external services required. For a managed ClickHouse, set
`ENVIO_CLICKHOUSE_HOST` / `_DATABASE` / `_USERNAME` / `_PASSWORD` in `.env`.

## Quick start

```bash
pnpm install
pnpm dev
```

Then open the GraphQL playground at http://localhost:8080 (admin secret:
`testing`). The `dev`/`start` scripts set `ENVIO_INDEXING_MAX_BUFFER_SIZE=50000`
to bound the multichain fetch buffer (keeps memory ~1.4 GB on a full sync).

Regenerate types after editing `config.yaml` or `schema.graphql`:

```bash
pnpm codegen
```

## Example queries

**Per-user crvUSD / Lend health** — the data Curve's public API doesn't expose:

```graphql
{
  Loan(where: { isActive: { _eq: true } }, order_by: { debtUsd: desc }, limit: 5) {
    user
    market { collateralToken { symbol } marketType }
    collateral
    debt
    debtUsd
    n1   # lower soft-liquidation band
    n2   # upper soft-liquidation band
    liquidationDiscount
  }
}
```

**Top pools by TVL across all chains:**

```graphql
{
  Pool(where: { tvlUsd: { _is_null: false } }, order_by: { tvlUsd: desc }, limit: 10) {
    chainId
    symbol
    poolType
    tvlUsd
  }
}
```

**crvUSD peg defense** — keeper reserves and the live peg:

```graphql
{
  PegKeeper(order_by: { debt: desc }) { stablecoin debt totalProvided totalProfit }
}
```

Run analytical queries directly against ClickHouse:

```bash
docker exec envio-clickhouse clickhouse-client \
  --query "SELECT stablecoin, round(toFloat64(debt)/1e18,0) AS debt FROM default.PegKeeper ORDER BY debt DESC"
```

## Performance

Powered by [HyperSync](https://docs.envio.dev/docs/HyperIndex/hypersync). The
indexer is fetch-bound — handlers run in sub-microseconds and on-chain reads are
cached/throttled — so throughput tracks HyperSync's fetch rate (multiple
thousands of events/sec per chain). Prometheus metrics are exposed on `:9898`.

## Pre-requisites

- [Node.js v22+ (v24 recommended)](https://nodejs.org/en/download/current)
- [pnpm v8+](https://pnpm.io/installation)
- [Docker](https://www.docker.com/products/docker-desktop/) or [Podman](https://podman.io/)

See the [Envio documentation](https://docs.envio.dev) for a full guide to
HyperIndex features.
