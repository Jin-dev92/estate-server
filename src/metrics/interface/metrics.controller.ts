import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Registry } from 'prom-client';
import { SWAGGER_TAG_METRICS } from '../../common/swagger/swagger.constants';
import { METRICS_REGISTRY } from '../infrastructure/metrics.registry';

@ApiTags(SWAGGER_TAG_METRICS)
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus 메트릭 조회' })
  @ApiResponse({
    status: 200,
    description: 'Prometheus text exposition format',
  })
  async metrics(@Res() response: Response): Promise<void> {
    const metricsText = await this.registry.metrics();

    // registry.contentType은 Prometheus text exposition format의 Content-Type이다
    // (예: "text/plain; version=0.0.4; charset=utf-8"). 스크레이퍼(Prometheus 서버)가
    // 이 헤더로 응답 포맷을 파싱한다.
    // 문자열 body를 response.send()로 보내면 Express가 setCharset()에서
    // content-type 패키지의 format()을 호출하는데, 이 함수는 파라미터 키를
    // Object.keys().sort()로 알파벳순 재정렬한다(version→charset 순서가 charset→version
    // 으로 뒤바뀜). 원본 순서를 보존하기 위해 res.send 대신 res.end로 직접 응답한다.
    // (Nest가 자동으로 reply()를 호출하지 않도록 @Res()를 passthrough 없이 사용한다.)
    response.setHeader('Content-Type', this.registry.contentType);
    response.end(metricsText);
  }
}
