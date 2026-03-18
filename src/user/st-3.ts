import { Logger } from '@nestjs/common';
import { S3AllPostOrderContext, S3GroupContext } from '../context/bot.js';
import { BotService } from '../bot/bot.service.js';
import { getGroupKey } from '../utils/bot.js';

export const handleMessage = (message: any, key: string, botService: BotService, logger: Logger) => {
  const status = message.status;
  const conditionId = message.market;
  switch (message.event_type) {
    case 'trade':
      if (status === "MATCHED") {
        const maker_orders = message.maker_orders.filter((o: any) => o.owner === key);
        if (maker_orders.length > 0) {
          for (const maker_order of maker_orders) {
            const orderId = maker_order.order_id;
            const price = Math.round(parseFloat(maker_order.price) * 100) / 100 || 0;
            const outcome = maker_order.outcome.toLowerCase();
            const matchedSize = parseFloat(maker_order.matched_amount) || 0;

            let postOrder = S3GroupContext.get(getGroupKey(conditionId, outcome === 'up', price));
            if (!postOrder) {
              // logger.log(`${message.timestamp}: ${Date.now()}: [Socket] No post order found at price ${price} and outcome ${outcome}`);
              return;
            }
            const newPostOrder = {
              id: orderId,
              outcome: outcome === 'up',
              price,
              size: postOrder.size,
              matchedSize: Math.round((postOrder.matchedSize + matchedSize) * 1000000) / 1000000,
            }

            if (newPostOrder.matchedSize >= newPostOrder.size) {
              S3GroupContext.delete(getGroupKey(conditionId, outcome === 'up', price));
              S3AllPostOrderContext.set(conditionId, S3AllPostOrderContext.get(conditionId).filter(o => o.id !== orderId));
              botService.setPosition(conditionId, outcome === 'up');

            } else {
              // S3PostOrderContext.set(orderKey, newPostOrder);
              S3GroupContext.set(getGroupKey(conditionId, outcome === 'up', price), newPostOrder);
            }
          }
        }
      }
      break;
    default:
      break;
  }
}