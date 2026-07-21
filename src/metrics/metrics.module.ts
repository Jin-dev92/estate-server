import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from '../prisma/prisma.module';
import { HttpMetricsInterceptor } from './infrastructure/http-metrics.interceptor';
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
  // 임포트한다.
  imports: [PrismaModule],
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_REGISTRY, useFactory: createMetricsRegistry },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
    OutboxDepthCollector,
  ],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
