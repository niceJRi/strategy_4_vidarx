import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';

import { BotService } from '../bot/bot.service.js';

import { 
  TokenIdContext, 
  PriceContext, 
  PrevPriceContext, 
  PriceTimeContext, 
  MatchedPriceTimeContext,
  getAll5MinuteTokenIdList, 
  getAll1HourTokenIdList, 
  getSlugByTokenId, 
} from '../context/market.js';
import { WS_BASE } from '../constant.js';
import { StartContext } from '../context/bot.js';

@Injectable()
export class PriceService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PriceService.name);
  private readonly excelDir = path.join(process.cwd(), 'excels');
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1; // 5 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;

  private subscribedTokenIds: string[] = [];

  constructor(
    private readonly botService: BotService,
  ) {
    super();
  }

  onModuleInit() {
    this.logger.log('Price service initialized');
    try {
      if (!fs.existsSync(this.excelDir)) {
        fs.mkdirSync(this.excelDir, { recursive: true });
      }
    } catch (error) {
      this.logger.error(`Failed to create excels directory: ${error}`);
    }
    this.connect();
  }

  onModuleDestroy() {
    this.disconnect();
  }

  @Cron(CronExpression.EVERY_10_SECONDS)
  ping() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    this.ws.send("PING");
  }

  private connect() {
    if (this.isConnecting || (this.ws && this.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    this.isConnecting = true;

    try {
      this.ws = new WebSocket(`${WS_BASE}/ws/market`);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        if (this.subscribedTokenIds.length > 0) {
          const subscription = {
            assets_ids: this.subscribedTokenIds,
            type: 'market', 
            operation: 'subscribe',
          }
          this.ws.send(JSON.stringify(subscription));
        }
        this.logger.log(`Connected to Polymarket Price WebSocket at ${Date.now()}`);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          if (data.toString() === "PONG") {
            return;
          }
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          this.logger.error(`Error handling Price WebSocket message: ${error}`);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error(`Price WebSocket error: ${Date.now()} ${error}`);
        this.isConnecting = false;
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn(`Price WebSocket closed: ${Date.now()} ${code} - ${reason.toString()}`);
        this.isConnecting = false;
        this.ws = null;
        this.scheduleReconnect();
      });
    } catch (error) {
      this.logger.error(`Error creating Price WebSocket connection: ${error}`);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnect for Price WebSocket attempts reached. Giving up.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    // this.logger.log(`Scheduling reconnect for Price WebSocket attempt ${this.reconnectAttempts} in ${delay}ms`);

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  private disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.removeAllListeners();
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
      this.ws = null;
    }
    this.isConnecting = false;
  }

  private handleMessage(message: any) {
    switch (message.event_type) {
      case 'price_change':
        if (message.price_changes) {
          message.price_changes.forEach((priceChange) => {
            const tokenId = priceChange.asset_id;
            const bestAsk = parseFloat(priceChange.best_ask);
            const bestBid = parseFloat(priceChange.best_bid);

            if (!tokenId || isNaN(bestAsk) || bestAsk < 0) {
              return;
            }

            const marketSlug = getSlugByTokenId(tokenId);
            const tokenIdPair = TokenIdContext.get(marketSlug);

            const price = PriceContext.get(tokenId);
            if (!price || price.bestAsk !== bestAsk) {
              PriceContext.set(tokenId, {bestAsk, bestBid});

              const upPrice = PriceContext.get(tokenIdPair.up);
              const downPrice = PriceContext.get(tokenIdPair.down);

              const prevUpPrice = PrevPriceContext.get(tokenIdPair.up);
              const prevDownPrice = PrevPriceContext.get(tokenIdPair.down);

              const lastTime = PriceTimeContext.get(marketSlug);
              const matchedLastTime = MatchedPriceTimeContext.get(marketSlug);

              if (!prevUpPrice || !prevDownPrice || !lastTime) {
                PrevPriceContext.set(tokenIdPair.up, upPrice);
                PrevPriceContext.set(tokenIdPair.down, downPrice);
                PriceTimeContext.set(marketSlug, Number(message.timestamp));
                MatchedPriceTimeContext.set(marketSlug, Number(message.timestamp));
                return;
              }

              const result = Papa.unparse([
                [(Number(message.timestamp) / 1000).toFixed(3), `${Math.round(Number(upPrice.bestAsk) * 100)}`, `${Math.round(Number(downPrice.bestAsk) * 100)}`]
              ], { header: false });

              try {
                if (!fs.existsSync(this.excelDir)) {
                  fs.mkdirSync(this.excelDir, { recursive: true });
                }
                fs.appendFileSync(path.join(this.excelDir, `${marketSlug}.csv`), `${result}\n`);
              } catch (error) {
                this.logger.error(`Error writing CSV for ${marketSlug}: ${error}`);
              }
              if (upPrice && downPrice && upPrice.bestAsk + downPrice.bestAsk === 1.01 && prevUpPrice.bestAsk !== upPrice.bestAsk && prevDownPrice.bestAsk !== downPrice.bestAsk) {
                PrevPriceContext.set(tokenIdPair.up, upPrice);
                PrevPriceContext.set(tokenIdPair.down, downPrice);
                MatchedPriceTimeContext.set(marketSlug, Number(message.timestamp));
              }
              PriceTimeContext.set(marketSlug, Number(message.timestamp));

              const isAllowedToRun = StartContext.get("start");
              const isRunning = this.botService.getIsRunning(marketSlug);
              if (!isRunning && isAllowedToRun) {
                this.botService.runBot(marketSlug, message.timestamp, tokenIdPair);
              }
            }
          });
        }
        break; 
      default:
        break;
    }
  }

  autoSubscribe() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    
    const tokenIds = [...getAll5MinuteTokenIdList(), ...getAll1HourTokenIdList()];

    try {
      const unsubscribeTokenIds = this.subscribedTokenIds.filter(tokenId => !tokenIds.includes(tokenId));
      if (unsubscribeTokenIds.length > 0) {
        const unsubscription = {
          assets_ids: unsubscribeTokenIds,
          type: 'market',
          operation: 'unsubscribe',
        }
        this.ws.send(JSON.stringify(unsubscription));
        // unsubscribeTokenIds.forEach(tokenId => {
        //   this.logger.log(`Unsubscribed from token id: ${tokenId}`);
        // });
      }

      const newSubscribedTokenIds = tokenIds.filter(tokenId => !this.subscribedTokenIds.includes(tokenId));
      if (newSubscribedTokenIds.length > 0) {
        const subscription = {
          assets_ids: newSubscribedTokenIds,
          type: 'market', 
          operation: 'subscribe',
        }
        this.ws.send(JSON.stringify(subscription));
        const newSubscribedSlugs = [...new Set(newSubscribedTokenIds.map(tokenId => getSlugByTokenId(tokenId)))];
        // newSubscribedSlugs.forEach(slug => {
        //   this.logger.log(`Subscribed to ${slug}`);
        // });
      }

      this.subscribedTokenIds = tokenIds;
    } catch (error) {
      this.logger.error(`Error sending subscription: ${error}`);
    }
  }
}
