import { Controller, Inject } from '@nestjs/common';
import {
  EventPattern,
  Payload,
  Ctx,
  KafkaContext,
} from '@nestjs/microservices';
import { KafkaTopic } from '../../events/event-type.enum';
import { DomainEvent } from '../../events/domain-event';
import {
  AUDIT_LOG_REPOSITORY,
  AuditLogRepository,
} from '../domain/audit-log.repository';
import {
  continueTraceFromHeaders,
  kafkaTraceHeaders,
  SPAN_OP_QUEUE_PROCESS,
  SpanOptions,
} from '../../common/tracing/trace-propagation';

// 세 핸들러가 공유하는 span 정의(반복 리터럴 단일화).
const AUDIT_SPAN: SpanOptions = {
  name: 'audit.handle',
  op: SPAN_OP_QUEUE_PROCESS,
};

// audit-worker: chat·board·membership 전체를 구독해 AuditLog로 적재한다(audit=전체).
// 부작용 없는 소비자. 독립 consumer group 'audit-worker'로 구동된다.
@Controller()
export class AuditWorkerController {
  constructor(
    @Inject(AUDIT_LOG_REPOSITORY)
    private readonly audit: AuditLogRepository,
  ) {}

  @EventPattern(KafkaTopic.ChatEvents)
  async onChatEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(kafkaTraceHeaders(ctx), AUDIT_SPAN, () =>
      this.audit.record(event),
    );
  }

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(kafkaTraceHeaders(ctx), AUDIT_SPAN, () =>
      this.audit.record(event),
    );
  }

  @EventPattern(KafkaTopic.MembershipEvents)
  async onMembershipEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(kafkaTraceHeaders(ctx), AUDIT_SPAN, () =>
      this.audit.record(event),
    );
  }
}
