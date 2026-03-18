import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { BotService } from './bot.service.js';
import { Side } from '@polymarket/clob-client';
import { StartContext } from '../context/bot.js';

export class ConfigDto {
  started?: boolean;
  strategy?: number;
  baseSize?: number;
  priceThreshold?: number;
  profit?: number;
  rate?: number;
  maxCount?: number;
  st4Enabled?: boolean;
  st4TradeWindowStartSec?: number;
  st4HardStopSec?: number;
  st4CooldownMs?: number;
  st4MaxTradesPerMarket?: number;
  st4MaxMarketExposureUsdc?: number;
  st4MaxTradeUsdc?: number;
  st4MinTradeUsdc?: number;
  st4MaxBudgetFractionPerTrade?: number;
  st4MinPriceGap?: number;
  st4StrongPriceGap?: number;
  st4MaxCombinedAsk?: number;
  st4HedgeOnlyBelowPrice?: number;
  st4HedgeCombinedCap?: number;
  st4MinLeaderShare?: number;
  st4MaxLeaderShare?: number;
  st4MaxOneSideExposurePct?: number;
  st4SlippageBuffer?: number;
}

export class MarketSlugDto {
  marketSlug!: string;
}

@Controller('bot')
export class BotGateway {
  constructor(private readonly botService: BotService) {}

  @Get()
  getHello(): string {
    return "Hello from BotGateway!";
  }

  @Post('start')
  async startBot(): Promise<any> {
    StartContext.set("start", true);
    return { message: `Bot started` };
  }

  @Post('stop')
  async stopBot(): Promise<any> {
    StartContext.set("start", false);
    return { message: `Bot stopped` };
  }

  @Post('config')
  async changeVariables(@Body() dto: ConfigDto): Promise<any> {
    const config = this.botService.editVariables(dto);
    return { message: 'Bot config updated', config };
  }

  @Post('reset')
  async resetRound(@Body() dto: MarketSlugDto): Promise<any> {
    const { marketSlug } = dto;
    this.botService.resetRound(marketSlug);
    return { message: `Bot round reset` };
  }

  @Get('config')
  async getConfig(): Promise<any> {
    const config = this.botService.getConfig();
    return config;
  }
}
