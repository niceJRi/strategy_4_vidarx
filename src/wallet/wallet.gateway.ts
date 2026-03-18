import { Controller, Get, Param, Post } from '@nestjs/common';
import { WalletService } from './wallet.service.js';
import { ConditionIdContext } from '../context/market.js';

@Controller('wallet')
export class WalletGateway {
  constructor(private readonly walletService: WalletService) {}

  @Get()
  getHello(): string {
    return "Hello from WalletGateway!";
  }

  @Post('redeem/:marketSlug')
  async redeem(@Param("marketSlug") marketSlug: string): Promise<any> {
    const conditionId = ConditionIdContext.get(marketSlug);
    if (!conditionId) {
      return { error: `No condition ID found for market slug: ${marketSlug}` };
    }
    const response = await this.walletService.redeem(conditionId);
    return response;
  }
}
