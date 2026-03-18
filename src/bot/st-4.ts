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

function sideLabel(direction: boolean) {
  return direction ? 'up' : 'down';
}

async function submitBuy(params: {
  orderService: OrderService;
  tokenID: string;
  askPrice: number;
  usdcAmount: number;
  slippageBuffer: number;
}) {
  const { orderService, tokenID, askPrice, usdcAmount, slippageBuffer } = params;
  const spend = round6(usdcAmount);
  if (spend <= 0 || askPrice <= 0) return null;

  const size = round6(spend / askPrice);
  if (size <= 0) return null;

  const orderPrice = Math.min(0.99, round6(askPrice + slippageBuffer));

  return orderService.createAndPostOrder({
    tokenID,
    price: orderPrice,
    side: Side.BUY,
    size,
    orderType: OrderType.GTC,
  });
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
  if (!config.enabled) return;

  const tokenIds = TokenIdContext.get(marketSlug);
  const conditionId = ConditionIdContext.get(marketSlug);
  if (!tokenIds || !conditionId) return;

  if (!Number.isFinite(upAsk) || !Number.isFinite(downAsk) || upAsk <= 0 || downAsk <= 0) {
    return;
  }

  const nowMs = Date.now();
  const endDateSec = EndDateContext.get(marketSlug);
  if (!endDateSec) return;

  const timeLeftSec = endDateSec - nowMs / 1000;
  if (timeLeftSec > config.tradeWindowStartSec) return;
  if (timeLeftSec <= config.hardStopSec) return;

  const combinedAsk = round6(upAsk + downAsk);
  if (combinedAsk > config.maxCombinedAsk) return;

  const state = marketState.get(marketSlug) ?? getDefaultState();
  if (state.closed) return;
  if (state.tradeCount >= config.maxTradesPerMarket) return;
  if (nowMs - state.lastActionAt < config.cooldownMs) return;

  const totalSpent = state.spentUpUsdc + state.spentDownUsdc;
  const remainingBudget = config.maxMarketExposureUsdc - totalSpent;
  if (remainingBudget < config.minTradeUsdc) return;

  const gap = Math.abs(upAsk - downAsk);
  if (gap < config.minPriceGap) return;

  const leaderIsUp = upAsk >= downAsk;
  const leaderAsk = leaderIsUp ? upAsk : downAsk;
  const hedgeAsk = leaderIsUp ? downAsk : upAsk;
  const leaderSpent = leaderIsUp ? state.spentUpUsdc : state.spentDownUsdc;
  const hedgeSpent = leaderIsUp ? state.spentDownUsdc : state.spentUpUsdc;
  const oneSideCapUsdc = config.maxMarketExposureUsdc * config.maxOneSideExposurePct;

  const gapStrength = clamp(
    (gap - config.minPriceGap) /
      Math.max(config.strongPriceGap - config.minPriceGap, 0.000001),
    0,
    1,
  );

  let targetLeaderShare =
    config.minLeaderShare +
    (config.maxLeaderShare - config.minLeaderShare) * gapStrength;

  if (hedgeAsk > config.hedgeOnlyBelowPrice || combinedAsk > config.hedgeCombinedCap) {
    targetLeaderShare = config.maxLeaderShare;
  }

  targetLeaderShare = clamp(
    targetLeaderShare,
    config.minLeaderShare,
    config.maxLeaderShare,
  );

  const maxTradeBudget = Math.min(
    config.maxTradeUsdc,
    remainingBudget,
    Math.max(config.minTradeUsdc, remainingBudget * config.maxBudgetFractionPerTrade),
  );

  if (maxTradeBudget < config.minTradeUsdc) return;

  let leaderUsdc = round6(maxTradeBudget * targetLeaderShare);
  let hedgeUsdc = round6(maxTradeBudget - leaderUsdc);

  const leaderRemainingCap = Math.max(0, oneSideCapUsdc - leaderSpent);
  const hedgeRemainingCap = Math.max(0, oneSideCapUsdc - hedgeSpent);

  leaderUsdc = Math.min(leaderUsdc, leaderRemainingCap, remainingBudget);
  hedgeUsdc = Math.min(hedgeUsdc, hedgeRemainingCap, Math.max(0, remainingBudget - leaderUsdc));

  if (leaderUsdc < config.minTradeUsdc) return;
  if (hedgeUsdc < config.minTradeUsdc) hedgeUsdc = 0;

  const orders: Array<{
    label: 'up' | 'down';
    tokenID: string;
    askPrice: number;
    usdc: number;
  }> = [];

  orders.push({
    label: leaderIsUp ? 'up' : 'down',
    tokenID: leaderIsUp ? tokenIds.up : tokenIds.down,
    askPrice: leaderAsk,
    usdc: leaderUsdc,
  });

  if (hedgeUsdc >= config.minTradeUsdc) {
    orders.push({
      label: leaderIsUp ? 'down' : 'up',
      tokenID: leaderIsUp ? tokenIds.down : tokenIds.up,
      askPrice: hedgeAsk,
      usdc: hedgeUsdc,
    });
  }

  const fills: Array<{ label: 'up' | 'down'; usdc: number; shares: number }> = [];

  for (const order of orders) {
    const response = await submitBuy({
      orderService,
      tokenID: order.tokenID,
      askPrice: order.askPrice,
      usdcAmount: order.usdc,
      slippageBuffer: config.slippageBuffer,
    });

    if (!response?.success) continue;

    const spend = round6(order.usdc);
    const shares = round6(spend / order.askPrice);

    fills.push({
      label: order.label,
      usdc: spend,
      shares,
    });
  }

  if (fills.length === 0) return;

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
  }

  marketState.set(marketSlug, state);

  logger.log(
    `${timestamp}: ${Date.now()}: [ST4] market=${marketSlug} timeLeft=${timeLeftSec.toFixed(1)}s combinedAsk=${combinedAsk.toFixed(3)} gap=${gap.toFixed(3)} leader=${sideLabel(leaderIsUp)} targetLeaderShare=${targetLeaderShare.toFixed(3)} spentUp=${state.spentUpUsdc.toFixed(3)} spentDown=${state.spentDownUsdc.toFixed(3)} trades=${state.tradeCount}`,
  );
}
