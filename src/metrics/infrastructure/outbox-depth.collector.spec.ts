import { Registry } from 'prom-client';
import { OutboxStatus } from '../../outbox/domain/outbox-status.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { OutboxDepthCollector } from './outbox-depth.collector';

// scrape 시 조회할 PENDING/FAILED 건수. Prisma groupBy 응답 픽스처의 기대값과
// 게이지 노출값을 동시에 검증하는 데 재사용한다.
const PENDING_COUNT = 7;
const FAILED_COUNT = 2;

// collect()의 쿼리 타임아웃(ms)과 동일한 값. 페이크 타이머로 정확히 이 값만큼
// 진행시켜 "타임아웃이 실제로 이 시점에 발동하는지"를 검증한다.
const QUERY_TIMEOUT_MS = 1000;

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

  beforeEach(() => {
    registry = new Registry();
    prisma = createMockPrisma();
    // collector 인스턴스는 registry에 Gauge를 등록하는 부수효과만 필요하다.
    // 이후 검증은 registry.metrics()/registry.getSingleMetricAsString()으로
    // 하므로 변수에 담아두지 않는다.
    new OutboxDepthCollector(registry, prisma as unknown as PrismaService);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    registry.clear();
  });

  describe('scrape(registry.metrics()) 시', () => {
    describe('groupBy가 정상 응답하면', () => {
      it('PENDING·FAILED 건수로 두 Gauge를 함께 노출하고 groupBy는 한 번만 호출한다', async () => {
        // Arrange
        prisma.outboxEvent.groupBy.mockResolvedValue([
          createGroupByRow(OutboxStatus.Pending, PENDING_COUNT),
          createGroupByRow(OutboxStatus.Failed, FAILED_COUNT),
        ]);

        // Act: registry.metrics()는 두 Gauge의 collect 콜백을 병렬로 호출한다
        // (Registry.metrics() 내부 Promise.all). 여기서 두 값이 "같은 조회
        // 결과"로 동시에 노출되는지가 회귀 포인트다 — collector가 진행 중인
        // 조회를 공유하지 않으면 한쪽은 직전 scrape 값을 스냅샷해버린다.
        const text = await registry.metrics();

        // Assert
        expect(text).toContain(`outbox_events_pending ${PENDING_COUNT}`);
        expect(text).toContain(`outbox_events_failed ${FAILED_COUNT}`);
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
      it('registry.metrics()는 정상 resolve되고 두 Gauge 샘플 값이 생략된다', async () => {
        // Arrange: 실패 케이스 이전에 성공 스크레이프로 7/2 값을 먼저 채워둔다.
        // 실패 후 "이전 성공값이 그대로 노출되는" 회귀와 "0으로 남는"(정상
        // 0건과 조회 실패를 혼동시키는) 회귀를 모두 잡기 위함이다.
        prisma.outboxEvent.groupBy.mockResolvedValueOnce([
          createGroupByRow(OutboxStatus.Pending, PENDING_COUNT),
          createGroupByRow(OutboxStatus.Failed, FAILED_COUNT),
        ]);
        await registry.metrics();
        prisma.outboxEvent.groupBy.mockRejectedValueOnce(new Error('DB down'));

        // Act
        const text = await registry.metrics();

        // Assert: reject를 삼켜 scrape 자체는 실패하지 않는다. HELP/TYPE
        // 주석 라인은 남아 있어도 되지만, 값 라인(숫자로 끝나는 라인)은 두
        // 메트릭 모두 없어야 한다 — "0"도 값이므로 허용하지 않는다.
        expect(text).not.toMatch(/^outbox_events_pending \d/m);
        expect(text).not.toMatch(/^outbox_events_failed \d/m);
        expect(text).toContain('# HELP outbox_events_pending');
        expect(text).toContain('# HELP outbox_events_failed');
      });
    });

    describe('groupBy가 타임아웃(1,000ms 초과)되면', () => {
      it('조회를 포기하고 샘플을 생략하며 타이머를 해제한다', async () => {
        // Arrange: 절대 응답하지 않는 groupBy로 순수 타임아웃 경로만 태운다.
        jest.useFakeTimers();
        prisma.outboxEvent.groupBy.mockReturnValue(new Promise(() => {}));

        // Act: registry.metrics()를 시작해두고 타임아웃 시점까지 시계를
        // 진행시킨다. advanceTimersByTimeAsync는 진행 중 마이크로태스크까지
        // 함께 흘려보내 Promise.race의 reject를 실제로 처리한다.
        const metricsPromise = registry.metrics();
        await jest.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS);
        const text = await metricsPromise;

        // Assert: 샘플이 생략되고, setTimeout 핸들이 clearTimeout으로
        // 해제되어 남은 타이머가 없다(M13 그레이스풀 셧다운이 걸리지 않음).
        expect(text).not.toMatch(/^outbox_events_pending \d/m);
        expect(text).not.toMatch(/^outbox_events_failed \d/m);
        expect(jest.getTimerCount()).toBe(0);
      });
    });
  });
});
