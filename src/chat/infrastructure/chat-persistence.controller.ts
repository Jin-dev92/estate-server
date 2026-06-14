import { Controller, Inject } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import { ChatMessagePayload } from '../domain/chat-message';
import {
  MESSAGE_REPOSITORY,
  MessageRepository,
} from '../domain/message.repository';

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
  ): Promise<void> {
    await this.messages.persist(event.payload);
  }
}
