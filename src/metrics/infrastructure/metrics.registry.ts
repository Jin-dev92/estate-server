import { Registry, collectDefaultMetrics } from 'prom-client';

// DI 토큰. Symbol을 사용해 문자열 토큰 충돌을 피하고, 다른 모듈에서도
// 동일한 Registry 인스턴스를 주입받을 수 있게 한다.
export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
const DEFAULT_METRIC_PREFIX = 'estate_';

// GET /metrics 라우트 경로. 컨트롤러(@Controller)와 테스트(supertest 요청 경로)가
// 같은 상수를 참조해 매직 스트링 중복·오타를 막는다.
export const METRICS_PATH = 'metrics';

// 앱 전체가 공유하는 단일 prom-client Registry를 생성한다.
// collectDefaultMetrics로 프로세스/이벤트루프 등 기본 메트릭을 자동 수집한다.
export function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: DEFAULT_METRIC_PREFIX });
  return registry;
}
