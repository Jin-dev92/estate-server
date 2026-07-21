import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { HttpMetricsInterceptor } from './infrastructure/http-metrics.interceptor';
import {
  METRICS_REGISTRY,
  createMetricsRegistry,
} from './infrastructure/metrics.registry';
import { MetricsController } from './interface/metrics.controller';

@Module({
  controllers: [MetricsController],
  providers: [
    { provide: METRICS_REGISTRY, useFactory: createMetricsRegistry },
    { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
  ],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
