import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ThrottlerModule } from '@nestjs/throttler';
import { ScheduleModule } from '@nestjs/schedule';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { MarketModule } from './market/market.module.js';
import { OrderModule } from './order/order.module.js';

import * as dotenv from 'dotenv';
import { AuthModule } from './auth/auth.module.js';
import { SessionGuard } from './auth/session.guard.js';
import { EventsModule } from './events/events.module.js';
import { BotModule } from './bot/bot.module.js';
import { BotGateway } from './bot/bot.gateway.js';
import { UserModule } from './user/user.module.js';
import { WalletGateway } from './wallet/wallet.gateway.js';
import { WalletModule } from './wallet/wallet.module.js';
import { OrderGateway } from './order/order.gateway.js';

dotenv.config();

@Module({
  imports: [
    ScheduleModule.forRoot(),
    ThrottlerModule.forRoot(
      {
        throttlers: [
          {
            ttl: 30000,
            limit: 3,
          }
        ]
      }
    ),
    AuthModule,
    EventsModule,
    MarketModule,
    UserModule,
    OrderModule,
    BotModule,
    WalletModule
  ],
  controllers: [AppController, BotGateway, WalletGateway, OrderGateway],
  providers: [
    AppService,
    { provide: APP_GUARD, useClass: SessionGuard },
  ],
})
export class AppModule {}
