// 일부 4xx를 낮은 샘플로만 Sentry에 보낼지 정하는 순수 함수.
// 대상은 "우리 DTO/도메인 계약 위반"(타입 있는 FE라면 안 나야 할 것) → FE/계약 버그 신호.
// 사용자발 4xx(만료 토큰 401·오타 URL 404 등)는 노이즈라 제외한다.
const CAPTURE_ELIGIBLE_4XX = ['VALIDATION_FAILED', 'COMMON_VALIDATION_FAILED'];

export function shouldCapture4xx(
  code: string,
  sampleRate: number,
  rng: () => number = Math.random,
): boolean {
  if (sampleRate <= 0) return false;
  if (!CAPTURE_ELIGIBLE_4XX.includes(code)) return false;
  return rng() < sampleRate;
}
