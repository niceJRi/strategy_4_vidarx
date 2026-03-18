import { Logger } from '@nestjs/common';
import { OrderIdContext, RoundContext } from '../context/bot.js';
import { BroadcastService } from '../events/broadcast.service.js';

export const handleMessage = (message: any, broadcastService: BroadcastService, logger: Logger) => {
  const status = message.status;
  const conditionId = message.market;
  const currentOrder = OrderIdContext.get(conditionId);
  if (!currentOrder) return;
  const round = RoundContext.get(conditionId);
  if (round && round.done) return;
  switch (message.event_type) {
    case 'trade':
      if (status === "MATCHED" || status === "MINED" || status === "CONFIRMED") {
        // logger.log(`Received trade message for market ${Date.now()}, message: ${JSON.stringify(message)}`);
        const maker_orders = message.maker_orders.filter((o: any) => o.order_id === currentOrder.id);
        if (maker_orders.length > 0) {
          RoundContext.set(conditionId, {
            lastOutcome: round.lastOutcome,
            lastPrice: round.lastPrice,
            count: round.count,
            done: true,
          })
          logger.log(`${message.timestamp}: ${Date.now()}: Finished round ${round.count} for market ${conditionId}`);
          broadcastService.broadcast(`${round.count} round finished.`, {});
        }
      }
      break;
    default:
      break;
  }
}