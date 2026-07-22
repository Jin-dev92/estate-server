import { Admin } from 'kafkajs';
import { Registry } from 'prom-client';
import { ConsumerGroup } from '../../events/consumer-groups';
import { KafkaTopic } from '../../events/event-type.enum';
import { KafkaLagCollector } from './kafka-lag.collector';

// Persistence 그룹 + ChatEvents 토픽 조합의 committed/latest offset 픽스처.
// 나머지 group/topic 조합은 committed 이력이 없는 것으로 취급한다.
const CHAT_PARTITION = 0;
const PERSISTENCE_CHAT_COMMITTED_OFFSET = 7;
const PERSISTENCE_CHAT_LATEST_OFFSET = 10;
const PERSISTENCE_CHAT_LAG = 3;

// collector의 KAFKA_LAG_QUERY_TIMEOUT_MS와 동일한 값. 소스 상수를 export하지
// 않으므로 타임아웃 경계 테스트용으로만 로컬에 미러링한다.
const QUERY_TIMEOUT_MS = 1000;
const NO_COMMITTED_OFFSET = '-1';

// NestJS ServerKafka가 groupId에 붙이는 postfix. 브로커에 실제 등록되는
// consumer group명은 'persistence-worker-server'이므로 collector도 이 이름으로
// 조회·라벨링해야 한다(collector 소스와 반드시 일치).
const NESTJS_SERVER_POSTFIX = '-server';
const PERSISTENCE_BROKER_GROUP = `${ConsumerGroup.Persistence}${NESTJS_SERVER_POSTFIX}`;

// kafkajs Admin은 거대 인터페이스라 collector가 실제로 쓰는 4개 메서드만
// mock한다. `satisfies`로 실제 시그니처(Partial<jest.Mocked<Admin>>)를
// 강제해 mock 메서드 이름·형태가 타입에서 벗어나지 않게 한다.
function createMockAdmin() {
  return {
    connect: jest.fn<
      ReturnType<Admin['connect']>,
      Parameters<Admin['connect']>
    >(),
    disconnect: jest.fn<
      ReturnType<Admin['disconnect']>,
      Parameters<Admin['disconnect']>
    >(),
    fetchOffsets: jest.fn<
      ReturnType<Admin['fetchOffsets']>,
      Parameters<Admin['fetchOffsets']>
    >(),
    fetchTopicOffsets: jest.fn<
      ReturnType<Admin['fetchTopicOffsets']>,
      Parameters<Admin['fetchTopicOffsets']>
    >(),
  } satisfies Partial<jest.Mocked<Admin>>;
}

// fetchOffsets({ groupId, topics }) 응답 픽스처.
// Persistence + ChatEvents 조합만 committed offset 7을 갖고, 나머지
// group/topic 조합은 committed 이력이 없는 것(빈 partitions 배열)으로 응답한다.
function stubFetchOffsets(admin: ReturnType<typeof createMockAdmin>) {
  admin.fetchOffsets.mockImplementation(({ groupId, topics }) =>
    Promise.resolve(
      (topics ?? []).map((topic) => {
        if (
          groupId === PERSISTENCE_BROKER_GROUP &&
          (topic as KafkaTopic) === KafkaTopic.ChatEvents
        ) {
          return {
            topic,
            partitions: [
              {
                partition: CHAT_PARTITION,
                offset: String(PERSISTENCE_CHAT_COMMITTED_OFFSET),
                metadata: null,
              },
            ],
          };
        }
        return { topic, partitions: [] };
      }),
    ),
  );
}

// fetchTopicOffsets(topic) 응답 픽스처. ChatEvents만 partition 0의 최신
// offset 10을 갖고, 나머지 토픽은 파티션이 없는 것으로 응답한다.
function stubFetchTopicOffsets(admin: ReturnType<typeof createMockAdmin>) {
  admin.fetchTopicOffsets.mockImplementation((topic) => {
    if ((topic as KafkaTopic) === KafkaTopic.ChatEvents) {
      return Promise.resolve([
        {
          partition: CHAT_PARTITION,
          offset: String(PERSISTENCE_CHAT_LATEST_OFFSET),
          high: String(PERSISTENCE_CHAT_LATEST_OFFSET),
          low: '0',
        },
      ]);
    }
    return Promise.resolve([]);
  });
}

// Persistence+ChatEvents 조합에 임의의 committed/latest offset을 심는 픽스처.
// -1(커밋 없음)·음수 차이 같은 경계값 검증에 재사용한다. 나머지 조합은 빈 응답.
function stubPersistenceChatOffsets(
  admin: ReturnType<typeof createMockAdmin>,
  committedOffset: string,
  latestOffset: number,
  lowOffset = 0,
) {
  admin.fetchOffsets.mockImplementation(({ groupId, topics }) =>
    Promise.resolve(
      (topics ?? []).map((topic) => {
        if (
          groupId === PERSISTENCE_BROKER_GROUP &&
          (topic as KafkaTopic) === KafkaTopic.ChatEvents
        ) {
          return {
            topic,
            partitions: [
              {
                partition: CHAT_PARTITION,
                offset: committedOffset,
                metadata: null,
              },
            ],
          };
        }
        return { topic, partitions: [] };
      }),
    ),
  );
  admin.fetchTopicOffsets.mockImplementation((topic) => {
    if ((topic as KafkaTopic) === KafkaTopic.ChatEvents) {
      return Promise.resolve([
        {
          partition: CHAT_PARTITION,
          offset: String(latestOffset),
          high: String(latestOffset),
          low: String(lowOffset),
        },
      ]);
    }
    return Promise.resolve([]);
  });
}

describe('KafkaLagCollector', () => {
  let registry: Registry;
  let admin: ReturnType<typeof createMockAdmin>;
  let collector: KafkaLagCollector;

  beforeEach(() => {
    registry = new Registry();
    admin = createMockAdmin();
    // collector 인스턴스는 registry에 Gauge를 등록하는 부수효과와 lifecycle
    // 훅 호출 검증에 쓴다. 메트릭 검증은 registry.metrics()로 한다.
    collector = new KafkaLagCollector(registry, admin as unknown as Admin);
  });

  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
    registry.clear();
  });

  describe('lifecycle', () => {
    it('onModuleInit은 admin.connect를 호출한다', async () => {
      // Arrange
      admin.connect.mockResolvedValue(undefined);

      // Act
      await collector.onModuleInit();

      // Assert
      expect(admin.connect).toHaveBeenCalledTimes(1);
    });

    it('onModuleDestroy는 admin.disconnect를 호출한다', async () => {
      // Arrange
      admin.disconnect.mockResolvedValue(undefined);

      // Act
      await collector.onModuleDestroy();

      // Assert
      expect(admin.disconnect).toHaveBeenCalledTimes(1);
    });
  });

  describe('scrape(registry.metrics()) 시', () => {
    describe('offset 조회가 정상 응답하면', () => {
      it('committed=7, latest=10인 partition의 lag을 3으로 노출한다', async () => {
        // Arrange
        stubFetchOffsets(admin);
        stubFetchTopicOffsets(admin);

        // Act
        const text = await registry.metrics();

        // Assert
        expect(text).toContain(
          `kafka_consumer_lag{group="${PERSISTENCE_BROKER_GROUP}",topic="${KafkaTopic.ChatEvents}",partition="${CHAT_PARTITION}"} ${PERSISTENCE_CHAT_LAG}`,
        );
        // 회귀 가드: NestJS ServerKafka가 groupId에 '-server'를 붙이므로, 실제
        // 브로커 group명으로 조회해야 한다. base명('persistence-worker')으로
        // 조회하면 존재하지 않는 group이라 committed가 없어 lag이 latest로
        // 잘못 나온다(라이브 실측으로 발견된 결함).
        expect(admin.fetchOffsets).toHaveBeenCalledWith(
          expect.objectContaining({ groupId: PERSISTENCE_BROKER_GROUP }),
        );
      });
    });

    describe('fetchOffsets가 실패(reject)하면', () => {
      it('registry.metrics()는 정상 resolve되고 lag 샘플이 생략된다', async () => {
        // Arrange: committed 조회 자체가 실패하는 경로만 태운다.
        admin.fetchOffsets.mockRejectedValue(new Error('broker down'));
        admin.fetchTopicOffsets.mockResolvedValue([]);

        // Act
        const text = await registry.metrics();

        // Assert: reject를 삼켜 scrape 자체는 실패하지 않는다. 값 라인(라벨
        // 뒤 숫자로 끝나는 라인)이 없어야 한다 — labeled Gauge는 reset()되면
        // 샘플 라인 자체가 사라진다.
        expect(text).not.toMatch(/^kafka_consumer_lag\{/m);
        expect(text).toContain('# HELP kafka_consumer_lag');
      });
    });

    describe('committed offset이 -1(커밋 이력 없음)이면', () => {
      it('lag을 latest offset 전체로 계산한다', async () => {
        // Arrange: committed=-1 이면 처리한 메시지가 없다는 의미이므로 lag은
        // latest offset 전체가 된다.
        const latestOffset = 5;
        stubPersistenceChatOffsets(admin, NO_COMMITTED_OFFSET, latestOffset);

        // Act
        const text = await registry.metrics();

        // Assert
        expect(text).toContain(
          `kafka_consumer_lag{group="${PERSISTENCE_BROKER_GROUP}",topic="${KafkaTopic.ChatEvents}",partition="${CHAT_PARTITION}"} ${latestOffset}`,
        );
      });
    });

    describe('committed가 없고 retention으로 low가 0보다 크면', () => {
      it('lag을 latest 전체가 아니라 high-low(소비 가능 backlog)로 계산한다', async () => {
        // Arrange: low 아래 메시지는 retention으로 삭제돼 소비 불가하므로,
        // 신규 그룹의 실제 backlog 상한은 high-low다(latest 전체가 아님).
        const latestOffset = 100050;
        const lowOffset = 100000;
        const expectedLag = latestOffset - lowOffset;
        stubPersistenceChatOffsets(
          admin,
          NO_COMMITTED_OFFSET,
          latestOffset,
          lowOffset,
        );

        // Act
        const text = await registry.metrics();

        // Assert
        expect(text).toContain(
          `kafka_consumer_lag{group="${PERSISTENCE_BROKER_GROUP}",topic="${KafkaTopic.ChatEvents}",partition="${CHAT_PARTITION}"} ${expectedLag}`,
        );
      });
    });

    describe('committed offset이 latest보다 크면', () => {
      it('lag을 음수가 아닌 0으로 하한 보정한다', async () => {
        // Arrange: 리밸런스/재설정 등으로 committed가 latest를 앞설 수 있는데,
        // 음수 lag은 무의미하므로 Math.max(0, ...)로 0에 고정한다.
        const committedOffset = 10;
        const latestOffset = 8;
        stubPersistenceChatOffsets(
          admin,
          String(committedOffset),
          latestOffset,
        );

        // Act
        const text = await registry.metrics();

        // Assert
        expect(text).toContain(
          `kafka_consumer_lag{group="${PERSISTENCE_BROKER_GROUP}",topic="${KafkaTopic.ChatEvents}",partition="${CHAT_PARTITION}"} 0`,
        );
      });
    });

    describe('offset 조회가 1,000ms를 초과하면', () => {
      it('조회를 포기하고 lag 샘플을 생략하며 타이머를 해제한다', async () => {
        // Arrange: fetchOffsets가 영원히 resolve되지 않게 해 타임아웃 경로를
        // 태운다. fake timer로 1,000ms를 인위적으로 흘려보낸다.
        jest.useFakeTimers();
        admin.fetchOffsets.mockReturnValue(new Promise(() => {}));
        admin.fetchTopicOffsets.mockResolvedValue([]);

        // Act: registry.metrics()가 collect()를 트리거하지만, 타이머를 진행시켜
        // Promise.race의 timeout 쪽이 이기기 전에는 resolve되지 않는다.
        const metricsPromise = registry.metrics();
        await jest.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS);
        const text = await metricsPromise;

        // Assert: 값 라인이 없어야 하고(생략), finally의 clearTimeout으로
        // 남은 타이머가 0이어야 한다(M13 셧다운 방해 방지).
        expect(text).not.toMatch(/^kafka_consumer_lag\{/m);
        expect(jest.getTimerCount()).toBe(0);
      });
    });
  });
});
