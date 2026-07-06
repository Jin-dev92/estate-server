import { Inject, Injectable, Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { OUTBOX_STORE, OutboxStore } from '../domain/outbox-store';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../domain/transaction-runner';
import { OUTBOX_BATCH_SIZE } from './outbox.tokens';
import {
  continueTraceFromHeaders,
  SPAN_OP_QUEUE_PUBLISH,
} from '../../common/tracing/trace-propagation';

// 폴링 1틱: 한 트랜잭션 안에서 PENDING을 잠그고(SKIP LOCKED) emit → 마킹.
// 트랜잭션으로 감싸야 잠금이 유지돼 멀티 relay가 같은 행을 중복 발행하지 않는다.
@Injectable()
export class RelayOutboxUseCase {
  private readonly logger = new Logger(RelayOutboxUseCase.name);

  constructor(
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
    @Inject(OUTBOX_STORE) private readonly outbox: OutboxStore,
    @Inject(EVENT_PUBLISHER) private readonly publisher: EventPublisher,
    @Inject(OUTBOX_BATCH_SIZE) private readonly batchSize: number,
  ) {}

  async execute(): Promise<void> {
    await this.txRunner.run(async (tx) => {
      const rows = await this.outbox.fetchPending(this.batchSize, tx);
      for (const row of rows) {
        try {
          await continueTraceFromHeaders(
            row.traceContext ?? {},
            { name: 'outbox.publish', op: SPAN_OP_QUEUE_PUBLISH },
            () => this.publisher.publishOrThrow(row.payload),
          );
          await this.outbox.markPublished(row.id, tx);
        } catch (err) {
          // emit 실패: store가 백오프 재스케줄 vs FAILED 격리를 결정한다.
          // 한 행 실패가 배치를 막지 않도록 per-row로 처리한다.
          const message = (err as Error).message;
          const { quarantined } = await this.outbox.markFailed(
            row.id,
            row.attempts,
            message,
            tx,
          );
          if (quarantined) {
            // poison message: 더는 재시도하지 않고 DLQ(FAILED)로 격리됨.
            this.logger.error(
              `outbox 발행 영구 실패(FAILED 격리): ${row.eventId} attempts=${row.attempts + 1} ${message}`,
            );
            // poison(영구 실패)을 운영 가시화 — M9 ERROR 로그의 Sentry판.
            // 일시 실패(else, 재시도 예정)는 노이즈라 보내지 않는다.
            Sentry.captureException(err, (scope) => {
              scope.setTag('eventId', row.eventId);
              scope.setTag('eventType', row.eventType);
              scope.setTag('attempts', String(row.attempts + 1));
              return scope;
            });
          } else {
            this.logger.warn(
              `outbox 발행 실패(백오프 후 재시도): ${row.eventId} ${message}`,
            );
          }
        }
      }
    });
  }
}
