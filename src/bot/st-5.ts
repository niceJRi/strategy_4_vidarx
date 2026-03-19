import { Logger } from '@nestjs/common';
import { OrderType, Side } from '@polymarket/clob-client';
import { OrderService } from '../order/order.service.js';
import { EndDateContext, TokenIdContext } from '../context/market.js';

export type Strategy5Config = {
  enabled: boolean;
  observeSec: number;
  stopBeforeEndSec: number;
  trendWindowMs: number;
  cycleMs: number;
  cooldownMs: number;
  trendMinMove: number;
  cycleTargetTrendShares: number;
  trendChunkShares: number;
  maxOrdersPerMarket: number;
  slippageBuffer: number;
  maxTradePrice: number;
  maxTotalSpentUsdc: number;
  maxSideSpentUsdc: number;
};

type PricePoint = {
  ts: number;
  up: number;
  down: number;
};

type TrendSide = 'UP' | 'DOWN';
type TrendDirection = TrendSide | 'FLAT';

type MarketState = {
  firstSeenAt: number;
  lastActionAt: number;
  orderCount: number;
  closed: boolean;

  spentUpUsdc: number;
  spentDownUsdc: number;
  sharesUp: number;
  sharesDown: number;

  priceHistory: PricePoint[];

  currentCycleStartedAt: number;
  currentCycleTrend: TrendDirection;
  currentCycleTrendSharesBought: number;
  currentCycleTrendUsdcBought: number;
};

const strategy5State = new Map<string, MarketState>();

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

    priceHistory: [],

    currentCycleStartedAt: now,
    currentCycleTrend: 'FLAT',
    currentCycleTrendSharesBought: 0,
    currentCycleTrendUsdcBought: 0,
  };
}

function round6(v: number) {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function fmt1(v: number) {
  return Number.isFinite(v) ? v.toFixed(1) : 'NaN';
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

function detectTrend(
  history: PricePoint[],
  trendWindowMs: number,
  trendMinMove: number,
): TrendDirection {
  if (history.length < 2) return 'FLAT';

  const newest = history[history.length - 1];
  const oldestAllowedTs = newest.ts - trendWindowMs;

  let oldest = history[0];
  for (const p of history) {
    if (p.ts >= oldestAllowedTs) {
      oldest = p;
      break;
    }
  }

  const upMove = newest.up - oldest.up;

  if (upMove >= trendMinMove) return 'UP';
  if (upMove <= -trendMinMove) return 'DOWN';
  return 'FLAT';
}

function calcAvgPrice(spentUsdc: number, shares: number): number {
  if (shares <= 0) return 0;
  return spentUsdc / shares;
}

function calcReward(state: MarketState): number {
  return round6(
    Math.min(state.sharesUp, state.sharesDown) -
    (state.spentUpUsdc + state.spentDownUsdc),
  );
}

function oppositeSide(side: TrendSide): TrendSide {
  return side === 'UP' ? 'DOWN' : 'UP';
}

async function submitBuyByShares(params: {
  orderService: OrderService;
  tokenID: string;
  askPrice: number;
  shares: number;
  slippageBuffer: number;
  label: 'UP' | 'DOWN';
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
  config: Strategy5Config;
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

  const size = round6(shares);
  if (size <= 0) return false;

  if (askPrice <= 0 || askPrice > config.maxTradePrice) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `price_block side=${side} ask=${fmt3(askPrice)} max=${fmt3(config.maxTradePrice)}`,
    );
    return false;
  }

  const usdc = round6(size * askPrice);
  const totalSpent = round6(state.spentUpUsdc + state.spentDownUsdc);

  if (totalSpent + usdc > config.maxTotalSpentUsdc + 1e-9) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `total_cap side=${side} usdc=${fmt6(usdc)} total=${fmt6(totalSpent)} cap=${fmt6(config.maxTotalSpentUsdc)}`,
    );
    return false;
  }

  if (side === 'UP' && state.spentUpUsdc + usdc > config.maxSideSpentUsdc + 1e-9) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `up_cap usdc=${fmt6(usdc)} sideSpent=${fmt6(state.spentUpUsdc)} cap=${fmt6(config.maxSideSpentUsdc)}`,
    );
    return false;
  }

  if (side === 'DOWN' && state.spentDownUsdc + usdc > config.maxSideSpentUsdc + 1e-9) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `down_cap usdc=${fmt6(usdc)} sideSpent=${fmt6(state.spentDownUsdc)} cap=${fmt6(config.maxSideSpentUsdc)}`,
    );
    return false;
  }

  const response = await submitBuyByShares({
    orderService,
    tokenID: side === 'UP' ? tokenIds.up : tokenIds.down,
    askPrice,
    shares: size,
    slippageBuffer: config.slippageBuffer,
    label: side,
    logger,
    timestamp,
    marketSlug,
  });

  if (!getAcceptedOrder(response)) return false;

  if (side === 'UP') {
    state.sharesUp = round6(state.sharesUp + size);
    state.spentUpUsdc = round6(state.spentUpUsdc + usdc);
  } else {
    state.sharesDown = round6(state.sharesDown + size);
    state.spentDownUsdc = round6(state.spentDownUsdc + usdc);
  }

  state.orderCount += 1;
  state.lastActionAt = Date.now();
  return true;
}

function startNewCycle(state: MarketState, trend: TrendDirection, now: number) {
  state.currentCycleTrend = trend;
  state.currentCycleStartedAt = now;
  state.currentCycleTrendSharesBought = 0;
  state.currentCycleTrendUsdcBought = 0;
}

export function getStrategy5State(marketSlug: string) {
  return strategy5State.get(marketSlug);
}

export function resetStrategy5State(marketSlug?: string) {
  if (marketSlug) {
    strategy5State.delete(marketSlug);
    return;
  }
  strategy5State.clear();
}

export async function main(
  marketSlug: string,
  timestamp: any,
  upAsk: number,
  downAsk: number,
  orderService: OrderService,
  logger: Logger,
  config: Strategy5Config,
) {
  const now = Date.now();
  const state = strategy5State.get(marketSlug) ?? getDefaultState(now);
  strategy5State.set(marketSlug, state);

  const tokenIds = TokenIdContext.get(marketSlug);
  const endDateSec = EndDateContext.get(marketSlug);

  if (!config.enabled) {
    log(logger, timestamp, marketSlug, 'SKIP', 'disabled');
    return;
  }

  if (!tokenIds || !endDateSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `missing_context tokenIds=${!!tokenIds} endDate=${!!endDateSec}`,
    );
    return;
  }

  if (!Number.isFinite(upAsk) || !Number.isFinite(downAsk) || upAsk <= 0 || downAsk <= 0) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `invalid_prices up=${fmt3(upAsk)} down=${fmt3(downAsk)}`,
    );
    return;
  }

  const timeLeftSec = endDateSec - now / 1000;
  const observedSec = (now - state.firstSeenAt) / 1000;

  trimHistory(state.priceHistory, now, Math.max(config.trendWindowMs * 3, 10_000));
  state.priceHistory.push({ ts: now, up: upAsk, down: downAsk });

  log(
    logger,
    timestamp,
    marketSlug,
    'TICK',
    `up=${fmt3(upAsk)} down=${fmt3(downAsk)} left=${fmt1(timeLeftSec)}s observed=${fmt1(observedSec)}s reward=${fmt6(calcReward(state))}`,
  );

  if (state.closed) {
    log(logger, timestamp, marketSlug, 'SKIP', 'closed');
    return;
  }

  if (state.orderCount >= config.maxOrdersPerMarket) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `max_orders count=${state.orderCount} max=${config.maxOrdersPerMarket}`,
    );
    return;
  }

  if (timeLeftSec <= config.stopBeforeEndSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `hard_stop left=${fmt1(timeLeftSec)} stop=${config.stopBeforeEndSec}`,
    );
    return;
  }

  if (observedSec < config.observeSec) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `observe_only observed=${fmt1(observedSec)} need=${config.observeSec}`,
    );
    return;
  }

  if (now - state.lastActionAt < config.cooldownMs) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `cooldown elapsed=${now - state.lastActionAt}ms cooldown=${config.cooldownMs}ms`,
    );
    return;
  }

  const detectedTrend = detectTrend(
    state.priceHistory,
    config.trendWindowMs,
    config.trendMinMove,
  );

  if (state.currentCycleTrend === 'FLAT') {
    if (detectedTrend === 'FLAT') {
      log(logger, timestamp, marketSlug, 'SKIP', 'no_trend');
      return;
    }

    startNewCycle(state, detectedTrend, now);
    log(
      logger,
      timestamp,
      marketSlug,
      'ACTION',
      `cycle_start trend=${state.currentCycleTrend}`,
    );
  }

  const cycleElapsed = now - state.currentCycleStartedAt;

  if (cycleElapsed >= config.cycleMs) {
    const prevTrend = state.currentCycleTrend;
    const prevShares = round6(state.currentCycleTrendSharesBought);
    const prevUsdc = round6(state.currentCycleTrendUsdcBought);

    if (prevTrend !== 'FLAT' && prevShares > 0) {
      const hedgeSide = oppositeSide(prevTrend);
      const currentOtherAsk = hedgeSide === 'UP' ? upAsk : downAsk;
      const avgTrendPrice = calcAvgPrice(prevUsdc, prevShares);
      const sumCheck = round6(avgTrendPrice + currentOtherAsk);

      let nextTrend: TrendDirection = detectedTrend === 'FLAT' ? prevTrend : detectedTrend;

      if (sumCheck < 1) {
        const ok = await buySideShares({
          state,
          orderService,
          tokenIds,
          side: hedgeSide,
          askPrice: currentOtherAsk,
          shares: prevShares,
          config,
          logger,
          timestamp,
          marketSlug,
        });

        if (ok) {
          log(
            logger,
            timestamp,
            marketSlug,
            'ACTION',
            `cycle_hedge prevTrend=${prevTrend} hedgeSide=${hedgeSide} hedgeShares=${fmt6(prevShares)} avgTrend=${fmt3(avgTrendPrice)} otherAsk=${fmt3(currentOtherAsk)} sum=${fmt3(sumCheck)}`,
          );
        } else {
          log(
            logger,
            timestamp,
            marketSlug,
            'SKIP',
            `hedge_failed prevTrend=${prevTrend} hedgeSide=${hedgeSide} hedgeShares=${fmt6(prevShares)}`,
          );
        }
      } else {
        nextTrend = oppositeSide(prevTrend);
        log(
          logger,
          timestamp,
          marketSlug,
          'ACTION',
          `cycle_flip prevTrend=${prevTrend} nextTrend=${nextTrend} avgTrend=${fmt3(avgTrendPrice)} otherAsk=${fmt3(currentOtherAsk)} sum=${fmt3(sumCheck)}`,
        );
      }

      startNewCycle(state, nextTrend, now);
      strategy5State.set(marketSlug, state);
      return;
    }

    const fallbackTrend: TrendDirection =
      detectedTrend === 'FLAT'
        ? state.currentCycleTrend === 'FLAT'
          ? 'FLAT'
          : state.currentCycleTrend
        : detectedTrend;

    startNewCycle(state, fallbackTrend, now);
    strategy5State.set(marketSlug, state);
    return;
  }

  if (state.currentCycleTrend === 'FLAT') {
    log(logger, timestamp, marketSlug, 'SKIP', 'flat_cycle');
    return;
  }

  const remainingCycleShares = round6(
    config.cycleTargetTrendShares - state.currentCycleTrendSharesBought,
  );

  if (remainingCycleShares <= 0) {
    log(
      logger,
      timestamp,
      marketSlug,
      'SKIP',
      `cycle_full trend=${state.currentCycleTrend} bought=${fmt6(state.currentCycleTrendSharesBought)} target=${fmt6(config.cycleTargetTrendShares)}`,
    );
    return;
  }

  const chunkShares = round6(
    Math.min(config.trendChunkShares, remainingCycleShares),
  );

  const tradeSide: TrendSide = state.currentCycleTrend === 'UP' ? 'UP' : 'DOWN';
  const tradeAsk = tradeSide === 'UP' ? upAsk : downAsk;

  const ok = await buySideShares({
    state,
    orderService,
    tokenIds,
    side: tradeSide,
    askPrice: tradeAsk,
    shares: chunkShares,
    config,
    logger,
    timestamp,
    marketSlug,
  });

  if (!ok) {
    strategy5State.set(marketSlug, state);
    return;
  }

  const tradeUsdc = round6(chunkShares * tradeAsk);
  state.currentCycleTrendSharesBought = round6(
    state.currentCycleTrendSharesBought + chunkShares,
  );
  state.currentCycleTrendUsdcBought = round6(
    state.currentCycleTrendUsdcBought + tradeUsdc,
  );

  const totalSpent = round6(state.spentUpUsdc + state.spentDownUsdc);
  if (totalSpent >= config.maxTotalSpentUsdc - 0.5) {
    state.closed = true;
    log(
      logger,
      timestamp,
      marketSlug,
      'ACTION',
      `market_close totalSpent=${fmt6(totalSpent)} cap=${fmt6(config.maxTotalSpentUsdc)}`,
    );
  }

  strategy5State.set(marketSlug, state);

  log(
    logger,
    timestamp,
    marketSlug,
    'DONE',
    `trend=${state.currentCycleTrend} chunk=${fmt6(chunkShares)} cycleShares=${fmt6(state.currentCycleTrendSharesBought)} cycleUsdc=${fmt6(state.currentCycleTrendUsdcBought)} totalUpShares=${fmt6(state.sharesUp)} totalDownShares=${fmt6(state.sharesDown)} spentUp=${fmt6(state.spentUpUsdc)} spentDown=${fmt6(state.spentDownUsdc)} reward=${fmt6(calcReward(state))} orders=${state.orderCount}`,
  );
}