/*
* 
*/
import { Logger } from "@nestjs/common";
import { OpenOrder, OrderType, Side } from "@polymarket/clob-client";
import { St2RoundContext, St2OrderIdContext, St2Round, St2Order } from "../context/bot.js";
import { ConditionIdContext, TokenIdContext } from "../context/market.js";
import { OrderService } from '../order/order.service.js';

import Papa from 'papaparse';

const BASE_SIZE = 5;
const LIMIT_SUM = 0.95;
const OPPOSITE_PRICE_DELTA = 0.1;
const INTERVAL_SIZE = 0.2;

const getIntervals = (price: number) => {
  return [
    Math.floor(price / INTERVAL_SIZE) * INTERVAL_SIZE, 
    Math.floor(price / INTERVAL_SIZE) * INTERVAL_SIZE + INTERVAL_SIZE
  ];
}

export async function main(
  marketSlug: string,
  timestamp: any,
  upPrice: number,
  downPrice: number,
  orderService: OrderService,
  logger: Logger,
) {
  const tokenIds = TokenIdContext.get(marketSlug);
  const conditionId = ConditionIdContext.get(marketSlug);
  if (!tokenIds || !conditionId) return;

  const rounds = St2RoundContext.get(conditionId);
  const orders = St2OrderIdContext.get(conditionId);

  if (upPrice >= LIMIT_SUM || downPrice >= LIMIT_SUM) return;
  const direction = upPrice > downPrice;

  if (!rounds || rounds.length === 0) {

    await startRound([], [], 1, marketSlug, timestamp, direction, tokenIds, conditionId, logger, orderService);
  } else {
    const round = rounds[rounds.length - 1]; // last round
    // if (round.outcome && upPrice > round.threshold) {
    if (round.outcome && direction) {
      const intervals = getIntervals(upPrice);
      const subRounds = rounds.filter(r => intervals[0] <= r.price && r.price < intervals[1] && r.outcome && !r.done);
      if (subRounds.length === 0) {
        await startRound(rounds, orders, round.id + 1, marketSlug, timestamp, round.outcome, tokenIds, conditionId, logger, orderService);
      }
    }
    // if (round.outcome && upPrice <= round.threshold) {
    if (round.outcome && !direction) {
      const intervals = getIntervals(downPrice);
      const subRounds = rounds.filter(r => intervals[0] <= r.price && r.price < intervals[1] && !r.outcome && !r.done);
      if (subRounds.length === 0) {
        await startRound(rounds, orders, round.id + 1, marketSlug, timestamp, !round.outcome, tokenIds, conditionId, logger, orderService);
      }
    }
    // if (!round.outcome && downPrice > round.threshold) {
    if (!round.outcome && !direction) {
      const intervals = getIntervals(downPrice);
      const subRounds = rounds.filter(r => intervals[0] <= r.price && r.price < intervals[1] && !r.outcome && !r.done);
      if (subRounds.length === 0) {
        await startRound(rounds, orders, round.id + 1, marketSlug, timestamp, !round.outcome, tokenIds, conditionId, logger, orderService);
      }
    }
    // if (!round.outcome && downPrice <= round.threshold) {
    if (!round.outcome && direction) {
      const intervals = getIntervals(upPrice);
      const subRounds = rounds.filter(r => intervals[0] <= r.price && r.price < intervals[1] && r.outcome && !r.done);
      if (subRounds.length === 0) {
        await startRound(rounds, orders, round.id + 1, marketSlug, timestamp, round.outcome, tokenIds, conditionId, logger, orderService);
      }
    }
  }
}

async function startRound(
  prevRounds: St2Round[],
  prevOrders: St2Order[],
  roundId: number,
  marketSlug: string, 
  timestamp: any, 
  direction: boolean,
  tokenIds: {up: string, down: string},
  conditionId: string,
  logger: Logger, 
  orderService: OrderService, 
) {
  logger.log(`${timestamp}: ${Date.now()}: Starting round ${roundId} for market ${marketSlug}`);

  const order = await orderService.createAndPostOrder({ 
    tokenID: direction ? tokenIds.up : tokenIds.down,
    price: 0.99,
    side: Side.BUY,
    size: BASE_SIZE,
    orderType: OrderType.GTC,
  });

  if (!order || !order.success) {
    logger.error(`${Date.now()}: ${timestamp}: Failed to create initial buy order for ${marketSlug} at round ${roundId}`);
    return;
  };

  const value = parseFloat(order.makingAmount); // value of first market order
  const price = Math.round((value / BASE_SIZE) * 100) / 100; // price of first market order

  let currentRound = {
    id: roundId,
    outcome: direction,
    price,
    threshold: Math.round((price - OPPOSITE_PRICE_DELTA) * 100) / 100,
    done: false,
  };

  St2RoundContext.set(conditionId, [...prevRounds, currentRound]);

  logger.log(`${timestamp}: ${Date.now()}: Bought ${BASE_SIZE} of ${direction ? 'up' : 'down'} at price ${price} at round ${roundId} for market ${marketSlug}`);

  let limitPrice = Math.round((LIMIT_SUM - price) * 100) / 100;

  if (limitPrice <= 0) limitPrice = 0.01;

  logger.log(`${timestamp}: ${Date.now()}: Placing limit buy order for ${BASE_SIZE} of ${direction ? 'down' : 'up'} at price ${limitPrice} at round ${roundId} for market ${marketSlug}`);

  const limitOrder = await orderService.createAndPostOrder({
    tokenID: direction ? tokenIds.down : tokenIds.up,
    price: limitPrice,
    side: Side.BUY,
    size: BASE_SIZE,
    orderType: OrderType.GTC,
  })

  if (!limitOrder || !limitOrder.success) {
    logger.error(`${timestamp}: ${Date.now()}: Failed to create limit buy order at round ${roundId} for ${marketSlug}`);
    return;
  };
  
  const limitValue = parseFloat(limitOrder.makingAmount) || null;
  if (limitValue) {
    currentRound.done = true;
    St2RoundContext.set(conditionId, [...prevRounds, currentRound]);
    logger.log(`${timestamp}: ${Date.now()}: Finished round ${roundId} for market ${marketSlug}`);
  } else {
    St2OrderIdContext.set(conditionId, [...prevOrders, {
      id: limitOrder.orderID,
      round: roundId,
      outcome: !direction,
      price: limitPrice,
      size: BASE_SIZE,
      matchedSize: 0
    }]); 
    logger.log(`${timestamp}: ${Date.now()}: Placed limit buy order for ${BASE_SIZE} of ${direction ? 'down' : 'up'} at price ${limitPrice} at round ${roundId} for market ${marketSlug}`);
  }
}