import { Logger } from '@nestjs/common';
import { OrderType, Side } from '@polymarket/clob-client';
import { OrderService } from '../order/order.service.js';
import { EndDateContext, TokenIdContext } from '../context/market.js';

export type Strategy10Config = {
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

  // Inventory-average gates, not live pair-ask gates.
  maxPairPrice: number;
  maxLivePairPrice: number;
  hedgePairPrice: number;

  // Legacy names kept for dashboard compatibility.
  targetTrendSharesPerCycle: number;
  minChunkShares: number;
  maxChunkShares: number;
  hedgeChunkShares: number;
  minHedgeTriggerShares: number;

  // New sizing controls.
  baseChildCap: number;
  retryMinShares: number;
  windowMinShares: number;
  windowMaxShares: number;

  slippageBuffer: number;
  maxTradePrice: number;
  maxSpread: number;
  volatilitySoftCap: number;

  maxOrdersPerMarket: number;
  maxTotalSpentUsdc: number;
  maxSideSpentUsdc: number;

  flipConfirmTicks: number;
  scoreTrendWeight: number;
  scoreEdgeWeight: number;

  leaderMinGap: number;
  hedgeRatio: number;
  hedgeMaxPrice: number;
  cheapHedgePrice: number;
  minLeaderSpendShare: number;
  maxLeaderSpendShare: number;
  burstCount: number;
  burstSpacingMs: number;
  flipMinGap: number;
  strongGap: number;

  // <= 0 disables reward-close.
  closeOnBothRewardBuffer: number;
};

type TrendSide = 'UP' | 'DOWN';
type TrendDirection = TrendSide | 'FLAT';
type ActionRole = 'LEADER' | 'HEDGE';

type Quote = {
  bestAsk: number;
  bestBid: number;
};

type PricePoint = {
  ts: number;
  upAsk: number;
  upBid: number;
  downAsk: number;
  downBid: number;
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

  preferredSide: TrendDirection;
  preferredSideStartedAt: number;
  pendingFlipSide: TrendSide | null;
  pendingFlipCount: number;
};

type LiveQuotes = {
  upAsk: number;
  upBid: number;
  downAsk: number;
  downBid: number;
};

type LeaderSignal = {
  leader: TrendDirection;
  upMove: number;
  downMove: number;
  gap: number;
  pairLive: number;
  upSpread: number;
  downSpread: number;
  volatility: number;
  upScore: number;
  downScore: number;
  strength: number;
};

type CandidateAction = {
  side: TrendSide;
  role: ActionRole;
  askPrice: number;
  targetShares: number;
  projectedPairAvg: number;
  postSpendShare: number;
  score: number;
  reason: string;
};

const strategy10State = new Map<string, MarketState>();

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

    preferredSide: 'FLAT',
    preferredSideStartedAt: now,
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

function totalSpent(state: MarketState): number {
  return round6(state.spentUpUsdc + state.spentDownUsdc);
}

function upReward(state: MarketState): number {
  return round6(state.sharesUp - totalSpent(state));
}

function downReward(state: MarketState): number {
  return round6(state.sharesDown - totalSpent(state));
}

function shouldCloseMarketByReward(state: MarketState, config: Strategy10Config): boolean {
  return config.closeOnBothRewardBuffer > 0 &&
    upReward(state) > config.closeOnBothRewardBuffer &&
    downReward(state) > config.closeOnBothRewardBuffer;
}

function oppositeSide(side: TrendSide): TrendSide {
  return side === 'UP' ? 'DOWN' : 'UP';
}

function getLatest(history: PricePoint[]) {
  return history.length > 0 ? history[history.length - 1] : null;
}

function getWindowOldest(history: PricePoint[], windowMs: number) {
  if (history.length === 0) return null;
  const newest = history[history.length - 1];
  const oldestAllowedTs = newest.ts - windowMs;

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

function getAsk(live: LiveQuotes, side: TrendSide) {
  return side === 'UP' ? live.upAsk : live.downAsk;
}

function getBid(live: LiveQuotes, side: TrendSide) {
  return side === 'UP' ? live.upBid : live.downBid;
}

function getSpread(live: LiveQuotes, side: TrendSide) {
  return round6(Math.max(0, getAsk(live, side) - getBid(live, side)));
}

function getCurrentPairAvg(state: MarketState, live: LiveQuotes): number {
  const upComp = state.sharesUp > 0 ? avgPrice(state.spentUpUsdc, state.sharesUp) : live.upAsk;
  const downComp = state.sharesDown > 0 ? avgPrice(state.spentDownUsdc, state.sharesDown) : live.downAsk;
  return round6(upComp + downComp);
}

function projectedPairAvg(params: {
  state: MarketState;
  side: TrendSide;
  addShares: number;
  addPrice: number;
  live: LiveQuotes;
}) {
  const { state, side, addShares, addPrice, live } = params;

  const newSpentUp = side === 'UP'
    ? state.spentUpUsdc + (addShares * addPrice)
    : state.spentUpUsdc;
  const newSpentDown = side === 'DOWN'
    ? state.spentDownUsdc + (addShares * addPrice)
    : state.spentDownUsdc;
  const newSharesUp = side === 'UP'
    ? state.sharesUp + addShares
    : state.sharesUp;
  const newSharesDown = side === 'DOWN'
    ? state.sharesDown + addShares
    : state.sharesDown;

  const upComp = newSharesUp > 0 ? newSpentUp / newSharesUp : live.upAsk;
  const downComp = newSharesDown > 0 ? newSpentDown / newSharesDown : live.downAsk;
  return round6(upComp + downComp);
}

function getSpendShareAfter(params: {
  state: MarketState;
  side: TrendSide;
  addShares: number;
  addPrice: number;
}) {
  const { state, side, addShares, addPrice } = params;
  const addSpend = addShares * addPrice;
  const currentTotal = totalSpent(state);
  const nextTotal = currentTotal + addSpend;
  if (nextTotal <= 0) return 0;
  const nextSide = getSideSpent(state, side) + addSpend;
  return round6(nextSide / nextTotal);
}

function getLeaderSignal(params: {
  history: PricePoint[];
  trendWindowMs: number;
  trendMinMove: number;
  minImbalance: number;
  leaderMinGap: number;
  maxSpread: number;
  scoreTrendWeight: number;
  scoreEdgeWeight: number;
}) {
  const {
    history,
    trendWindowMs,
    trendMinMove,
    minImbalance,
    leaderMinGap,
    maxSpread,
    scoreTrendWeight,
    scoreEdgeWeight,
  } = params;

  const newest = getLatest(history);
  const oldest = getWindowOldest(history, trendWindowMs);

  if (!newest || !oldest) {
    return {
      leader: 'FLAT' as TrendDirection,
      upMove: 0,
      downMove: 0,
      gap: 0,
      pairLive: 0,
      upSpread: 0,
      downSpread: 0,
      volatility: 0,
      upScore: 0,
      downScore: 0,
      strength: 0,
    };
  }

  const upMove = round6(newest.upAsk - oldest.upAsk);
  const downMove = round6(newest.downAsk - oldest.downAsk);
  const gap = round6(newest.upAsk - newest.downAsk);
  const pairLive = round6(newest.upAsk + newest.downAsk);
  const upSpread = round6(Math.max(0, newest.upAsk - newest.upBid));
  const downSpread = round6(Math.max(0, newest.downAsk - newest.downBid));

  let upScore = 0;
  let downScore = 0;

  const gapScale = Math.max(leaderMinGap, 0.000001);
  const moveScale = Math.max(trendMinMove, 0.000001);
  const imbScale = Math.max(minImbalance, 0.000001);

  upScore += clamp(gap / gapScale, 0, 3) * 0.8;
  downScore += clamp((-gap) / gapScale, 0, 3) * 0.8;

  upScore += clamp(upMove / moveScale, 0, 3) * (0.75 * scoreTrendWeight);
  downScore += clamp(downMove / moveScale, 0, 3) * (0.75 * scoreTrendWeight);

  upScore += clamp((-downMove) / imbScale, 0, 3) * (0.55 * scoreEdgeWeight / 8);
  downScore += clamp((-upMove) / imbScale, 0, 3) * (0.55 * scoreEdgeWeight / 8);

  if (history.length >= 3) {
    const last3 = history.slice(-3);
    const upConsistent =
      last3[1].upAsk >= last3[0].upAsk &&
      last3[2].upAsk >= last3[1].upAsk;
    const downConsistent =
      last3[1].downAsk >= last3[0].downAsk &&
      last3[2].downAsk >= last3[1].downAsk;
    const upBidSupport =
      last3[1].upBid >= last3[0].upBid &&
      last3[2].upBid >= last3[1].upBid;
    const downBidSupport =
      last3[1].downBid >= last3[0].downBid &&
      last3[2].downBid >= last3[1].downBid;

    if (upConsistent) upScore += 0.4;
    if (downConsistent) downScore += 0.4;
    if (upBidSupport) upScore += 0.25;
    if (downBidSupport) downScore += 0.25;
  }

  const upSpreadPenalty = clamp(upSpread / Math.max(maxSpread, 0.000001), 0, 2.5) * 0.55;
  const downSpreadPenalty = clamp(downSpread / Math.max(maxSpread, 0.000001), 0, 2.5) * 0.55;
  upScore -= upSpreadPenalty;
  downScore -= downSpreadPenalty;

  const recent = history.slice(-Math.min(6, history.length));
  let volatility = 0;
  for (let i = 1; i < recent.length; i++) {
    volatility = Math.max(
      volatility,
      Math.abs(recent[i].upAsk - recent[i - 1].upAsk),
      Math.abs(recent[i].downAsk - recent[i - 1].downAsk),
      Math.abs((recent[i].upAsk - recent[i].downAsk) - (recent[i - 1].upAsk - recent[i - 1].downAsk)),
    );
  }
  volatility = round6(volatility);

  let leader: TrendDirection = 'FLAT';
  const diff = upScore - downScore;
  const absDiff = Math.abs(diff);

  if (absDiff >= 0.35) {
    leader = diff > 0 ? 'UP' : 'DOWN';
  } else if (gap >= leaderMinGap && upMove >= -0.003) {
    leader = 'UP';
  } else if (-gap >= leaderMinGap && downMove >= -0.003) {
    leader = 'DOWN';
  }

  const strength = round6(clamp(absDiff / 3.0, 0, 1));

  return {
    leader,
    upMove,
    downMove,
    gap,
    pairLive,
    upSpread,
    downSpread,
    volatility,
    upScore: round6(upScore),
    downScore: round6(downScore),
    strength,
  };
}

function getDesiredLeaderSpendShare(signal: LeaderSignal, config: Strategy10Config) {
  let share =
    config.minLeaderSpendShare +
    (config.maxLeaderSpendShare - config.minLeaderSpendShare) * signal.strength;

  if (Math.abs(signal.gap) >= config.strongGap) {
    share += 0.02;
  }
  if (signal.volatility >= config.volatilitySoftCap) {
    share -= 0.015;
  }

  return round6(clamp(share, config.minLeaderSpendShare, config.maxLeaderSpendShare));
}

function getLeaderWindowTargetShares(params: {
  signal: LeaderSignal;
  leaderSide: TrendSide;
  live: LiveQuotes;
  secLeft: number;
  config: Strategy10Config;
}) {
  const { signal, leaderSide, live, secLeft, config } = params;

  const spread = getSpread(live, leaderSide);
  let target =
    config.windowMinShares +
    (config.windowMaxShares - config.windowMinShares) * signal.strength;

  target = Math.max(target, Math.min(config.targetTrendSharesPerCycle, config.windowMaxShares));

  if (Math.abs(signal.gap) >= config.strongGap) {
    target += 12;
  }

  const volPenalty = clamp(1 - (signal.volatility / Math.max(config.volatilitySoftCap, 0.000001)) * 0.40, 0.45, 1);
  const spreadPenalty = clamp(1 - (spread / Math.max(config.maxSpread, 0.000001)) * 0.45, 0.35, 1);

  let latePenalty = 1;
  if (secLeft <= config.stopBeforeEndSec + 90) latePenalty = 0.65;
  else if (secLeft <= config.stopBeforeEndSec + 150) latePenalty = 0.82;

  target *= volPenalty * spreadPenalty * latePenalty;
  return round6(clamp(target, config.windowMinShares, config.windowMaxShares));
}

function getDynamicChildShares(params: {
  remaining: number;
  attemptIndex: number;
  askPrice: number;
  spread: number;
  signal: LeaderSignal;
  config: Strategy10Config;
}) {
  const { remaining, attemptIndex, askPrice, spread, signal, config } = params;

  const retryWeights = [1.0, 0.72, 0.54, 0.40, 0.32, 0.26];
  const retryWeight = retryWeights[attemptIndex] ?? retryWeights[retryWeights.length - 1];

  let size = Math.min(config.baseChildCap, config.maxChunkShares, remaining) * retryWeight;

  const volPenalty = clamp(1 - (signal.volatility / Math.max(config.volatilitySoftCap, 0.000001)) * 0.30, 0.50, 1);
  const spreadPenalty = clamp(1 - (spread / Math.max(config.maxSpread, 0.000001)) * 0.45, 0.35, 1);

  size *= volPenalty * spreadPenalty;

  if (askPrice >= 0.70) size *= 0.82;
  else if (askPrice >= 0.58) size *= 0.90;

  size = Math.min(size, remaining);
  size = clamp(size, config.retryMinShares, Math.min(config.baseChildCap, config.maxChunkShares, remaining));
  return round6(size);
}

function logRealtimeState(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  state: MarketState,
  live: LiveQuotes,
  secLeft: number,
) {
  log(
    logger,
    timestamp,
    marketSlug,
    'LIVE',
    `secLeft=${fmt3(secLeft)} upAsk=${fmt3(live.upAsk)} upBid=${fmt3(live.upBid)} downAsk=${fmt3(live.downAsk)} downBid=${fmt3(live.downBid)} pref=${state.preferredSide} sharesUp=${fmt6(state.sharesUp)} sharesDown=${fmt6(state.sharesDown)} spentUp=${fmt6(state.spentUpUsdc)} spentDown=${fmt6(state.spentDownUsdc)} totalSpent=${fmt6(totalSpent(state))} pairAvg=${fmt6(getCurrentPairAvg(state, live))} upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))} closed=${state.closed}`,
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
    `BUY_SUBMIT side=${label} ask=${fmt3(askPrice)} bidPad=${fmt3(slippageBuffer)} order=${fmt3(orderPrice)} shares=${fmt6(size)} usdc=${fmt6(usdc)}`,
  );

  try {
    const response = await orderService.createAndPostOrder({
      tokenID,
      price: orderPrice,
      side: Side.BUY,
      size,
      orderType: OrderType.FAK,
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
  live: LiveQuotes;
  config: Strategy10Config;
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
    live,
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
  const currentTotalSpent = totalSpent(state);
  if (currentTotalSpent + spendTry > config.maxTotalSpentUsdc) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `total_cap_guard totalSpent=${fmt6(currentTotalSpent)} try=${fmt6(spendTry)} max=${fmt6(config.maxTotalSpentUsdc)}`,
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

  log(
    logger,
    timestamp,
    marketSlug,
    'STATE',
    `pos up=${fmt6(state.sharesUp)} down=${fmt6(state.sharesDown)} spentUp=${fmt6(state.spentUpUsdc)} spentDown=${fmt6(state.spentDownUsdc)} totalSpent=${fmt6(totalSpent(state))} pairAvg=${fmt6(getCurrentPairAvg(state, live))} upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))}`,
  );

  if (shouldCloseMarketByReward(state, config)) {
    state.closed = true;
    log(
      logger,
      timestamp,
      marketSlug,
      'STOP',
      `reward_target_hit upReward=${fmt6(upReward(state))} downReward=${fmt6(downReward(state))} totalSpent=${fmt6(totalSpent(state))} market_closed=true`,
    );
  }

  return true;
}

function evaluateLeaderCandidate(params: {
  state: MarketState;
  side: TrendSide;
  signal: LeaderSignal;
  live: LiveQuotes;
  secLeft: number;
  config: Strategy10Config;
}) {
  const { state, side, signal, live, secLeft, config } = params;

  const askPrice = getAsk(live, side);
  const otherSide = oppositeSide(side);
  const otherShares = getSideShares(state, otherSide);
  const desiredLeaderShare = getDesiredLeaderSpendShare(signal, config);
  let targetShares = getLeaderWindowTargetShares({
    signal,
    leaderSide: side,
    live,
    secLeft,
    config,
  });

  const currentTotalSpent = totalSpent(state);
  if (askPrice <= 0 || askPrice > config.maxTradePrice) return null;
  if (signal.pairLive > config.maxLivePairPrice) return null;
  if (currentTotalSpent >= config.maxTotalSpentUsdc) return null;

  let postSpendShare = getSpendShareAfter({
    state,
    side,
    addShares: targetShares,
    addPrice: askPrice,
  });

  if (currentTotalSpent > 0 && postSpendShare > desiredLeaderShare + 0.14) {
    targetShares *= 0.6;
    postSpendShare = getSpendShareAfter({
      state,
      side,
      addShares: targetShares,
      addPrice: askPrice,
    });
  }

  targetShares = round6(clamp(targetShares, config.windowMinShares, config.windowMaxShares));
  const projected = projectedPairAvg({
    state,
    side,
    addShares: targetShares,
    addPrice: askPrice,
    live,
  });

  const seedMode = otherShares <= 0;
  const strongSignalBonus = signal.strength >= 0.75 ? 0.008 : 0;
  const projectedCap = seedMode
    ? config.maxLivePairPrice
    : config.maxPairPrice + strongSignalBonus;

  if (!seedMode && projected > projectedCap) {
    return null;
  }

  const spread = getSpread(live, side);
  let score = 22;
  score += signal.strength * 8;
  score += Math.max(0, config.maxTradePrice - askPrice) * 3.5;
  score -= Math.max(0, spread - config.maxSpread) * 25;
  score -= Math.max(0, postSpendShare - (desiredLeaderShare + 0.04)) * 55;
  score -= signal.volatility * 40;
  if (!seedMode) {
    score += Math.max(0, (config.maxPairPrice - projected) * 130);
  }
  if (Math.abs(signal.gap) >= config.strongGap) {
    score += 2;
  }

  return {
    side,
    role: 'LEADER' as ActionRole,
    askPrice: round6(askPrice),
    targetShares,
    projectedPairAvg: projected,
    postSpendShare,
    score: round6(score),
    reason: `seed=${seedMode} desiredShare=${fmt6(desiredLeaderShare)} livePair=${fmt6(signal.pairLive)} projected=${fmt6(projected)}`,
  };
}

function evaluateHedgeCandidate(params: {
  state: MarketState;
  leaderSide: TrendSide;
  signal: LeaderSignal;
  live: LiveQuotes;
  config: Strategy10Config;
}) {
  const { state, leaderSide, signal, live, config } = params;

  const side = oppositeSide(leaderSide);
  const askPrice = getAsk(live, side);
  const leaderShares = getSideShares(state, leaderSide);
  const hedgeSpent = getSideSpent(state, side);

  if (leaderShares < config.minHedgeTriggerShares) return null;
  if (askPrice <= 0 || askPrice > Math.min(config.maxTradePrice, config.hedgeMaxPrice)) return null;

  const desiredLeaderShare = getDesiredLeaderSpendShare(signal, config);
  const desiredHedgeShare = round6(1 - desiredLeaderShare);

  const currentPairAvg = getCurrentPairAvg(state, live);
  const desiredHedgeSpend = Math.max(0, totalSpent(state) * desiredHedgeShare - hedgeSpent);
  let targetShares = desiredHedgeSpend > 0
    ? desiredHedgeSpend / askPrice
    : config.retryMinShares;

  if (askPrice <= config.cheapHedgePrice) {
    targetShares *= 1.15;
  } else {
    targetShares *= 0.80;
  }

  targetShares = clamp(targetShares, config.retryMinShares, config.hedgeChunkShares);
  targetShares = round6(targetShares);

  const projected = projectedPairAvg({
    state,
    side,
    addShares: targetShares,
    addPrice: askPrice,
    live,
  });
  const improvement = round6(currentPairAvg - projected);
  const postSpendShare = getSpendShareAfter({
    state,
    side,
    addShares: targetShares,
    addPrice: askPrice,
  });

  const postLeaderShare = round6(1 - postSpendShare);
  const hedgeWantedByShare = postLeaderShare <= desiredLeaderShare + 0.03;
  const cheapEnough = askPrice <= config.cheapHedgePrice;
  const improvesEnough = improvement >= Math.max(config.minEdge * 0.30, 0.002);
  const projectedOk = projected <= config.hedgePairPrice || projected <= currentPairAvg - 0.003;

  if (!(cheapEnough || improvesEnough || hedgeWantedByShare) || !projectedOk) {
    return null;
  }

  let score = 17;
  score += Math.max(0, improvement) * 180;
  score += Math.max(0, config.hedgeMaxPrice - askPrice) * 18;
  score += Math.max(0, desiredLeaderShare - postLeaderShare) * 35;
  score -= signal.volatility * 18;

  return {
    side,
    role: 'HEDGE' as ActionRole,
    askPrice: round6(askPrice),
    targetShares,
    projectedPairAvg: projected,
    postSpendShare,
    score: round6(score),
    reason: `improvement=${fmt6(improvement)} currentPair=${fmt6(currentPairAvg)} desiredLeaderShare=${fmt6(desiredLeaderShare)}`,
  };
}

function updatePreferredSide(params: {
  state: MarketState;
  signal: LeaderSignal;
  now: number;
  config: Strategy10Config;
  logger: Logger;
  timestamp: any;
  marketSlug: string;
}) {
  const { state, signal, now, config, logger, timestamp, marketSlug } = params;

  if (signal.leader === 'FLAT') {
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;
    return;
  }

  if (state.preferredSide === 'FLAT') {
    state.preferredSide = signal.leader;
    state.preferredSideStartedAt = now;
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;
    log(logger, timestamp, marketSlug, 'CYCLE', `start preferred=${state.preferredSide}`);
    return;
  }

  if (state.preferredSide === signal.leader) {
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;
    return;
  }

  const preferredAgeMs = now - state.preferredSideStartedAt;
  const strongFlip =
    Math.abs(signal.gap) >= config.flipMinGap &&
    ((signal.leader === 'UP' && signal.upMove >= config.reversalMove) ||
      (signal.leader === 'DOWN' && signal.downMove >= config.reversalMove));

  if (preferredAgeMs < config.cycleMs && !strongFlip) {
    return;
  }

  if (state.pendingFlipSide === signal.leader) {
    state.pendingFlipCount += 1;
  } else {
    state.pendingFlipSide = signal.leader;
    state.pendingFlipCount = 1;
  }

  log(
    logger,
    timestamp,
    marketSlug,
    'FLIP_CHECK',
    `current=${state.preferredSide} pending=${signal.leader} count=${state.pendingFlipCount}/${config.flipConfirmTicks} strongFlip=${strongFlip}`,
  );

  if (strongFlip || state.pendingFlipCount >= config.flipConfirmTicks) {
    state.preferredSide = signal.leader;
    state.preferredSideStartedAt = now;
    state.pendingFlipSide = null;
    state.pendingFlipCount = 0;
    log(logger, timestamp, marketSlug, 'CYCLE', `flip_to=${state.preferredSide}`);
  }
}

async function executeActionBurst(params: {
  state: MarketState;
  candidate: CandidateAction;
  signal: LeaderSignal;
  live: LiveQuotes;
  orderService: OrderService;
  tokenIds: { up: string; down: string };
  config: Strategy10Config;
  logger: Logger;
  timestamp: any;
  marketSlug: string;
}) {
  const {
    state,
    candidate,
    signal,
    live,
    orderService,
    tokenIds,
    config,
    logger,
    timestamp,
    marketSlug,
  } = params;

  let remaining = candidate.targetShares;
  let filledAny = false;
  const spread = getSpread(live, candidate.side);

  log(
    logger,
    timestamp,
    marketSlug,
    candidate.role,
    `choose side=${candidate.side} ask=${fmt6(candidate.askPrice)} target=${fmt6(candidate.targetShares)} projected=${fmt6(candidate.projectedPairAvg)} postSpendShare=${fmt6(candidate.postSpendShare)} score=${fmt6(candidate.score)} reason=${candidate.reason}`,
  );

  for (let i = 0; i < config.burstCount; i++) {
    if (remaining <= 0) break;
    if (state.orderCount >= config.maxOrdersPerMarket) break;
    if (state.closed) break;

    const shares = getDynamicChildShares({
      remaining,
      attemptIndex: i,
      askPrice: candidate.askPrice,
      spread,
      signal,
      config,
    });

    if (shares <= 0) break;

    const ok = await buySideShares({
      state,
      orderService,
      tokenIds,
      side: candidate.side,
      askPrice: candidate.askPrice,
      shares,
      live,
      config,
      logger,
      timestamp,
      marketSlug,
    });

    if (ok) {
      filledAny = true;
      remaining = round6(Math.max(0, remaining - shares));
    } else if (shares <= config.retryMinShares) {
      break;
    }

    if (remaining <= 0 || state.closed) break;
    if (i < config.burstCount - 1 && config.burstSpacingMs > 0) {
      await sleep(config.burstSpacingMs);
    }
  }

  return filledAny;
}

export function resetStrategy10State(marketSlug?: string) {
  if (marketSlug) {
    strategy10State.delete(marketSlug);
    return;
  }
  strategy10State.clear();
}

export async function main(
  marketSlug: string,
  timestamp: any,
  upQuote: Quote,
  downQuote: Quote,
  orderService: OrderService,
  logger: Logger,
  config: Strategy10Config,
) {
  const now = Date.now();

  if (!config.enabled) return;
  if (!upQuote || !downQuote) return;
  if (!Number.isFinite(upQuote.bestAsk) || !Number.isFinite(downQuote.bestAsk)) return;

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

  let state = strategy10State.get(marketSlug);
  if (!state) {
    state = getDefaultState(now);
    strategy10State.set(marketSlug, state);
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

  const live: LiveQuotes = {
    upAsk: upQuote.bestAsk,
    upBid: upQuote.bestBid ?? 0,
    downAsk: downQuote.bestAsk,
    downBid: downQuote.bestBid ?? 0,
  };

  state.history.push({
    ts: now,
    upAsk: live.upAsk,
    upBid: live.upBid,
    downAsk: live.downAsk,
    downBid: live.downBid,
  });
  trimHistory(state.history, now, Math.max(config.trendWindowMs * 5, 15_000));

  if (now - state.lastLiveLogAt >= 500) {
    logRealtimeState(logger, timestamp, marketSlug, state, live, secLeft);
    state.lastLiveLogAt = now;
  }

  const lifeSec = (now - state.firstSeenAt) / 1000;
  if (lifeSec < config.observeSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'OBSERVE',
      `lifeSec=${fmt3(lifeSec)} upAsk=${fmt3(live.upAsk)} downAsk=${fmt3(live.downAsk)} pairLive=${fmt6(live.upAsk + live.downAsk)}`,
    );
    return;
  }

  if (now - state.lastActionAt < config.cooldownMs) return;
  if (state.orderCount >= config.maxOrdersPerMarket) {
    log(logger, timestamp, marketSlug, 'SKIP', `max_orders_reached=${state.orderCount}`);
    return;
  }
  if (shouldCloseMarketByReward(state, config)) {
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
    maxSpread: config.maxSpread,
    scoreTrendWeight: config.scoreTrendWeight,
    scoreEdgeWeight: config.scoreEdgeWeight,
  });

  log(
    logger,
    timestamp,
    marketSlug,
    'DEBUG',
    `leader=${signal.leader} pref=${state.preferredSide} upAsk=${fmt3(live.upAsk)} downAsk=${fmt3(live.downAsk)} upBid=${fmt3(live.upBid)} downBid=${fmt3(live.downBid)} gap=${fmt6(signal.gap)} pairLive=${fmt6(signal.pairLive)} pairAvg=${fmt6(getCurrentPairAvg(state, live))} upMove=${fmt6(signal.upMove)} downMove=${fmt6(signal.downMove)} upSpread=${fmt6(signal.upSpread)} downSpread=${fmt6(signal.downSpread)} vol=${fmt6(signal.volatility)} upScore=${fmt6(signal.upScore)} downScore=${fmt6(signal.downScore)}`,
  );

  updatePreferredSide({
    state,
    signal,
    now,
    config,
    logger,
    timestamp,
    marketSlug,
  });

  if (state.preferredSide === 'FLAT') return;

  const preferredSide = state.preferredSide as TrendSide;
  const leaderCandidate = evaluateLeaderCandidate({
    state,
    side: preferredSide,
    signal,
    live,
    secLeft,
    config,
  });
  const hedgeCandidate = evaluateHedgeCandidate({
    state,
    leaderSide: preferredSide,
    signal,
    live,
    config,
  });

  const candidates = [leaderCandidate, hedgeCandidate]
    .filter((c): c is CandidateAction => !!c)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) {
    return;
  }

  const chosen = candidates[0];
  const ok = await executeActionBurst({
    state,
    candidate: chosen,
    signal,
    live,
    orderService,
    tokenIds,
    config,
    logger,
    timestamp,
    marketSlug,
  });

  if (!ok && candidates.length > 1) {
    await executeActionBurst({
      state,
      candidate: candidates[1],
      signal,
      live,
      orderService,
      tokenIds,
      config,
      logger,
      timestamp,
      marketSlug,
    });
  }
}
