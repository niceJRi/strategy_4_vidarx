import { NestFactory } from '@nestjs/core';
import { ConsoleLogger, ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module.js';
import { BINDING_PORT } from './constant.js';

import { Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';

class FileLogger extends ConsoleLogger {
  private logDir = path.join(process.cwd(), 'logs');
  private logFile = path.join(this.logDir, 'polymarket-bot.log');

  constructor() {
    super();
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  private writeToFile(message: string) {
    fs.appendFileSync(this.logFile, `${Logger.getTimestamp()} ${message}\n`);
  }

  log(message: string) {
    super.log(message);
    this.writeToFile(`[LOG] ${message}`);
  }

  error(message: string, trace?: string) {
    super.error(message, trace);
    this.writeToFile(`[ERROR] ${message} ${trace ?? ''}`);
  }

  warn(message: string) {
    super.warn(message);
    this.writeToFile(`[WARN] ${message}`);
  }
}

async function bootstrap() {
  const app = await NestFactory.create(
    AppModule,
    {
      logger: new FileLogger(),
    }
  );
  
  const config = new DocumentBuilder()
    .setTitle('Polymarket Bot')
    .setVersion('1.0')
    .addTag('polymarket')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  app.useWebSocketAdapter(new WsAdapter(app))
  app.useGlobalPipes(new ValidationPipe());
  app.enableCors(
    {
      origin: '*',
      methods: ['GET', 'POST', 'PUT', 'DELETE'],
      allowedHeaders: ['Content-Type', 'Authorization'],
    }
  );
  await app.listen(BINDING_PORT);
}

bootstrap();