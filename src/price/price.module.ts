import { Module } from '@nestjs/common';
import { PriceGateway } from './price.gateway.js';
import { PriceService } from './price.service.js';
import { BotModule } from '../bot/bot.module.js';

@Module({
  imports: [BotModule],
  providers: [
    PriceGateway,
    PriceService
  ],
  exports: [PriceService],
})
export class PriceModule {}
