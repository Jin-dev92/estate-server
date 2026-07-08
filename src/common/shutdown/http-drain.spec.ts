import type { Server } from 'http';
import { drainHttpServer } from './http-drain';

const FORCE_AFTER_MS = 9_000;

interface FakeServerWithMocks extends Server {
  __closeIdleMock: jest.Mock;
  __closeMock: jest.Mock;
  __closeAllMock: jest.Mock;
}

// close 콜백을 제어할 수 있는 가짜 http.Server.
function fakeServer(overrides?: Partial<Server>): FakeServerWithMocks {
  const closeIdleConnectionsMock = jest.fn();
  const closeMock = jest.fn(((cb?: (err?: Error) => void) => {
    cb?.();
    return undefined as unknown;
  }) as unknown as typeof Server.prototype.close);
  const closeAllConnectionsMock = jest.fn();

  return {
    close: closeMock,
    closeIdleConnections: closeIdleConnectionsMock,
    closeAllConnections: closeAllConnectionsMock,
    __closeIdleMock: closeIdleConnectionsMock,
    __closeMock: closeMock,
    __closeAllMock: closeAllConnectionsMock,
    ...overrides,
  } as FakeServerWithMocks;
}

describe('drainHttpServer', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('정상 드레인', () => {
    it('유휴 정리 후 close 완료를 기다리고, 강제 종료는 호출하지 않는다', async () => {
      const server = fakeServer();

      await drainHttpServer(server, FORCE_AFTER_MS);

      expect(server.__closeIdleMock).toHaveBeenCalledTimes(1);
      expect(server.__closeMock).toHaveBeenCalledTimes(1);
      expect(server.__closeAllMock).not.toHaveBeenCalled();
    });
  });

  describe('드레인 지연', () => {
    it('forceCloseAfterMs 경과 시 잔여 연결을 강제 종료한다', async () => {
      jest.useFakeTimers();
      // close가 콜백을 바로 부르지 않는(매달린) 서버.
      let finishClose: (() => void) | undefined;
      const overriddenClose = jest.fn(((cb?: (err?: Error) => void) => {
        finishClose = () => cb?.();
        return undefined as unknown;
      }) as unknown as typeof Server.prototype.close);
      const server = fakeServer({
        close: overriddenClose,
      });
      server.__closeMock = overriddenClose;

      const draining = drainHttpServer(server, FORCE_AFTER_MS);
      jest.advanceTimersByTime(FORCE_AFTER_MS);

      expect(server.__closeAllMock).toHaveBeenCalledTimes(1);

      finishClose?.();
      await draining;
    });

    it('close가 에러를 주면 reject한다', async () => {
      const overriddenClose = jest.fn(((cb?: (err?: Error) => void) => {
        cb?.(new Error('not running'));
        return undefined as unknown;
      }) as unknown as typeof Server.prototype.close);
      const server = fakeServer({
        close: overriddenClose,
      });
      server.__closeMock = overriddenClose;

      await expect(
        drainHttpServer(server as Server, FORCE_AFTER_MS),
      ).rejects.toThrow('not running');
    });
  });
});
