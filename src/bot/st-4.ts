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
  totalBuy: number;
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

function calcCurrentPairAvg(state: MarketState, upAsk: number, downAsk: number): number {
  const avgUp = state.sharesUp > 0 ? calcAvgPrice(state.spentUpUsdc, state.sharesUp) : upAsk;
  const avgDown = state.sharesDown > 0 ? calcAvgPrice(state.spentDownUsdc, state.sharesDown) : downAsk;
  return avgUp + avgDown;
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
  currentPairAvg: number;
  phaseProgress: number;
  hasBothSides: boolean;
  gapStrength: number;
  combinedAsk: number;
}) {
  const {
    targetUpShare,
    projectedUpShare,
    projectedPairAvg,
    buyUpUsdc,
    buyDownUsdc,
    currentPairAvg,
    phaseProgress,
    hasBothSides,
    gapStrength,
    combinedAsk,
  } = params;

  const totalBuy = buyUpUsdc + buyDownUsdc;
  const splitError = Math.abs(targetUpShare - projectedUpShare);
  const bothSides = buyUpUsdc > 0 && buyDownUsdc > 0;
  const pairImprove = currentPairAvg - projectedPairAvg;

  let score = 0;
  score += totalBuy * (9.5 - phaseProgress * 2.5);
  score -= splitError * 55;
  score -= Math.max(0, projectedPairAvg - 0.985) * 250;
  score += pairImprove * 120;

  if (bothSides) score += 10 + (1 - phaseProgress) * 6;
  if (!hasBothSides && bothSides) score += 12;
  if (!bothSides && !hasBothSides) score -= 16;
  if (!bothSides && combinedAsk > 0.985) score += 5;
  if (bothSides && combinedAsk <= 0.975) score += 6;

  score += gapStrength * 6;

  return score;
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
  const currentPairAvg = calcCurrentPairAvg(state, upAsk, downAsk);
  const hasBothSides = state.spentUpUsdc > 0 && state.spentDownUsdc > 0;

  if (gap < config.minPriceGap && currentPairAvg > config.maxAvgPairPrice) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'gap_small_and_pair_rich',
      `gap=${fmt3(gap)} pairAvg=${fmt3(currentPairAvg)} minGap=${fmt3(config.minPriceGap)}`,
    );
    return;
  }

  const phaseProgress = clamp(
    (config.tradeWindowStartSec - timeLeftSec) /
      Math.max(config.tradeWindowStartSec - config.hardStopSec, 1),
    0,
    1,
  );

  const rawTradeBudget = Math.min(
    config.maxTradeUsdc,
    remainingBudget,
    Math.max(config.minTradeUsdc, remainingBudget * config.maxBudgetFractionPerTrade),
  );

  const phaseBudget = round6(
    clamp(rawTradeBudget * (1.2 - phaseProgress * 0.35), config.minTradeUsdc, config.maxTradeUsdc),
  );

  if (phaseBudget < config.minTradeUsdc) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'trade_budget_low',
      `phaseBudget=${fmt3(phaseBudget)} minTrade=${fmt3(config.minTradeUsdc)}`,
    );
    return;
  }

  const leaderIsUp = upAsk >= downAsk;
  const gapStrength = clamp(
    gap / Math.max(config.strongPriceGap, 0.000001),
    0,
    1,
  );

  let leaderShare =
    config.minLeaderShare +
    (config.maxLeaderShare - config.minLeaderShare) * gapStrength;

  if (combinedAsk > config.hedgeCombinedCap) {
    leaderShare = Math.max(leaderShare, Math.min(config.maxLeaderShare, 0.70));
  }

  leaderShare = clamp(leaderShare, config.minLeaderShare, config.maxLeaderShare);

  const targetUpShare = leaderIsUp ? leaderShare : 1 - leaderShare;
  const projectedTotalSpent = totalSpent + phaseBudget;
  const exactUpBuy = round6(clamp(targetUpShare * projectedTotalSpent - state.spentUpUsdc, 0, phaseBudget));
  const exactDownBuy = round6(phaseBudget - exactUpBuy);

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

    const allowSeedException =
      state.spentUpUsdc === 0 &&
      state.spentDownUsdc === 0 &&
      buyUpUsdc > 0 &&
      buyDownUsdc > 0;

    if (!allowSeedException && metrics.projectedPairAvg > config.maxAvgPairPrice + 1e-9) {
      return;
    }

    const totalBuy = buyUpUsdc + buyDownUsdc;
    if (totalBuy < config.minTradeUsdc) return;

    candidates.push({
      buyUpUsdc,
      buyDownUsdc,
      projectedAvgUp: metrics.projectedAvgUp,
      projectedAvgDown: metrics.projectedAvgDown,
      projectedPairAvg: metrics.projectedPairAvg,
      projectedUpShare: metrics.projectedUpShare,
      totalBuy,
      score: candidateScore({
        targetUpShare,
        projectedUpShare: metrics.projectedUpShare,
        projectedPairAvg: metrics.projectedPairAvg,
        buyUpUsdc,
        buyDownUsdc,
        currentPairAvg,
        phaseProgress,
        hasBothSides,
        gapStrength,
        combinedAsk,
      }),
      reason,
    });
  }

  // Seed both sides very early, which matches the CSV much better than late-only hedging.
  if (totalSpent === 0) {
    const seedBudget = round6(Math.min(phaseBudget, Math.max(config.starterTradeUsdc * 2, config.minTradeUsdc * 2)));
    const seedLeaderShare = clamp((leaderIsUp ? targetUpShare : 1 - targetUpShare), 0.52, 0.60);
    const seedUp = round6(leaderIsUp ? seedBudget * seedLeaderShare : seedBudget * (1 - seedLeaderShare));
    const seedDown = round6(seedBudget - seedUp);
    tryCandidate(seedUp, seedDown, 'seed_both');
    tryCandidate(round6(seedBudget * 0.5), round6(seedBudget * 0.5), 'seed_even');
  }

  // Main candidate: spend toward target share using both sides whenever possible.
  tryCandidate(exactUpBuy, exactDownBuy, 'target_split');

  // Gentle both-side candidate around 60/40, useful when exact split leaves one side tiny.
  if (leaderIsUp) {
    tryCandidate(round6(phaseBudget * 0.62), round6(phaseBudget * 0.38), 'leader_62_38');
    tryCandidate(round6(phaseBudget * 0.70), round6(phaseBudget * 0.30), 'leader_70_30');
  } else {
    tryCandidate(round6(phaseBudget * 0.38), round6(phaseBudget * 0.62), 'leader_38_62');
    tryCandidate(round6(phaseBudget * 0.30), round6(phaseBudget * 0.70), 'leader_30_70');
  }

  // Missing-side seed: historical data almost always has both sides traded.
  if (state.spentUpUsdc === 0 && upAsk <= config.minOppositeSeedPrice) {
    tryCandidate(config.starterTradeUsdc, 0, 'seed_up_only_cheap');
    tryCandidate(config.starterTradeUsdc, config.minTradeUsdc, 'seed_up_plus_down');
  }

  if (state.spentDownUsdc === 0 && downAsk <= config.minOppositeSeedPrice) {
    tryCandidate(0, config.starterTradeUsdc, 'seed_down_only_cheap');
    tryCandidate(config.minTradeUsdc, config.starterTradeUsdc, 'seed_down_plus_up');
  }

  // Rebalance candidate toward underweight side.
  const currentUpShare = totalSpent > 0 ? state.spentUpUsdc / totalSpent : 0.5;
  const upNeed = targetUpShare - currentUpShare;
  if (Math.abs(upNeed) > config.rebalanceBand) {
    const tilt = clamp(0.5 + upNeed, 0.18, 0.82);
    tryCandidate(round6(phaseBudget * tilt), round6(phaseBudget * (1 - tilt)), 'rebalance');
  }

  // One-sided leader add is allowed only after both sides exist or pair is already tight.
  if ((hasBothSides || combinedAsk > config.hedgeCombinedCap) && gapStrength >= 0.35) {
    tryCandidate(leaderIsUp ? phaseBudget : 0, leaderIsUp ? 0 : phaseBudget, 'leader_only');
  }

  if (candidates.length === 0) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'no_valid_candidate',
      `combined=${fmt3(combinedAsk)} targetUp=${fmt3(targetUpShare)} currentUp=${fmt3(currentUpShare)} avgUp=${fmt3(calcAvgPrice(state.spentUpUsdc, state.sharesUp))} avgDown=${fmt3(calcAvgPrice(state.spentDownUsdc, state.sharesDown))} pairAvg=${fmt3(currentPairAvg)}`,
    );
    return;
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];

  let buyUpUsdc = best.buyUpUsdc;
  let buyDownUsdc = best.buyDownUsdc;

  if (buyUpUsdc > 0 && buyUpUsdc < config.minTradeUsdc) buyUpUsdc = 0;
  if (buyDownUsdc > 0 && buyDownUsdc < config.minTradeUsdc) buyDownUsdc = 0;

  // Keep both sides whenever the pair is cheap enough. If the smaller leg was clipped by minTrade,
  // fold it back in only when the pair is already too rich.
  if (combinedAsk <= config.hedgeCombinedCap) {
    if (buyUpUsdc === 0 && best.buyUpUsdc > 0 && remainingBudget >= config.minTradeUsdc) {
      buyUpUsdc = config.minTradeUsdc;
      buyDownUsdc = round6(Math.max(0, buyDownUsdc - config.minTradeUsdc));
    }
    if (buyDownUsdc === 0 && best.buyDownUsdc > 0 && remainingBudget >= config.minTradeUsdc) {
      buyDownUsdc = config.minTradeUsdc;
      buyUpUsdc = round6(Math.max(0, buyUpUsdc - config.minTradeUsdc));
    }
  }

  if (buyUpUsdc + buyDownUsdc < config.minTradeUsdc) {
    logSkip(logger, timestamp, marketSlug, 'final_total_low');
    return;
  }

  logAction(
    logger,
    timestamp,
    marketSlug,
    'PLAN',
    `reason=${best.reason} up=${fmt3(upAsk)} down=${fmt3(downAsk)} combined=${fmt3(combinedAsk)} pairAvg=${fmt3(currentPairAvg)} gap=${fmt3(gap)} left=${fmt1(timeLeftSec)}s phase=${fmt3(phaseProgress)} targetUp=${fmt3(targetUpShare)} currentUp=${fmt3(currentUpShare)} buyUp=${fmt3(buyUpUsdc)} buyDown=${fmt3(buyDownUsdc)} projAvgUp=${fmt3(best.projectedAvgUp)} projAvgDown=${fmt3(best.projectedAvgDown)} projPair=${fmt3(best.projectedPairAvg)} score=${fmt3(best.score)}`,
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
