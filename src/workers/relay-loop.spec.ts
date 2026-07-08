import { RelayLoop } from './relay-loop';

const POLL_MS = 100;

describe('RelayLoop', () => {
  afterEach(() => {
    jest.clearAllMocks();
    jest.useRealTimers();
  });

  describe('폴링', () => {
    it('pollMs 주기로 tick을 실행한다', async () => {
      jest.useFakeTimers();
      const tick = jest.fn(() => Promise.resolve());
      const loop = new RelayLoop(tick, POLL_MS);

      loop.start();
      await jest.advanceTimersByTimeAsync(POLL_MS * 3);

      expect(tick).toHaveBeenCalledTimes(3);
      await loop.stop();
    });

    it('이전 틱이 진행 중이면 새 틱을 건너뛴다(누적 방지)', async () => {
      jest.useFakeTimers();
      // 두 주기에 걸치는 느린 틱.
      const tick = jest.fn(
        () => new Promise<void>((r) => setTimeout(r, POLL_MS * 2 + 10)),
      );
      const loop = new RelayLoop(tick, POLL_MS);

      loop.start();
      await jest.advanceTimersByTimeAsync(POLL_MS * 2);

      expect(tick).toHaveBeenCalledTimes(1);

      // stop()을 호출하고, 진행 중 틱이 완주될 시간까지 타이머 진행.
      // 첫 틱은 t=100 시작 후 210ms가 필요해 t=310에 완료되므로,
      // 그보다 충분히 오래(예: 310ms 이상) 타이머를 진행해야 stop()이 반환된다.
      const stopping = loop.stop();
      await jest.advanceTimersByTimeAsync(POLL_MS * 3 + 10);
      await stopping;
    });

    it('틱 예외는 루프를 죽이지 않는다', async () => {
      jest.useFakeTimers();
      const tick = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error('한 틱 실패'))
        .mockResolvedValue(undefined);
      const loop = new RelayLoop(tick, POLL_MS);

      loop.start();
      await jest.advanceTimersByTimeAsync(POLL_MS * 2);

      expect(tick).toHaveBeenCalledTimes(2);
      await loop.stop();
    });
  });

  describe('stop — 그레이스풀 종료의 핵심', () => {
    it('진행 중 틱의 완주를 기다린 후 반환한다', async () => {
      jest.useFakeTimers();
      let finished = false;
      const tick = jest.fn(
        () =>
          new Promise<void>((r) =>
            setTimeout(() => {
              finished = true;
              r();
            }, POLL_MS * 3),
          ),
      );
      const loop = new RelayLoop(tick, POLL_MS);
      loop.start();
      await jest.advanceTimersByTimeAsync(POLL_MS); // 틱 시작

      const stopping = loop.stop();
      await jest.advanceTimersByTimeAsync(POLL_MS * 3); // 틱 완주 시간 경과
      await stopping;

      expect(finished).toBe(true);
    });

    it('stop 이후 새 틱이 돌지 않는다', async () => {
      jest.useFakeTimers();
      const tick = jest.fn(() => Promise.resolve());
      const loop = new RelayLoop(tick, POLL_MS);
      loop.start();
      await jest.advanceTimersByTimeAsync(POLL_MS);

      await loop.stop();
      await jest.advanceTimersByTimeAsync(POLL_MS * 5);

      expect(tick).toHaveBeenCalledTimes(1);
    });
  });
});
