import { Controller, Get, Query } from '@nestjs/common';
import { AppService } from './app.service.js';
import { PriceContext, getSlugByTokenId } from './context/market.js';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('/price')
  getPrice(@Query('tokenId') tokenId: string): { bestAsk: number, bestBid: number } {
    return PriceContext.get(tokenId);
  }

  @Get('/prices')
  getPrices(): { slug: string, tokenId: string, bestAsk: number, bestBid: number }[] {
    return Array.from(PriceContext.entries()).map(([tokenId, { bestAsk, bestBid }]) => ({ slug: getSlugByTokenId(tokenId), tokenId, bestAsk, bestBid }));
  }
}
