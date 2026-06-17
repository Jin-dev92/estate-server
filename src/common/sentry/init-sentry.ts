import * as Sentry from '@sentry/nestjs';
import { scrubEvent } from './sentry-scrub';
import { decideTraceSample } from './traces-sampler';

export interface SentryInitOptions {
  dsn: string;
  environment: string;
  tracesSampleRate: number;
}

// Sentry 초기화를 한 곳에 캡슐화. main·워커가 부트스트랩 맨 앞에서 호출한다.
// dsn이 비면 init을 건너뛴다(no-op) → 외부 전송 없음. 활성 여부를 boolean으로 돌려준다.
export function initSentry(opts: SentryInitOptions): boolean {
  if (!opts.dsn) return false;
  Sentry.init({
    dsn: opts.dsn,
    environment: opts.environment,
    sendDefaultPii: false, // 헤더·쿠키·IP 자동 첨부 안 함
    tracesSampler: (ctx) => decideTraceSample(ctx.name, opts.tracesSampleRate),
    beforeSend: (event) => scrubEvent(event),
  });
  return true;
}
