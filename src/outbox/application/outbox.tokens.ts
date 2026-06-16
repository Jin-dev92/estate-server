// DI로 주입하는 폴링 배치 크기 토큰(모듈에서 ConfigService로 값을 제공).
export const OUTBOX_BATCH_SIZE = Symbol('OUTBOX_BATCH_SIZE');
