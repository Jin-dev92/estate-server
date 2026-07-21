import { Controller, Get, INestApplication } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { Registry } from 'prom-client';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { HttpMetricsInterceptor } from './http-metrics.interceptor';
import { METRICS_REGISTRY } from './metrics.registry';

// 실제 프로덕션 컨트롤러 대신, "/buildings/:buildingId/posts" 형태의 파라미터
// 라우트를 갖는 픽스처 컨트롤러를 둔다. 인터셉터가 원시 URL(파라미터 값 포함)이
// 아니라 라우트 패턴 자체를 라벨로 쓰는지 검증하기 위함이다.
const FIXTURE_BUILDING_ID = 'building-1';

@Controller('buildings/:buildingId')
class FixtureBuildingController {
  @Get('posts')
  getPosts(): { ok: true } {
    return { ok: true };
  }
}

describe('HttpMetricsInterceptor', () => {
  let app: INestApplication;
  let registry: Registry;

  beforeEach(async () => {
    registry = new Registry();

    const moduleRef = await Test.createTestingModule({
      controllers: [FixtureBuildingController],
      providers: [
        { provide: METRICS_REGISTRY, useValue: registry },
        { provide: APP_INTERCEPTOR, useClass: HttpMetricsInterceptor },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    registry.clear();
    await app.close();
  });

  describe('GET /buildings/:buildingId/posts 요청 시', () => {
    it('라우트 패턴 라벨로 RED 메트릭(Counter, Histogram)을 기록한다', async () => {
      // Arrange: beforeEach에서 픽스처 컨트롤러 + 인터셉터로 앱을 구성했다.

      // Act
      await request(app.getHttpServer() as App).get(
        `/buildings/${FIXTURE_BUILDING_ID}/posts`,
      );

      const counter = await registry.getSingleMetricAsString(
        'http_requests_total',
      );
      const histogram = await registry.getSingleMetricAsString(
        'http_request_duration_seconds',
      );

      // Assert: 라벨은 라우트 패턴이어야 하고, 파라미터 원시값(building-1)은
      // 카디널리티 폭발을 막기 위해 절대 노출되면 안 된다.
      expect(counter).toContain(
        'method="GET",route="/buildings/:buildingId/posts",status="200"} 1',
      );
      expect(counter).not.toContain(FIXTURE_BUILDING_ID);
      expect(histogram).toContain('http_request_duration_seconds_count');
      expect(histogram).toContain('route="/buildings/:buildingId/posts"');
    });
  });
});
