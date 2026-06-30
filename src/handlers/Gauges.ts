import { indexer } from "envio";

// Gauges + GaugeController. NewGauge (controller) registers the gauge and seeds
// its weight; NewGaugeWeight tracks weight over time; VoteForGauge records
// veCRV holders steering CRV emissions. The gauge itself emits Deposit/Withdraw
// (staked LP) and UpdateLiquidityLimit (boosted working supply).

indexer.contractRegister(
  { contract: "GaugeController", event: "NewGauge" },
  async ({ event, context }) => {
    context.chain.Gauge.add(event.params.addr);
  },
);

indexer.onEvent(
  { contract: "GaugeController", event: "NewGauge" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const id = `${chainId}_${event.params.addr.toLowerCase()}`;
    context.Gauge.set({
      id,
      chainId,
      address: event.params.addr.toLowerCase(),
      gaugeType: Number(event.params.gauge_type),
      weight: event.params.weight,
      totalWeight: 0n,
      totalStaked: 0n,
      workingSupply: 0n,
      isKilled: false,
      createdBlock: event.block.number,
      createdTimestamp: BigInt(event.block.timestamp),
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "GaugeController", event: "NewGaugeWeight" },
  async ({ event, context }) => {
    const id = `${event.chainId}_${event.params.gauge_address.toLowerCase()}`;
    const gauge = await context.Gauge.get(id);
    if (!gauge) return;
    context.Gauge.set({
      ...gauge,
      weight: event.params.weight,
      totalWeight: event.params.total_weight,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "GaugeController", event: "VoteForGauge" },
  async ({ event, context }) => {
    const chainId = event.chainId;
    const id = `${chainId}_${event.params.gauge_addr.toLowerCase()}`;
    context.GaugeVote.set({
      id: `${chainId}_${event.block.number}_${event.logIndex}`,
      chainId,
      gauge_id: id,
      user: event.params.user.toLowerCase(),
      weight: event.params.weight,
      votedAt: event.params.time,
      timestamp: BigInt(event.block.timestamp),
      blockNumber: event.block.number,
    });
  },
);

// --- Gauge contract (staked LP + boost) -------------------------------------

indexer.onEvent(
  { contract: "Gauge", event: "Deposit" },
  async ({ event, context }) => {
    const id = `${event.chainId}_${event.srcAddress.toLowerCase()}`;
    const gauge = await context.Gauge.get(id);
    if (!gauge) return;
    context.Gauge.set({
      ...gauge,
      totalStaked: gauge.totalStaked + event.params.value,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "Gauge", event: "Withdraw" },
  async ({ event, context }) => {
    const id = `${event.chainId}_${event.srcAddress.toLowerCase()}`;
    const gauge = await context.Gauge.get(id);
    if (!gauge) return;
    const next = gauge.totalStaked - event.params.value;
    context.Gauge.set({
      ...gauge,
      totalStaked: next > 0n ? next : 0n,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);

indexer.onEvent(
  { contract: "Gauge", event: "UpdateLiquidityLimit" },
  async ({ event, context }) => {
    const id = `${event.chainId}_${event.srcAddress.toLowerCase()}`;
    const gauge = await context.Gauge.get(id);
    if (!gauge) return;
    context.Gauge.set({
      ...gauge,
      workingSupply: event.params.working_supply,
      lastUpdatedBlock: event.block.number,
      lastUpdatedTimestamp: BigInt(event.block.timestamp),
    });
  },
);
