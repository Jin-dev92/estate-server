import type { Server } from 'http';

// HTTP 드레인: 신규 수신 중단 → 유휴 keep-alive 정리 → in-flight 완주 대기.
// keep-alive 유휴 소켓은 요청이 없어도 열려 있어 close 완료를 영원히 막는다 —
// Node 19+는 close()가 유휴 연결도 닫지만, closeIdleConnections를 명시 호출해 의도를 남긴다.
// forceCloseAfterMs 경과 시 잔여 연결을 강제 종료한다(그래도 안 끝나면 워치독이 exit 1).
export async function drainHttpServer(
  server: Server,
  forceCloseAfterMs: number,
): Promise<void> {
  const force = setTimeout(
    () => server.closeAllConnections(),
    Math.max(0, forceCloseAfterMs),
  );
  server.closeIdleConnections();
  try {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  } finally {
    clearTimeout(force);
  }
}
