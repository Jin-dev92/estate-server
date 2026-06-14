import { KafkaTopic } from './event-type.enum';

// 단일 노드 브로커(KRaft)라 복제계수는 1만 가능하다.
const SINGLE_NODE_REPLICATION = 1;

// 파티션 수. 1보다 크게 두어야 파티션 키(entityId)에 의한
// 분산·순서 보장(같은 엔티티 = 같은 파티션)을 실제로 연습할 수 있다.
const DEFAULT_PARTITIONS = 3;

export interface KafkaTopicSpec {
  topic: KafkaTopic;
  numPartitions: number;
  replicationFactor: number;
}

// 앱이 소유하는 토픽 계약의 단일 출처(B 방식 — 부팅 시 명시 생성).
// production을 모사해 브로커 auto-create는 끄고, 여기 선언된 토픽만 생성한다.
export const KAFKA_TOPIC_SPECS: readonly KafkaTopicSpec[] = [
  {
    topic: KafkaTopic.BoardEvents,
    numPartitions: DEFAULT_PARTITIONS,
    replicationFactor: SINGLE_NODE_REPLICATION,
  },
  {
    topic: KafkaTopic.MembershipEvents,
    numPartitions: DEFAULT_PARTITIONS,
    replicationFactor: SINGLE_NODE_REPLICATION,
  },
  {
    topic: KafkaTopic.ChatEvents,
    numPartitions: DEFAULT_PARTITIONS,
    replicationFactor: SINGLE_NODE_REPLICATION,
  },
];
