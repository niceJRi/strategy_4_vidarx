import { Logger } from '@nestjs/common';
import { OrderType, Side } from '@polymarket/clob-client';
import { OrderService } from '../order/order.service.js';
import { EndDateContext, TokenIdContext } from '../context/market.js';

export type Strategy9Config = {
  enabled: boolean;
  observeSec: number;
  stopBeforeEndSec: number;
  trendWindowMs: number;
  cycleMs: number;
  cooldownMs: number;

  trendMinMove: number;
  reversalMove: number;

  minImbalance: number;
  minEdge: number;
  maxPairPrice: number;

  targetTrendSharesPerCycle: number;
  minChunkShares: number;
  maxChunkShares: number;
  hedgeChunkShares: number;
  minHedgeTriggerShares: number;

  slippageBuffer: number;
  maxTradePrice: number;

  maxOrdersPerMarket: number;
  maxTotalSpentUsdc: number;
  maxSideSpentUsdc: number;

  flipConfirmTicks: number;
  scoreTrendWeight: number;
  scoreEdgeWeight: number;

  leaderMinGap: number;
  hedgeRatio: number;
  hedgeMaxPrice: number;
  burstCount: number;
  burstSpacingMs: number;
  flipMinGap: number;
};

type TrendSide = 'UP' | 'DOWN';
type TrendDirection = TrendSide | 'FLAT';

type PricePoint = {
  ts: number;
  upAsk: number;
  downAsk: number;
};

type MarketState = {
  firstSeenAt: number;
  lastActionAt: number;
  lastLiveLogAt: number;
  orderCount: number;
  closed: boolean;

  spentUpUsdc: number;
  spentDownUsdc: number;
  sharesUp: number;
  sharesDown: number;

  history: PricePoint[];

  cycleStartedAt: number;
  cycleTrend: TrendDirection;
  cycleTrendShares: number;
  cycleTrendSpentUsdc: number;

  pendingFlipSide: TrendSide | null;
  pendingFlipCount: number;
};

const strategy9State = new Map<string, MarketState>();

function getDefaultState(now: number): MarketState {
  return {
    firstSeenAt: now,
    lastActionAt: 0,
    lastLiveLogAt: 0,
    orderCount: 0,
    closed: false,

    spentUpUsdc: 0,
    spentDownUsdc: 0,
    sharesUp: 0,
    sharesDown: 0,

    history: [],

    cycleStartedAt: now,
    cycleTrend: 'FLAT',
    cycleTrendShares: 0,
    cycleTrendSpentUsdc: 0,

    pendingFlipSide: null,
    pendingFlipCount: 0,
  };
}

function round6(v: number) {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function fmt3(v: number) {
  return Number.isFinite(v) ? v.toFixed(3) : 'NaN';
}

function fmt6(v: number) {
  return Number.isFinite(v) ? v.toFixed(6) : 'NaN';
}

function logPrefix(timestamp: any, marketSlug: string) {
  return `${timestamp} | ${Date.now()} | ${marketSlug}`;
}

function log(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  tag: string,
  msg: string,
) {
  logger.log(`${logPrefix(timestamp, marketSlug)} | ${tag} | ${msg}`);
}

function getAcceptedOrder(response: any) {
  return !!response && (
    response.success === true ||
    response.orderID ||
    response.orderId ||
    response.status === 'live' ||
    response.status === 'matched' ||
    response.accepted === true
  );
}

/**
 * Extracts actual fill from a real Polymarket OrderResponse.
 *   takingAmount (string) = shares received for a BUY
 *   makingAmount (string) = USDC spent for a BUY
 * Falls back to full requested size if the API doesn't return fill detail
 * (e.g. paper mode responses or legacy API versions).
 */
function parseFillFromResponse(
  response: any,
  requestedShares: number,
  askPrice: number,
): { filledShares: number; filledUsdc: number } {
  if (!response) return { filledShares: 0, filledUsdc: 0 };

  if (response.takingAmount != null && response.makingAmount != null) {
    const filledShares = round6(parseFloat(response.takingAmount) || 0);
    const filledUsdc = round6(parseFloat(response.makingAmount) || 0);
    return { filledShares, filledUsdc };
  }

  // Fallback: accepted order with no fill detail → treat as fully filled
  if (getAcceptedOrder(response)) {
    return {
      filledShares: requestedShares,
      filledUsdc: round6(requestedShares * askPrice),
    };
  }

  return { filledShares: 0, filledUsdc: 0 };
}

function trimHistory(history: PricePoint[], now: number, maxMs: number) {
  const cutoff = now - maxMs;
  while (history.length > 0 && history[0].ts < cutoff) {
    history.shift();
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function avgPrice(spentUsdc: number, shares: number): number {
  if (shares <= 0) return 0;
  return spentUsdc / shares;
}

function totalSpent(state: MarketState): number {
  return round6(state.spentUpUsdc + state.spentDownUsdc);
}

function upReward(state: MarketState): number {
  return round6(state.sharesUp - totalSpent(state));
}

function downReward(state: MarketState): number {
  return round6(state.sharesDown - totalSpent(state));
}

function shouldCloseMarketByReward(state: MarketState): boolean {
  return upReward(state) > 1 && downReward(state) > 1;
}

function oppositeSide(side: TrendSide): TrendSide {
  return side === 'UP' ? 'DOWN' : 'UP';
}

function getLatest(history: PricePoint[]) {
  return history.length > 0 ? history[history.length - 1] : null;
}

function getWindowOldest(history: PricePoint[], trendWindowMs: number) {
  if (history.length === 0) return null;
  const newest = history[history.length - 1];
  const oldestAllowedTs = newest.ts - trendWindowMs;

  for (const p of history) {
    if (p.ts >= oldestAllowedTs) return p;
  }

  return history[0];
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getSideShares(state: MarketState, side: TrendSide) {
  return side === 'UP' ? state.sharesUp : state.sharesDown;
}

function getSideSpent(state: MarketState, side: TrendSide) {
  return side === 'UP' ? state.spentUpUsdc : state.spentDownUsdc;
}

function getCycleTrendAvg(state: MarketState, side: TrendSide) {
  if (state.cycleTrend === side && state.cycleTrendShares > 0) {
    return round6(state.cycleTrendSpentUsdc / state.cycleTrendShares);
  }

  return round6(avgPrice(getSideSpent(state, side), getSideShares(state, side)));
}

function getLeaderSignal(params: {
  history: PricePoint[];
  trendWindowMs: number;
  trendMinMove: number;
  minImbalance: number;
  leaderMinGap: number;
}) {
  const {
    history,
    trendWindowMs,
    trendMinMove,
    minImbalance,
    leaderMinGap,
  } = params;

  const newest = getLatest(history);
  const oldest = getWindowOldest(history, trendWindowMs);

  if (!newest || !oldest) {
    return {
      leader: 'FLAT' as TrendDirection,
      upMove: 0,
      downMove: 0,
      gap: 0,
      pairPrice: 0,
      upStrength: 0,
      downStrength: 0,
    };
  }

  const upMove = round6(newest.upAsk - oldest.upAsk);
  const downMove = round6(newest.downAsk - oldest.downAsk);
  const gap = round6(newest.upAsk - newest.downAsk);
  const pairPrice = round6(newest.upAsk + newest.downAsk);

  let upStrength = 0;
  let downStrength = 0;

  if (gap >= leaderMinGap) upStrength += 1;
  if (-gap >= leaderMinGap) downStrength += 1;

  if (upMove >= trendMinMove) upStrength += 1;
  if (downMove >= trendMinMove) downStrength += 1;

  if (downMove <= -minImbalance) upStrength += 1;
  if (upMove <= -minImbalance) downStrength += 1;

  if (history.length >= 3) {
    const last3 = history.slice(-3);
    const upConsistent =
      last3[1].upAsk >= last3[0].upAsk &&
      last3[2].upAsk >= last3[1].upAsk;
    const downConsistent =
      last3[1].downAsk >= last3[0].downAsk &&
      last3[2].downAsk >= last3[1].downAsk;
    if (upConsistent && !downConsistent) upStrength += 1;
    if (downConsistent && !upConsistent) downStrength += 1;
  }

  let leader: TrendDirection = 'FLAT';

  if (upStrength >= 2 && upStrength > downStrength) {
    leader = 'UP';
  } else if (downStrength >= 2 && downStrength > upStrength) {
    leader = 'DOWN';
  } else if (gap >= leaderMinGap && upMove >= -0.002) {
    leader = 'UP';
  } else if (-gap >= leaderMinGap && downMove >= -0.002) {
    leader = 'DOWN';
  } else if (upMove >= trendMinMove * 1.2 && gap > 0) {
    leader = 'UP';
  } else if (downMove >= trendMinMove * 1.2 && gap < 0) {
    leader = 'DOWN';
  }

  return {
    leader,
    upMove,
    downMove,
    gap,
    pairPrice,
    upStrength,
    downStrength,
  };
}


function logRealtimeState(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  state: MarketState,
  upPrice: number,
  downPrice: number,
  secLeft: number,
) {
  log(
    logger,
    timestamp,
    marketSlug,
    'LIVE',
    `secLeft=${fmt3(secLeft)} upAsk=${fmt3(upPrice)} downAsk=${fmt3(downPrice)} sharesUp=${fmt6(state.sharesUp)} sharesDown=${fmt6(state.sharesDown)} spentUp=${fmt6(state.spentUpUsdc)} spentDown=${fmt6(state.spentDownUsdc)} totalSpent=${fmt6(totalSpent(state))} upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))} closed=${state.closed}`,
  );
}

async function submitBuyByShares(params: {
  orderService: OrderService;
  tokenID: string;
  askPrice: number;
  shares: number;
  slippageBuffer: number;
  label: TrendSide;
  logger: Logger;
  timestamp: any;
  marketSlug: string;
}): Promise<{ accepted: boolean; filledShares: number; filledUsdc: number }> {
  const {
    orderService,
    tokenID,
    askPrice,
    shares,
    slippageBuffer,
    label,
    logger,
    timestamp,
    marketSlug,
  } = params;

  const size = round6(shares);
  if (size <= 0 || askPrice <= 0) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `submit_invalid side=${label} ask=${fmt3(askPrice)} shares=${fmt6(size)}`,
    );
    return { accepted: false, filledShares: 0, filledUsdc: 0 };
  }

  const orderPrice = Math.min(0.99, round6(askPrice + slippageBuffer));
  const estUsdc = round6(size * askPrice);

  log(
    logger,
    timestamp,
    marketSlug,
    'ACTION',
    `BUY_SUBMIT side=${label} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} shares=${fmt6(size)} estUsdc=${fmt6(estUsdc)}`,
  );

  try {
    const response = await orderService.createAndPostOrder({
      tokenID,
      price: orderPrice,
      side: Side.BUY,
      size,
      orderType: OrderType.FAK,
    });

    const { filledShares, filledUsdc } = parseFillFromResponse(response, size, askPrice);

    if (filledShares > 0) {
      log(
        logger,
        timestamp,
        marketSlug,
        'FILL',
        `BUY_ACCEPT side=${label} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} filled=${fmt6(filledShares)} usdc=${fmt6(filledUsdc)} requested=${fmt6(size)}`,
      );
      return { accepted: true, filledShares, filledUsdc };
    }

    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `buy_zero_fill side=${label} shares=${fmt6(size)} resp=${JSON.stringify(response)}`,
    );
    return { accepted: false, filledShares: 0, filledUsdc: 0 };
  } catch (error: any) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `buy_error side=${label} error=${error?.message || error}`,
    );
    return { accepted: false, filledShares: 0, filledUsdc: 0 };
  }
}

/**
 * Buys `shares` on `side`. Updates state with ACTUAL filled amounts only.
 * If the fill is partial (shortfall >= minChunkShares), immediately re-orders
 * the remainder once before returning.
 * Returns total actually filled shares (0 = order failed entirely).
 */
async function buySideShares(params: {
  state: MarketState;
  orderService: OrderService;
  tokenIds: { up: string; down: string };
  side: TrendSide;
  askPrice: number;
  shares: number;
  config: Strategy9Config;
  logger: Logger;
  timestamp: any;
  marketSlug: string;
}): Promise<number> {
  const {
    state,
    orderService,
    tokenIds,
    side,
    askPrice,
    shares,
    config,
    logger,
    timestamp,
    marketSlug,
  } = params;

  if (shares <= 0) return 0;
  if (askPrice <= 0 || askPrice > config.maxTradePrice) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `price_guard side=${side} ask=${fmt3(askPrice)} maxTradePrice=${fmt3(config.maxTradePrice)}`,
    );
    return 0;
  }

  const spendTry = round6(shares * askPrice);
  const currentTotalSpent = totalSpent(state);
  if (currentTotalSpent + spendTry > config.maxTotalSpentUsdc) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `total_cap_guard totalSpent=${fmt6(currentTotalSpent)} try=${fmt6(spendTry)} max=${fmt6(config.maxTotalSpentUsdc)}`,
    );
    return 0;
  }

  const sideSpent = getSideSpent(state, side);
  if (sideSpent + spendTry > config.maxSideSpentUsdc) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `side_cap_guard side=${side} sideSpent=${fmt6(sideSpent)} try=${fmt6(spendTry)} max=${fmt6(config.maxSideSpentUsdc)}`,
    );
    return 0;
  }

  const tokenID = side === 'UP' ? tokenIds.up : tokenIds.down;

  // ── Primary order ──────────────────────────────────────────────────────────
  const result = await submitBuyByShares({
    orderService,
    tokenID,
    askPrice,
    shares,
    slippageBuffer: config.slippageBuffer,
    label: side,
    logger,
    timestamp,
    marketSlug,
  });

  if (!result.accepted) return 0;

  let totalFilled = result.filledShares;
  let totalFilledUsdc = result.filledUsdc;
  state.orderCount += 1;

  // ── Immediate re-order for shortfall ──────────────────────────────────────
  const shortfall = round6(shares - result.filledShares);
  if (shortfall >= Math.max(config.minChunkShares, 0.5)) {
    const shortfallSpend = round6(shortfall * askPrice);
    const newTotalSpent = totalSpent(state) + totalFilledUsdc;
    const newSideSpent = getSideSpent(state, side) + totalFilledUsdc;

    const canReorder =
      state.orderCount < config.maxOrdersPerMarket &&
      newTotalSpent + shortfallSpend <= config.maxTotalSpentUsdc &&
      newSideSpent + shortfallSpend <= config.maxSideSpentUsdc;

    if (canReorder) {
      log(
        logger,
        timestamp,
        marketSlug,
        'REORDER',
        `side=${side} shortfall=${fmt6(shortfall)} filled=${fmt6(result.filledShares)} requested=${fmt6(shares)}`,
      );

      const reResult = await submitBuyByShares({
        orderService,
        tokenID,
        askPrice,
        shares: shortfall,
        slippageBuffer: config.slippageBuffer,
        label: side,
        logger,
        timestamp,
        marketSlug,
      });

      if (reResult.accepted && reResult.filledShares > 0) {
        totalFilled = round6(totalFilled + reResult.filledShares);
        totalFilledUsdc = round6(totalFilledUsdc + reResult.filledUsdc);
        state.orderCount += 1;
      }
    }
  }

  // ── Update state with ACTUAL fills only ───────────────────────────────────
  if (totalFilled <= 0) return 0;

  if (side === 'UP') {
    state.sharesUp = round6(state.sharesUp + totalFilled);
    state.spentUpUsdc = round6(state.spentUpUsdc + totalFilledUsdc);
  } else {
    state.sharesDown = round6(state.sharesDown + totalFilled);
    state.spentDownUsdc = round6(state.spentDownUsdc + totalFilledUsdc);
  }

  state.lastActionAt = Date.now();

  if (state.cycleTrend === side) {
    state.cycleTrendShares = round6(state.cycleTrendShares + totalFilled);
    state.cycleTrendSpentUsdc = round6(state.cycleTrendSpentUsdc + totalFilledUsdc);
  }

  log(
    logger,
    timestamp,
    marketSlug,
    'STATE',
    `pos up=${fmt6(state.sharesUp)} down=${fmt6(state.sharesDown)} spentUp=${fmt6(state.spentUpUsdc)} spentDown=${fmt6(state.spentDownUsdc)} totalSpent=${fmt6(totalSpent(state))} upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))}`,
  );

  if (shouldCloseMarketByReward(state)) {
    state.closed = true;
    log(
      logger,
      timestamp,
      marketSlug,
      'STOP',
      `reward_target_hit upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))} totalSpent=${fmt6(totalSpent(state))} market_closed=true`,
    );
  }

  return totalFilled;
}

async function buyTrendBursts(params: {
  state: MarketState;
  orderService: OrderService;
  tokenIds: { up: string; down: string };
  side: TrendSide;
  askPrice: number;
  config: Strategy9Config;
  logger: Logger;
  timestamp: any;
  marketSlug: string;
}): Promise<boolean> {
  const { state, config, logger, timestamp, marketSlug } = params;

  let filledAny = false;
  let consecutiveZeros = 0;
  const MAX_ZEROS = 2;

  while (true) {
    if (state.closed) break;
    if (state.orderCount >= config.maxOrdersPerMarket) break;

    const remaining = round6(config.targetTrendSharesPerCycle - state.cycleTrendShares);
    if (remaining <= 0) {
      log(logger, timestamp, marketSlug, 'CYCLE_DONE',
        `side=${params.side} target=${fmt6(config.targetTrendSharesPerCycle)} filled=${fmt6(state.cycleTrendShares)}`);
      break;
    }

    const chunk = round6(clamp(remaining, config.minChunkShares, config.maxChunkShares));
    if (chunk < config.minChunkShares) break;

    log(logger, timestamp, marketSlug, 'BURST',
      `side=${params.side} chunk=${fmt6(chunk)} remaining=${fmt6(remaining)} zeros=${consecutiveZeros}`);

    const filled = await buySideShares({
      state: params.state,
      orderService: params.orderService,
      tokenIds: params.tokenIds,
      side: params.side,
      askPrice: params.askPrice,
      shares: chunk,
      config: params.config,
      logger,
      timestamp,
      marketSlug,
    });

    if (filled <= 0) {
      consecutiveZeros++;
      if (consecutiveZeros >= MAX_ZEROS) {
        log(logger, timestamp, marketSlug, 'BURST_STOP',
          `no_fill_x${consecutiveZeros} side=${params.side} remaining=${fmt6(remaining)}`);
        break;
      }
    } else {
      consecutiveZeros = 0;
      filledAny = true;
    }

    if (state.closed) break;
    if (config.burstSpacingMs > 0) await sleep(config.burstSpacingMs);
  }

  return filledAny;
}

function shouldHedge(params: {
  state: MarketState;
  trendSide: TrendSide;
  upAsk: number;
  downAsk: number;
  config: Strategy9Config;
}) {
  const { state, trendSide, upAsk, downAsk, config } = params;

  const hedgeSide = oppositeSide(trendSide);
  const trendAvg = getCycleTrendAvg(state, trendSide);
  const hedgePrice = hedgeSide === 'UP' ? upAsk : downAsk;
  const edge = round6(1 - (trendAvg + hedgePrice));

  const trendShares = getSideShares(state, trendSide);
  const hedgeShares = getSideShares(state, hedgeSide);

  const targetHedgeShares = round6(trendShares * config.hedgeRatio);
  const desired = round6(Math.max(0, targetHedgeShares - hedgeShares));

  const minHedgeTrigger = config.minHedgeTriggerShares ?? 8;

  return {
    hedgeSide,
    trendAvg: round6(trendAvg),
    hedgePrice: round6(hedgePrice),
    edge,
    trendShares: round6(trendShares),
    hedgeShares: round6(hedgeShares),
    targetHedgeShares,
    desired,
    ok:
      trendShares >= minHedgeTrigger &&
      trendAvg > 0 &&
      hedgePrice > 0 &&
      hedgePrice <= config.hedgeMaxPrice &&
      edge >= config.minEdge &&
      trendAvg + hedgePrice <= config.maxPairPrice &&
      desired > 0,
  };
}

function startNewCycle(
  state: MarketState,
  side: TrendSide,
  now: number,
) {
  state.cycleTrend = side;
  state.cycleStartedAt = now;
  state.cycleTrendShares = 0;
  state.cycleTrendSpentUsdc = 0;
  state.pendingFlipSide = null;
  state.pendingFlipCount = 0;
}

export function resetStrategy9State(marketSlug?: string) {
  if (marketSlug) {
    strategy9State.delete(marketSlug);
    return;
  }
  strategy9State.clear();
}

export async function main(
  marketSlug: string,
  timestamp: any,
  upPrice: number,
  downPrice: number,
  orderService: OrderService,
  logger: Logger,
  config: Strategy9Config,
) {
  const now = Date.now();

  if (!config.enabled) return;
  if (!Number.isFinite(upPrice) || !Number.isFinite(downPrice)) return;

  const endDate = EndDateContext.get(marketSlug);
  const tokenIds = TokenIdContext.get(marketSlug);
  if (!endDate || !tokenIds) return;

  const secLeft = endDate - Math.floor(now / 1000);

  if (secLeft <= config.stopBeforeEndSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'STOP',
      `hard_stop secLeft=${fmt3(secLeft)} stopAt=${config.stopBeforeEndSec}`,
    );
    return;
  }

  let state = strategy9State.get(marketSlug);
  if (!state) {
    state = getDefaultState(now);
    strategy9State.set(marketSlug, state);
  }

  if (state.closed) {
    log(
      logger,
      timestamp,
      marketSlug,
      'STOP',
      `market_already_closed upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))} totalSpent=${fmt6(totalSpent(state))}`,
    );
    return;
  }

  state.history.push({
    ts: now,
    upAsk: upPrice,
    downAsk: downPrice,
  });
  trimHistory(
    state.history,
    now,
    Math.max(config.trendWindowMs * 4, 15_000),
  );

  if (now - state.lastLiveLogAt >= 500) {
    logRealtimeState(
      logger,
      timestamp,
      marketSlug,
      state,
      upPrice,
      downPrice,
      secLeft,
    );
    state.lastLiveLogAt = now;
  }

  const lifeSec = (now - state.firstSeenAt) / 1000;
  if (lifeSec < config.observeSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'OBSERVE',
      `lifeSec=${fmt3(lifeSec)} up=${fmt3(upPrice)} down=${fmt3(downPrice)} upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))}`,
    );
    return;
  }

  if (now - state.lastActionAt < config.cooldownMs) return;

  if (state.orderCount >= config.maxOrdersPerMarket) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `max_orders_reached=${state.orderCount}`,
    );
    return;
  }

  if (shouldCloseMarketByReward(state)) {
    state.closed = true;
    log(
      logger,
      timestamp,
      marketSlug,
      'STOP',
      `reward_target_hit upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))} totalSpent=${fmt6(totalSpent(state))} market_closed=true`,
    );
    return;
  }

  const signal = getLeaderSignal({
    history: state.history,
    trendWindowMs: config.trendWindowMs,
    trendMinMove: config.trendMinMove,
    minImbalance: config.minImbalance,
    leaderMinGap: config.leaderMinGap,
  });

  log(
    logger,
    timestamp,
    marketSlug,
    'DEBUG',
    `leader=${signal.leader} up=${fmt3(upPrice)} down=${fmt3(downPrice)} gap=${fmt6(signal.gap)} pair=${fmt6(signal.pairPrice)} upMove=${fmt6(signal.upMove)} downMove=${fmt6(signal.downMove)} upStr=${signal.upStrength} downStr=${signal.downStrength} totalSpent=${fmt6(totalSpent(state))} upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))}`,
  );

  if (signal.pairPrice > config.maxPairPrice && state.cycleTrend === 'FLAT') {
    log(
      logger,
      timestamp,
      marketSlug,
      'DEBUG',
      `pair_over_limit_for_hedge_only pair=${fmt6(signal.pairPrice)} max=${fmt6(config.maxPairPrice)}`,
    );
  }

  if (signal.leader === 'FLAT' && state.cycleTrend === 'FLAT') return;

  const cycleAgeMs = now - state.cycleStartedAt;

  if (state.cycleTrend === 'FLAT' && signal.leader !== 'FLAT') {
    startNewCycle(state, signal.leader as TrendSide, now);
    log(logger, timestamp, marketSlug, 'CYCLE', `start trend=${state.cycleTrend}`);
  }

  if (state.cycleTrend !== 'FLAT' && signal.leader !== 'FLAT' && state.cycleTrend !== signal.leader) {
    const leaderSide = signal.leader as TrendSide;
    const strongFlip =
      Math.abs(signal.gap) >= config.flipMinGap &&
      (
        (leaderSide === 'UP' && signal.upMove >= config.reversalMove) ||
        (leaderSide === 'DOWN' && signal.downMove >= config.reversalMove)
      );

    if (cycleAgeMs >= config.cycleMs || strongFlip) {
      if (state.pendingFlipSide === leaderSide) {
        state.pendingFlipCount += 1;
      } else {
        state.pendingFlipSide = leaderSide;
        state.pendingFlipCount = 1;
      }

      log(
        logger,
        timestamp,
        marketSlug,
        'FLIP_CHECK',
        `current=${state.cycleTrend} pending=${leaderSide} count=${state.pendingFlipCount}/${config.flipConfirmTicks} strongFlip=${strongFlip}`,
      );

      if (state.pendingFlipCount >= config.flipConfirmTicks) {
        startNewCycle(state, leaderSide, now);
        log(logger, timestamp, marketSlug, 'CYCLE', `flip_to=${leaderSide}`);
      } else {
        return;
      }
    }
  } else {
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;
  }

  if (state.cycleTrend === 'FLAT') return;

  const trendSide = state.cycleTrend as TrendSide;
  const trendAsk = trendSide === 'UP' ? upPrice : downPrice;

  const canTrendBuy =
    trendAsk > 0 &&
    trendAsk <= config.maxTradePrice &&
    (
      signal.leader === trendSide ||
      state.cycleTrendShares <= 0 ||
      cycleAgeMs <= config.cycleMs ||
      (signal.leader === 'FLAT' && cycleAgeMs <= config.cycleMs * 2.0)
    );

  if (
    canTrendBuy &&
    state.cycleTrendShares < config.targetTrendSharesPerCycle
  ) {
    const burstOk = await buyTrendBursts({
      state,
      orderService,
      tokenIds,
      side: trendSide,
      askPrice: trendAsk,
      config,
      logger,
      timestamp,
      marketSlug,
    });

    if (state.closed) return;
    if (burstOk) return;
  }

  const hedgeCheck = shouldHedge({
    state,
    trendSide,
    upAsk: upPrice,
    downAsk: downPrice,
    config,
  });

  if (hedgeCheck.ok) {
    const hedgeShares = round6(
      Math.min(hedgeCheck.desired, config.hedgeChunkShares),
    );

    log(
      logger,
      timestamp,
      marketSlug,
      'HEDGE',
      `trend=${trendSide} hedge=${hedgeCheck.hedgeSide} trendAvg=${fmt6(hedgeCheck.trendAvg)} hedgeAsk=${fmt6(hedgeCheck.hedgePrice)} edge=${fmt6(hedgeCheck.edge)} trendShares=${fmt6(hedgeCheck.trendShares)} hedgeShares=${fmt6(hedgeCheck.hedgeShares)} targetHedge=${fmt6(hedgeCheck.targetHedgeShares)} chunk=${fmt6(hedgeShares)}`,
    );

    const hedgeFilled = await buySideShares({
      state,
      orderService,
      tokenIds,
      side: hedgeCheck.hedgeSide,
      askPrice: hedgeCheck.hedgePrice,
      shares: hedgeShares,
      config,
      logger,
      timestamp,
      marketSlug,
    });

    if (state.closed) return;
    if (hedgeFilled > 0) return;
  }

  if (cycleAgeMs > config.cycleMs * 1.4 && signal.leader !== 'FLAT' && signal.leader !== state.cycleTrend) {
    startNewCycle(state, signal.leader as TrendSide, now);
    log(
      logger,
      timestamp,
      marketSlug,
      'CYCLE',
      `stale_restart trend=${state.cycleTrend}`,
    );
  }
}