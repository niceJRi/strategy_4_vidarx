import { Injectable, Logger } from '@nestjs/common';
import {
  ClobClient,
  OrderType,
  PostOrdersArgs,
  OpenOrder,
  Side,
} from '@polymarket/clob-client';
import { SignedOrder } from '@polymarket/order-utils';
import * as fs from 'fs';
import * as path from 'path';

import { S3PreOrderContext } from '../context/bot.js';
import {
  signer,
  CLOB_API_BASE,
  SAFE_ADDRESS,
  POLY_BUILDER_API_KEY,
  POLY_BUILDER_SECRET,
  POLY_BUILDER_PASSPHRASE,
} from '../constant.js';
import {
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
  orderType?: OrderType.GTC | OrderType.GTD | OrderType.FAK | OrderType.FOK;
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
  price?: number;
  side: Side;
  amount: number;
  orderType?: OrderType.FOK | OrderType.FAK;
}

type OutcomeSide = 'up' | 'down';

type MarketTradeStats = {
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
  private clobClient: ClobClient;
  private readonly marketStats = new Map<string, MarketTradeStats>();
  private readonly settleInFlight = new Set<string>();

  private readonly logsDir = path.join(process.cwd(), 'logs');
  private readonly marketResultLogPath = path.join(
    process.cwd(),
    'logs',
    'market-results.csv',
  );

  async onModuleInit() {
    // signatureType=1 → POLY_PROXY mode:
    //   maker  = Polymarket proxy wallet (0xaf8d54ff6e3dfd108b66c5851a1c78597e85c396)
    //   signer = EOA MetaMask key (0x38c31aFd3655973041D6E5A0151Eb5a55CD2d893)
    // USDC is drawn from the proxy wallet (your Polymarket account balance).
    const PROXY_WALLET = '0xaf8d54ff6e3dfd108b66c5851a1c78597e85c396';
    const creds = {
      key: POLY_BUILDER_API_KEY,
      secret: POLY_BUILDER_SECRET,
      passphrase: POLY_BUILDER_PASSPHRASE,
    };
    this.clobClient = new ClobClient(CLOB_API_BASE, 137, signer, creds, 2, PROXY_WALLET);

    this.ensureBaseLogFiles();
    this.logger.log('[REAL ORDER MODE] initialized with live Polymarket CLOB');

    setInterval(() => {
      this.checkAndSettleEndedMarkets().catch((error) => {
        this.logger.error(`Error settling markets: ${error}`);
      });
    }, 5000);
  }

  // ── Order creation ────────────────────────────────────────────────────────

  async createOrder(params: CreateOrderParams): Promise<SignedOrder> {
    try {
      const { key, tokenID, price, side, size } = params;
      const order = await this.clobClient.createOrder({
        tokenID,
        price,
        side,
        size,
      });
      S3PreOrderContext.set(key, order);
      return order;
    } catch (error) {
      this.logger.error(`Error creating order: ${error}`);
      throw error;
    }
  }

  async postOrder(order: SignedOrder, orderType: OrderType): Promise<any> {
    try {
      return await this.clobClient.postOrder(order, orderType);
    } catch (error) {
      this.logger.error(`Error posting order: ${error}`);
    }
  }

  async postOrders(orders: PostOrdersArgs[]): Promise<any> {
    try {
      return await this.clobClient.postOrders(orders);
    } catch (error) {
      this.logger.error(`Error posting orders: ${error}`);
    }
  }

  /**
   * Creates and posts a single limit order.
   * Returns the raw OrderResponse from the CLOB API:
   *   { success, orderID, status, takingAmount (shares filled), makingAmount (USDC spent) }
   */
  async createAndPostOrder(params: CreateAndPostOrderParams): Promise<any> {
    try {
      const { tokenID, price, side, size, orderType = OrderType.GTC } = params;

      let response: any;
      if (orderType === OrderType.FAK || orderType === OrderType.FOK) {
        const amount = Math.round(size * price * 1_000_000) / 1_000_000;
        response = await this.clobClient.createAndPostMarketOrder(
          { tokenID, price, side, amount, orderType },
          null,
          orderType as OrderType.FAK | OrderType.FOK,
        );
      } else {
        response = await this.clobClient.createAndPostOrder(
          { tokenID, price, side, size },
          null,
          orderType as OrderType.GTC | OrderType.GTD,
        );
      }

      // Best-effort trade logging for audit trail + P&L settlement
      this.tryRecordFill(tokenID, side, price, size, response);

      return response;
    } catch (error) {
      this.logger.error(`Error creating and posting order: ${error}`);
    }
  }

  async createAndPostMarketOrder(
    params: CreateMarketOrderParams,
    orderType: OrderType.FOK | OrderType.FAK = OrderType.FOK,
  ): Promise<any> {
    try {
      const { tokenID, price, side, amount } = params;
      return await this.clobClient.createAndPostMarketOrder(
        { tokenID, price, side, amount, orderType },
        null,
        orderType,
      );
    } catch (error) {
      this.logger.error(`Error creating and posting market order: ${error}`);
    }
  }

  async createOrders(
    orders: CreateAndPostOrderParams[],
    orderType: OrderType.GTC | OrderType.GTD = OrderType.GTC,
  ): Promise<any> {
    try {
      const orderArgs: PostOrdersArgs[] = await Promise.all(
        orders.map(async ({ tokenID, price, side, size }) => {
          const order = await this.clobClient.createOrder({
            tokenID,
            price,
            side,
            size,
          });
          return { order, orderType };
        }),
      );
      return await this.clobClient.postOrders(orderArgs);
    } catch (error) {
      this.logger.error(`Error creating orders: ${error}`);
    }
  }

  // ── Order management ──────────────────────────────────────────────────────

  async cancelOrder(orderID: string): Promise<any> {
    try {
      return await this.clobClient.cancelOrder({ orderID });
    } catch (error) {
      this.logger.error(`Error canceling order: ${error}`);
    }
  }

  async cancelOrders(orderIDs: string[]): Promise<any> {
    try {
      return await this.clobClient.cancelOrders(orderIDs);
    } catch (error) {
      this.logger.error(`Error canceling orders: ${error}`);
    }
  }

  async cancelAllOrders(): Promise<any> {
    try {
      return await this.clobClient.cancelAll();
    } catch (error) {
      this.logger.error(`Error canceling all orders: ${error}`);
    }
  }

  async getOrders(market: string): Promise<OpenOrder[]> {
    try {
      return await this.clobClient.getOpenOrders({ market });
    } catch (error) {
      this.logger.error(`Error fetching open orders: ${error}`);
      return [];
    }
  }

  // ── Trade logging & P&L settlement ───────────────────────────────────────

  /**
   * Extracts the actual fill from a real OrderResponse and records it.
   * OrderResponse fields:
   *   takingAmount (string) = shares received for a BUY
   *   makingAmount (string) = USDC spent for a BUY
   */
  private tryRecordFill(
    tokenID: string,
    side: Side,
    price: number,
    requestedSize: number,
    response: any,
  ) {
    try {
      if (!response) return;
      const meta = this.resolveTokenMeta(tokenID);
      if (!meta) return;

      let filledShares = 0;
      let filledUsdc = 0;

      if (response.takingAmount != null && response.makingAmount != null) {
        filledShares = parseFloat(response.takingAmount) || 0;
        filledUsdc = parseFloat(response.makingAmount) || 0;
      } else if (response.success !== false && response.orderID) {
        // API didn't return fill amounts — assume full fill for logging
        filledShares = requestedSize;
        filledUsdc = requestedSize * price;
      }

      // Only record orders that actually filled — FAK zero-fill = cancelled
      if (filledShares <= 0) return;

      this.ensureTradeLogFile(meta.marketSlug);

      this.appendTradeLog(meta.marketSlug, {
        event: 'ORDER_FILLED',
        marketSlug: meta.marketSlug,
        conditionId: meta.conditionId,
        tokenId: tokenID,
        outcome: meta.outcome,
        side,
        orderPrice: price,
        size: filledShares,
        orderId: response.orderID || response.orderId || '',
        notes: `status=${response.status ?? 'unknown'} takingAmount=${response.takingAmount ?? ''} makingAmount=${response.makingAmount ?? ''}`,
      });

      if (side === Side.BUY && filledShares > 0) {
        const stats = this.ensureMarketStats(meta.marketSlug, meta.conditionId);
        if (meta.outcome === 'up') {
          stats.upShares += filledShares;
          stats.upCostUsdc += filledUsdc;
          stats.upFillCount += 1;
        } else {
          stats.downShares += filledShares;
          stats.downCostUsdc += filledUsdc;
          stats.downFillCount += 1;
        }
      }
    } catch {
      // Best-effort — never throw from a logging helper
    }
  }

  private ensureMarketStats(
    marketSlug: string,
    conditionId: string,
  ): MarketTradeStats {
    const existing = this.marketStats.get(marketSlug);
    if (existing) return existing;

    const created: MarketTradeStats = {
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
      if (!Number.isFinite(endMs) || now < endMs) continue;

      this.settleInFlight.add(marketSlug);

      try {
        const winner = await this.fetchWinnerForMarket(marketSlug);
        if (!winner) continue;
        this.finalizeMarket(stats, winner);
      } catch (error) {
        this.logger.error(`Error finalizing market ${marketSlug}: ${error}`);
      } finally {
        this.settleInFlight.delete(marketSlug);
      }
    }
  }

  private async fetchWinnerForMarket(
    marketSlug: string,
  ): Promise<OutcomeSide | null> {
    try {
      const url = `${GAMMA_MARKETS_ENDPOINT}?slug=${encodeURIComponent(marketSlug)}`;
      const response = await fetch(url);
      if (!response.ok) return null;

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
        if (value.includes('up') || value === 'yes' || value === '1') return 'up';
        if (value.includes('down') || value === 'no' || value === '0') return 'down';
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

  private finalizeMarket(stats: MarketTradeStats, winner: OutcomeSide) {
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
      `[RESULT] ${stats.marketSlug} winner=${winner} upShares=${stats.upShares.toFixed(6)} downShares=${stats.downShares.toFixed(6)} upCost=${stats.upCostUsdc.toFixed(6)} downCost=${stats.downCostUsdc.toFixed(6)} netPnl=${netPnl.toFixed(6)}`,
    );
  }

  // ── Token metadata ────────────────────────────────────────────────────────

  private resolveTokenMeta(
    tokenID: string,
  ): { marketSlug: string; conditionId: string; outcome: OutcomeSide } | null {
    for (const [marketSlug, pair] of TokenIdContext.entries()) {
      const conditionId = ConditionIdContext.get(marketSlug);
      if (!conditionId) continue;
      if (pair?.up === tokenID) return { marketSlug, conditionId, outcome: 'up' };
      if (pair?.down === tokenID) return { marketSlug, conditionId, outcome: 'down' };
    }
    return null;
  }

  // ── CSV helpers ───────────────────────────────────────────────────────────

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
    const logPath = this.getTradeLogPath(marketSlug);
    if (!fs.existsSync(logPath)) {
      const header =
        'ts,event,marketSlug,conditionId,tokenId,outcome,side,orderPrice,size,orderId,notes\n';
      fs.writeFileSync(logPath, header, 'utf8');
    }
  }

  private getTradeLogPath(marketSlug: string) {
    return path.join(
      this.logsDir,
      `trades-${marketSlug.replace(/[^a-zA-Z0-9._-]/g, '_')}.csv`,
    );
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
      this.csvVal(row.orderPrice),
      this.csvVal(row.size),
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
      this.csvVal(row.upShares),
      this.csvVal(row.downShares),
      this.csvVal(row.upCostUsdc),
      this.csvVal(row.downCostUsdc),
      this.csvVal(row.upPayoutUsdc),
      this.csvVal(row.downPayoutUsdc),
      this.csvVal(row.winAmount),
      this.csvVal(row.loseAmount),
      this.csvVal(row.netPnl),
    ];
    fs.appendFileSync(
      this.marketResultLogPath,
      values.join(',') + '\n',
      'utf8',
    );
  }

  private csvVal(value?: number) {
    if (value == null || Number.isNaN(value)) return '';
    return String(value);
  }
}
