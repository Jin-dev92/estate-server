import { Inject, Injectable, Logger } from '@nestjs/common';
import { EVENT_PUBLISHER, EventPublisher } from '../../events/event-publisher';
import { OUTBOX_STORE, OutboxStore } from '../domain/outbox-store';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../domain/transaction-runner';
import { OUTBOX_BATCH_SIZE } from './outbox.tokens';

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
          await this.publisher.publish(row.payload);
          await this.outbox.markPublished(row.id, tx);
        } catch (err) {
          // emit 실패: status 유지(attempts++) → 다음 폴링 재시도. 한 행 실패가 배치를 막지 않음.
          this.logger.warn(
            `outbox 발행 실패(재시도 예정): ${row.eventId} ${(err as Error).message}`,
          );
          await this.outbox.markFailed(row.id, tx);
        }
      }
    });
  }
}
