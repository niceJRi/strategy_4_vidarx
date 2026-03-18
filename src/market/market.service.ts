import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { get5MinuteMarketSlug, getOneHourMarketSlug } from '../utils/market.js';
import { AVAILABLE_5M_MARKETS, AVAILABLE_1H_MARKETS, GAMMA_API_BASE } from '../constant.js';
import { ConditionIdContext, EndDateContext, MatchedPriceTimeContext, PrevPriceContext, PriceContext, PriceTimeContext, SplittedContext, TokenIdContext, getAll1HourTokenIdList, getMarketSlugList, getSplittedConditionIdList } from '../context/market.js';
import { PriceService } from '../price/price.service.js';
import { WalletService } from '../wallet/wallet.service.js';

@Injectable()
export class MarketService {
  private readonly logger = new Logger(MarketService.name);

  private lastCheckedTimestampFor5MinuteMarkets: number = 0;
  private lastCheckedTimestampFor1HourMarkets: number = 0;

  constructor(
    private readonly priceService: PriceService,
    private readonly walletService: WalletService
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async handle5MinuteMarketsUpdate() {
    const marketData : {slug: string, timestamp: number}[] = [];
    let currentMarketTimestamp = 0;

    for (const market of AVAILABLE_5M_MARKETS) {
      currentMarketTimestamp = get5MinuteMarketSlug(market).timestamp;
      marketData.push(get5MinuteMarketSlug(market));
    }

    // Only fetch if timestamp has changed
    if (currentMarketTimestamp > this.lastCheckedTimestampFor5MinuteMarkets) {
      this.lastCheckedTimestampFor5MinuteMarkets = currentMarketTimestamp;

      await this.fetchMarketBySlug(marketData);
    }
  }

  // @Cron(CronExpression.EVERY_SECOND)
  // async handle1HourMarketsUpdate() {
  //   const marketData : {slug: string, timestamp: number}[] = [];
  //   let currentMarketTimestamp = 0;

  //   for (const market of AVAILABLE_1H_MARKETS) {
  //     currentMarketTimestamp = getOneHourMarketSlug(market).timestamp;
  //     marketData.push(getOneHourMarketSlug(market));
  //   }

  //   // Only fetch if timestamp has changed
  //   if (currentMarketTimestamp > this.lastCheckedTimestampFor1HourMarkets) {
  //     this.lastCheckedTimestampFor1HourMarkets = currentMarketTimestamp;
  //     await this.fetchMarketBySlug(marketData);
  //   }
  // }

  @Cron(CronExpression.EVERY_SECOND)
  async deleteOldMarkets() {
    const marketSlugs = getMarketSlugList();
    const currentTimestamp = Math.floor(Date.now() / 1000);
    let deletedMarkets = 0;
    for (const marketSlug of marketSlugs) {
      if (EndDateContext.get(marketSlug) + 60 < currentTimestamp) {
        PriceContext.delete(marketSlug);
        EndDateContext.delete(marketSlug);
        const tokenIds = TokenIdContext.get(marketSlug);
        PrevPriceContext.delete(tokenIds.up);
        PrevPriceContext.delete(tokenIds.down);
        PriceTimeContext.delete(marketSlug);
        MatchedPriceTimeContext.delete(marketSlug);
        TokenIdContext.delete(marketSlug);
        // ConditionIdContext.delete(marketSlug);
        // this.logger.log(`Deleted market ${marketSlug}`);
        deletedMarkets++;
      }
    }
    if (deletedMarkets > 0) {
      this.priceService.autoSubscribe();
    }
  }

  // @Cron(CronExpression.EVERY_MINUTE)
  // async handleSplit() {
  //   for (const market of AVAILABLE_15M_MARKETS) {
  //     const currentTimestamp = Math.floor(Date.now() / 1000);
  //     const marketSlug = get15MinuteMarketSlug(market).slug;
  //     const conditionId = ConditionIdContext.get(marketSlug)
  //     if (
  //       conditionId && 
  //       // EndDateContext.get(marketSlug) < currentTimestamp + 600 && 
  //       (!SplittedContext.get(conditionId) || SplittedContext.get(conditionId) === 0)
  //     ) {
  //       await this.walletService.split(conditionId, "5");
  //     }
  //   }
  // }

  // @Cron(CronExpression.EVERY_MINUTE)
  // async handleReedem() {
  //   const conditionIds = getSplittedConditionIdList();
  //   for (const conditionId of conditionIds) {
  //     await this.walletService.redeem(conditionId);
  //   }
  // }

  async fetchMarketBySlug(marketData: {slug: string, timestamp: number}[]) {
    try {
      const marketResponse = await fetch(
        `${GAMMA_API_BASE}/markets?slug=${marketData.map(market => market.slug).join('&slug=')}`,
        {method: 'GET'}
      );
      if (marketResponse.ok) {
        const markets = await marketResponse.json();
        for (const market of markets) {
          let upTokenId = null;
          let downTokenId = null;
          const clobTokenIds = JSON.parse(market.clobTokenIds || '[]');
          const conditionId = market.conditionId;
          const outcomes = JSON.parse(market.outcomes || '[]');
          const endDate = market.endDate;
  
          if (clobTokenIds.length >= 2 && outcomes.length >= 2 && conditionId && endDate) {
            // Find which index is Up and which is Down
            const upIndex = outcomes.findIndex(o => o.toLowerCase().includes('up'));
            const downIndex = outcomes.findIndex(o => o.toLowerCase().includes('down'));
  
            if (upIndex >= 0) {
              upTokenId = clobTokenIds[upIndex];
            } else {
              upTokenId = clobTokenIds[0]; // Default to first token
            }
  
            if (downIndex >= 0) {
              downTokenId = clobTokenIds[downIndex];
            } else {
              downTokenId = clobTokenIds[1]; // Default to second token
            }
  
            TokenIdContext.set(market.slug, { up: upTokenId, down: downTokenId });
            ConditionIdContext.set(market.slug, conditionId);
            EndDateContext.set(market.slug, Math.floor(new Date(endDate).getTime()/1000));

            // this.logger.log(`Updated market ${market.slug}`);
          }
        }
        if (marketData.length > 0) {
          this.priceService.autoSubscribe();
        }
      }
    } catch (error) {
      this.logger.error(error);
    }
  }
}
