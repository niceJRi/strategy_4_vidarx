import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { BroadcastService } from './broadcast.service.js';
import { EventsGateway } from './events.gateway.js';

@Module({
  imports: [AuthModule],
  providers: [EventsGateway, BroadcastService],
  exports: [BroadcastService],
})
export class EventsModule {}
