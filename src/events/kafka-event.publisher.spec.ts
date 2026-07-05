import { Logger } from '@nestjs/common';
import { of, throwError } from 'rxjs';
import { ClientKafka } from '@nestjs/microservices';
import { KafkaEventPublisher } from './kafka-event.publisher';
import { EventType, EntityType, KafkaTopic } from './event-type.enum';
import { DomainEvent } from './domain-event';

function eventOf(overrides: Partial<DomainEvent> = {}): DomainEvent {
  return {
    eventId: 'e1',
    eventType: EventType.PostCreated,
    occurredAt: '2026-06-14T00:00:00.000Z',
    actorId: 'u1',
    entityType: EntityType.Post,
    entityId: 'post1',
    payload: { foo: 'bar' },
    ...overrides,
  };
}

describe('KafkaEventPublisher', () => {
  let client: { emit: jest.Mock; connect: jest.Mock };
  let publisher: KafkaEventPublisher;

  beforeEach(() => {
    // ClientKafka는 큰 타입이라 emit/connect만 mock하고 as unknown as 로 주입한다(테스트 한정).
    client = {
      emit: jest.fn().mockReturnValue(of(undefined)),
      connect: jest.fn(),
    };
    publisher = new KafkaEventPublisher(client as unknown as ClientKafka);
  });

  afterEach(() => jest.clearAllMocks());

  it('PostCreated/CommentCreated는 board-events 토픽에 entityId 키로 발행한다', async () => {
    await publisher.publish(
      eventOf({ eventType: EventType.PostCreated, entityId: 'post1' }),
    );

    expect(client.emit).toHaveBeenCalledWith(
      KafkaTopic.BoardEvents,
      expect.objectContaining({
        key: 'post1',
        value: eventOf({
          eventType: EventType.PostCreated,
          entityId: 'post1',
        }),
        headers: expect.any(Object) as object,
      }),
    );
  });

  it('TenantJoined/LeaseEnded는 membership-events 토픽에 발행한다', async () => {
    await publisher.publish(
      eventOf({
        eventType: EventType.LeaseEnded,
        entityType: EntityType.Lease,
        entityId: 'lease1',
      }),
    );

    expect(client.emit).toHaveBeenCalledWith(
      KafkaTopic.MembershipEvents,
      expect.objectContaining({
        key: 'lease1',
        value: eventOf({
          eventType: EventType.LeaseEnded,
          entityType: EntityType.Lease,
          entityId: 'lease1',
        }),
        headers: expect.any(Object) as object,
      }),
    );
  });

  it('발행이 실패해도 throw하지 않는다(after-commit 한계, 로깅만)', async () => {
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    client.emit.mockReturnValue(throwError(() => new Error('broker down')));

    await expect(publisher.publish(eventOf())).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  describe('publishOrThrow — Outbox relay 전용 계약', () => {
    it('emit 성공 시 resolve한다', async () => {
      client.emit.mockReturnValue(of(undefined));

      await expect(
        publisher.publishOrThrow(eventOf()),
      ).resolves.toBeUndefined();
    });

    it('emit 실패 시 reject한다(relay가 markFailed로 분기하도록)', async () => {
      client.emit.mockReturnValue(throwError(() => new Error('broker down')));

      await expect(publisher.publishOrThrow(eventOf())).rejects.toThrow(
        'broker down',
      );
    });
  });

  it('emit 메시지에 trace 전파용 headers를 포함한다', async () => {
    // Sentry 미초기화라 headers는 {} 지만, 메시지에 headers 키 자체가 실려야 한다.
    const sampleEvent = eventOf();

    await publisher.publishOrThrow(sampleEvent);

    expect(client.emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        key: sampleEvent.entityId,
        value: sampleEvent,
        headers: expect.any(Object) as object,
      }),
    );
  });
});
