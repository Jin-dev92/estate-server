import * as Sentry from '@sentry/nestjs';
import { KafkaContext } from '@nestjs/microservices';

// Kafka 헤더로 실어 나를 trace 전파 헤더 키(Sentry 표준). W3C baggage와 호환.
export const SENTRY_TRACE_HEADER = 'sentry-trace';
export const BAGGAGE_HEADER = 'baggage';

// span op(종류) — 여러 워커·relay가 공유하는 값이라 상수로 단일화(매직 스트링 방지).
export const SPAN_OP_QUEUE_PROCESS = 'queue.process'; // 큐 메시지 소비(워커)
export const SPAN_OP_QUEUE_PUBLISH = 'queue.publish'; // 큐 메시지 발행(relay)

export interface SpanOptions {
  name: string; // span 표시 이름(예: 'outbox.publish')
  op: string; // span 종류(예: 'queue.publish')
}

// 현재 활성 trace를 전파용 헤더 맵으로 직렬화한다(inject).
// Sentry 비활성/실패 시 빈 맵 — 호출부는 그대로 Kafka 헤더에 펼치면 된다(비침습).
export function captureTraceHeaders(): Record<string, string> {
  try {
    const data = Sentry.getTraceData();
    const headers: Record<string, string> = {};
    const trace = data[SENTRY_TRACE_HEADER];
    const baggage = data[BAGGAGE_HEADER];
    if (trace) headers[SENTRY_TRACE_HEADER] = trace;
    if (baggage) headers[BAGGAGE_HEADER] = baggage;
    return headers;
  } catch {
    return {};
  }
}

// 헤더에서 trace를 복원(extract)해 fn을 그 trace의 자식 span으로 실행한다.
// 헤더 없음/실패 시 fn을 그대로 실행(새 trace로 폴백). 비침습.
//
// 제약: fn은 반드시 async(Promise 반환)여야 한다. catch 폴백은 "Sentry 셋업이
// 동기적으로 던진" 경우만 fn을 재시도하도록 의도된 것으로, async fn의 업무 실패는
// rejected Promise로 전파돼 이 동기 catch에 걸리지 않는다. 만약 동기 fn을 넘기면
// 업무 예외가 catch에 걸려 fn이 2회 실행(발행·기록 중복)될 수 있다.
export function continueTraceFromHeaders<T>(
  headers: Record<string, string | undefined>,
  span: SpanOptions,
  fn: () => T,
): T {
  try {
    const sentryTrace = headers[SENTRY_TRACE_HEADER];
    const baggage = headers[BAGGAGE_HEADER];
    if (!sentryTrace) return fn();
    return Sentry.continueTrace({ sentryTrace, baggage }, () =>
      Sentry.startSpan(span, () => fn()),
    );
  } catch {
    return fn();
  }
}

// Kafka 메시지 헤더(Buffer 값)에서 전파 헤더 2개를 문자열로 뽑는다.
export function kafkaTraceHeaders(ctx: KafkaContext): Record<string, string> {
  try {
    const raw = ctx.getMessage().headers ?? {};
    const out: Record<string, string> = {};
    for (const key of [SENTRY_TRACE_HEADER, BAGGAGE_HEADER]) {
      const v = raw[key];
      if (v != null) out[key] = v.toString();
    }
    return out;
  } catch {
    return {};
  }
}
