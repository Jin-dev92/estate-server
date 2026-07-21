import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Admin, Kafka } from 'kafkajs';
import { ConfigKey } from '../config/config-keys';
import { PrismaModule } from '../prisma/prisma.module';
import { HttpMetricsInterceptor } from './infrastructure/http-metrics.interceptor';
import {
  KAFKA_ADMIN,
  KafkaLagCollector,
} from './infrastructure/kafka-lag.collector';
import {
  METRICS_REGISTRY,
  createMetricsRegistry,
} from './infrastructure/metrics.registry';
import { OutboxDepthCollector } from './infrastructure/outbox-depth.collector';
import { MetricsController } from './interface/metrics.controller';

@Module({
  // PrismaModule은 @Global()이라 AppModule에서 이미 전역 등록되지만,
  // MetricsModule 단독으로 테스트 모듈을 구성할 때도(Test.createTestingModule
  // 등) OutboxDepthCollector가 PrismaService를 해석할 수 있도록 명시적으로
  // 임포트한다. ConfigModule도 같은 이유로 명시 임포트한다 — KAFKA_ADMIN
  // 프로바이더가 ConfigService를 주입받는다.
  imports: [PrismaModule, ConfigModule],
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_REGISTRY, useFactory: createMetricsRegistry },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    OutboxDepthCollector,
    {
      provide: KAFKA_ADMIN,
      inject: [ConfigService],
      useFactory: (config: ConfigService): Admin =>
        new Kafka({
          brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
        }).admin(),
    },
    KafkaLagCollector,
  ],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
