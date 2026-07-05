import { Controller } from '@nestjs/common';
import {
  EventPattern,
  Payload,
  Ctx,
  KafkaContext,
} from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import { HandleEventUseCase } from '../application/handle-event.use-case';
import {
  continueTraceFromHeaders,
  kafkaTraceHeaders,
  SPAN_OP_QUEUE_PROCESS,
  SpanOptions,
} from '../../common/tracing/trace-propagation';

// 두 핸들러가 공유하는 span 정의(반복 리터럴 단일화).
const NOTIFICATION_SPAN: SpanOptions = {
  name: 'notification.handle',
  op: SPAN_OP_QUEUE_PROCESS,
};

// notification-worker: chat-events·board-events를 독립 그룹으로 구독해 알림을 생성한다.
@Controller()
export class NotificationWorkerController {
  constructor(private readonly handle: HandleEventUseCase) {}

  @EventPattern(KafkaTopic.ChatEvents)
  async onChatEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      NOTIFICATION_SPAN,
      () => this.handle.execute(event),
    );
  }

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      NOTIFICATION_SPAN,
      () => this.handle.execute(event),
    );
  }
}
