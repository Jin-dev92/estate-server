import { Module } from '@nestjs/common';
import {
  METRICS_REGISTRY,
  createMetricsRegistry,
} from './infrastructure/metrics.registry';
import { MetricsController } from './interface/metrics.controller';

@Module({
  controllers: [MetricsController],
  providers: [{ provide: METRICS_REGISTRY, useFactory: createMetricsRegistry }],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
