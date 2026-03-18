import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { OpenOrder, OrderType, Side } from '@polymarket/clob-client';
import { BroadcastService } from '../events/broadcast.service.js';
import { OrderService } from '../order/order.service.js';
import { WalletService } from '../wallet/wallet.service.js';
import { main as st_1_bot } from './st-1.js';
import { main as st_2_bot } from './st-2.js';
import { main as st_3_bot } from './st-3.js';
import { Strategy4Config, main as st_4_bot, resetStrategy4State } from './st-4.js';

import { ConditionIdContext, PrevPriceContext, TokenIdContext } from '../context/market.js';
import { DATA_API_BASE, SAFE_ADDRESS } from '../constant.js';
import { PositionSizeContext, RoundContext, S3AllPostOrderContext, S3GroupContext, S3PositionSizeContext, S3PreOrderContext, StartContext } from '../context/bot.js';
import { getGroupKey } from "../utils/bot.js";

@Injectable()
export class BotService {
  private readonly logger = new Logger(BotService.name);
  private isRunning = new Map<string, boolean>();
  private currentMarketSlug: string | null = null;
  private openOrders: OpenOrder[] = [];
  private baseSize: number = 5;
  private delta: number = 0.03;
  private priceThreshold: number = 0.58;
  private profit: number = 0.06;
  private rate: number = 2;
  private maxCount = 3; // can't buy baseSize * 2 ** maxCount
  private strategy = 4;
  private st4Config: Strategy4Config = {
    enabled: true,
    tradeWindowStartSec: 120,
    hardStopSec: 12,
    cooldownMs: 3000,
    maxTradesPerMarket: 4,
    maxMarketExposureUsdc: 60,
    maxTradeUsdc: 20,
    minTradeUsdc: 3,
    maxBudgetFractionPerTrade: 0.35,
    minPriceGap: 0.12,
    strongPriceGap: 0.22,
    maxCombinedAsk: 0.985,
    hedgeOnlyBelowPrice: 0.34,
    hedgeCombinedCap: 0.965,
    minLeaderShare: 0.68,
    maxLeaderShare: 0.86,
    maxOneSideExposurePct: 0.78,
    slippageBuffer: 0.02,
  };
  private preOrdersCreated = new Map<string, boolean>();
  private isMerging = new Map<string, boolean>();

  constructor(
    private readonly orderService: OrderService,
    private readonly walletService: WalletService,
    private readonly broadcastService: BroadcastService,
  ) {}

  @Cron(CronExpression.EVERY_SECOND)
  async checkPositions() {
    if (process.env.PAPER_MODE === 'true') {
        return;
      }
    try {
      const positionResponse = await fetch(
        `${DATA_API_BASE}/positions?user=${SAFE_ADDRESS}`,
        {method: 'GET'}
      );
      if (positionResponse.ok) {
        const positions = await positionResponse.json();
        if (positions && positions.length > 0) {
          const activePositions = positions.filter((p) => !p.redeemable) as any[];
          const endedPositions = positions.filter((p) => p.redeemable);
          const activeConditionIds = [...new Set(activePositions.map(p => p.conditionId))];
          const endedConditionIds = [...new Set(endedPositions.map(p => p.conditionId))];

          for (const conditionId of (activeConditionIds as any)) {
            const upSize = activePositions.filter((p) => p.conditionId === conditionId && p.outcome === "Up")?.[0]?.size || 0;
            const downSize = activePositions.filter((p) => p.conditionId === conditionId && p.outcome === "Down")?.[0]?.size || 0;
            PositionSizeContext.set(conditionId, {up: upSize, down: downSize});
          }

          this.walletService.setClosedPositionIds(endedConditionIds);
        } else {
          this.walletService.setClosedPositionIds([]);
        }
      }
    } catch (error) {
      this.logger.error(`Error checking positions: ${error}`);
    }
  }

  @Cron(CronExpression.EVERY_SECOND)
  async getOrders() {
    try {
      if (!this.currentMarketSlug) return;
      const conditionId = ConditionIdContext.get(this.currentMarketSlug);
      if (!conditionId) return;
      const tokenIds = TokenIdContext.get(this.currentMarketSlug);
      if (!tokenIds) return;
      const allPostOrders = S3AllPostOrderContext.get(conditionId) || [];
      if (allPostOrders.length === 0) return;

      const openOrders = await this.orderService.getOrders(conditionId);

      const postOrdersToRemove = [];
      
      for (const postOrder of allPostOrders) {
        const orderIndex = openOrders.findIndex(o => o.id === postOrder.id);
        if (orderIndex === -1) postOrdersToRemove.push({
          id: postOrder.id,
          outcome: postOrder.outcome,
          price: postOrder.price,
        });
      }

      for (const postOrder of postOrdersToRemove) {
        S3GroupContext.delete(getGroupKey(conditionId, postOrder.outcome, postOrder.price));
        S3AllPostOrderContext.set(conditionId, S3AllPostOrderContext.get(conditionId).filter(o => o.id !== postOrder.id));
        this.setPosition(conditionId, postOrder.outcome);
      }
    } catch (error) {
      this.logger.error(`Error fetching orders: ${error}`);
    }
  }

  // @Cron(CronExpression.EVERY_MINUTE)
  // async mergePosition() {
  //   if (!this.currentMarketSlug) return;
  //   const conditionId = ConditionIdContext.get(this.currentMarketSlug);
  //   if (!conditionId) return;
  //   if (this.isMerging.get(conditionId)) return;
  //   const upSize = S3PositionSizeContext.get(conditionId)?.up || 0;
  //   const downSize = S3PositionSizeContext.get(conditionId)?.down || 0;
  //   if (upSize >= 50 && downSize >= 50) {
  //     this.isMerging.set(conditionId, true);
  //     const amount = upSize > downSize ? Math.floor(downSize) : Math.floor(upSize);
  //     const hash = await this.walletService.mergeByRelayer(conditionId, amount.toFixed());
  //     if (hash) {
  //       this.logger.log(`${Date.now()}: [API] Merged position ${conditionId} with amount ${amount}`);
  //       S3PositionSizeContext.set(conditionId, {
  //         up: Math.round((S3PositionSizeContext.get(conditionId)?.up || 0 - amount) * 1000000) / 1000000,
  //         down: Math.round((S3PositionSizeContext.get(conditionId)?.down || 0 - amount) * 1000000) / 1000000,
  //       })
  //     }
  //     this.isMerging.set(conditionId, false);
  //   }
  // }

  async setPosition(conditionId: string, outcome: boolean) {
    const upSize = S3PositionSizeContext.get(conditionId)?.up || 0;
    const downSize = S3PositionSizeContext.get(conditionId)?.down || 0;
    S3PositionSizeContext.set(conditionId, {
      up: outcome ? Math.round((upSize + this.baseSize) * 1000000) / 1000000 : upSize,
      down: !outcome ? Math.round((downSize + this.baseSize) * 1000000) / 1000000 : downSize,
    })
  }

  async createPreOrders(marketSlug: string) {
    await this.createPreOrders1(marketSlug);

    this.logger.log(`${Date.now()}: [API] Created pre orders for market ${marketSlug}`);
    this.preOrdersCreated.set(marketSlug, true);
  }

  @Cron(CronExpression.EVERY_SECOND) // every 2 seconds
  createPreOrdersCron() {
    if (!this.currentMarketSlug) return;
    this.createPreOrders1(this.currentMarketSlug);
  }

  async createPreOrders1(marketSlug: string) {
    const conditionId = ConditionIdContext.get(marketSlug);
    if (!conditionId) return;
    const tokenIds = TokenIdContext.get(marketSlug);
    if (!tokenIds) return;
    
    for (let i = 1; i <= 99; i ++) {
      const price = i / 100;
      const upKey = `${conditionId}-up-${price}`;
      const downKey = `${conditionId}-down-${price}`;
      const upPreOrder = S3PreOrderContext.get(upKey);
      const downPreOrder = S3PreOrderContext.get(downKey);
      
      if (!upPreOrder) await this.orderService.createOrder({
        key: upKey,
        tokenID: tokenIds.up,
        price: price,
        side: Side.BUY,
        size: 5,
        orderType: OrderType.GTC,
      })
      if (!downPreOrder) await this.orderService.createOrder({
        key: downKey,
        tokenID: tokenIds.down,
        price: price,
        side: Side.BUY,
        size: 5,
        orderType: OrderType.GTC,
      })
    }
  }

  getPosition(marketSlug: string)  {
    const conditionId = ConditionIdContext.get(marketSlug);
    if (!conditionId) return "No data";
    return PositionSizeContext.get(conditionId);
  }

  resetRound(marketSlug: string) {
    const conditionId = ConditionIdContext.get(marketSlug);
    if (!conditionId) return;
    RoundContext.delete(conditionId);
    resetStrategy4State(marketSlug);
    this.broadcastService.broadcast(`Round Reset for market`, {});
  }

  getIsRunning(marketSlug: string) {
    return this.isRunning.get(marketSlug) || false;
  }

  getPreOrdersCreated(marketSlug: string) {
    return this.preOrdersCreated.get(marketSlug) || false;
  }

  editVariables(dto: Record<string, any>) {
    if (dto.baseSize != null) this.baseSize = dto.baseSize;
    if (dto.priceThreshold != null) this.priceThreshold = dto.priceThreshold;
    if (dto.profit != null) this.profit = dto.profit;
    if (dto.rate != null) this.rate = dto.rate;
    if (dto.maxCount != null) this.maxCount = dto.maxCount;
    if (dto.strategy != null) this.strategy = dto.strategy;

    const mapping: Record<string, keyof Strategy4Config> = {
      st4Enabled: 'enabled',
      st4TradeWindowStartSec: 'tradeWindowStartSec',
      st4HardStopSec: 'hardStopSec',
      st4CooldownMs: 'cooldownMs',
      st4MaxTradesPerMarket: 'maxTradesPerMarket',
      st4MaxMarketExposureUsdc: 'maxMarketExposureUsdc',
      st4MaxTradeUsdc: 'maxTradeUsdc',
      st4MinTradeUsdc: 'minTradeUsdc',
      st4MaxBudgetFractionPerTrade: 'maxBudgetFractionPerTrade',
      st4MinPriceGap: 'minPriceGap',
      st4StrongPriceGap: 'strongPriceGap',
      st4MaxCombinedAsk: 'maxCombinedAsk',
      st4HedgeOnlyBelowPrice: 'hedgeOnlyBelowPrice',
      st4HedgeCombinedCap: 'hedgeCombinedCap',
      st4MinLeaderShare: 'minLeaderShare',
      st4MaxLeaderShare: 'maxLeaderShare',
      st4MaxOneSideExposurePct: 'maxOneSideExposurePct',
      st4SlippageBuffer: 'slippageBuffer',
    };

    for (const [inputKey, configKey] of Object.entries(mapping)) {
      if (dto[inputKey] != null) {
        (this.st4Config as any)[configKey] = dto[inputKey];
      }
    }

    const config = this.getConfig();
    this.broadcastService.broadcast('Bot variables changed.', config);
    return config;
  }

  getConfig() {
    return {
      started: StartContext.get("start"),
      strategy: this.strategy,
      baseSize: this.baseSize,
      priceThreshold: this.priceThreshold,
      profit: this.profit,
      rate: this.rate,
      maxCount: this.maxCount,
      strategy4: this.st4Config,
    };
  }

  async runBot(marketSlug: string, timestamp: any, tokenIdPair: any) {
    const upPrice = PrevPriceContext.get(tokenIdPair.up);
    const downPrice = PrevPriceContext.get(tokenIdPair.down);
    if (!upPrice || !downPrice) return;
    this.isRunning.set(marketSlug, true);
    const isPreOrdersCreated = this.getPreOrdersCreated(marketSlug);
    if (!isPreOrdersCreated) {
      await this.createPreOrders(marketSlug);
      this.isRunning.set(marketSlug, false);
      return;
    }
    this.currentMarketSlug = marketSlug;
    try {
      // await st_1_bot({
      //   marketSlug, 
      //   timestamp, 
      //   upPrice, 
      //   downPrice, 
      //   config: {
      //     baseSize: this.baseSize,
      //     priceThreshold: this.priceThreshold,
      //     profit: this.profit,
      //     rate: this.rate,
      //     maxCount: this.maxCount
      //   },
      //   orderService: this.orderService,
      //   broadcastService: this.broadcastService,
      //   logger: this.logger,
      // });
      if (this.strategy === 1) {
        await st_1_bot({
          marketSlug,
          timestamp,
          upPrice: upPrice.bestAsk,
          downPrice: downPrice.bestAsk,
          config: {
            baseSize: this.baseSize,
            priceThreshold: this.priceThreshold,
            profit: this.profit,
            rate: this.rate,
            maxCount: this.maxCount,
          },
          orderService: this.orderService,
          broadcastService: this.broadcastService,
          logger: this.logger,
        });
      } else if (this.strategy === 2) {
        await st_2_bot(
          marketSlug,
          timestamp,
          upPrice.bestAsk,
          downPrice.bestAsk,
          this.orderService,
          this.logger,
        );
      } else if (this.strategy === 3) {
        await st_3_bot(
          marketSlug, 
          timestamp, 
          upPrice.bestAsk, 
          downPrice.bestAsk, 
          this.baseSize, 
          this.delta, 
          this.orderService, 
          this.logger
        );
      } else {
        await st_4_bot(
          marketSlug,
          timestamp,
          upPrice.bestAsk,
          downPrice.bestAsk,
          this.orderService,
          this.logger,
          this.st4Config,
        );
      }
    } catch (error) {
      this.logger.error(`Error running bot for market ${marketSlug}: ${error.message}`);
    } finally {
      this.isRunning.set(marketSlug, false);
    }
  }
}
