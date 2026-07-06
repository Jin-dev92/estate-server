import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ClientKafka } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { EventPublisher } from './event-publisher';
import { DomainEvent } from './domain-event';
import { topicForEvent } from './event-type.enum';
import { captureTraceHeaders } from '../common/tracing/trace-propagation';

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
    try {
      await this.emit(event);
    } catch (err) {
      // 직접 발행(after-commit)의 한계: 실패를 삼키고 로깅만. 유실 방지가 필요한 경로는 Outbox(publishOrThrow)를 쓴다.
      this.logger.error(
        `이벤트 발행 실패: ${event.eventType} ${event.entityId}`,
        err as Error,
      );
    }
  }

  // Outbox relay 전용: 발행 실패를 throw로 전파한다(relay가 markFailed→재시도하도록).
  publishOrThrow(event: DomainEvent): Promise<void> {
    return this.emit(event);
  }

  private emit(event: DomainEvent): Promise<void> {
    const topic = topicForEvent(event.eventType);
    // 파티션 키 = entityId → 같은 엔티티 이벤트의 순서 보장.
    // 현재 활성 trace를 Kafka 헤더로 전파(직접 발행 경로). Outbox 경로는 relay가
    // continueTrace로 컨텍스트를 되살린 뒤 이 메서드를 타므로, 여기 한 곳이면 충분하다.
    const headers = captureTraceHeaders();
    return firstValueFrom(
      this.client.emit(topic, { key: event.entityId, value: event, headers }),
    ).then(() => undefined);
  }
}
