import { Injectable } from '@nestjs/common';

/**
 * PriceGateway is not used for broadcasting to clients.
 * PriceService directly connects to Polymarket WebSocket to receive price data.
 */
@Injectable()
export class PriceGateway {}
