/* eslint-disable @typescript-eslint/require-await */
import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import {
  createShutdownRunner,
  getShutdownTimeoutMs,
  DEFAULT_SHUTDOWN_TIMEOUT_MS,
  FORCE_CLOSE_MARGIN_MS,
} from './graceful-shutdown';

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

    it('워치독 발화 후 drain이 뒤늦게 성공해도 exit 0으로 뒤집히지 않는다', async () => {
      jest.useFakeTimers();
      const app = { close: jest.fn(async () => undefined) };
      const exit = jest.fn();
      // drain을 수동으로 resolve 가능한 deferred로 만든다 — 워치독 발화 "이후"
      // 시점에 성공 경로가 뒤늦게 도착하는 경합을 재현하기 위함.
      let resolveDrain!: () => void;
      const drain = jest.fn(
        () =>
          new Promise<void>((resolve) => {
            resolveDrain = resolve;
          }),
      );

      const runner = createShutdownRunner(app, {
        name: 'test',
        timeoutMs: TIMEOUT_MS,
        drain,
        exit,
      });

      const running = runner();
      // 워치독 발화 → timedOut = true, flushThenExit(1) 예약(마이크로태스크 대기 중).
      await jest.advanceTimersByTimeAsync(TIMEOUT_MS);

      // 워치독 발화 "이후"에 drain이 뒤늦게 성공 → app.close()까지 이어짐.
      resolveDrain();
      // 마이크로태스크(성공 경로의 await 체인 + flushThenExit의 flush.then)를 모두 소진.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(exit).toHaveBeenCalledTimes(1);
      expect(exit).toHaveBeenCalledWith(1);
      expect(exit).not.toHaveBeenCalledWith(0);
      void running;
    });
  });
});

describe('getShutdownTimeoutMs', () => {
  const KEY = 'SHUTDOWN_TIMEOUT_MS';
  const original = process.env[KEY];

  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
    jest.restoreAllMocks();
  });

  describe('파싱', () => {
    it('env 값을 숫자로 반환한다', () => {
      process.env[KEY] = '15000';

      expect(getShutdownTimeoutMs()).toBe(15_000);
    });

    it('미설정·0·비숫자는 기본값으로 폴백한다', () => {
      delete process.env[KEY];
      expect(getShutdownTimeoutMs()).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);

      process.env[KEY] = 'abc';
      expect(getShutdownTimeoutMs()).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);

      process.env[KEY] = '0';
      expect(getShutdownTimeoutMs()).toBe(DEFAULT_SHUTDOWN_TIMEOUT_MS);
    });
  });

  describe('하한 가드', () => {
    it('강제 정리 여유 이하면 경고를 남긴다(값은 그대로 반환)', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      process.env[KEY] = String(FORCE_CLOSE_MARGIN_MS);

      const result = getShutdownTimeoutMs();

      expect(result).toBe(FORCE_CLOSE_MARGIN_MS);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('SHUTDOWN_TIMEOUT_MS'),
      );
    });

    it('충분히 크면 경고하지 않는다', () => {
      const warn = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      process.env[KEY] = '10000';

      getShutdownTimeoutMs();

      expect(warn).not.toHaveBeenCalled();
    });
  });
});
