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
          groupId === ConsumerGroup.Persistence &&
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
          `kafka_consumer_lag{group="${ConsumerGroup.Persistence}",topic="${KafkaTopic.ChatEvents}",partition="${CHAT_PARTITION}"} ${PERSISTENCE_CHAT_LAG}`,
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
  });
});
