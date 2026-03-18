import { Module } from '@nestjs/common';
import { UserService } from './user.service.js';
import { BotModule } from '../bot/bot.module.js';
import { EventsModule } from '../events/events.module.js';

@Module({
  imports: [BotModule, EventsModule],
  providers: [
    UserService
  ],
  exports: [UserService],
})
export class UserModule {}
