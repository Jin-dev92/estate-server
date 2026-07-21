import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Registry } from 'prom-client';
import * as request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../../prisma/prisma.service';
import {
  METRICS_PATH,
  METRICS_REGISTRY,
} from '../infrastructure/metrics.registry';
import { MetricsModule } from '../metrics.module';

// OutboxDepthCollector(Task 4)가 PrismaService에 의존하게 되면서, MetricsModule
// 단독으로 테스트 모듈을 구성할 때도 PrismaService가 DI에 해석되어야 한다.
// 실제 PrismaService를 그대로 쓰면 onModuleInit()에서 진짜 DB($connect)로
// 붙으려 하므로, GET /metrics의 기본 메트릭 노출만 검증하는 이 스펙에서는
// outboxEvent.groupBy만 가진 가벼운 mock으로 대체한다.
function createMockPrisma() {
  return {
    outboxEvent: { groupBy: jest.fn().mockResolvedValue([]) },
  };
}

// Content-Type 헤더를 미디어 타입 + 파라미터(key=value)로 파싱한다.
// Express의 res.send()가 문자열 body를 보낼 때 setCharset()이 content-type
// 패키지의 format()을 호출해 파라미터 순서를 알파벳순으로 재정렬하므로
// (version=0.0.4; charset=utf-8 → charset=utf-8; version=0.0.4),
// 문자열 그대로 비교하면 순서 차이로 테스트가 깨진다. 순서에 무관하게
// 의미(미디어 타입, 파라미터 값)만 비교하기 위해 파싱해서 검증한다.
function parseContentType(header: string): {
  mediaType: string;
  params: Record<string, string>;
} {
  const [mediaType, ...paramParts] = header
    .split(';')
    .map((part) => part.trim());
  const params: Record<string, string> = {};
  for (const part of paramParts) {
    const [key, value] = part.split('=').map((piece) => piece.trim());
    params[key] = value;
  }
  return { mediaType, params };
}

describe('MetricsController', () => {
  let app: INestApplication;
  let registry: Registry;

  beforeEach(async () => {
    // 수동으로 컨트롤러+Registry를 조립하지 않고 프로덕션 MetricsModule을 그대로
    // 임포트한다. 그래야 MetricsModule의 provider/export 누락이나 기본 메트릭
    // 수집 누락이 실제 프로덕션 부팅 경로와 동일하게 테스트에서 잡힌다.
    const moduleRef = await Test.createTestingModule({
      imports: [MetricsModule],
    })
      .overrideProvider(PrismaService)
      .useValue(createMockPrisma())
      .compile();
    app = moduleRef.createNestApplication();
    await app.init();

    registry = app.get<Registry>(METRICS_REGISTRY);
  });

  afterEach(async () => {
    jest.clearAllMocks();
    registry.clear();
    await app.close();
  });

  describe('GET /metrics 요청 시', () => {
    it('Prometheus content type과 기본 프로세스 메트릭을 반환한다', async () => {
      // Arrange: beforeEach에서 프로덕션 MetricsModule로 구성한 Nest 앱을 준비한다.

      // Act
      const response = await request(app.getHttpServer() as App).get(
        `/${METRICS_PATH}`,
      );

      // Assert
      expect(response.status).toBe(200);

      const actual = parseContentType(response.headers['content-type']);
      const expected = parseContentType(registry.contentType);
      expect(actual.mediaType).toBe(expected.mediaType);
      expect(actual.params).toEqual(expected.params);

      expect(response.text).toContain('estate_process_cpu_user_seconds_total');
    });
  });
});
