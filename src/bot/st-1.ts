/*
* 
*/
import { Logger } from "@nestjs/common";
import { OrderType, Side } from "@polymarket/clob-client";
import { PositionSizeContext, OrderIdContext, RoundContext, TotalDepositContext } from "../context/bot.js";
import { ConditionIdContext, TokenIdContext } from "../context/market.js";
import { OrderService } from '../order/order.service.js';
import { BroadcastService } from "../events/broadcast.service.js";

import Papa from 'papaparse';
import { config } from "dotenv";

function getLimitSize(count: number, rate: number) {
  let oddSum = 0, evenSum = 0;
  for (let i = 0; i <= count; i += rate) {
    oddSum += rate ** i;
  }
  for (let i = 1; i <= count; i += rate) {
    evenSum += rate ** i;
  }
  return [oddSum > evenSum ? oddSum : evenSum, Math.round(Math.abs(oddSum - evenSum))];
}

export async function main({
  marketSlug,
  timestamp,
  upPrice,
  downPrice,
  config,
  orderService,
  broadcastService,
  logger,
}: {
  marketSlug: string,
  timestamp: any,
  upPrice: number,
  downPrice: number,
  config: {
    baseSize: number,
    priceThreshold: number,
    profit: number,
    rate: number,
    maxCount: number
  },
  orderService: OrderService,
  broadcastService: BroadcastService,
  logger: Logger,
}) {
  const tokenIds = TokenIdContext.get(marketSlug);
  const conditionId = ConditionIdContext.get(marketSlug);
  if (!tokenIds || !conditionId) return;

  const round = RoundContext.get(conditionId);

  if (!round) {
    if (upPrice < config.priceThreshold && downPrice < config.priceThreshold) return;
    const direction = upPrice > downPrice;

    logger.log(`${timestamp}: ${Date.now()}: Starting round 1 for market ${marketSlug}`);

    const order = await orderService.createAndPostOrder({
      tokenID: direction ? tokenIds.up : tokenIds.down,
      price: 0.99,
      side: Side.BUY,
      size: config.baseSize,
      orderType: OrderType.GTC,
    });

    if (!order || !order.success) {
      logger.error(`${Date.now()}: ${timestamp}: Failed to create initial buy order for ${marketSlug} at round 1`);
      broadcastService.broadcast('1 Round Market Failed.', {});
      return;
    };

    const value = parseFloat(order.makingAmount); // value of first market order
    const price = value / config.baseSize; // price of first market order

    TotalDepositContext.set(conditionId, value);

    RoundContext.set(conditionId, {
      lastOutcome: direction,
      lastPrice: price,
      count: 1,
      done: false,
    })

    logger.log(`${timestamp}: ${Date.now()}: Bought ${config.baseSize} of ${direction ? 'up' : 'down'} at price ${price} for market ${marketSlug} at round 1`);
    broadcastService.broadcast('1 Round Market:', {
      marketSlug,
      side: Side.BUY,
      direction,
      price,
      size: config.baseSize,
      timestamp: Date.now(),
    });

    const firstLimitPrice = Math.round((1 - config.profit - price) * 100) / 100;

    logger.log(`${timestamp}: ${Date.now()}: Placing limit buy order for ${Math.round(config.baseSize)} of ${direction ? 'down' : 'up'} at price ${firstLimitPrice} for market ${marketSlug} at round 1`);

    const limitOrder = await orderService.createAndPostOrder({
      tokenID: direction ? tokenIds.down : tokenIds.up,
      price: firstLimitPrice,
      side: Side.BUY,
      size: config.baseSize,
      orderType: OrderType.GTC,
    })

    if (!limitOrder || !limitOrder.success) {
      logger.error(`${timestamp}: ${Date.now()}: Failed to create limit buy order for ${marketSlug} at round 1`);
      broadcastService.broadcast('1 Round Limit Failed.', {});
      return;
    };
    
    const limitValue = parseFloat(limitOrder.makingAmount) || null;
    if (limitValue) {
      // PositionSizeContext.set(conditionId, null);
      RoundContext.set(conditionId, {
        lastOutcome: direction,
        lastPrice: price,
        count: 1,
        done: true,
      })
      logger.log(`${timestamp}: ${Date.now()}: Finished round 1 for market ${marketSlug}`);
      broadcastService.broadcast('1 Round Finished.', {});
    } else {
      OrderIdContext.set(conditionId, {
        id: limitOrder.orderID,
        outcome: !direction,
        price: firstLimitPrice,
        size: config.baseSize
      }); 
      logger.log(`${timestamp}: ${Date.now()}: Placed limit buy order for ${config.baseSize} of ${direction ? 'down' : 'up'} at price ${firstLimitPrice} for market ${marketSlug} at round 1`);
      broadcastService.broadcast('1 Round Limit:', {
        marketSlug,
        side: Side.BUY,
        direction: !direction,
        price: firstLimitPrice,
        size: config.baseSize,
        timestamp: Date.now(),
      });
    }
  } else {
    if (round.done) return;

    const direction = !round.lastOutcome;
    const currentPrice = direction ? upPrice : downPrice;

    if (currentPrice < config.priceThreshold) return;
    if (round.count >= config.maxCount) { 
      await runSafeMode(conditionId, orderService, tokenIds, config.profit, config.priceThreshold, round, logger); 
      logger.log(`${timestamp}: ${Date.now()}: Finished round ${round.count} for market ${marketSlug}`);
      broadcastService.broadcast(`${round.count} Round Finished. SAFE MODE`, {});
      return; 
    }

    logger.log(`${timestamp}: ${Date.now()}: Starting round ${round.count + 1} for market ${marketSlug}`);

    const size = Math.round(config.baseSize * (config.rate ** round.count));
    const order = await orderService.createAndPostOrder({ 
      tokenID: direction ? tokenIds.up : tokenIds.down,
      price: 0.99,
      side: Side.BUY,
      size,
      orderType: OrderType.GTC,
    });

    if (!order || !order.success) {
      logger.error(`${Date.now()}: ${timestamp}: Failed to create buy order for ${marketSlug} at round ${round.count + 1}`);
      broadcastService.broadcast(`${round.count + 1} Round Market Failed.`, {});
      return;
    };

    const value = parseFloat(order.makingAmount);
    const price = value / size;

    const totalDeposit = TotalDepositContext.get(conditionId) || 0;
    TotalDepositContext.set(conditionId, Math.round((totalDeposit + value) * 100) / 100);

    RoundContext.set(conditionId, {
      lastOutcome: direction,
      lastPrice: price,
      count: round.count + 1,
      done: false,
    })

    logger.log(`${timestamp}: ${Date.now()}: Bought ${size} of ${direction ? 'up' : 'down'} at price ${price} for market ${marketSlug} at round ${round.count + 1}`);
    broadcastService.broadcast(`${round.count + 1} Round Market:`, {
      marketSlug,
      side: Side.BUY,
      direction,
      price,
      size,
      timestamp: Date.now(),
    });

    const lastLimitOrder = OrderIdContext.get(conditionId);

    if (lastLimitOrder) {
      const res = await orderService.cancelOrder(lastLimitOrder.id);
      if (res && res['canceled'].includes(lastLimitOrder.id)) {
        logger.log(`${timestamp}: ${Date.now()}: Canceled existing limit order for market ${marketSlug} at round ${round.count}`);
        OrderIdContext.delete(conditionId);
      }
    }

    const [totalCount, diffCount] = getLimitSize(round.count, config.rate);

    const limitSize = config.baseSize * diffCount;
    const totalSize = config.baseSize * totalCount;

    let limitPrice = Math.floor(((totalSize - totalDeposit - value - config.profit) / limitSize) * 100) / 100;
    if (limitPrice <= 0) limitPrice = 0.1;

    ///////////////////////////////////////////////////////////////////////////////////////////////////

    logger.log(`${timestamp}: ${Date.now()}: Placing limit buy order for ${Math.round(limitSize)} of ${direction ? 'down' : 'up'} at price ${limitPrice} for market ${marketSlug} at round ${round.count + 1}`);

    const limitOrder = await orderService.createAndPostOrder({
      tokenID: direction ? tokenIds.down : tokenIds.up,
      price: limitPrice,
      side: Side.BUY,
      size: Math.round(limitSize),
      orderType: OrderType.GTC,
    })

    if (!limitOrder || !limitOrder.success) {
      logger.error(`${timestamp}: ${Date.now()}: Failed to create limit buy order for ${marketSlug} at round ${round.count + 1}`);
      broadcastService.broadcast(`${round.count + 1} Round Limit Failed.`, {});
      return;
    };
    
    const limitValue = parseFloat(limitOrder.makingAmount) || null;
    if (limitValue) {
      // PositionSizeContext.set(conditionId, null);
      RoundContext.set(conditionId, {
        lastOutcome: direction,
        lastPrice: price,
        count: round.count + 1,
        done: true,
      })
      const result = Papa.unparse([
        [(Number(timestamp) / 1000).toFixed(3), (Date.now()/1000).toFixed(3), `${round.count.toString()}`]
      ], { header: false });
      // fs.appendFileSync(path.join(process.cwd(), 'result', `result.csv`), `${result}\n`);
      logger.log(`${timestamp}: ${Date.now()}: Finished round ${round.count + 1} for market ${marketSlug}`);
      broadcastService.broadcast(`${round.count + 1} Round Finished.`, {});

    } else {
      OrderIdContext.set(conditionId, {
        id: limitOrder.orderID,
        outcome: !direction,
        price: limitPrice,
        size: Math.round(limitSize)
      });
      logger.log(`${timestamp}: ${Date.now()}: Placed limit buy order for ${Math.round(limitSize)} of ${direction ? 'down' : 'up'} at price ${limitPrice} for market ${marketSlug} at round ${round.count + 1}`);
      broadcastService.broadcast(`${round.count + 1} Round Limit:`, {
        marketSlug,
        side: Side.BUY,
        direction: !direction,
        price: limitPrice,
        size: Math.round(limitSize),
        timestamp: Date.now(),
      });
    }
  }
}

async function runSafeMode(
  conditionId: string,
  orderService: OrderService,
  tokenIds: any,
  profit: number,
  priceThreshold: number,
  round: any,
  logger: Logger
) {
  const positionSize = PositionSizeContext.get(conditionId)
  if (!positionSize) return;

  await orderService.createOrders([{ 
    tokenID: tokenIds.up,
    price: 0.01,
    side: Side.SELL,
    size: positionSize.up,
    orderType: OrderType.GTC,
  },{
    tokenID: tokenIds.down,
    price: 0.01,
    side: Side.SELL,
    size: positionSize.down,
    orderType: OrderType.GTC,
  }]);

  RoundContext.set(conditionId, {
    lastOutcome: round.direction,
    lastPrice: round.price,
    count: round.count,
    done: true,
  })

  logger.log(`Entered Safe Mode at round ${round.count}, All sold!`)
}