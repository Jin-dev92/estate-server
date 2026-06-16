import { DomainEvent } from '../../events/domain-event';

// outbox 행의 도메인 표현(relay가 다루는 형태).
export interface OutboxRecord {
  id: string;
  eventId: string;
  eventType: string;
  topic: string;
  partitionKey: string;
  payload: DomainEvent;
  attempts: number;
}
