import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { WebSocket } from 'ws';
import { EventEmitter } from 'events';

import { ApiKeyCreds, ClobClient } from '@polymarket/clob-client';

import * as fs from 'fs';
import * as path from 'path';
import Papa from 'papaparse';

import { BotService } from '../bot/bot.service.js';
import { BroadcastService } from '../events/broadcast.service.js';
import { WS_BASE, clobClient as tempClient } from '../constant.js';
// import { handleMessage } from './st-1.js';
// import { handleMessage } from './st-2.js';
import { handleMessage } from './st-4.js';

@Injectable()
export class UserService extends EventEmitter implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(UserService.name);
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 10;
  private reconnectDelay = 1; // 5 seconds
  private reconnectTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;

  private subscribedTokenIds: string[] = [];

  private clobClient: ClobClient;
  private creds: ApiKeyCreds;

  constructor(
    private readonly botService: BotService,
    private readonly broadcastService: BroadcastService,
  ) {
    super();
  }

  async onModuleInit() {
    this.logger.log('User service initialized');
    this.creds = await tempClient.deriveApiKey();
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
      this.ws = new WebSocket(`${WS_BASE}/ws/user`);

      this.ws.on('open', () => {
        this.isConnecting = false;
        this.reconnectAttempts = 0;
        const auth = {
          apiKey: this.creds.key,
          secret: this.creds.secret,
          passphrase: this.creds.passphrase,
        }
        const subscription = {
          auth,
          markets: [],
          type: 'user',
        };
        this.ws.send(JSON.stringify(subscription));
        this.logger.log(`Connected to Polymarket User WebSocket at ${Date.now()}`);
      });

      this.ws.on('message', (data: Buffer) => {
        try {
          if (data.toString() === "PONG") {
            return;
          }
          const message = JSON.parse(data.toString());
          this.handleMessage(message);
        } catch (error) {
          this.logger.error(`Error parsing User WebSocket message: ${error}`);
        }
      });

      this.ws.on('error', (error) => {
        this.logger.error(`User WebSocket error: ${Date.now()} ${error}`);
        this.isConnecting = false;
      });

      this.ws.on('close', (code, reason) => {
        this.logger.warn(`User WebSocket closed: ${Date.now()} ${code} - ${reason.toString()}`);
        this.isConnecting = false;
        this.ws = null;
        this.scheduleReconnect();
      });
    } catch (error) {
      this.logger.error(`Error creating User WebSocket connection: ${error}`);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      this.logger.error('Max reconnect for User WebSocket attempts reached. Giving up.');
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * this.reconnectAttempts;
    // this.logger.log(`Scheduling reconnect for User WebSocket attempt ${this.reconnectAttempts} in ${delay}ms`);

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
    // handleMessage(message, this.broadcastService, this.logger);
    handleMessage(message, this.creds.key, this.botService, this.logger);
  }
}
