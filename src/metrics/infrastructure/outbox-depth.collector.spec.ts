import { Registry } from 'prom-client';
import { OutboxStatus } from '../../outbox/domain/outbox-status.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxDepthCollector } from './outbox-depth.collector';

// scrape 시 조회할 PENDING/FAILED 건수. Prisma groupBy 응답 픽스처의 기대값과
// 게이지 노출값을 동시에 검증하는 데 재사용한다.
const PENDING_COUNT = 7;
const FAILED_COUNT = 2;

// PrismaService는 거대 생성 타입이라 collector가 실제로 쓰는 outboxEvent만
// mock한다. `satisfies`로 실제 시그니처(Partial<jest.Mocked<...>>)를 강제해
// mock 메서드 이름·형태가 타입에서 벗어나지 않게 한다.
function createMockPrisma() {
  const outboxEvent = {
    groupBy: jest.fn(),
  } satisfies Partial<jest.Mocked<PrismaService['outboxEvent']>>;

  return { outboxEvent };
}

// Prisma groupBy(_count: { _all: true }) 응답 행 하나를 만드는 팩토리.
function createGroupByRow(status: OutboxStatus, count: number) {
  return { status, _count: { _all: count } };
}

describe('OutboxDepthCollector', () => {
  let registry: Registry;
  let prisma: ReturnType<typeof createMockPrisma>;
  let collector: OutboxDepthCollector;

  beforeEach(() => {
    registry = new Registry();
    prisma = createMockPrisma();
    collector = new OutboxDepthCollector(
      registry,
      prisma as unknown as PrismaService,
    );
  });

  afterEach(() => {
    jest.clearAllMocks();
    registry.clear();
  });

  describe('scrape(registry.metrics()) 시', () => {
    describe('groupBy가 정상 응답하면', () => {
      it('PENDING·FAILED 건수로 두 Gauge를 노출한다', async () => {
        // Arrange
        prisma.outboxEvent.groupBy.mockResolvedValue([
          createGroupByRow(OutboxStatus.Pending, PENDING_COUNT),
          createGroupByRow(OutboxStatus.Failed, FAILED_COUNT),
        ]);

        // Act
        await collector.collect();
        const pendingText = await registry.getSingleMetricAsString(
          'outbox_events_pending',
        );
        const failedText = await registry.getSingleMetricAsString(
          'outbox_events_failed',
        );

        // Assert
        expect(pendingText).toContain(`outbox_events_pending ${PENDING_COUNT}`);
        expect(failedText).toContain(`outbox_events_failed ${FAILED_COUNT}`);
      });

      it('groupBy를 정확히 한 번, 지정된 shape으로만 호출한다', async () => {
        // Arrange
        prisma.outboxEvent.groupBy.mockResolvedValue([]);

        // Act
        await collector.collect();

        // Assert
        expect(prisma.outboxEvent.groupBy).toHaveBeenCalledTimes(1);
        expect(prisma.outboxEvent.groupBy).toHaveBeenCalledWith({
          by: ['status'],
          _count: { _all: true },
          where: {
            status: { in: [OutboxStatus.Pending, OutboxStatus.Failed] },
          },
        });
      });
    });

    describe('groupBy가 실패(reject)하면', () => {
      it('registry.metrics()는 정상 resolve되고 이전 성공값이 남지 않는다', async () => {
        // Arrange: 실패 케이스 이전에 성공 스크레이프로 7/2 값을 먼저 채워둔다.
        // reset() 후 재조회에 실패했을 때 "이전 성공값이 그대로 노출되는" 회귀를
        // 잡기 위함이다.
        prisma.outboxEvent.groupBy.mockResolvedValueOnce([
          createGroupByRow(OutboxStatus.Pending, PENDING_COUNT),
          createGroupByRow(OutboxStatus.Failed, FAILED_COUNT),
        ]);
        await collector.collect();
        prisma.outboxEvent.groupBy.mockRejectedValueOnce(new Error('DB down'));

        // Act: registry.metrics()가 Gauge의 async collect 콜백을 통해 재조회를
        // 트리거한다 — scrape 시점 집계가 실제로 동작하는지 함께 검증한다.
        const metricsText = await registry.metrics();

        // Assert: reject를 삼켜 scrape 자체는 실패하지 않는다.
        // (prom-client Gauge는 labelNames가 없으면 reset() 후에도 암묵적으로
        // "0" 샘플 한 줄을 유지하는 라이브러리 동작이 있어, 완전한 샘플 부재
        // 대신 "0으로 리셋되어 이전 성공값이 남지 않는지"를 검증한다.)
        expect(metricsText).not.toContain(
          `outbox_events_pending ${PENDING_COUNT}`,
        );
        expect(metricsText).not.toContain(
          `outbox_events_failed ${FAILED_COUNT}`,
        );
        expect(metricsText).toContain('outbox_events_pending 0');
        expect(metricsText).toContain('outbox_events_failed 0');
      });
    });
  });
});
