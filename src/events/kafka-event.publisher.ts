import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { EventPublisher } from './event-publisher';
import { DomainEvent } from './domain-event';
import { EventType, KafkaTopic } from './event-type.enum';

// 이벤트 종류 → 토픽 매핑의 단일 출처.
const TOPIC_BY_EVENT: Record<EventType, KafkaTopic> = {
  [EventType.PostCreated]: KafkaTopic.BoardEvents,
  [EventType.CommentCreated]: KafkaTopic.BoardEvents,
  [EventType.TenantJoined]: KafkaTopic.MembershipEvents,
  [EventType.LeaseEnded]: KafkaTopic.MembershipEvents,
  [EventType.MessageSent]: KafkaTopic.ChatEvents,
};

export const KAFKA_CLIENT = 'KAFKA_CLIENT';

@Injectable()
export class KafkaEventPublisher implements EventPublisher, OnModuleInit {
  private readonly logger = new Logger(KafkaEventPublisher.name);

  constructor(@Inject(KAFKA_CLIENT) private readonly client: ClientKafka) {}

  async onModuleInit(): Promise<void> {
    // producer 전용 연결. (consumer는 hybrid app이 별도로 띄운다.)
    await this.client.connect();
  }

  async publish(event: DomainEvent): Promise<void> {
    const topic = TOPIC_BY_EVENT[event.eventType];
    try {
      // 파티션 키 = entityId → 같은 엔티티 이벤트의 순서 보장.
      await firstValueFrom(
        this.client.emit(topic, { key: event.entityId, value: event }),
      );
    } catch (err) {
      // after-commit 한계: DB는 이미 커밋됐으므로 발행 실패를 삼키고 로깅만 한다.
      // 유실 방지는 M6 Transactional Outbox에서 해결한다.
      this.logger.error(
        `이벤트 발행 실패: ${event.eventType} ${event.entityId}`,
        err as Error,
      );
    }
  }
}
