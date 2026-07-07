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

// env 값(문자열)을 숫자로 파싱. 미설정·빈 문자열·비숫자("abc")는 모두 fallback으로 흘린다.
// 가드가 없으면 Number("abc")=NaN·Number("")=0 이 cockatiel 정책 생성자에 그대로 전달돼
// 타임아웃/임계가 조용히 오작동한다. "0" 같은 정상값(예: 벌크헤드 큐 0)은 그대로 보존한다.
export function parseEnvNumber(
  raw: string | undefined,
  fallback: number,
): number {
  if (raw == null || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

// 조립에 쓰는 회복탄력성 설정값 묶음. env(문자열)에서 파싱한 숫자들.
export interface ResilienceConfig {
  timeoutMs: number;
  retryMaxAttempts: number;
  breakerThreshold: number;
  breakerHalfOpenMs: number;
  bulkheadConcurrent: number;
  bulkheadQueue: number;
}

// 설정 검증. 두 종류로 나뉜다.
// (1) 명백히 잘못된 값(0 이하 등)은 기동 시 throw(fail-fast) — NaN/0이 cockatiel
//     정책 생성자에 흘러들어 타임아웃·임계가 조용히 오작동하는 것을 막는다.
// (2) breakerThreshold < retryMaxAttempts+1 은 "틀림"은 아니지만 위험한 조합이라
//     경고 메시지로 반환한다(호출부가 로깅). 재시도가 브레이커 바깥이라(§조합 순서)
//     프로필 실패 1건이 임계 카운트를 최대 (재시도+1)회 소모 → 임계가 그보다 작으면
//     로그인 1회 실패로 회로가 열려 토큰 교환까지 차단될 수 있다.
export function validateResilienceConfig(
  name: string,
  cfg: ResilienceConfig,
): string[] {
  const errors: string[] = [];
  const requireMin = (label: string, value: number, min: number): void => {
    if (!Number.isFinite(value) || value < min) {
      errors.push(`${label}=${value}(>= ${min} 이어야 함)`);
    }
  };
  requireMin('timeoutMs', cfg.timeoutMs, 1);
  requireMin('retryMaxAttempts', cfg.retryMaxAttempts, 0);
  requireMin('breakerThreshold', cfg.breakerThreshold, 1);
  requireMin('breakerHalfOpenMs', cfg.breakerHalfOpenMs, 1);
  requireMin('bulkheadConcurrent', cfg.bulkheadConcurrent, 1);
  requireMin('bulkheadQueue', cfg.bulkheadQueue, 0);
  if (errors.length > 0) {
    throw new Error(
      `[${name}] 회복탄력성 설정이 유효하지 않습니다: ${errors.join(', ')}`,
    );
  }

  const warnings: string[] = [];
  const multiplier = cfg.retryMaxAttempts + 1;
  if (cfg.breakerThreshold < multiplier) {
    warnings.push(
      `[${name}] breakerThreshold(${cfg.breakerThreshold}) < retryMaxAttempts+1(${multiplier}) — ` +
        `재시도가 브레이커 카운트를 배수로 소모해 로그인 1회 실패로 회로가 열릴 수 있습니다. ` +
        `breakerThreshold를 (재시도 횟수 + 1) 이상으로 두는 것을 권장합니다.`,
    );
  }
  return warnings;
}

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
    // env는 문자열로 오므로 숫자 변환. 미설정·빈 문자열·비숫자는 코드 기본값으로 폴백.
    const num = (key: ConfigKey, fallback: number): number =>
      parseEnvNumber(config.get<string>(key), fallback);

    const cfg: ResilienceConfig = {
      timeoutMs: num(ConfigKey.KakaoTimeoutMs, DEFAULTS.timeoutMs),
      retryMaxAttempts: num(
        ConfigKey.KakaoRetryMaxAttempts,
        DEFAULTS.retryMaxAttempts,
      ),
      breakerThreshold: num(
        ConfigKey.KakaoBreakerThreshold,
        DEFAULTS.breakerThreshold,
      ),
      breakerHalfOpenMs: num(
        ConfigKey.KakaoBreakerHalfOpenMs,
        DEFAULTS.breakerHalfOpenMs,
      ),
      bulkheadConcurrent: num(
        ConfigKey.KakaoBulkheadConcurrent,
        DEFAULTS.bulkheadConcurrent,
      ),
      bulkheadQueue: num(ConfigKey.KakaoBulkheadQueue, DEFAULTS.bulkheadQueue),
    };
    // 잘못된 값이면 throw(기동 fail-fast), 위험한 조합이면 경고 로깅.
    for (const warning of validateResilienceConfig('kakao', cfg)) {
      this.logger.warn(warning);
    }

    // 시도당 타임아웃. Aggressive = 콜백 완료를 기다리지 않고 즉시 거절 + AbortSignal 전파.
    const timeoutPolicy = timeout(cfg.timeoutMs, TimeoutStrategy.Aggressive);

    // 동시 실행 격리(세마포어) — 느린 카카오가 이벤트 루프 태스크를 잠식하지 못하게.
    const bulkheadPolicy = bulkhead(cfg.bulkheadConcurrent, cfg.bulkheadQueue);

    // 연속 실패 임계 초과 시 open → 즉시 거절, half-open으로 복구 탐침.
    const breaker = circuitBreaker(transientOnly, {
      halfOpenAfter: cfg.breakerHalfOpenMs,
      breaker: new ConsecutiveBreaker(cfg.breakerThreshold),
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
      maxAttempts: cfg.retryMaxAttempts,
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
