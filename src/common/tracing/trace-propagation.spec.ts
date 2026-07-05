import {
  captureTraceHeaders,
  continueTraceFromHeaders,
  SENTRY_TRACE_HEADER,
} from './trace-propagation';

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
});
