import { Logger } from '@nestjs/common';
import { OrderType, Side } from '@polymarket/clob-client';
import { OrderService } from '../order/order.service.js';
import { ConditionIdContext, EndDateContext, TokenIdContext } from '../context/market.js';

export type Strategy4Config = {
  enabled: boolean;
  tradeWindowStartSec: number;
  hardStopSec: number;
  cooldownMs: number;
  maxTradesPerMarket: number;
  maxMarketExposureUsdc: number;
  maxTradeUsdc: number;
  minTradeUsdc: number;
  maxBudgetFractionPerTrade: number;
  minPriceGap: number;
  strongPriceGap: number;
  maxCombinedAsk: number;
  hedgeOnlyBelowPrice: number;
  hedgeCombinedCap: number;
  minLeaderShare: number;
  maxLeaderShare: number;
  maxOneSideExposurePct: number;
  slippageBuffer: number;

  // new fields
  maxAvgPairPrice: number;
  maxSideSpentUsdc: number;
  rebalanceBand: number;
  starterTradeUsdc: number;
  minOppositeSeedPrice: number;
};

type MarketState = {
  tradeCount: number;
  spentUpUsdc: number;
  spentDownUsdc: number;
  sharesUp: number;
  sharesDown: number;
  lastActionAt: number;
  closed: boolean;
};

type CandidatePlan = {
  buyUpUsdc: number;
  buyDownUsdc: number;
  projectedAvgUp: number;
  projectedAvgDown: number;
  projectedPairAvg: number;
  projectedUpShare: number;
  score: number;
  reason: string;
};

const marketState = new Map<string, MarketState>();

function getDefaultState(): MarketState {
  return {
    tradeCount: 0,
    spentUpUsdc: 0,
    spentDownUsdc: 0,
    sharesUp: 0,
    sharesDown: 0,
    lastActionAt: 0,
    closed: false,
  };
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function fmt1(value: number) {
  return Number.isFinite(value) ? value.toFixed(1) : 'NaN';
}

function fmt3(value: number) {
  return Number.isFinite(value) ? value.toFixed(3) : 'NaN';
}

function fmt6(value: number) {
  return Number.isFinite(value) ? value.toFixed(6) : 'NaN';
}

function logPrefix(timestamp: any, marketSlug: string) {
  return `${timestamp} | ${Date.now()} | ${marketSlug}`;
}

function logTick(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  upAsk: number,
  downAsk: number,
  timeLeftSec?: number,
) {
  logger.log(
    `${logPrefix(timestamp, marketSlug)} | TICK | up=${fmt3(upAsk)} down=${fmt3(downAsk)} left=${timeLeftSec != null ? fmt1(timeLeftSec) : 'n/a'}s`,
  );
}

function logSkip(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  reason: string,
  details?: string,
) {
  logger.log(
    `${logPrefix(timestamp, marketSlug)} | SKIP | ${reason}${details ? ` | ${details}` : ''}`,
  );
}

function logAction(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  action: string,
  details?: string,
) {
  logger.log(
    `${logPrefix(timestamp, marketSlug)} | ACTION | ${action}${details ? ` | ${details}` : ''}`,
  );
}

function logFill(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  details: string,
) {
  logger.log(`${logPrefix(timestamp, marketSlug)} | FILL | ${details}`);
}

function logDone(
  logger: Logger,
  timestamp: any,
  marketSlug: string,
  details: string,
) {
  logger.log(`${logPrefix(timestamp, marketSlug)} | DONE | ${details}`);
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

function calcAvgPrice(spentUsdc: number, shares: number): number {
  if (shares <= 0) return 0;
  return spentUsdc / shares;
}

function calcProjectedMetrics(params: {
  state: MarketState;
  upBuyUsdc: number;
  downBuyUsdc: number;
  upAsk: number;
  downAsk: number;
}) {
  const { state, upBuyUsdc, downBuyUsdc, upAsk, downAsk } = params;

  const upBuyShares = upBuyUsdc > 0 && upAsk > 0 ? upBuyUsdc / upAsk : 0;
  const downBuyShares = downBuyUsdc > 0 && downAsk > 0 ? downBuyUsdc / downAsk : 0;

  const nextSpentUp = state.spentUpUsdc + upBuyUsdc;
  const nextSpentDown = state.spentDownUsdc + downBuyUsdc;
  const nextSharesUp = state.sharesUp + upBuyShares;
  const nextSharesDown = state.sharesDown + downBuyShares;

  const projectedAvgUp = calcAvgPrice(nextSpentUp, nextSharesUp);
  const projectedAvgDown = calcAvgPrice(nextSpentDown, nextSharesDown);

  let projectedPairAvg: number;
  if (nextSharesUp > 0 && nextSharesDown > 0) {
    projectedPairAvg = projectedAvgUp + projectedAvgDown;
  } else if (nextSharesUp > 0) {
    projectedPairAvg = projectedAvgUp + downAsk;
  } else if (nextSharesDown > 0) {
    projectedPairAvg = projectedAvgDown + upAsk;
  } else {
    projectedPairAvg = Infinity;
  }

  const nextTotalSpent = nextSpentUp + nextSpentDown;
  const projectedUpShare = nextTotalSpent > 0 ? nextSpentUp / nextTotalSpent : 0.5;

  return {
    nextSpentUp,
    nextSpentDown,
    nextSharesUp,
    nextSharesDown,
    projectedAvgUp,
    projectedAvgDown,
    projectedPairAvg,
    projectedUpShare,
  };
}

function candidateScore(params: {
  targetUpShare: number;
  projectedUpShare: number;
  projectedPairAvg: number;
  buyUpUsdc: number;
  buyDownUsdc: number;
}) {
  const {
    targetUpShare,
    projectedUpShare,
    projectedPairAvg,
    buyUpUsdc,
    buyDownUsdc,
  } = params;

  const splitError = Math.abs(targetUpShare - projectedUpShare);
  const totalBuy = buyUpUsdc + buyDownUsdc;
  return totalBuy * 10 - splitError * 20 - projectedPairAvg * 2;
}

async function submitBuy(params: {
  orderService: OrderService;
  tokenID: string;
  askPrice: number;
  usdcAmount: number;
  slippageBuffer: number;
  logger: Logger;
  marketSlug: string;
  label: 'up' | 'down';
  timestamp: any;
}) {
  const {
    orderService,
    tokenID,
    askPrice,
    usdcAmount,
    slippageBuffer,
    logger,
    marketSlug,
    label,
    timestamp,
  } = params;

  const spend = round6(usdcAmount);
  if (spend <= 0 || askPrice <= 0) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'submit_buy_invalid',
      `side=${label.toUpperCase()} spend=${fmt6(spend)} ask=${fmt6(askPrice)}`,
    );
    return null;
  }

  const size = round6(spend / askPrice);
  if (size <= 0) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'submit_buy_zero_size',
      `side=${label.toUpperCase()} spend=${fmt6(spend)} ask=${fmt6(askPrice)} size=${fmt6(size)}`,
    );
    return null;
  }

  const orderPrice = Math.min(0.99, round6(askPrice + slippageBuffer));

  logAction(
    logger,
    timestamp,
    marketSlug,
    'BUY_SUBMIT',
    `side=${label.toUpperCase()} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} usdc=${fmt3(spend)} shares=${fmt6(size)}`,
  );

  try {
    const response = await orderService.createAndPostOrder({
      tokenID,
      price: orderPrice,
      side: Side.BUY,
      size,
      orderType: OrderType.GTC,
    });

    const accepted = getAcceptedOrder(response);

    if (accepted) {
      logFill(
        logger,
        timestamp,
        marketSlug,
        `BUY_ACCEPT side=${label.toUpperCase()} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} usdc=${fmt3(spend)} shares=${fmt6(size)}`,
      );
    } else {
      logSkip(
        logger,
        timestamp,
        marketSlug,
        'buy_failed',
        `side=${label.toUpperCase()} ask=${fmt3(askPrice)} order=${fmt3(orderPrice)} usdc=${fmt3(spend)} shares=${fmt6(size)} resp=${JSON.stringify(response)}`,
      );
    }

    return response;
  } catch (error: any) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'buy_error',
      `side=${label.toUpperCase()} error=${error?.message || error}`,
    );
    return null;
  }
}

export function getStrategy4State(marketSlug: string) {
  return marketState.get(marketSlug) ?? getDefaultState();
}

export function resetStrategy4State(marketSlug?: string) {
  if (marketSlug) {
    marketState.delete(marketSlug);
    return;
  }
  marketState.clear();
}

export async function main(
  marketSlug: string,
  timestamp: any,
  upAsk: number,
  downAsk: number,
  orderService: OrderService,
  logger: Logger,
  config: Strategy4Config,
) {
  const nowMs = Date.now();
  const endDateSec = EndDateContext.get(marketSlug);
  const timeLeftSec = endDateSec ? endDateSec - nowMs / 1000 : NaN;

  logTick(logger, timestamp, marketSlug, upAsk, downAsk, timeLeftSec);

  if (!config.enabled) {
    logSkip(logger, timestamp, marketSlug, 'disabled');
    return;
  }

  const tokenIds = TokenIdContext.get(marketSlug);
  const conditionId = ConditionIdContext.get(marketSlug);

  if (!tokenIds || !conditionId) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'missing_context',
      `tokenIds=${!!tokenIds} conditionId=${!!conditionId}`,
    );
    return;
  }

  if (!Number.isFinite(upAsk) || !Number.isFinite(downAsk) || upAsk <= 0 || downAsk <= 0) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'invalid_prices',
      `up=${fmt3(upAsk)} down=${fmt3(downAsk)}`,
    );
    return;
  }

  if (!endDateSec) {
    logSkip(logger, timestamp, marketSlug, 'missing_end_date');
    return;
  }

  if (timeLeftSec > config.tradeWindowStartSec) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'before_window',
      `left=${fmt1(timeLeftSec)}s startAt<=${config.tradeWindowStartSec}s`,
    );
    return;
  }

  if (timeLeftSec <= config.hardStopSec) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'hard_stop',
      `left=${fmt1(timeLeftSec)}s hardStop=${config.hardStopSec}s`,
    );
    return;
  }

  const combinedAsk = round6(upAsk + downAsk);
  if (combinedAsk > config.maxCombinedAsk) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'combined_high',
      `up=${fmt3(upAsk)} down=${fmt3(downAsk)} combined=${fmt3(combinedAsk)} max=${fmt3(config.maxCombinedAsk)}`,
    );
    return;
  }

  const state = marketState.get(marketSlug) ?? getDefaultState();

  if (state.closed) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'market_closed',
      `spentUp=${fmt3(state.spentUpUsdc)} spentDown=${fmt3(state.spentDownUsdc)} trades=${state.tradeCount}`,
    );
    return;
  }

  if (state.tradeCount >= config.maxTradesPerMarket) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'max_trades',
      `count=${state.tradeCount} max=${config.maxTradesPerMarket}`,
    );
    return;
  }

  if (nowMs - state.lastActionAt < config.cooldownMs) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'cooldown',
      `elapsed=${nowMs - state.lastActionAt}ms cooldown=${config.cooldownMs}ms`,
    );
    return;
  }

  const totalSpent = round6(state.spentUpUsdc + state.spentDownUsdc);
  const remainingBudget = round6(config.maxMarketExposureUsdc - totalSpent);

  if (remainingBudget < config.minTradeUsdc) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'budget_low',
      `remaining=${fmt3(remainingBudget)} minTrade=${fmt3(config.minTradeUsdc)}`,
    );
    return;
  }

  const gap = Math.abs(upAsk - downAsk);
  if (gap < config.minPriceGap) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'gap_small',
      `gap=${fmt3(gap)} minGap=${fmt3(config.minPriceGap)}`,
    );
    return;
  }

  const maxTradeBudget = Math.min(
    config.maxTradeUsdc,
    remainingBudget,
    Math.max(config.minTradeUsdc, remainingBudget * config.maxBudgetFractionPerTrade),
  );

  if (maxTradeBudget < config.minTradeUsdc) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'trade_budget_low',
      `maxTradeBudget=${fmt3(maxTradeBudget)} minTrade=${fmt3(config.minTradeUsdc)}`,
    );
    return;
  }

  const signalDirection = upAsk - downAsk;
  const gapStrength = clamp(
    (gap - config.minPriceGap) /
      Math.max(config.strongPriceGap - config.minPriceGap, 0.000001),
    0,
    1,
  );

  let leaderShare =
    config.minLeaderShare +
    (config.maxLeaderShare - config.minLeaderShare) * gapStrength;

  if (combinedAsk > config.hedgeCombinedCap) {
    leaderShare = Math.min(leaderShare, 0.72);
  }

  leaderShare = clamp(leaderShare, config.minLeaderShare, config.maxLeaderShare);

  let targetUpShare: number;
  if (signalDirection > 0) {
    targetUpShare = leaderShare;
  } else if (signalDirection < 0) {
    targetUpShare = 1 - leaderShare;
  } else {
    targetUpShare = 0.5;
  }

  const currentUpShare = totalSpent > 0 ? state.spentUpUsdc / totalSpent : 0.5;
  const upNeed = targetUpShare - currentUpShare;

  let desiredUpUsdc = 0;
  let desiredDownUsdc = 0;

  if (Math.abs(upNeed) <= config.rebalanceBand) {
    desiredUpUsdc = round6(maxTradeBudget * 0.5);
    desiredDownUsdc = round6(maxTradeBudget * 0.5);
  } else if (upNeed > 0) {
    desiredUpUsdc = round6(maxTradeBudget * clamp(0.5 + upNeed, 0.55, 0.85));
    desiredDownUsdc = round6(maxTradeBudget - desiredUpUsdc);
  } else {
    desiredDownUsdc = round6(maxTradeBudget * clamp(0.5 + Math.abs(upNeed), 0.55, 0.85));
    desiredUpUsdc = round6(maxTradeBudget - desiredDownUsdc);
  }

  const sideCap = Math.min(
    config.maxSideSpentUsdc,
    config.maxMarketExposureUsdc * config.maxOneSideExposurePct,
  );

  const candidates: CandidatePlan[] = [];

  function tryCandidate(buyUpUsdc: number, buyDownUsdc: number, reason: string) {
    buyUpUsdc = round6(Math.max(0, buyUpUsdc));
    buyDownUsdc = round6(Math.max(0, buyDownUsdc));

    const nextSpentUp = state.spentUpUsdc + buyUpUsdc;
    const nextSpentDown = state.spentDownUsdc + buyDownUsdc;

    if (nextSpentUp > sideCap + 1e-9) return;
    if (nextSpentDown > sideCap + 1e-9) return;
    if (buyUpUsdc + buyDownUsdc > remainingBudget + 1e-9) return;

    const metrics = calcProjectedMetrics({
      state,
      upBuyUsdc: buyUpUsdc,
      downBuyUsdc: buyDownUsdc,
      upAsk,
      downAsk,
    });

    if (metrics.projectedPairAvg > config.maxAvgPairPrice) return;

    const totalBuy = buyUpUsdc + buyDownUsdc;
    if (totalBuy < config.minTradeUsdc) return;

    candidates.push({
      buyUpUsdc,
      buyDownUsdc,
      projectedAvgUp: metrics.projectedAvgUp,
      projectedAvgDown: metrics.projectedAvgDown,
      projectedPairAvg: metrics.projectedPairAvg,
      projectedUpShare: metrics.projectedUpShare,
      score: candidateScore({
        targetUpShare,
        projectedUpShare: metrics.projectedUpShare,
        projectedPairAvg: metrics.projectedPairAvg,
        buyUpUsdc,
        buyDownUsdc,
      }),
      reason,
    });
  }

  // main balanced/dynamic candidate
  tryCandidate(desiredUpUsdc, desiredDownUsdc, 'dynamic_main');

  // up only
  tryCandidate(maxTradeBudget, 0, 'up_only');

  // down only
  tryCandidate(0, maxTradeBudget, 'down_only');

  // cheap missing-side seed
  if (state.spentUpUsdc === 0 && upAsk <= config.minOppositeSeedPrice) {
    tryCandidate(config.starterTradeUsdc, 0, 'seed_up');
  }

  if (state.spentDownUsdc === 0 && downAsk <= config.minOppositeSeedPrice) {
    tryCandidate(0, config.starterTradeUsdc, 'seed_down');
  }

  if (candidates.length === 0) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'no_valid_candidate',
      `combined=${fmt3(combinedAsk)} targetUp=${fmt3(targetUpShare)} currentUp=${fmt3(currentUpShare)} avgUp=${fmt3(calcAvgPrice(state.spentUpUsdc, state.sharesUp))} avgDown=${fmt3(calcAvgPrice(state.spentDownUsdc, state.sharesDown))}`,
    );
    return;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  let buyUpUsdc = best.buyUpUsdc;
  let buyDownUsdc = best.buyDownUsdc;

  if (buyUpUsdc > 0 && buyUpUsdc < config.minTradeUsdc) buyUpUsdc = 0;
  if (buyDownUsdc > 0 && buyDownUsdc < config.minTradeUsdc) buyDownUsdc = 0;

  if (buyUpUsdc + buyDownUsdc < config.minTradeUsdc) {
    logSkip(logger, timestamp, marketSlug, 'final_total_low');
    return;
  }

  logAction(
    logger,
    timestamp,
    marketSlug,
    'PLAN',
    `reason=${best.reason} up=${fmt3(upAsk)} down=${fmt3(downAsk)} combined=${fmt3(combinedAsk)} gap=${fmt3(gap)} left=${fmt1(timeLeftSec)}s targetUp=${fmt3(targetUpShare)} currentUp=${fmt3(currentUpShare)} buyUp=${fmt3(buyUpUsdc)} buyDown=${fmt3(buyDownUsdc)} projAvgUp=${fmt3(best.projectedAvgUp)} projAvgDown=${fmt3(best.projectedAvgDown)} projPair=${fmt3(best.projectedPairAvg)}`,
  );

  const orders: Array<{
    label: 'up' | 'down';
    tokenID: string;
    askPrice: number;
    usdc: number;
  }> = [];

  if (buyUpUsdc >= config.minTradeUsdc) {
    orders.push({
      label: 'up',
      tokenID: tokenIds.up,
      askPrice: upAsk,
      usdc: buyUpUsdc,
    });
  }

  if (buyDownUsdc >= config.minTradeUsdc) {
    orders.push({
      label: 'down',
      tokenID: tokenIds.down,
      askPrice: downAsk,
      usdc: buyDownUsdc,
    });
  }

  if (orders.length === 0) {
    logSkip(logger, timestamp, marketSlug, 'no_orders_after_sizing');
    return;
  }

  const fills: Array<{ label: 'up' | 'down'; usdc: number; shares: number }> = [];

  for (const order of orders) {
    const response = await submitBuy({
      orderService,
      tokenID: order.tokenID,
      askPrice: order.askPrice,
      usdcAmount: order.usdc,
      slippageBuffer: config.slippageBuffer,
      logger,
      marketSlug,
      label: order.label,
      timestamp,
    });

    const accepted = getAcceptedOrder(response);
    if (!accepted) continue;

    const spend = round6(order.usdc);
    const shares = round6(spend / order.askPrice);

    fills.push({
      label: order.label,
      usdc: spend,
      shares,
    });
  }

  if (fills.length === 0) {
    logSkip(logger, timestamp, marketSlug, 'no_successful_orders');
    return;
  }

  for (const fill of fills) {
    if (fill.label === 'up') {
      state.spentUpUsdc = round6(state.spentUpUsdc + fill.usdc);
      state.sharesUp = round6(state.sharesUp + fill.shares);
    } else {
      state.spentDownUsdc = round6(state.spentDownUsdc + fill.usdc);
      state.sharesDown = round6(state.sharesDown + fill.shares);
    }
  }

  state.tradeCount += 1;
  state.lastActionAt = nowMs;

  if (state.spentUpUsdc + state.spentDownUsdc >= config.maxMarketExposureUsdc - config.minTradeUsdc) {
    state.closed = true;
    logAction(
      logger,
      timestamp,
      marketSlug,
      'MARKET_CLOSE',
      `totalSpent=${fmt3(state.spentUpUsdc + state.spentDownUsdc)} exposure=${fmt3(config.maxMarketExposureUsdc)}`,
    );
  }

  marketState.set(marketSlug, state);

  const avgUp = calcAvgPrice(state.spentUpUsdc, state.sharesUp);
  const avgDown = calcAvgPrice(state.spentDownUsdc, state.sharesDown);

  logDone(
    logger,
    timestamp,
    marketSlug,
    `up=${fmt3(upAsk)} down=${fmt3(downAsk)} combined=${fmt3(combinedAsk)} gap=${fmt3(gap)} left=${fmt1(timeLeftSec)}s spentUp=${fmt3(state.spentUpUsdc)} spentDown=${fmt3(state.spentDownUsdc)} avgUp=${fmt3(avgUp)} avgDown=${fmt3(avgDown)} avgPair=${fmt3(avgUp + avgDown)} trades=${state.tradeCount}`,
  );
}