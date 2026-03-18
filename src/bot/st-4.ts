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

  if (combinedAsk > 1.0) {
    leaderShare = Math.min(leaderShare, 0.72);
  }

  const hedgeCheapEnough =
    hedgeCheap(upAsk, downAsk, signalDirection, config.hedgeOnlyBelowPrice) &&
    combinedAsk <= config.hedgeCombinedCap;

  if (hedgeCheapEnough) {
    leaderShare = Math.min(leaderShare, 0.68);
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

  if (combinedAsk > 1.0) {
    targetUpShare = clamp(targetUpShare, 0.30, 0.70);
  }

  const currentUpShare = totalSpent > 0 ? state.spentUpUsdc / totalSpent : 0.5;
  const currentDownShare = 1 - currentUpShare;
  const targetDownShare = 1 - targetUpShare;

  const upNeed = targetUpShare - currentUpShare;
  const downNeed = targetDownShare - currentDownShare;

  const upBias = Math.max(0, upNeed);
  const downBias = Math.max(0, downNeed);

  let upWeight = upBias;
  let downWeight = downBias;

  if (upWeight === 0 && downWeight === 0) {
    if (signalDirection > 0) {
      upWeight = 0.55;
      downWeight = hedgeCheapEnough ? 0.45 : 0.20;
    } else if (signalDirection < 0) {
      downWeight = 0.55;
      upWeight = hedgeCheapEnough ? 0.45 : 0.20;
    } else {
      upWeight = 0.5;
      downWeight = 0.5;
    }
  }

  const totalWeight = upWeight + downWeight;
  if (totalWeight <= 0) {
    logSkip(logger, timestamp, marketSlug, 'zero_weights');
    return;
  }

  let upUsdc = round6(maxTradeBudget * (upWeight / totalWeight));
  let downUsdc = round6(maxTradeBudget * (downWeight / totalWeight));

  const oneSideCapUsdc = config.maxMarketExposureUsdc * config.maxOneSideExposurePct;
  const upRemainingCap = Math.max(0, oneSideCapUsdc - state.spentUpUsdc);
  const downRemainingCap = Math.max(0, oneSideCapUsdc - state.spentDownUsdc);

  upUsdc = Math.min(upUsdc, upRemainingCap, remainingBudget);
  downUsdc = Math.min(downUsdc, downRemainingCap, Math.max(0, remainingBudget - upUsdc));

  const plannedTotal = round6(upUsdc + downUsdc);

  if (plannedTotal < config.minTradeUsdc) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'planned_total_low',
      `planned=${fmt3(plannedTotal)} minTrade=${fmt3(config.minTradeUsdc)}`,
    );
    return;
  }

  if (upUsdc > 0 && upUsdc < config.minTradeUsdc) {
    if (plannedTotal >= config.minTradeUsdc * 2) {
      upUsdc = config.minTradeUsdc;
      downUsdc = round6(plannedTotal - upUsdc);
    } else {
      upUsdc = 0;
    }
  }

  if (downUsdc > 0 && downUsdc < config.minTradeUsdc) {
    if (plannedTotal >= config.minTradeUsdc * 2) {
      downUsdc = config.minTradeUsdc;
      upUsdc = round6(plannedTotal - downUsdc);
    } else {
      downUsdc = 0;
    }
  }

  const finalTotal = round6(upUsdc + downUsdc);
  if (finalTotal < config.minTradeUsdc) {
    logSkip(
      logger,
      timestamp,
      marketSlug,
      'final_total_low',
      `final=${fmt3(finalTotal)} minTrade=${fmt3(config.minTradeUsdc)}`,
    );
    return;
  }

  logAction(
    logger,
    timestamp,
    marketSlug,
    'PLAN',
    `up=${fmt3(upAsk)} down=${fmt3(downAsk)} combined=${fmt3(combinedAsk)} gap=${fmt3(gap)} left=${fmt1(timeLeftSec)}s signal=${fmt3(signalDirection)} targetUp=${fmt3(targetUpShare)} currentUp=${fmt3(currentUpShare)} buyUp=${fmt3(upUsdc)} buyDown=${fmt3(downUsdc)} remaining=${fmt3(remainingBudget)}`,
  );

  const orders: Array<{
    label: 'up' | 'down';
    tokenID: string;
    askPrice: number;
    usdc: number;
  }> = [];

  if (upUsdc >= config.minTradeUsdc) {
    orders.push({
      label: 'up',
      tokenID: tokenIds.up,
      askPrice: upAsk,
      usdc: upUsdc,
    });
  }

  if (downUsdc >= config.minTradeUsdc) {
    orders.push({
      label: 'down',
      tokenID: tokenIds.down,
      askPrice: downAsk,
      usdc: downUsdc,
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

  logDone(
    logger,
    timestamp,
    marketSlug,
    `up=${fmt3(upAsk)} down=${fmt3(downAsk)} combined=${fmt3(combinedAsk)} gap=${fmt3(gap)} left=${fmt1(timeLeftSec)}s spentUp=${fmt3(state.spentUpUsdc)} spentDown=${fmt3(state.spentDownUsdc)} sharesUp=${fmt3(state.sharesUp)} sharesDown=${fmt3(state.sharesDown)} trades=${state.tradeCount}`,
  );
}

function hedgeCheap(
  upAsk: number,
  downAsk: number,
  signalDirection: number,
  hedgeOnlyBelowPrice: number,
) {
  if (signalDirection > 0) return downAsk <= hedgeOnlyBelowPrice;
  if (signalDirection < 0) return upAsk <= hedgeOnlyBelowPrice;
  return upAsk <= hedgeOnlyBelowPrice || downAsk <= hedgeOnlyBelowPrice;
}