// Sentry beforeSend 훅에서 민감정보를 제거하는 순수 함수.
// sendDefaultPii:false로 헤더 자동 첨부는 막지만, 혹시 실린 민감 헤더를 한 번 더 막는다.
const SENSITIVE_HEADERS = ['authorization', 'cookie'];

// Sentry ErrorEvent를 그대로 받도록, request.headers만 보는 최소 제약으로 둔다
// (인덱스 시그니처를 넣으면 ErrorEvent가 제약을 못 만족해 타입이 깨진다).
interface ScrubbableEvent {
  request?: { headers?: Record<string, unknown> };
}

export function scrubEvent<T extends ScrubbableEvent>(event: T): T {
  const headers = event.request?.headers;
  if (headers) {
    for (const key of Object.keys(headers)) {
      if (SENSITIVE_HEADERS.includes(key.toLowerCase())) {
        headers[key] = '***';
      }
    }
  }
  return event;
}
