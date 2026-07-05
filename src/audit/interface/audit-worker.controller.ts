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
} from '../../common/tracing/trace-propagation';

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
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      { name: 'audit.handle', op: 'queue.process' },
      () => this.audit.record(event),
    );
  }

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      { name: 'audit.handle', op: 'queue.process' },
      () => this.audit.record(event),
    );
  }

  @EventPattern(KafkaTopic.MembershipEvents)
  async onMembershipEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      { name: 'audit.handle', op: 'queue.process' },
      () => this.audit.record(event),
    );
  }
}
