import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { IncomingMessage } from 'http';
import { WebSocket } from 'ws';
import { BroadcastService } from './broadcast.service.js';
import { JwtService } from '@nestjs/jwt';

@WebSocketGateway({ path: '/events' })
export class EventsGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: import('ws').Server;

  private readonly logger = new Logger(EventsGateway.name);

  constructor(
    private readonly broadcastService: BroadcastService,
    private readonly jwtService: JwtService,
  ) {}

  handleConnection(client: WebSocket, request?: IncomingMessage) {
    const token = this.getTokenFromRequest(request);
    if (!token) {
      this.logger.warn('WebSocket connection rejected: no token');
      client.close(4001, 'Access token required');
      return;
    }

    try {
      const payload = this.jwtService.verify(token);
      this.broadcastService.addClient(client);
      this.logger.log(`Client connected (${payload.sub})`);
    } catch {
      this.logger.warn('WebSocket connection rejected: invalid or expired token');
      client.close(4001, 'Invalid or expired token');
    }
  }

  handleDisconnect(client: WebSocket) {
    this.broadcastService.removeClient(client);
    this.logger.log('Client disconnected');
  }

  private getTokenFromRequest(request?: IncomingMessage): string | null {
    if (!request?.url) return null;
    try {
      const url = new URL(request.url, baseUrl(request));
      return url.searchParams.get('token');
    } catch {
      return null;
    }
  }
}

function baseUrl(req: IncomingMessage): string {
  const host = req.headers.host || 'localhost';
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
  return `${proto}://${host}/`;
}
