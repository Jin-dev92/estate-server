import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ConfigKey } from '../config/config-keys';
import { PrismaModule } from '../prisma/prisma.module';
import { KafkaModule } from '../events/kafka.module';
import { TRANSACTION_RUNNER } from './domain/transaction-runner';
import { OUTBOX_STORE } from './domain/outbox-store';
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
} from './application/outbox.tokens';
import { PrismaTransactionRunner } from './infrastructure/prisma-transaction-runner';
import { PrismaOutboxStore } from './infrastructure/prisma-outbox-store';
import { RelayOutboxUseCase } from './application/relay-outbox.use-case';

// 적재 측(use case)은 TRANSACTION_RUNNER·OUTBOX_STORE만 필요(export).
// 발행 측(relay 워커)은 EVENT_PUBLISHER(KafkaModule)·RelayOutboxUseCase까지 필요.
// 워커는 standalone context(createApplicationContext)로 뜨므로 전역 인프라를 직접 import한다.
@Module({
  imports: [
    // 워커 standalone context에서 ConfigService를 해결하기 위해 직접 forRoot 호출
    // (AppModule 없이 뜰 때도 env를 읽을 수 있어야 함)
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    KafkaModule,
  ],
  providers: [
    { provide: TRANSACTION_RUNNER, useClass: PrismaTransactionRunner },
    { provide: OUTBOX_STORE, useClass: PrismaOutboxStore },
    {
      provide: OUTBOX_BATCH_SIZE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxBatchSize)) || 100,
    },
    {
      provide: OUTBOX_MAX_ATTEMPTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxMaxAttempts)) || 5,
    },
    {
      provide: OUTBOX_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxBackoffBaseMs)) || 1000,
    },
    {
      provide: OUTBOX_BACKOFF_CAP_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxBackoffCapMs)) || 60000,
    },
    RelayOutboxUseCase,
  ],
  exports: [TRANSACTION_RUNNER, OUTBOX_STORE],
})
export class OutboxModule {}
