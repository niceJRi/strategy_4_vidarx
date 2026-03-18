import { Logger } from '@nestjs/common';
import { OrderIdContext, RoundContext, St2OrderIdContext, St2RoundContext } from '../context/bot.js';

export const handleMessage = (message: any, key: string, logger: Logger) => {
  const status = message.status;
  const conditionId = message.market;
  // const marketSlug = message
  let rounds = St2RoundContext.get(conditionId);
  let orders = St2OrderIdContext.get(conditionId);
  if (orders.length === 0 || rounds.length === 0) return;
  switch (message.event_type) {
    case 'trade':
      if (status === "MATCHED") {
        const maker_orders = message.maker_orders.filter((o: any) => o.owner === key);
        if (maker_orders.length > 0) {
          for (const maker_order of maker_orders) {
            const matchedSize = parseFloat(maker_order.matched_amount) || 0;
            const orderIndex = orders.findIndex(o => o.id === maker_order.order_id);
            if (orderIndex !== -1) {
              const roundId = orders[orderIndex].round;
              const roundIndex = rounds.findIndex(r => r.id === roundId);
              const orderMatchedSize = Math.round((orders[orderIndex].matchedSize + matchedSize) * 100) / 100
              if (orderMatchedSize < orders[orderIndex].size) {
                St2OrderIdContext.set(conditionId, [...orders.slice(0, orderIndex), {
                  ...orders[orderIndex],
                  matchedSize: Math.round((orders[orderIndex].matchedSize + matchedSize) * 100) / 100, // round to 2 decimal places
                } , ...orders.slice(orderIndex + 1)]);
              } else {
                St2OrderIdContext.set(conditionId, [...orders.slice(0, orderIndex), ...orders.slice(orderIndex + 1)]); // remove order if fully matched
                St2RoundContext.set(conditionId, rounds.map(r => r.id === roundId ? {...r, done: true} : r));
                logger.log(`${message.timestamp}: ${Date.now()}: Finished round ${roundId} for market ${conditionId}`);
              }
            }
          }
        }
      }
      break;
    default:
      break;
  }
}