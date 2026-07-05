import { Controller, Inject } from '@nestjs/common';
import {
  EventPattern,
  Payload,
  Ctx,
  KafkaContext,
} from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import { ChatMessagePayload } from '../domain/chat-message';
import {
  MESSAGE_REPOSITORY,
  MessageRepository,
} from '../domain/message.repository';
import {
  continueTraceFromHeaders,
  kafkaTraceHeaders,
  SPAN_OP_QUEUE_PROCESS,
} from '../../common/tracing/trace-propagation';

// persistence-worker: chat-events를 구독해 Message를 비동기 멱등 INSERT한다.
// audit-worker(M3)와 같은 패턴, consumer group만 'persistence-worker'.
@Controller()
export class ChatPersistenceController {
  constructor(
    @Inject(MESSAGE_REPOSITORY) private readonly messages: MessageRepository,
  ) {}

  @EventPattern(KafkaTopic.ChatEvents)
  async onMessageSent(
    @Payload() event: DomainEvent<ChatMessagePayload>,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      { name: 'chat.persist', op: SPAN_OP_QUEUE_PROCESS },
      () => this.messages.persist(event.payload),
    );
  }
}
