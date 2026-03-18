import { Injectable, Logger } from '@nestjs/common';
import {
  OpenOrder,
  OrderType,
  PostOrdersArgs,
  Side,
} from '@polymarket/clob-client';
import { SignedOrder } from '@polymarket/order-utils';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { S3PreOrderContext } from '../context/bot.js';
import {
  PriceContext,
  TokenIdContext,
  ConditionIdContext,
  EndDateContext,
} from '../context/market.js';

const GAMMA_MARKETS_ENDPOINT = 'https://gamma-api.polymarket.com/markets';

export interface CreateAndPostOrderParams {
  tokenID: string;
  price: number;
  side: Side;
  size: number;
  orderType?: OrderType.GTC | OrderType.GTD;
}

export interface CreateOrderParams {
  key: string;
  tokenID: string;
  price: number;
  side: Side;
  size: number;
  orderType?: OrderType.GTC | OrderType.GTD;
}

export interface CreateMarketOrderParams {
  tokenID: string;
  price: number;
  side: Side;
  amount: number;
  orderType?: OrderType.FOK | OrderType.FAK;
}

type OutcomeSide = 'up' | 'down';

type FakeOrderPayload = {
  salt: string;
  maker: string;
  signer: string;
  taker: string;
  tokenId: string;
  tokenID: string;
  price: number;
  side: Side;
  size: number;
};

type FakeLiveOrder = {
  id: string;
  market: string; // conditionId
  marketSlug: string;
  tokenID: string;
  outcome: OutcomeSide;
  side: Side;
  price: number;
  size: number;
  remainingSize: number;
  createdAt: number;
  updatedAt: number;
  status: 'live';
};

type MarketPaperStats = {
  marketSlug: string;
  conditionId: string;
  upShares: number;
  downShares: number;
  upCostUsdc: number;
  downCostUsdc: number;
  upFillCount: number;
  downFillCount: number;
  settled: boolean;
  winner?: OutcomeSide;
  settledAt?: number;
};

@Injectable()
export class OrderService {
  private readonly logger = new Logger(OrderService.name);
  private readonly liveOrders = new Map<string, FakeLiveOrder>();
  private readonly marketStats = new Map<string, MarketPaperStats>();
  private readonly settleInFlight = new Set<string>();

  private readonly logsDir = path.join(process.cwd(), 'logs');
  private readonly marketResultLogPath = path.join(
    process.cwd(),
    'logs',
    'paper-market-results.csv',
  );

  async onModuleInit() {
    this.ensureBaseLogFiles();

    this.logger.log(
      '[FAKE ORDER MODE] initialized with real best bid/ask + per-market paper trade logs',
    );

    setInterval(() => {
      this.checkAndSettleEndedMarkets().catch((error) => {
        this.logger.error(`Error settling ended paper markets: ${error}`);
      });
    }, 5000);
  }

  async createOrder(params: CreateOrderParams): Promise<SignedOrder> {
    try {
      const { key, tokenID, price, side, size } = params;

      const order: FakeOrderPayload = {
        salt: randomUUID(),
        maker: 'paper-maker',
        signer: 'paper-signer',
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: tokenID,
        tokenID,
        price,
        side,
        size,
      };

      S3PreOrderContext.set(key, order as unknown as SignedOrder);
      return order as unknown as SignedOrder;
    } catch (error) {
      this.logger.error(`Error creating fake order: ${error}`);
      throw error;
    }
  }

  async postOrder(order: SignedOrder, orderType: OrderType): Promise<any> {
    const results = await this.postOrders([{ order, orderType }]);
    return results?.[0];
  }

  async postOrders(orders: PostOrdersArgs[]): Promise<any[]> {
    try {
      const responses: any[] = [];

      for (const item of orders) {
        const raw = item.order as unknown as Partial<FakeOrderPayload> & {
          tokenId?: string;
          tokenID?: string;
          price?: number | string;
          side?: Side;
          size?: number | string;
        };

        const tokenID = raw.tokenID || raw.tokenId;
        const price = Number(raw.price);
        const side = raw.side;
        const size = Number(raw.size);

        if (!tokenID || !side || Number.isNaN(price) || Number.isNaN(size)) {
          responses.push({
            success: false,
            status: 'rejected',
            error: 'invalid_fake_order_payload',
          });
          continue;
        }

        const meta = this.resolveTokenMeta(tokenID);
        if (!meta) {
          responses.push({
            success: false,
            status: 'rejected',
            error: 'unknown_token_id',
          });
          continue;
        }

        this.ensureMarketStats(meta.marketSlug, meta.conditionId);
        this.ensureTradeLogFile(meta.marketSlug);

        const priceState = PriceContext.get(tokenID);
        const bestAsk = priceState?.bestAsk;
        const bestBid = priceState?.bestBid;

        const isImmediatelyMatched = this.isMarketable({
          side,
          price,
          bestAsk,
          bestBid,
        });

        if (isImmediatelyMatched) {
          const orderID = `fake-${randomUUID()}`;
          const fillPrice =
            side === Side.BUY
              ? (bestAsk ?? price)
              : side === Side.SELL
                ? (bestBid ?? price)
                : price;

          this.recordFill({
            marketSlug: meta.marketSlug,
            conditionId: meta.conditionId,
            tokenId: tokenID,
            outcome: meta.outcome,
            side,
            fillPrice,
            size,
            bestBid,
            bestAsk,
            orderId: orderID,
            notes: 'matched_at_submit',
          });

          responses.push({
            success: true,
            status: 'matched',
            orderID,
            makingAmount: size.toFixed(6),
            price: fillPrice,
            tokenID,
            outcome: meta.outcome,
          });
          continue;
        }

        const fakeId = `fake-${randomUUID()}`;
        const liveOrder: FakeLiveOrder = {
          id: fakeId,
          market: meta.conditionId,
          marketSlug: meta.marketSlug,
          tokenID,
          outcome: meta.outcome,
          side,
          price,
          size,
          remainingSize: size,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          status: 'live',
        };

        this.liveOrders.set(fakeId, liveOrder);

        this.appendTradeLog(meta.marketSlug, {
          event: 'ORDER_LIVE',
          marketSlug: meta.marketSlug,
          conditionId: meta.conditionId,
          tokenId: tokenID,
          outcome: meta.outcome,
          side,
          orderPrice: price,
          size,
          bestBid,
          bestAsk,
          orderId: fakeId,
          notes: 'accepted_into_paper_book',
        });

        responses.push({
          success: true,
          status: 'live',
          orderID: fakeId,
          price,
          tokenID,
          outcome: meta.outcome,
        });
      }

      return responses;
    } catch (error) {
      this.logger.error(`Error posting fake orders: ${error}`);
      return [];
    }
  }

  async createAndPostOrder(params: CreateAndPostOrderParams): Promise<any> {
    try {
      const fakeOrder: FakeOrderPayload = {
        salt: randomUUID(),
        maker: 'paper-maker',
        signer: 'paper-signer',
        taker: '0x0000000000000000000000000000000000000000',
        tokenId: params.tokenID,
        tokenID: params.tokenID,
        price: params.price,
        side: params.side,
        size: params.size,
      };

      return await this.postOrder(
        fakeOrder as unknown as SignedOrder,
        params.orderType ?? OrderType.GTC,
      );
    } catch (error) {
      this.logger.error(`Error createAndPostOrder in fake mode: ${error}`);
    }
  }

  async createMarketOrder(params: CreateMarketOrderParams): Promise<any> {
    try {
      const tokenID = params.tokenID;
      const amount = Number(params.amount);
      const priceState = PriceContext.get(tokenID);
      const meta = this.resolveTokenMeta(tokenID);

      if (!meta) {
        return {
          success: false,
          status: 'rejected',
          error: 'unknown_token_id',
        };
      }

      if (!priceState) {
        return {
          success: false,
          status: 'rejected',
          error: 'no_live_price',
        };
      }

      this.ensureMarketStats(meta.marketSlug, meta.conditionId);
      this.ensureTradeLogFile(meta.marketSlug);

      const fillPrice =
        params.side === Side.BUY ? priceState.bestAsk : priceState.bestBid;

      if (fillPrice == null || Number.isNaN(fillPrice)) {
        return {
          success: false,
          status: 'rejected',
          error: 'bad_touch_price',
        };
      }

      const orderID = `fake-${randomUUID()}`;

      this.recordFill({
        marketSlug: meta.marketSlug,
        conditionId: meta.conditionId,
        tokenId: tokenID,
        outcome: meta.outcome,
        side: params.side,
        fillPrice,
        size: amount,
        bestBid: priceState.bestBid,
        bestAsk: priceState.bestAsk,
        orderId: orderID,
        notes: 'market_order_fake_fill',
      });

      return {
        success: true,
        status: 'matched',
        orderID,
        makingAmount: amount.toFixed(6),
        price: fillPrice,
        tokenID,
        outcome: meta.outcome,
      };
    } catch (error) {
      this.logger.error(`Error creating fake market order: ${error}`);
    }
  }

  async createOrders(orders: CreateAndPostOrderParams[]): Promise<any> {
    try {
      const payload: PostOrdersArgs[] = orders.map((params) => {
        const fakeOrder: FakeOrderPayload = {
          salt: randomUUID(),
          maker: 'paper-maker',
          signer: 'paper-signer',
          taker: '0x0000000000000000000000000000000000000000',
          tokenId: params.tokenID,
          tokenID: params.tokenID,
          price: params.price,
          side: params.side,
          size: params.size,
        };

        return {
          order: fakeOrder as unknown as SignedOrder,
          orderType: params.orderType ?? OrderType.GTC,
        };
      });

      return await this.postOrders(payload);
    } catch (error) {
      this.logger.error(`Error creating fake orders: ${error}`);
    }
  }

  async cancelOrder(orderID: string): Promise<any> {
    try {
      const existing = this.liveOrders.get(orderID);
      const existed = this.liveOrders.delete(orderID);

      if (existed && existing) {
        const priceState = PriceContext.get(existing.tokenID);
        this.ensureTradeLogFile(existing.marketSlug);

        this.appendTradeLog(existing.marketSlug, {
          event: 'ORDER_CANCELED',
          marketSlug: existing.marketSlug,
          conditionId: existing.market,
          tokenId: existing.tokenID,
          outcome: existing.outcome,
          side: existing.side,
          orderPrice: existing.price,
          size: existing.remainingSize,
          bestBid: priceState?.bestBid,
          bestAsk: priceState?.bestAsk,
          orderId: existing.id,
          notes: 'manual_cancel',
        });
      }

      return {
        success: existed,
        canceled: existed,
        orderID,
      };
    } catch (error) {
      this.logger.error(`Error canceling fake order: ${error}`);
    }
  }

  async cancelOrders(orderIDs: string[]): Promise<any> {
    try {
      const canceled: string[] = [];

      for (const id of orderIDs) {
        const existing = this.liveOrders.get(id);

        if (this.liveOrders.delete(id)) {
          canceled.push(id);

          if (existing) {
            const priceState = PriceContext.get(existing.tokenID);
            this.ensureTradeLogFile(existing.marketSlug);

            this.appendTradeLog(existing.marketSlug, {
              event: 'ORDER_CANCELED',
              marketSlug: existing.marketSlug,
              conditionId: existing.market,
              tokenId: existing.tokenID,
              outcome: existing.outcome,
              side: existing.side,
              orderPrice: existing.price,
              size: existing.remainingSize,
              bestBid: priceState?.bestBid,
              bestAsk: priceState?.bestAsk,
              orderId: existing.id,
              notes: 'batch_cancel',
            });
          }
        }
      }

      return {
        success: true,
        canceled,
      };
    } catch (error) {
      this.logger.error(`Error canceling fake orders: ${error}`);
    }
  }

  async cancelAllOrders(): Promise<any> {
    try {
      const existingOrders = Array.from(this.liveOrders.values());

      for (const order of existingOrders) {
        const priceState = PriceContext.get(order.tokenID);
        this.ensureTradeLogFile(order.marketSlug);

        this.appendTradeLog(order.marketSlug, {
          event: 'ORDER_CANCELED',
          marketSlug: order.marketSlug,
          conditionId: order.market,
          tokenId: order.tokenID,
          outcome: order.outcome,
          side: order.side,
          orderPrice: order.price,
          size: order.remainingSize,
          bestBid: priceState?.bestBid,
          bestAsk: priceState?.bestAsk,
          orderId: order.id,
          notes: 'cancel_all',
        });
      }

      const count = this.liveOrders.size;
      this.liveOrders.clear();

      return {
        success: true,
        canceledCount: count,
      };
    } catch (error) {
      this.logger.error(`Error canceling all fake orders: ${error}`);
    }
  }

  async getOrders(market: string): Promise<OpenOrder[]> {
    try {
      this.refreshLiveOrdersAgainstRealPrices(market);

      return Array.from(this.liveOrders.values())
        .filter((order) => order.market === market)
        .map((order) => this.toOpenOrder(order));
    } catch (error) {
      this.logger.error(`Error fetching fake open orders: ${error}`);
      return [];
    }
  }

  private refreshLiveOrdersAgainstRealPrices(conditionId: string) {
    for (const [id, order] of this.liveOrders.entries()) {
      if (order.market !== conditionId) continue;

      const priceState = PriceContext.get(order.tokenID);
      if (!priceState) continue;

      const shouldFillNow = this.isMarketable({
        side: order.side,
        price: order.price,
        bestAsk: priceState.bestAsk,
        bestBid: priceState.bestBid,
      });

      if (shouldFillNow) {
        const fillPrice =
          order.side === Side.BUY
            ? (priceState.bestAsk ?? order.price)
            : (priceState.bestBid ?? order.price);

        this.recordFill({
          marketSlug: order.marketSlug,
          conditionId: order.market,
          tokenId: order.tokenID,
          outcome: order.outcome,
          side: order.side,
          fillPrice,
          size: order.remainingSize,
          bestBid: priceState.bestBid,
          bestAsk: priceState.bestAsk,
          orderId: order.id,
          notes:
            order.side === Side.BUY
              ? 'filled_by_real_best_ask'
              : 'filled_by_real_best_bid',
        });

        this.liveOrders.delete(id);
      }
    }
  }

  private recordFill(params: {
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    outcome: OutcomeSide;
    side: Side;
    fillPrice: number;
    size: number;
    bestBid?: number;
    bestAsk?: number;
    orderId: string;
    notes?: string;
  }) {
    const {
      marketSlug,
      conditionId,
      tokenId,
      outcome,
      side,
      fillPrice,
      size,
      bestBid,
      bestAsk,
      orderId,
      notes,
    } = params;

    this.ensureTradeLogFile(marketSlug);

    if (side === Side.BUY) {
      const stats = this.ensureMarketStats(marketSlug, conditionId);

      if (outcome === 'up') {
        stats.upShares += size;
        stats.upCostUsdc += fillPrice * size;
        stats.upFillCount += 1;
      } else {
        stats.downShares += size;
        stats.downCostUsdc += fillPrice * size;
        stats.downFillCount += 1;
      }
    }

    this.appendTradeLog(marketSlug, {
      event: 'ORDER_FILLED',
      marketSlug,
      conditionId,
      tokenId,
      outcome,
      side,
      orderPrice: fillPrice,
      size,
      bestBid,
      bestAsk,
      orderId,
      notes: notes ?? '',
    });
  }

  private ensureMarketStats(
    marketSlug: string,
    conditionId: string,
  ): MarketPaperStats {
    const existing = this.marketStats.get(marketSlug);
    if (existing) return existing;

    const created: MarketPaperStats = {
      marketSlug,
      conditionId,
      upShares: 0,
      downShares: 0,
      upCostUsdc: 0,
      downCostUsdc: 0,
      upFillCount: 0,
      downFillCount: 0,
      settled: false,
    };

    this.marketStats.set(marketSlug, created);
    return created;
  }

  private async checkAndSettleEndedMarkets() {
    const now = Date.now();

    for (const [marketSlug, stats] of this.marketStats.entries()) {
      if (stats.settled) continue;
      if (this.settleInFlight.has(marketSlug)) continue;

      const endDateRaw = EndDateContext.get(marketSlug);
      if (!endDateRaw) continue;

      const endMs = new Date(endDateRaw).getTime();
      if (!Number.isFinite(endMs)) continue;
      if (now < endMs) continue;

      this.settleInFlight.add(marketSlug);

      try {
        const winner = await this.fetchWinnerForMarket(marketSlug);
        if (!winner) continue;

        this.finalizeMarket(stats, winner);
      } catch (error) {
        this.logger.error(
          `Error finalizing paper market ${marketSlug}: ${error}`,
        );
      } finally {
        this.settleInFlight.delete(marketSlug);
      }
    }
  }

  private async fetchWinnerForMarket(
    marketSlug: string,
  ): Promise<OutcomeSide | null> {
    try {
      const url = `${GAMMA_MARKETS_ENDPOINT}?slug=${encodeURIComponent(
        marketSlug,
      )}`;

      const response = await fetch(url);
      if (!response.ok) {
        this.logger.warn(
          `fetchWinnerForMarket failed ${marketSlug}: ${response.status}`,
        );
        return null;
      }

      const data: any = await response.json();
      const market = Array.isArray(data) ? data[0] : data;

      if (!market) return null;

      const candidates = [
        market.winner,
        market.outcome,
        market.resolution,
        market.result,
      ]
        .filter(Boolean)
        .map((v: any) => String(v).toLowerCase());

      for (const value of candidates) {
        if (value.includes('up') || value === 'yes' || value === '1') {
          return 'up';
        }
        if (value.includes('down') || value === 'no' || value === '0') {
          return 'down';
        }
      }

      const outcomes = Array.isArray(market.outcomes)
        ? market.outcomes
        : Array.isArray(market.tokens)
          ? market.tokens
          : [];

      for (const outcome of outcomes) {
        const name = String(
          outcome?.outcome ?? outcome?.name ?? outcome?.title ?? '',
        ).toLowerCase();

        const winnerFlag =
          outcome?.winner === true ||
          outcome?.won === true ||
          (outcome?.resolved === true && outcome?.price === 1) ||
          outcome?.price === 1 ||
          outcome?.price === '1';

        if (!winnerFlag) continue;

        if (name.includes('up') || name === 'yes') return 'up';
        if (name.includes('down') || name === 'no') return 'down';
      }

      return null;
    } catch (error) {
      this.logger.error(`fetchWinnerForMarket error ${marketSlug}: ${error}`);
      return null;
    }
  }

  private finalizeMarket(stats: MarketPaperStats, winner: OutcomeSide) {
    if (stats.settled) return;

    stats.settled = true;
    stats.winner = winner;
    stats.settledAt = Date.now();

    const upPayoutUsdc = winner === 'up' ? stats.upShares : 0;
    const downPayoutUsdc = winner === 'down' ? stats.downShares : 0;

    const totalCostUsdc = stats.upCostUsdc + stats.downCostUsdc;
    const totalPayoutUsdc = upPayoutUsdc + downPayoutUsdc;
    const netPnl = totalPayoutUsdc - totalCostUsdc;

    const winAmount =
      winner === 'up'
        ? upPayoutUsdc - stats.upCostUsdc
        : downPayoutUsdc - stats.downCostUsdc;

    const loseAmount = winner === 'up' ? stats.downCostUsdc : stats.upCostUsdc;

    this.appendMarketResultLog({
      ts: ((stats.settledAt ?? Date.now()) / 1000).toFixed(3),
      marketSlug: stats.marketSlug,
      conditionId: stats.conditionId,
      winner,
      upShares: stats.upShares,
      downShares: stats.downShares,
      upCostUsdc: stats.upCostUsdc,
      downCostUsdc: stats.downCostUsdc,
      upPayoutUsdc,
      downPayoutUsdc,
      winAmount,
      loseAmount,
      netPnl,
    });

    this.logger.log(
      `[PAPER RESULT] ${stats.marketSlug} winner=${winner} upShares=${stats.upShares} downShares=${stats.downShares} upCost=${stats.upCostUsdc.toFixed(6)} downCost=${stats.downCostUsdc.toFixed(6)} netPnl=${netPnl.toFixed(6)}`,
    );
  }

  private isMarketable(params: {
    side: Side;
    price: number;
    bestAsk?: number;
    bestBid?: number;
  }): boolean {
    const { side, price, bestAsk, bestBid } = params;

    if (side === Side.BUY) {
      return bestAsk != null && !Number.isNaN(bestAsk) && bestAsk <= price;
    }

    if (side === Side.SELL) {
      return bestBid != null && !Number.isNaN(bestBid) && bestBid >= price;
    }

    return false;
  }

  private resolveTokenMeta(tokenID: string):
    | {
        marketSlug: string;
        conditionId: string;
        outcome: OutcomeSide;
      }
    | null {
    for (const [marketSlug, pair] of TokenIdContext.entries()) {
      const conditionId = ConditionIdContext.get(marketSlug);
      if (!conditionId) continue;

      if (pair?.up === tokenID) {
        return { marketSlug, conditionId, outcome: 'up' };
      }

      if (pair?.down === tokenID) {
        return { marketSlug, conditionId, outcome: 'down' };
      }
    }

    return null;
  }

  private toOpenOrder(order: FakeLiveOrder): OpenOrder {
    return {
      id: order.id,
      market: order.market,
      asset_id: order.tokenID,
      price: order.price.toString(),
      original_size: order.size.toString(),
      size_matched: (order.size - order.remainingSize).toString(),
      side: order.side,
      outcome: order.outcome === 'up' ? 'Up' : 'Down',
      status: 'LIVE',
      created_at: order.createdAt,
    } as unknown as OpenOrder;
  }

  private ensureBaseLogFiles() {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    if (!fs.existsSync(this.marketResultLogPath)) {
      const header =
        'ts,marketSlug,conditionId,winner,upShares,downShares,upCostUsdc,downCostUsdc,upPayoutUsdc,downPayoutUsdc,winAmount,loseAmount,netPnl\n';
      fs.writeFileSync(this.marketResultLogPath, header, 'utf8');
    }
  }

  private ensureTradeLogFile(marketSlug: string) {
    if (!fs.existsSync(this.logsDir)) {
      fs.mkdirSync(this.logsDir, { recursive: true });
    }

    const tradeLogPath = this.getTradeLogPath(marketSlug);

    if (!fs.existsSync(tradeLogPath)) {
      const header =
        'ts,event,marketSlug,conditionId,tokenId,outcome,side,orderPrice,size,bestBid,bestAsk,orderId,notes\n';
      fs.writeFileSync(tradeLogPath, header, 'utf8');
    }
  }

  private getTradeLogPath(marketSlug: string) {
    const safeSlug = this.sanitizeForFilename(marketSlug);
    return path.join(this.logsDir, `paper-trades-${safeSlug}.csv`);
  }

  private sanitizeForFilename(value: string) {
    return value.replace(/[^a-zA-Z0-9._-]/g, '_');
  }

  private appendTradeLog(
    marketSlug: string,
    row: {
      event: string;
      marketSlug?: string;
      conditionId?: string;
      tokenId?: string;
      outcome?: string;
      side?: string;
      orderPrice?: number;
      size?: number;
      bestBid?: number;
      bestAsk?: number;
      orderId?: string;
      notes?: string;
    },
  ) {
    this.ensureTradeLogFile(marketSlug);

    const ts = (Date.now() / 1000).toFixed(3);

    const values = [
      ts,
      row.event ?? '',
      row.marketSlug ?? '',
      row.conditionId ?? '',
      row.tokenId ?? '',
      row.outcome ?? '',
      row.side ?? '',
      this.csvValue(row.orderPrice),
      this.csvValue(row.size),
      this.csvValue(row.bestBid),
      this.csvValue(row.bestAsk),
      row.orderId ?? '',
      row.notes ?? '',
    ];

    fs.appendFileSync(
      this.getTradeLogPath(marketSlug),
      values.join(',') + '\n',
      'utf8',
    );
  }

  private appendMarketResultLog(row: {
    ts: string;
    marketSlug: string;
    conditionId: string;
    winner: OutcomeSide;
    upShares: number;
    downShares: number;
    upCostUsdc: number;
    downCostUsdc: number;
    upPayoutUsdc: number;
    downPayoutUsdc: number;
    winAmount: number;
    loseAmount: number;
    netPnl: number;
  }) {
    const values = [
      row.ts,
      row.marketSlug,
      row.conditionId,
      row.winner,
      this.csvValue(row.upShares),
      this.csvValue(row.downShares),
      this.csvValue(row.upCostUsdc),
      this.csvValue(row.downCostUsdc),
      this.csvValue(row.upPayoutUsdc),
      this.csvValue(row.downPayoutUsdc),
      this.csvValue(row.winAmount),
      this.csvValue(row.loseAmount),
      this.csvValue(row.netPnl),
    ];

    fs.appendFileSync(
      this.marketResultLogPath,
      values.join(',') + '\n',
      'utf8',
    );
  }

  private csvValue(value?: number) {
    if (value == null || Number.isNaN(value)) return '';
    return String(value);
  }
}