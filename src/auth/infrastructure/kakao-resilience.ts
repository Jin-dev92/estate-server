import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleWhen,
  IPolicy,
  retry,
  TaskCancelledError,
  timeout,
  TimeoutStrategy,
  wrap,
} from 'cockatiel';
import { ConfigKey } from '../../config/config-keys';
import { KakaoApiError } from './kakao-api.error';

// 실측 전 잠정값(스펙 §7 — 카카오 트래픽 실측 후 k6로 튜닝). env 미설정 시 사용.
const DEFAULTS = {
  timeoutMs: 3000,
  retryMaxAttempts: 3,
  breakerThreshold: 5,
  breakerHalfOpenMs: 10_000,
  bulkheadConcurrent: 10,
  bulkheadQueue: 20,
} as const;

// 일시적(카카오 측) 오류만 재시도·브레이커 집계 대상(handleAll 금지 — 위키 팀룰).
// - TaskCancelledError: 시도당 타임아웃(최내곽 timeout 정책)
// - TypeError: fetch 네트워크 오류(연결 거부·DNS 등)
// - KakaoApiError.transient: 429·5xx (4xx는 사용자·계약 오류라 제외)
// BrokenCircuitError는 의도적으로 제외 — 회로 open 시 남은 재시도가 즉시 중단된다.
const transientOnly = handleWhen(
  (err) =>
    err instanceof TaskCancelledError ||
    err instanceof TypeError ||
    (err instanceof KakaoApiError && err.transient),
);

// 카카오 의존성 전용 정책 세트(앱 수명당 1회 생성 — 매 호출 생성 시 브레이커가
// 실패 카운트를 누적하지 못해 무력화된다). 다른 의존성과 인스턴스 공유 금지.
@Injectable()
export class KakaoResilience {
  private readonly logger = new Logger(KakaoResilience.name);

  // 토큰 교환 POST: 비멱등(인가코드 1회용) → 재시도 없음.
  readonly tokenPolicy: IPolicy;
  // 프로필 GET: 멱등 → 재시도 포함.
  readonly profilePolicy: IPolicy;

  constructor(config: ConfigService) {
    // env는 문자열로 오므로 숫자 변환. 미설정 시 코드 기본값.
    const num = (key: ConfigKey, fallback: number): number => {
      const raw = config.get<string>(key);
      return raw != null ? Number(raw) : fallback;
    };

    // 시도당 타임아웃. Aggressive = 콜백 완료를 기다리지 않고 즉시 거절 + AbortSignal 전파.
    const timeoutPolicy = timeout(
      num(ConfigKey.KakaoTimeoutMs, DEFAULTS.timeoutMs),
      TimeoutStrategy.Aggressive,
    );

    // 동시 실행 격리(세마포어) — 느린 카카오가 이벤트 루프 태스크를 잠식하지 못하게.
    const bulkheadPolicy = bulkhead(
      num(ConfigKey.KakaoBulkheadConcurrent, DEFAULTS.bulkheadConcurrent),
      num(ConfigKey.KakaoBulkheadQueue, DEFAULTS.bulkheadQueue),
    );

    // 연속 실패 임계 초과 시 open → 즉시 거절, half-open으로 복구 탐침.
    const breaker = circuitBreaker(transientOnly, {
      halfOpenAfter: num(
        ConfigKey.KakaoBreakerHalfOpenMs,
        DEFAULTS.breakerHalfOpenMs,
      ),
      breaker: new ConsecutiveBreaker(
        num(ConfigKey.KakaoBreakerThreshold, DEFAULTS.breakerThreshold),
      ),
    });
    // 조용히 실패하는 서킷 금지(위키) — 상태 변화 로깅, open은 Sentry로 알린다.
    breaker.onBreak(() => {
      this.logger.warn('카카오 circuit OPEN — 호출 차단 시작');
      Sentry.captureMessage('kakao circuit OPEN', 'warning');
    });
    breaker.onHalfOpen(() =>
      this.logger.log('카카오 circuit HALF-OPEN — 복구 탐침'),
    );
    breaker.onReset(() => this.logger.log('카카오 circuit CLOSED — 복구'));

    // 지수 백오프 + jitter(cockatiel 기본이 decorrelated jitter). 고정 간격 금지.
    const retryPolicy = retry(transientOnly, {
      maxAttempts: num(
        ConfigKey.KakaoRetryMaxAttempts,
        DEFAULTS.retryMaxAttempts,
      ),
      backoff: new ExponentialBackoff(),
    });

    // wrap은 첫 인자가 최외곽(위키 필수 순서: Retry → CB → Bulkhead → Timeout).
    // retry가 breaker 바깥이라 각 재시도가 브레이커에 개별 집계되고,
    // 도중 open되면 남은 재시도가 즉시 차단된다. 순서 임의 변경 금지.
    this.tokenPolicy = wrap(breaker, bulkheadPolicy, timeoutPolicy);
    this.profilePolicy = wrap(
      retryPolicy,
      breaker,
      bulkheadPolicy,
      timeoutPolicy,
    );
  }
}
