import { Logger } from '@nestjs/common';
import { BotService } from '../bot/bot.service.js';

type St4FillState = {
  upMatchedShares: number;
  downMatchedShares: number;
  upMatchedCount: number;
  downMatchedCount: number;
  lastTradeAt: number;
};

const St4FillContext = new Map<string, St4FillState>();

function round6(value: number) {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function getState(conditionId: string): St4FillState {
  return (
    St4FillContext.get(conditionId) ?? {
      upMatchedShares: 0,
      downMatchedShares: 0,
      upMatchedCount: 0,
      downMatchedCount: 0,
      lastTradeAt: 0,
    }
  );
}

/**
 * User websocket handler for Strategy 4.
 *
 * This file belongs in src/user/st-4.ts
 * and is imported by src/user/user.service.ts
 *
 * Signature must match:
 * handleMessage(message, key, botService, logger)
 */
export const handleMessage = (
  message: any,
  key: string,
  _botService: BotService,
  logger: Logger,
) => {
  try {
    if (!message) return;
    if (message.event_type !== 'trade') return;
    if (message.status !== 'MATCHED') return;

    const conditionId = message.market;
    if (!conditionId) return;

    const makerOrders = Array.isArray(message.maker_orders)
      ? message.maker_orders.filter((o: any) => o.owner === key)
      : [];

    if (makerOrders.length === 0) return;

    const state = getState(conditionId);

    for (const makerOrder of makerOrders) {
      const outcomeRaw = String(makerOrder.outcome || '').toLowerCase();
      const matchedAmount = parseFloat(makerOrder.matched_amount) || 0;
      const price = parseFloat(makerOrder.price) || 0;
      const orderId = String(makerOrder.order_id || '');

      if (matchedAmount <= 0) continue;

      if (outcomeRaw === 'up') {
        state.upMatchedShares = round6(state.upMatchedShares + matchedAmount);
        state.upMatchedCount += 1;
      } else if (outcomeRaw === 'down') {
        state.downMatchedShares = round6(state.downMatchedShares + matchedAmount);
        state.downMatchedCount += 1;
      } else {
        continue;
      }

      state.lastTradeAt = Date.now();

      logger.log(
        `${message.timestamp}: ${Date.now()}: [ST4 USER] market=${conditionId} orderId=${orderId} outcome=${outcomeRaw} matchedShares=${matchedAmount.toFixed(6)} price=${price.toFixed(4)} upShares=${state.upMatchedShares.toFixed(6)} downShares=${state.downMatchedShares.toFixed(6)}`,
      );
    }

    St4FillContext.set(conditionId, state);
  } catch (error) {
    logger.error(`[ST4 USER] handleMessage error: ${error}`);
  }
};

export const getStrategy4UserState = (conditionId: string) => {
  return getState(conditionId);
};

export const resetStrategy4UserState = (conditionId?: string) => {
  if (conditionId) {
    St4FillContext.delete(conditionId);
    return;
  }

  St4FillContext.clear();
};