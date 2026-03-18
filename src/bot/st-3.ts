/*
* 
*/
import { Logger } from "@nestjs/common";
import { OrderType } from "@polymarket/clob-client";
import { S3PreOrderContext, S3AllPostOrderContext, S3PositionSizeContext, S3GroupContext } from "../context/bot.js";
import { ConditionIdContext, TokenIdContext } from "../context/market.js";
import { OrderService } from '../order/order.service.js';
import { calculateFee } from "../utils/fee.js";
import { getGroupKey } from "../utils/bot.js";

export async function main(
  marketSlug: string,
  timestamp: any,
  _upPrice: number,
  _downPrice: number,
  baseSize: number,
  delta: number,
  orderService: OrderService,
  logger: Logger,
) {
  const tokenIds = TokenIdContext.get(marketSlug);
  const conditionId = ConditionIdContext.get(marketSlug);
  if (!tokenIds || !conditionId) return;

  if (_upPrice <= delta || _downPrice <= delta) return;

  const upPrice = Math.round((_upPrice - delta) * 100) / 100;
  const downPrice = Math.round((_downPrice - delta) * 100) / 100;

  const upOrderKey = `${conditionId}-up-${upPrice}`;
  const downOrderKey = `${conditionId}-down-${downPrice}`;

  const upGroupKey = getGroupKey(conditionId, true, upPrice);
  const downGroupKey = getGroupKey(conditionId, false, downPrice);
  const upGroupOrder = S3GroupContext.get(upGroupKey);
  const downGroupOrder = S3GroupContext.get(downGroupKey);

  if (upGroupOrder) {
    // logger.error(`${timestamp}: ${Date.now()}: Post order found at price ${upPrice}`);
    return;
  }
  if (downGroupOrder) {
    // logger.error(`${timestamp}: ${Date.now()}: Post order found at price ${downPrice}`);
    return;
  }

  const preUpOrder = S3PreOrderContext.get(upOrderKey);
  const preDownOrder = S3PreOrderContext.get(downOrderKey);

  if (!preUpOrder || !preDownOrder) {
    logger.error(`${timestamp}: ${Date.now()}: No pre order found at price ${upPrice} or ${downPrice}`);
    return;
  }

  const orders = [
    {
      order: preUpOrder,
      orderType: OrderType.GTC,
    },
    {
      order: preDownOrder,
      orderType: OrderType.GTC,
    },
  ];

  // const orderKeys = [upOrderKey, downOrderKey];
  const groupKeys = [upGroupKey, downGroupKey];
  const orderPrice = [upPrice, downPrice];

  const response = await orderService.postOrders(orders);
  if (!response || response.length !== 2) {
    logger.error(`${timestamp}: ${Date.now()}: Failed to post orders at price up: ${upPrice} or down: ${downPrice}`);
    return;
  }

  for (let index = 0; index < response.length; index++) {
    const order = response[index];
    if (order.success) {
      if (order.status === 'live') {
        if (S3GroupContext.get(groupKeys[index])) {
          logger.log(`${timestamp}: ${Date.now()}: Post order already exists at price ${groupKeys[index].split('-')[1]}: ${orderPrice[index]}`);
          continue;
        }

        S3GroupContext.set(groupKeys[index], {
          id: order.orderID,
          outcome: groupKeys[index].includes('up'),
          price: orderPrice[index],
          size: baseSize,
          matchedSize: 0,
        });

        S3AllPostOrderContext.set(conditionId, [...S3AllPostOrderContext.get(conditionId) || [], {
          id: order.orderID,
          outcome: groupKeys[index].includes('up'),
          price: orderPrice[index]
        }]);
      }
      if (order.status === 'matched') {
        const outcome = groupKeys[index].includes('up');
        const value = parseFloat(order.makingAmount);
        const price = Math.round((value / baseSize) * 100) / 100;
        const fee = calculateFee(baseSize, price);
        const size = Math.round((baseSize - fee) * 1000000) / 1000000;
        
        S3PositionSizeContext.set(conditionId, {
          up: outcome ? Math.round((S3PositionSizeContext.get(conditionId)?.up || 0 + size) * 1000000) / 1000000 : (S3PositionSizeContext.get(conditionId)?.up || 0),
          down: outcome ? (S3PositionSizeContext.get(conditionId)?.down || 0) : Math.round((S3PositionSizeContext.get(conditionId)?.down || 0 + size) * 1000000) / 1000000,
        })
      }
    } else {
      logger.error(`${timestamp}: ${Date.now()}: Failed to post order at price ${groupKeys[index].split('-')[1]}: ${orderPrice[index]}`);
      return;
    }
  }

  logger.log(`${timestamp}: ${Date.now()}: [ORDER] up: ${upPrice},  down: ${downPrice}`);
  logger.log(`${timestamp}: ${Date.now()}: [SIZE]  up: ${S3PositionSizeContext.get(conditionId)?.up},  down: ${S3PositionSizeContext.get(conditionId)?.down}`);

  S3PreOrderContext.delete(upOrderKey);
  S3PreOrderContext.delete(downOrderKey);
}