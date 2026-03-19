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
  scoreTrendWeight: number; // kept for backward compatibility
  scoreEdgeWeight: number;  // kept for backward compatibility

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

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
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

function getBurstWeights(count: number) {
  const base = [0.40, 0.30, 0.18, 0.12, 0.08, 0.06];
  return Array.from({ length: Math.max(1, count) }, (_, i) => base[i] ?? base[base.length - 1]);
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

  const spendTry = round6(shares * askPrice);
  const totalSpent = round6(state.spentUpUsdc + state.spentDownUsdc);
  if (totalSpent + spendTry > config.maxTotalSpentUsdc) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `total_cap_guard totalSpent=${fmt6(totalSpent)} try=${fmt6(spendTry)} max=${fmt6(config.maxTotalSpentUsdc)}`,
    );
    return false;
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

  if (side === 'UP') {
    state.sharesUp = round6(state.sharesUp + shares);
    state.spentUpUsdc = round6(state.spentUpUsdc + spendTry);
  } else {
    state.sharesDown = round6(state.sharesDown + shares);
    state.spentDownUsdc = round6(state.spentDownUsdc + spendTry);
  }

  state.orderCount += 1;
  state.lastActionAt = Date.now();

  if (state.cycleTrend === side) {
    state.cycleTrendShares = round6(state.cycleTrendShares + shares);
    state.cycleTrendSpentUsdc = round6(state.cycleTrendSpentUsdc + spendTry);
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
}) {
  const {
    state,
    orderService,
    tokenIds,
    side,
    askPrice,
    config,
    logger,
    timestamp,
    marketSlug,
  } = params;

  const remainingTarget = round6(
    config.targetTrendSharesPerCycle - state.cycleTrendShares,
  );

  if (remainingTarget <= 0) return false;

  const weights = getBurstWeights(config.burstCount);
  let remaining = remainingTarget;
  let filledAny = false;

  for (let i = 0; i < config.burstCount; i++) {
    if (remaining <= 0) break;
    if (state.orderCount >= config.maxOrdersPerMarket) break;

    const weight = weights[i] ?? weights[weights.length - 1];
    const ideal = round6(remainingTarget * weight);

    let shares = round6(
      clamp(
        ideal,
        Math.min(config.minChunkShares, Math.max(remaining, 0.000001)),
        config.maxChunkShares,
      ),
    );

    shares = round6(Math.min(shares, remaining));
    if (shares <= 0) break;

    log(
      logger,
      timestamp,
      marketSlug,
      'BURST',
      `side=${side} idx=${i + 1}/${config.burstCount} shares=${fmt6(shares)} remainingBefore=${fmt6(remaining)}`,
    );

    const ok = await buySideShares({
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
    });

    if (!ok) {
      if (!filledAny) return false;
      break;
    }

    filledAny = true;
    remaining = round6(remaining - shares);

    if (remaining <= 0) break;
    if (i < config.burstCount - 1 && config.burstSpacingMs > 0) {
      await sleep(config.burstSpacingMs);
    }
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
    Math.max(config.trendWindowMs * 4, 15_000),
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
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `max_orders_reached=${state.orderCount}`,
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
    `leader=${signal.leader} up=${fmt3(upPrice)} down=${fmt3(downPrice)} gap=${fmt6(signal.gap)} pair=${fmt6(signal.pairPrice)} upMove=${fmt6(signal.upMove)} downMove=${fmt6(signal.downMove)} upStr=${signal.upStrength} downStr=${signal.downStrength} reward=${fmt6(reward(state))}`,
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
    cycleAgeMs <= config.cycleMs
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

    const ok = await buySideShares({
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

    if (ok) return;
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