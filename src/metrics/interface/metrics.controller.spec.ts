import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Registry, collectDefaultMetrics } from 'prom-client';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { METRICS_REGISTRY } from '../infrastructure/metrics.registry';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  let app: INestApplication;
  let registry: Registry;

  beforeEach(async () => {
    registry = new Registry();
    collectDefaultMetrics({ register: registry, prefix: 'estate_' });
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: METRICS_REGISTRY, useValue: registry }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    registry.clear();
    await app.close();
  });

  describe('GET /metrics 요청 시', () => {
    it('Prometheus content type과 기본 프로세스 메트릭을 반환한다', async () => {
      // Arrange: beforeEach에서 독립 Registry가 등록된 Nest 앱을 준비한다.

      // Act
      const response = await request(app.getHttpServer() as App).get(
        '/metrics',
      );

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(registry.contentType);
      expect(response.text).toContain('estate_process_cpu_user_seconds_total');
    });
  });
});
