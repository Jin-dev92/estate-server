/* eslint-disable @typescript-eslint/require-await */
import * as Sentry from '@sentry/nestjs';
import { createShutdownRunner } from './graceful-shutdown';

// 워치독·종료 코드는 Sentry로 알린다 — 코드베이스 관례대로 모듈 자동 모킹.
jest.mock('@sentry/nestjs');

const TIMEOUT_MS = 10_000;

describe('createShutdownRunner', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('정상 종료', () => {
    it('drain → app.close 순서로 실행하고 exit 0을 호출한다', async () => {
      const order: string[] = [];
      const app = {
        close: jest.fn(async () => {
          order.push('close');
        }),
      };
      const drain = jest.fn(async () => {
        order.push('drain');
      });
      const exit = jest.fn();

      const runner = createShutdownRunner(app, {
        name: 'test',
        timeoutMs: TIMEOUT_MS,
        drain,
        exit,
      });
      await runner();

      expect(order).toEqual(['drain', 'close']);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('중복 신호는 무시한다(러너 2회 호출 시 close 1회)', async () => {
      const app = { close: jest.fn(async () => undefined) };
      const exit = jest.fn();
      const runner = createShutdownRunner(app, {
        name: 'test',
        timeoutMs: TIMEOUT_MS,
        exit,
      });

      await Promise.all([runner(), runner()]);

      expect(app.close).toHaveBeenCalledTimes(1);
    });
  });

  describe('실패 경로', () => {
    it('close가 던지면 Sentry 캡처 후 exit 1', async () => {
      const boom = new Error('close 실패');
      const app = { close: jest.fn(async () => Promise.reject(boom)) };
      const exit = jest.fn();
      const runner = createShutdownRunner(app, {
        name: 'test',
        timeoutMs: TIMEOUT_MS,
        exit,
      });

      await runner();
      // exit는 이제 Sentry.flush 뒤(마이크로태스크)에 호출되므로 흘려보낸다.
      await Promise.resolve();
      await Promise.resolve();

      expect(Sentry.captureException).toHaveBeenCalledWith(boom);
      expect(exit).toHaveBeenCalledWith(1);
    });

    it('예산 초과 시 워치독이 Sentry 경고 후 exit 1', async () => {
      jest.useFakeTimers();
      // drain이 영원히 안 끝나는 상황.
      const app = { close: jest.fn(async () => undefined) };
      const exit = jest.fn();
      const runner = createShutdownRunner(app, {
        name: 'test',
        timeoutMs: TIMEOUT_MS,
        drain: () => new Promise<void>(() => undefined),
        exit,
      });

      const running = runner();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(exit).toHaveBeenCalledWith(1);
      expect(Sentry.captureMessage).toHaveBeenCalledWith(
        'test graceful shutdown timeout',
        'warning',
      );
      void running; // 러너 자체는 매달린 채(실제로는 exit가 프로세스를 끝냄)
    });

    it('워치독 발화 시 Sentry.flush가 exit보다 먼저 호출된다', async () => {
      jest.useFakeTimers();
      const app = { close: jest.fn(async () => undefined) };
      const exit = jest.fn();
      const runner = createShutdownRunner(app, {
        name: 'test',
        timeoutMs: TIMEOUT_MS,
        drain: () => new Promise<void>(() => undefined),
        exit,
      });

      const running = runner();
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS);

      expect(Sentry.flush).toHaveBeenCalledWith(2000);
      // invocationCallOrder로 flush가 exit보다 먼저 호출됐음을 확인한다.
      const flushOrder = (Sentry.flush as jest.Mock).mock
        .invocationCallOrder[0];
      const exitOrder = exit.mock.invocationCallOrder[0];
      expect(flushOrder).toBeLessThan(exitOrder);
      void running;
    });
  });
});
