import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Admin } from 'kafkajs';
import { Gauge, Registry } from 'prom-client';
import { ConsumerGroup, ConsumerGroupId } from '../../events/consumer-groups';
import { KafkaTopic } from '../../events/event-type.enum';
import { METRICS_REGISTRY } from './metrics.registry';

// DI 토큰. MetricsModule에서 kafkajs Admin 인스턴스를 주입하기 위한 unique symbol.
export const KAFKA_ADMIN = Symbol('KAFKA_ADMIN');

// 메트릭 이름·라벨. 매직 스트링 반복을 막기 위해 상수로 추출한다.
const KAFKA_CONSUMER_LAG_METRIC = 'kafka_consumer_lag';
const KAFKA_LAG_LABEL_NAMES = ['group', 'topic', 'partition'] as const;

// consumer group별 구독 토픽 매핑의 단일 출처(M14 고정값).
const TOPICS_BY_GROUP: Readonly<
  Record<ConsumerGroupId, readonly KafkaTopic[]>
> = {
  [ConsumerGroup.Persistence]: [KafkaTopic.ChatEvents],
  [ConsumerGroup.Audit]: [
    KafkaTopic.ChatEvents,
    KafkaTopic.BoardEvents,
    KafkaTopic.MembershipEvents,
  ],
  [ConsumerGroup.Notification]: [KafkaTopic.ChatEvents, KafkaTopic.BoardEvents],
};

// 커밋 오프셋이 없음을 나타내는 kafkajs 관용 값('-1' 문자열).
const NO_COMMITTED_OFFSET = '-1';

// NestJS 마이크로서비스 Kafka 서버(ServerKafka)는 설정한 groupId 뒤에 이
// postfix를 붙여 실제 브로커 consumer group을 만든다(기본값 '-server').
// 즉 워커가 groupId: 'persistence-worker'로 떠도 브로커에 등록되는 실제
// group은 'persistence-worker-server'다. Admin.fetchOffsets는 브로커의 실제
// group명으로 조회해야 하므로(존재하지 않는 base명으로 조회하면 committed가
// 없어 lag이 항상 latest로 잘못 나온다) ConsumerGroup 상수에 이 postfix를
// 붙여 쓴다. NestJS ServerKafka의 기본 postfixId와 반드시 일치해야 한다.
const NESTJS_KAFKA_SERVER_GROUP_POSTFIX = '-server';

// offset 조회 타임아웃(ms). scrape 경로가 브로커 응답 지연에 물리는 것을 막는
// 상한. 초과하면 조회를 포기하고 Gauge를 reset된 상태(샘플 없음)로 남긴다.
const KAFKA_LAG_QUERY_TIMEOUT_MS = 1000;

// collectLag이 계산해 반환하는 순수 결과 1건(파티션 단위 lag). Gauge 갱신은
// 이 배열을 받아 collect()에서만 수행한다 — 계산과 반영을 분리해, 타임아웃으로
// 진 collectLag이 뒤늦게 끝나도 Gauge를 오염시키지 못하게 한다.
interface LagSample {
  // 브로커에 실제 등록된 consumer group명(= ConsumerGroup 상수 + postfix).
  group: string;
  topic: KafkaTopic;
  partition: string;
  lag: number;
}

// Prometheus가 GET /metrics를 스크레이프하는 시점에만 committed offset(consumer
// group이 마지막으로 처리 완료한 위치)과 latest offset(토픽의 최신 위치)을
// 비교해 consumer lag을 계산하는 Collector. setInterval 등 별도 타이머를 두지
// 않는다 — M13 그레이스풀 셧다운에서 미해제 타이머가 프로세스 종료를 막지
// 않게 하기 위함이다.
@Injectable()
export class KafkaLagCollector implements OnModuleInit, OnModuleDestroy {
  private readonly lagGauge: Gauge<(typeof KAFKA_LAG_LABEL_NAMES)[number]>;

  constructor(
    @Inject(METRICS_REGISTRY) registry: Registry,
    @Inject(KAFKA_ADMIN) private readonly admin: Admin,
  ) {
    this.lagGauge = new Gauge({
      name: KAFKA_CONSUMER_LAG_METRIC,
      help: 'consumer group의 committed offset과 최신 offset 간 지연(scrape 시점 조회)',
      labelNames: KAFKA_LAG_LABEL_NAMES,
      registers: [registry],
      collect: () => this.collect(),
    });
  }

  async onModuleInit(): Promise<void> {
    await this.admin.connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.admin.disconnect();
  }

  async collect(): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('kafka lag query timed out'));
        }, KAFKA_LAG_QUERY_TIMEOUT_MS);
      });

      // collectLag은 Gauge를 만지지 않고 샘플만 계산해 반환한다. 그래야
      // 타임아웃으로 진 collectLag이 뒤늦게 완료돼도 이미 reset된 Gauge를
      // 다시 채우지 못한다. Gauge 갱신은 race에서 이긴 아래 경로에서만 한다.
      const samples = await Promise.race([this.collectLag(), timeout]);

      // reset+set은 await가 없는 동기 블록이라 한 번에 반영된다 — scrape가
      // 겹쳐도 파티션 일부만 갱신된 중간 상태가 노출되지 않는다.
      this.lagGauge.reset();
      for (const sample of samples) {
        this.lagGauge.set(
          {
            group: sample.group,
            topic: sample.topic,
            partition: sample.partition,
          },
          sample.lag,
        );
      }
    } catch {
      // 조회 실패/타임아웃 시 이전 scrape 값이 남아있으면 "직전 값"과 "조회
      // 실패"가 구분되지 않는다. labeled Gauge는 reset()하면 라벨 조합
      // 샘플이 전부 사라지므로(scrape 자체는 실패시키지 않음), 그대로
      // "이번 scrape는 샘플 없음"으로 노출된다.
      this.lagGauge.reset();
    } finally {
      // Promise.race에서 진 쪽 타이머가 남아있으면 M13 그레이스풀 셧다운을
      // 방해할 수 있으므로 성공/실패 무관하게 항상 해제한다.
      clearTimeout(timeoutHandle);
    }
  }

  // Gauge를 직접 만지지 않고 파티션별 lag 샘플만 계산해 반환한다(순수 계산).
  private async collectLag(): Promise<LagSample[]> {
    const samples: LagSample[] = [];

    // ponytail: 그룹 간 공유 토픽(예: ChatEvents)의 최신 offset을 그룹마다
    // 다시 조회한다 — 그룹·토픽 수가 적어 낭비가 크지 않다. 스크레이프
    // 빈도/그룹 수가 늘어 비용이 커지면 topic 단위 캐시로 최적화한다.
    for (const [group, topics] of Object.entries(TOPICS_BY_GROUP) as Array<
      [ConsumerGroupId, readonly KafkaTopic[]]
    >) {
      // 브로커에 실제 등록된 group명으로 조회·라벨링한다(NestJS postfix 반영).
      const brokerGroupId = `${group}${NESTJS_KAFKA_SERVER_GROUP_POSTFIX}`;
      const committedByTopic = await this.admin.fetchOffsets({
        groupId: brokerGroupId,
        topics: [...topics],
      });

      for (const topic of topics) {
        const committedPartitions =
          committedByTopic.find(
            (entry) => (entry.topic as KafkaTopic) === topic,
          )?.partitions ?? [];
        const latestPartitions = await this.admin.fetchTopicOffsets(topic);

        for (const latest of latestPartitions) {
          const committed = committedPartitions.find(
            (partition) => partition.partition === latest.partition,
          );
          const hasCommitted =
            committed !== undefined && committed.offset !== NO_COMMITTED_OFFSET;
          const latestOffset = Number(latest.offset);
          const lag = hasCommitted
            ? Math.max(0, latestOffset - Number(committed.offset))
            : latestOffset;

          samples.push({
            group: brokerGroupId,
            topic,
            partition: String(latest.partition),
            lag,
          });
        }
      }
    }

    return samples;
  }
}
