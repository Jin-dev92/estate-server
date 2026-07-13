/**
 * 환경설정(env) 키 중앙 정의.
 *
 * ConfigService 호출 시 문자열을 하드코딩하지 말고 이 enum을 참조한다.
 * (예: `config.getOrThrow(ConfigKey.JwtSecret)`)
 * 키 오타를 컴파일 타임에 잡고, env 키 목록을 한곳에서 관리하기 위함이다.
 */
export const enum ConfigKey {
  DatabaseUrl = 'DATABASE_URL',
  JwtSecret = 'JWT_SECRET',
  JwtExpiresIn = 'JWT_EXPIRES_IN',
  RedisUrl = 'REDIS_URL',
  KafkaBrokers = 'KAFKA_BROKERS',
  RateLimitWindowSec = 'RATE_LIMIT_WINDOW_SEC',
  RateLimitUserMax = 'RATE_LIMIT_USER_MAX',
  RateLimitIpMax = 'RATE_LIMIT_IP_MAX',
  OutboxPollMs = 'OUTBOX_POLL_MS',
  OutboxBatchSize = 'OUTBOX_BATCH_SIZE',
  OutboxMaxAttempts = 'OUTBOX_MAX_ATTEMPTS',
  OutboxBackoffBaseMs = 'OUTBOX_BACKOFF_BASE_MS',
  OutboxBackoffCapMs = 'OUTBOX_BACKOFF_CAP_MS',
  KakaoClientId = 'KAKAO_CLIENT_ID',
  KakaoClientSecret = 'KAKAO_CLIENT_SECRET',
  SentryDsn = 'SENTRY_DSN',
  SentryEnvironment = 'SENTRY_ENVIRONMENT',
  SentryTracesSampleRate = 'SENTRY_TRACES_SAMPLE_RATE',
  Sentry4xxSampleRate = 'SENTRY_4XX_SAMPLE_RATE',
  KakaoTimeoutMs = 'KAKAO_TIMEOUT_MS',
  KakaoRetryMaxAttempts = 'KAKAO_RETRY_MAX_ATTEMPTS',
  KakaoBreakerThreshold = 'KAKAO_BREAKER_THRESHOLD',
  KakaoBreakerHalfOpenMs = 'KAKAO_BREAKER_HALF_OPEN_MS',
  KakaoBulkheadConcurrent = 'KAKAO_BULKHEAD_CONCURRENT',
  KakaoBulkheadQueue = 'KAKAO_BULKHEAD_QUEUE',
  KakaoTotalTimeoutMs = 'KAKAO_TOTAL_TIMEOUT_MS',
  ShutdownTimeoutMs = 'SHUTDOWN_TIMEOUT_MS',
}
