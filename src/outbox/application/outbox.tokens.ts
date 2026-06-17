// DI로 주입하는 폴링 배치 크기 토큰(모듈에서 ConfigService로 값을 제공).
export const OUTBOX_BATCH_SIZE = Symbol('OUTBOX_BATCH_SIZE');

// DLQ·백오프 정책 파라미터(모듈에서 ConfigService로 값을 제공).
export const OUTBOX_MAX_ATTEMPTS = Symbol('OUTBOX_MAX_ATTEMPTS'); // 초과 시 FAILED 격리
export const OUTBOX_BACKOFF_BASE_MS = Symbol('OUTBOX_BACKOFF_BASE_MS'); // 지수 백오프 기준
export const OUTBOX_BACKOFF_CAP_MS = Symbol('OUTBOX_BACKOFF_CAP_MS'); // 백오프 상한
