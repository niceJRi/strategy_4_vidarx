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

  slippageBuffer: number;
  maxTradePrice: number;

  maxOrdersPerMarket: number;
  maxTotalSpentUsdc: number;
  maxSideSpentUsdc: number;

  flipConfirmTicks: number;
  scoreTrendWeight: number;
  scoreEdgeWeight: number;
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

function trimHistory(history: PricePoint[], now: number, maxMs: number) {
  const cutoff = now - maxMs;
  while (history.length > 0 && history[0].ts < cutoff) {
    history.shift();
  }
}

function avgPrice(spentUsdc: number, shares: number): number {
  if (shares <= 0) return 0;
  return spentUsdc / shares;
}

function reward(state: MarketState): number {
  return round6(
    Math.min(state.sharesUp, state.sharesDown) -
      (state.spentUpUsdc + state.spentDownUsdc),
  );
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

function detectTrend(
  history: PricePoint[],
  trendWindowMs: number,
  trendMinMove: number,
): TrendDirection {
  if (history.length < 2) return 'FLAT';

  const newest = getLatest(history);
  const oldest = getWindowOldest(history, trendWindowMs);
  if (!newest || !oldest) return 'FLAT';

  const upMove = newest.upAsk - oldest.upAsk;

  if (upMove >= trendMinMove) return 'UP';
  if (upMove <= -trendMinMove) return 'DOWN';
  return 'FLAT';
}

function calcImbalanceFromAsks(upAsk: number, downAsk: number): number {
  // if upAsk is rising and downAsk is falling, market is leaning UP.
  // This is only a proxy because repo does not keep full depth.
  return round6(upAsk - downAsk);
}

function calcCycleAvg(state: MarketState, side: TrendSide) {
  if (side === 'UP') {
    return avgPrice(state.spentUpUsdc, state.sharesUp);
  }
  return avgPrice(state.spentDownUsdc, state.sharesDown);
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

function computeScore(params: {
  trend: TrendDirection;
  upAsk: number;
  downAsk: number;
  trendMinMove: number;
  scoreTrendWeight: number;
  scoreEdgeWeight: number;
}) {
  const {
    trend,
    upAsk,
    downAsk,
    scoreTrendWeight,
    scoreEdgeWeight,
  } = params;

  const imbalance = calcImbalanceFromAsks(upAsk, downAsk);
  const pairEdge = 1 - (upAsk + downAsk);

  let upScore = 0;
  let downScore = 0;

  if (trend === 'UP') upScore += scoreTrendWeight;
  if (trend === 'DOWN') downScore += scoreTrendWeight;

  upScore += imbalance * scoreEdgeWeight;
  downScore += (-imbalance) * scoreEdgeWeight;

  upScore += pairEdge * 10;
  downScore += pairEdge * 10;

  return {
    upScore: round6(upScore),
    downScore: round6(downScore),
    pairEdge: round6(pairEdge),
    imbalance: round6(imbalance),
  };
}

function chooseTrendSide(
  trend: TrendDirection,
  upAsk: number,
  downAsk: number,
  config: Strategy9Config,
): TrendDirection {
  const { upScore, downScore, pairEdge, imbalance } = computeScore({
    trend,
    upAsk,
    downAsk,
    trendMinMove: config.trendMinMove,
    scoreTrendWeight: config.scoreTrendWeight,
    scoreEdgeWeight: config.scoreEdgeWeight,
  });

  if (pairEdge < -0.03) return 'FLAT';

  if (upScore > downScore && imbalance >= config.minImbalance) return 'UP';
  if (downScore > upScore && -imbalance >= config.minImbalance) return 'DOWN';

  return trend;
}

function calcAdaptiveChunkShares(params: {
  trendSide: TrendSide;
  upAsk: number;
  downAsk: number;
  state: MarketState;
  config: Strategy9Config;
}) {
  const { trendSide, upAsk, downAsk, state, config } = params;
  const trendPrice = trendSide === 'UP' ? upAsk : downAsk;
  const hedgePrice = trendSide === 'UP' ? downAsk : upAsk;
  const rawEdge = 1 - (trendPrice + hedgePrice);

  const exposurePenalty =
    (state.spentUpUsdc + state.spentDownUsdc) / Math.max(1, config.maxTotalSpentUsdc);

  const sideSpent =
    trendSide === 'UP' ? state.spentUpUsdc : state.spentDownUsdc;
  const sidePenalty = sideSpent / Math.max(1, config.maxSideSpentUsdc);

  const confidence = clamp(
    (rawEdge - config.minEdge) * 20 + (1 - exposurePenalty) * 0.5 + (1 - sidePenalty) * 0.5,
    0,
    1,
  );

  const chunk =
    config.minChunkShares +
    confidence * (config.maxChunkShares - config.minChunkShares);

  return round6(clamp(chunk, config.minChunkShares, config.maxChunkShares));
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
}) {
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
    return null;
  }

  const orderPrice = Math.min(0.99, round6(askPrice + slippageBuffer));
  const usdc = round6(size * askPrice);

  log(
    logger,
    timestamp,
    marketSlug,
    'ACTION',
    `BUY_SUBMIT side=${label} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} shares=${fmt6(size)} usdc=${fmt6(usdc)}`,
  );

  try {
    const response = await orderService.createAndPostOrder({
      tokenID,
      price: orderPrice,
      side: Side.BUY,
      size,
      orderType: OrderType.GTC,
    });

    if (getAcceptedOrder(response)) {
      log(
        logger,
        timestamp,
        marketSlug,
        'FILL',
        `BUY_ACCEPT side=${label} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} shares=${fmt6(size)} usdc=${fmt6(usdc)}`,
      );
    } else {
      log(
        logger,
        timestamp,
        marketSlug,
        'SKIP',
        `buy_failed side=${label} shares=${fmt6(size)} resp=${JSON.stringify(response)}`,
      );
    }

    return response;
  } catch (error: any) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `buy_error side=${label} error=${error?.message || error}`,
    );
    return null;
  }
}

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
}) {
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

  if (shares <= 0) return false;
  if (askPrice <= 0 || askPrice > config.maxTradePrice) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `price_guard side=${side} ask=${fmt3(askPrice)} maxTradePrice=${fmt3(config.maxTradePrice)}`,
    );
    return false;
  }

  const totalSpent = state.spentUpUsdc + state.spentDownUsdc;
  if (totalSpent + shares * askPrice > config.maxTotalSpentUsdc) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `total_cap_guard totalSpent=${fmt6(totalSpent)} try=${fmt6(shares * askPrice)} max=${fmt6(config.maxTotalSpentUsdc)}`,
    );
    return false;
  }

  const sideSpent = side === 'UP' ? state.spentUpUsdc : state.spentDownUsdc;
  if (sideSpent + shares * askPrice > config.maxSideSpentUsdc) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `side_cap_guard side=${side} sideSpent=${fmt6(sideSpent)} try=${fmt6(shares * askPrice)} max=${fmt6(config.maxSideSpentUsdc)}`,
    );
    return false;
  }

  const tokenID = side === 'UP' ? tokenIds.up : tokenIds.down;

  const response = await submitBuyByShares({
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

  if (!getAcceptedOrder(response)) return false;

  const cost = round6(shares * askPrice);

  if (side === 'UP') {
    state.sharesUp = round6(state.sharesUp + shares);
    state.spentUpUsdc = round6(state.spentUpUsdc + cost);
  } else {
    state.sharesDown = round6(state.sharesDown + shares);
    state.spentDownUsdc = round6(state.spentDownUsdc + cost);
  }

  state.orderCount += 1;
  state.lastActionAt = Date.now();

  if (state.cycleTrend === side) {
    state.cycleTrendShares = round6(state.cycleTrendShares + shares);
    state.cycleTrendSpentUsdc = round6(state.cycleTrendSpentUsdc + cost);
  }

  log(
    logger,
    timestamp,
    marketSlug,
    'STATE',
    `pos up=${fmt6(state.sharesUp)} down=${fmt6(state.sharesDown)} spentUp=${fmt6(state.spentUpUsdc)} spentDown=${fmt6(state.spentDownUsdc)} reward=${fmt6(reward(state))}`,
  );

  return true;
}

function shouldHedge(params: {
  state: MarketState;
  trendSide: TrendSide;
  upAsk: number;
  downAsk: number;
  config: Strategy9Config;
}) {
  const { state, trendSide, upAsk, downAsk, config } = params;

  const trendAvg = calcCycleAvg(state, trendSide);
  const hedgePrice = trendSide === 'UP' ? downAsk : upAsk;
  const edge = 1 - (trendAvg + hedgePrice);

  return {
    trendAvg: round6(trendAvg),
    hedgePrice: round6(hedgePrice),
    edge: round6(edge),
    ok:
      trendAvg > 0 &&
      hedgePrice > 0 &&
      edge >= config.minEdge &&
      trendAvg + hedgePrice <= config.maxPairPrice,
  };
}

function detectReversal(params: {
  history: PricePoint[];
  currentTrend: TrendSide;
  trendWindowMs: number;
  reversalMove: number;
}) {
  const { history, currentTrend, trendWindowMs, reversalMove } = params;
  if (history.length < 2) return false;

  const newest = getLatest(history);
  const oldest = getWindowOldest(history, trendWindowMs);
  if (!newest || !oldest) return false;

  const upMove = newest.upAsk - oldest.upAsk;

  if (currentTrend === 'UP') return upMove <= -reversalMove;
  return upMove >= reversalMove;
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
  if (secLeft <= config.stopBeforeEndSec) return;

  let state = strategy9State.get(marketSlug);
  if (!state) {
    state = getDefaultState(now);
    strategy9State.set(marketSlug, state);
  }

  if (state.closed) return;

  state.history.push({
    ts: now,
    upAsk: upPrice,
    downAsk: downPrice,
  });
  trimHistory(
    state.history,
    now,
    Math.max(config.trendWindowMs * 3, 12_000),
  );

  const lifeSec = (now - state.firstSeenAt) / 1000;
  if (lifeSec < config.observeSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'OBSERVE',
      `lifeSec=${fmt3(lifeSec)} up=${fmt3(upPrice)} down=${fmt3(downPrice)}`,
    );
    return;
  }

  if (now - state.lastActionAt < config.cooldownMs) return;

  if (state.orderCount >= config.maxOrdersPerMarket) {
    log(logger, timestamp, marketSlug, 'SKIP', `max_orders_reached=${state.orderCount}`);
    return;
  }

  const rawTrend = detectTrend(
    state.history,
    config.trendWindowMs,
    config.trendMinMove,
  );

  const chosenTrend = chooseTrendSide(rawTrend, upPrice, downPrice, config);

  const { upScore, downScore, pairEdge, imbalance } = computeScore({
    trend: rawTrend,
    upAsk: upPrice,
    downAsk: downPrice,
    trendMinMove: config.trendMinMove,
    scoreTrendWeight: config.scoreTrendWeight,
    scoreEdgeWeight: config.scoreEdgeWeight,
  });

  log(
    logger,
    timestamp,
    marketSlug,
    'DEBUG',
    `trend=${rawTrend} chosen=${chosenTrend} up=${fmt3(upPrice)} down=${fmt3(downPrice)} upScore=${fmt6(upScore)} downScore=${fmt6(downScore)} pairEdge=${fmt6(pairEdge)} imbalance=${fmt6(imbalance)} reward=${fmt6(reward(state))}`,
  );

  if (chosenTrend === 'FLAT') return;

  const cycleAgeMs = now - state.cycleStartedAt;
  const trendSide = chosenTrend as TrendSide;

  if (state.cycleTrend === 'FLAT') {
    state.cycleTrend = trendSide;
    state.cycleStartedAt = now;
    state.cycleTrendShares = 0;
    state.cycleTrendSpentUsdc = 0;
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;

    log(logger, timestamp, marketSlug, 'CYCLE', `start trend=${trendSide}`);
  }

  // flip confirmation
  if (state.cycleTrend !== trendSide) {
    if (state.pendingFlipSide === trendSide) {
      state.pendingFlipCount += 1;
    } else {
      state.pendingFlipSide = trendSide;
      state.pendingFlipCount = 1;
    }

    log(
      logger,
      timestamp,
      marketSlug,
      'FLIP_CHECK',
      `current=${state.cycleTrend} pending=${state.pendingFlipSide} count=${state.pendingFlipCount}/${config.flipConfirmTicks}`,
    );

    if (state.pendingFlipCount >= config.flipConfirmTicks) {
      state.cycleTrend = trendSide;
      state.cycleStartedAt = now;
      state.cycleTrendShares = 0;
      state.cycleTrendSpentUsdc = 0;
      state.pendingFlipSide = null;
      state.pendingFlipCount = 0;

      log(logger, timestamp, marketSlug, 'CYCLE', `flip_to=${trendSide}`);
    } else {
      return;
    }
  } else {
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;
  }

  // 1) trend buy
  if (
    cycleAgeMs <= config.cycleMs &&
    state.cycleTrendShares < config.targetTrendSharesPerCycle
  ) {
    const askPrice = trendSide === 'UP' ? upPrice : downPrice;
    const remaining = round6(
      config.targetTrendSharesPerCycle - state.cycleTrendShares,
    );

    const adaptiveChunk = calcAdaptiveChunkShares({
      trendSide,
      upAsk: upPrice,
      downAsk: downPrice,
      state,
      config,
    });

    const shares = round6(Math.min(remaining, adaptiveChunk));

    const ok = await buySideShares({
      state,
      orderService,
      tokenIds,
      side: trendSide,
      askPrice,
      shares,
      config,
      logger,
      timestamp,
      marketSlug,
    });

    if (ok) return;
  }

  // 2) hedge when opposite is cheap enough versus avg trend fill
  const hedgeCheck = shouldHedge({
    state,
    trendSide: state.cycleTrend as TrendSide,
    upAsk: upPrice,
    downAsk: downPrice,
    config,
  });

  if (hedgeCheck.ok) {
    const hedgeSide = oppositeSide(state.cycleTrend as TrendSide);

    const trendShares =
      state.cycleTrend === 'UP' ? state.sharesUp : state.sharesDown;
    const hedgeShares =
      hedgeSide === 'UP' ? state.sharesUp : state.sharesDown;

    const desired = round6(trendShares - hedgeShares);
    if (desired > 0) {
      const hedgeAsk = hedgeSide === 'UP' ? upPrice : downPrice;
      const hedgeChunk = round6(Math.min(desired, config.hedgeChunkShares));

      log(
        logger,
        timestamp,
        marketSlug,
        'HEDGE',
        `trend=${state.cycleTrend} hedge=${hedgeSide} trendAvg=${fmt6(hedgeCheck.trendAvg)} hedgeAsk=${fmt6(hedgeCheck.hedgePrice)} edge=${fmt6(hedgeCheck.edge)} desired=${fmt6(desired)} chunk=${fmt6(hedgeChunk)}`,
      );

      const ok = await buySideShares({
        state,
        orderService,
        tokenIds,
        side: hedgeSide,
        askPrice: hedgeAsk,
        shares: hedgeChunk,
        config,
        logger,
        timestamp,
        marketSlug,
      });

      if (ok) return;
    }
  }

  // 3) if cycle is old and reversal is obvious, start new cycle
  const reversal = detectReversal({
    history: state.history,
    currentTrend: state.cycleTrend as TrendSide,
    trendWindowMs: config.trendWindowMs,
    reversalMove: config.reversalMove,
  });

  if (cycleAgeMs > config.cycleMs && reversal) {
    const nextTrend = oppositeSide(state.cycleTrend as TrendSide);
    state.cycleTrend = nextTrend;
    state.cycleStartedAt = now;
    state.cycleTrendShares = 0;
    state.cycleTrendSpentUsdc = 0;
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;

    log(logger, timestamp, marketSlug, 'CYCLE', `reversal_restart trend=${nextTrend}`);
  }
}