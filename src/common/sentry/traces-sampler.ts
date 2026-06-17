// 트랜잭션 이름(예: "GET /docs")으로 성능 샘플링 비율을 정하는 순수 함수.
// 비즈니스 외 경로(문서 등)는 0으로 두어 노이즈·비용을 줄인다.
// (헬스체크 등이 생기면 EXCLUDED에 추가. CORS preflight는 미사용이라 제외 안 함.)
const EXCLUDED_PATHS = ['/docs']; // '/docs-json'도 includes('/docs')로 함께 잡힌다

export function decideTraceSample(
  name: string | undefined,
  defaultRate: number,
): number {
  if (name && EXCLUDED_PATHS.some((p) => name.includes(p))) {
    return 0;
  }
  return defaultRate;
}
