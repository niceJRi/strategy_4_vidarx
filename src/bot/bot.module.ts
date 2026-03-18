import { Module } from '@nestjs/common';
import { BotGateway } from './bot.gateway.js';
import { BotService } from './bot.service.js';
import { EventsModule } from '../events/events.module.js';
import { OrderModule } from '../order/order.module.js';
import { WalletModule } from '../wallet/wallet.module.js';

@Module({
  imports: [EventsModule, OrderModule, WalletModule],
  providers: [BotGateway, BotService],
  exports: [BotService],
})
export class BotModule {}
