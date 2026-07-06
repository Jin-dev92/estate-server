import {
  captureTraceHeaders,
  continueTraceFromHeaders,
  kafkaTraceHeaders,
  SENTRY_TRACE_HEADER,
  BAGGAGE_HEADER,
} from './trace-propagation';
import { KafkaContext } from '@nestjs/microservices';

// 실제 Kafka 헤더는 Buffer 값으로 온다. getMessage().headers를 흉내내는 팩토리.
function fakeCtxWithHeaders(
  headers: Record<string, Buffer> | (() => never),
): KafkaContext {
  const getMessage =
    typeof headers === 'function'
      ? headers // 던지는 경우(catch 폴백 검증용)
      : () => ({ headers });
  return { getMessage } as unknown as KafkaContext;
}

describe('trace-propagation', () => {
  describe('captureTraceHeaders', () => {
    it('Sentry 미초기화 상태에서도 던지지 않고 객체를 반환한다', () => {
      const headers = captureTraceHeaders();

      expect(typeof headers).toBe('object');
      expect(headers).not.toBeNull();
    });
  });

  describe('continueTraceFromHeaders', () => {
    it('헤더가 있어도 fn을 실행하고 그 반환값을 돌려준다', () => {
      const span = { name: 'test', op: 'test' };
      const headers = { [SENTRY_TRACE_HEADER]: 'abc-123-1' };

      const result = continueTraceFromHeaders(headers, span, () => 42);

      expect(result).toBe(42);
    });

    it('헤더가 없으면 폴백으로 fn을 그대로 실행한다', () => {
      const span = { name: 'test', op: 'test' };

      const result = continueTraceFromHeaders({}, span, () => 'ok');

      expect(result).toBe('ok');
    });

    it('비동기 fn의 Promise를 그대로 전달한다', async () => {
      const span = { name: 'test', op: 'test' };

      const result = continueTraceFromHeaders({}, span, () =>
        Promise.resolve('async-ok'),
      );

      await expect(result).resolves.toBe('async-ok');
    });
  });

  describe('kafkaTraceHeaders', () => {
    it('Buffer 헤더 값을 문자열로 추출한다', () => {
      const ctx = fakeCtxWithHeaders({
        [SENTRY_TRACE_HEADER]: Buffer.from('abc-123-1'),
        [BAGGAGE_HEADER]: Buffer.from('env=prod'),
      });

      const headers = kafkaTraceHeaders(ctx);

      expect(headers).toEqual({
        [SENTRY_TRACE_HEADER]: 'abc-123-1',
        [BAGGAGE_HEADER]: 'env=prod',
      });
    });

    it('없는 전파 헤더 키는 결과에서 제외한다', () => {
      const ctx = fakeCtxWithHeaders({
        [SENTRY_TRACE_HEADER]: Buffer.from('abc-123-1'),
      });

      const headers = kafkaTraceHeaders(ctx);

      expect(headers).toEqual({ [SENTRY_TRACE_HEADER]: 'abc-123-1' });
    });

    it('getMessage가 던지면 빈 맵으로 폴백한다', () => {
      const ctx = fakeCtxWithHeaders(() => {
        throw new Error('no message');
      });

      const headers = kafkaTraceHeaders(ctx);

      expect(headers).toEqual({});
    });
  });
});
