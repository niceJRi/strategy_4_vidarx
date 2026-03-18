import { Module } from '@nestjs/common';
import { OrderGateway } from './order.gateway.js';
import { OrderService } from './order.service.js';

@Module({
  providers: [OrderGateway, OrderService],
  exports: [OrderService]
})
export class OrderModule {}