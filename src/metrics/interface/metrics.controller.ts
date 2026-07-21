import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Registry } from 'prom-client';
import { SWAGGER_TAG_METRICS } from '../../common/swagger/swagger.constants';
import {
  METRICS_PATH,
  METRICS_REGISTRY,
} from '../infrastructure/metrics.registry';

@ApiTags(SWAGGER_TAG_METRICS)
@Controller(METRICS_PATH)
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus 메트릭 조회' })
  @ApiResponse({
    status: 200,
    description: 'Prometheus text exposition format',
  })
  metrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    // passthrough: true → Nest가 반환값을 그대로 응답 body로 보낸다(res.send 사용).
    // Content-Type만 registry.contentType으로 직접 지정해 Prometheus 스크레이퍼가
    // 기대하는 "text/plain; version=0.0.4; charset=utf-8" 형식으로 응답한다.
    response.type(this.registry.contentType);
    return this.registry.metrics();
  }
}
