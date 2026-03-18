import { Injectable } from '@nestjs/common';
import { WebSocket } from 'ws';

@Injectable()
export class BroadcastService {
  private readonly clients = new Set<WebSocket>();

  addClient(client: WebSocket) {
    this.clients.add(client);
  }

  removeClient(client: WebSocket) {
    this.clients.delete(client);
  }

  /**
   * Send data to all connected logged-in clients.
   * Call this from any service when something happens.
   *
   * @param event - Event name (e.g. 'orderFilled', 'priceUpdate', 'botRound')
   * @param data - Payload to send
   */
  broadcast(event: string, data: unknown) {
    const message = JSON.stringify({ event, data });
    for (const client of this.clients) {
      if (client.readyState === 1) {
        try {
          client.send(message);
        } catch (err) {
          this.clients.delete(client);
        }
      }
    }
  }
}
