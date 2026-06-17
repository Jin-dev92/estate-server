// outbox 행 상태. 매직스트링 금지 — store·relay가 단일 출처로 참조.
export const enum OutboxStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
  Failed = 'FAILED', // 최대 재시도 초과로 격리된 poison message(더는 폴링 안 함)
}
