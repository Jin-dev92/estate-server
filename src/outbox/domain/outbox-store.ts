import { DomainEvent } from '../../events/domain-event';
import { OutboxRecord } from './outbox-record';
import { TransactionClient } from './transaction-runner';

export const OUTBOX_STORE = Symbol('OUTBOX_STORE');

export interface OutboxStore {
  // 도메인 변경과 같은 트랜잭션(tx)으로 outbox 행을 INSERT한다(PENDING).
  add(event: DomainEvent, tx: TransactionClient): Promise<void>;
  // PENDING 행을 createdAt 순으로 limit개 잠그며 가져온다(FOR UPDATE SKIP LOCKED).
  fetchPending(limit: number, tx: TransactionClient): Promise<OutboxRecord[]>;
  // 발행 성공: PUBLISHED + publishedAt.
  markPublished(id: string, tx: TransactionClient): Promise<void>;
  // 발행 실패: attempts += 1 (status는 PENDING 유지 → 다음 폴링 재시도).
  markFailed(id: string, tx: TransactionClient): Promise<void>;
}
