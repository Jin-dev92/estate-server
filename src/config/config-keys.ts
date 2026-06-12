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
}
