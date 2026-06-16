// rate limit 전역 상수. 매직스트링/매직넘버 금지 — 데코레이터·가드·스토어가 단일 출처로 참조.

// SetMetadata 키
export const RATE_LIMIT_OPTIONS = 'rate_limit:options';
export const RATE_LIMIT_SKIP = 'rate_limit:skip';

// 라우트별 한도 오버라이드 옵션
export interface RateLimitOptions {
  userMax?: number;
  ipMax?: number;
  windowSec?: number;
}

// 기본 한도(설계 §5). 환경변수가 없을 때의 폴백.
export const DEFAULT_WINDOW_SEC = 60;
export const DEFAULT_USER_MAX = 60;
export const DEFAULT_IP_MAX = 120;

// 기본 적용 대상(쓰기 메서드). GET 등 읽기는 기본 제외.
export const WRITE_METHODS: readonly string[] = [
  'POST',
  'PATCH',
  'PUT',
  'DELETE',
];

// 고정 윈도우: INCR 후 윈도우 최초(c==1)에만 EXPIRE를 건다.
// INCR·EXPIRE를 한 스크립트로 묶어 "INCR 후 EXPIRE 직전 크래시 → TTL 없는 영구 키" race를 막는다.
export const FIXED_WINDOW_LUA = `
local c = redis.call('INCR', KEYS[1])
if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
return c
`;

// 키: ratelimit:{scope}:{id}:{windowStart}
export function rateLimitKey(
  scope: 'user' | 'ip',
  id: string,
  windowStart: number,
): string {
  return `ratelimit:${scope}:${id}:${windowStart}`;
}
