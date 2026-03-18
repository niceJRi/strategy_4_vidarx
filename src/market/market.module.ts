import { Module } from '@nestjs/common';
import { MarketService } from './market.service.js';
import { PriceModule } from '../price/price.module.js';
import { WalletModule } from '../wallet/wallet.module.js';

@Module({
  imports: [PriceModule, WalletModule],
  providers: [MarketService],
  exports: [MarketService],
})
export class MarketModule {}
