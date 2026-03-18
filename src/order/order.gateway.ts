import { Controller, Get, Param, Post } from '@nestjs/common';
import { OrderService } from './order.service.js';
import { Side } from '@polymarket/clob-client';

@Controller('order')
export class OrderGateway {
  constructor(private readonly orderService: OrderService) {}

  @Get()
  getHello(): string {
    return "Hello from BotGateway!";
  }

  @Post('cancel/:id')
  async cancelOrder(@Param("id") id: string): Promise<any> {
    const response = await this.orderService.cancelOrder(id);
    return response;
  }
}
