import { Logger } from '@nestjs/common';
import * as Sentry from '@sentry/nestjs';
import { ConfigKey } from '../../config/config-keys';

// process.exit()은 대기 중인 네트워크 I/O(Sentry 이벤트 전송 등)를 기다리지
// 않는다. Sentry.captureMessage/captureException 직후 바로 exit하면 캡처된
// 이벤트가 전송되기 전에 프로세스가 죽어 유실될 수 있으므로, 짧게 flush를
// 기다린 뒤 exit한다(전체 종료 예산에 비하면 무시할 수준의 지연).
const SENTRY_FLUSH_MS = 2000;

// 종료 예산 기본값(env 미설정 시). 5개 부트스트랩의 단일 출처.
export const DEFAULT_SHUTDOWN_TIMEOUT_MS = 10_000;
// HTTP 강제 커넥션 정리 여유: 종료 예산 만료 이 시간 전에 잔여 연결을 강제로 닫는다.
export const FORCE_CLOSE_MARGIN_MS = 1_000;

// SHUTDOWN_TIMEOUT_MS(env)를 파싱한다. 미설정·0·비숫자는 기본값으로 폴백한다.
// 5개 부트스트랩에 복붙되던 `Number(process.env[...]) || 10_000` 을 단일 출처로 모은다.
// 예산이 강제 정리 여유 이하이면 in-flight 드레인 유예가 사실상 사라지므로 경고한다
// (운영자가 의도적으로 짧게 둘 수 있어 clamp/throw는 하지 않고 알림만 — 조용히 넘기지 않기).
export function getShutdownTimeoutMs(): number {
  const timeoutMs =
    Number(process.env[ConfigKey.ShutdownTimeoutMs]) ||
    DEFAULT_SHUTDOWN_TIMEOUT_MS;
  if (timeoutMs <= FORCE_CLOSE_MARGIN_MS) {
    new Logger('GracefulShutdown').warn(
      `SHUTDOWN_TIMEOUT_MS(${timeoutMs}ms)가 강제 정리 여유(${FORCE_CLOSE_MARGIN_MS}ms) 이하 — ` +
        `in-flight 드레인 유예가 사실상 없습니다. 예산을 늘리는 것을 권장합니다.`,
    );
  }
  return timeoutMs;
}

// app.close()만 필요하므로 최소 계약으로 받는다(테스트 용이 + main/워커 공용).
export interface ClosableApp {
  close(): Promise<void>;
}

export interface ShutdownOptions {
  name: string; // 프로세스 이름(로그·Sentry 메시지용)
  timeoutMs: number; // 종료 예산 — 초과 시 exit 1(조용히 매달린 채 죽지 않기)
  drain?: () => Promise<void>; // 프로세스별 "신규 유입 중단 + 하던 일 완주"
  exit?: (code: number) => void; // 테스트 주입용. 기본 process.exit
}

// 종료 러너. 순서가 핵심: 워치독 → drain(수도꼭지 잠금+배수) → app.close()(파이프 해체).
//
// drain을 app.close() "앞"에서 직접 실행하는 이유: Nest 훅 순서가
// onModuleDestroy(인프라 정리) → beforeApplicationShutdown → dispose 라서,
// 드레인을 Nest 훅에 두면 Redis/Prisma가 먼저 닫혀 in-flight 작업이 실패한다.
export function createShutdownRunner(
  app: ClosableApp,
  opts: ShutdownOptions,
): () => Promise<void> {
  const logger = new Logger(`GracefulShutdown:${opts.name}`);
  const exit = opts.exit ?? ((code: number) => process.exit(code));
  let started = false;
  // 워치독이 이미 발화(exit 1 예약)했는지 표시하는 플래그. 워치독 발화 후에도
  // try 블록의 drain/close가 뒤늦게 성공할 수 있어(2초 flush 대기 창 안에서),
  // 이 경합에서 성공 경로가 종료 코드를 0으로 뒤집지 않도록 가드한다.
  let timedOut = false;

  // Sentry 캡처 후 exit하는 두 경로(워치독·close 실패)가 공유하는 헬퍼.
  // Promise.resolve(...)로 감싸는 이유: jest.mock('@sentry/nestjs') 자동
  // 모킹 시 Sentry.flush가 undefined를 반환해도 안전하게 처리하기 위함.
  // Sentry 비활성(DSN 없음)에서는 flush가 즉시 resolve되어 지연이 없다.
  const flushThenExit = (code: number): void => {
    void Promise.resolve(Sentry.flush(SENTRY_FLUSH_MS))
      .catch(() => undefined)
      .then(() => exit(code));
  };

  return async () => {
    if (started) return; // 중복 신호(SIGTERM 후 SIGINT 등) 무시
    started = true;
    logger.log(`종료 시작(예산 ${opts.timeoutMs}ms)`);

    const watchdog = setTimeout(() => {
      timedOut = true;
      logger.error('종료 예산 초과 — 강제 종료');
      Sentry.captureMessage(
        `${opts.name} graceful shutdown timeout`,
        'warning',
      );
      flushThenExit(1);
    }, opts.timeoutMs);

    try {
      await opts.drain?.();
      await app.close(); // 기존 OnModuleDestroy(Redis quit·Prisma disconnect 등) 재사용
      clearTimeout(watchdog);
      logger.log('종료 완료');
      // 워치독이 이미 발화해 flush 후 exit(1)이 예약된 상태 — 뒤늦은 성공이
      // 종료 코드를 0으로 뒤집으면 "예산 초과 = exit 1" 계약이 깨진다.
      if (timedOut) return;
      exit(0); // 성공 경로는 캡처가 없으므로 flush 없이 즉시 exit
    } catch (err) {
      clearTimeout(watchdog);
      logger.error(`종료 중 오류: ${(err as Error).message}`);
      // 워치독의 exit(1)이 이미 예약됨 — 중복 캡처/flush/exit 방지.
      if (timedOut) return;
      Sentry.captureException(err);
      flushThenExit(1);
    }
  };
}

// SIGTERM/SIGINT에 러너를 등록한다. enableShutdownHooks를 쓰지 않는 이유:
// Nest 기본 훅은 워치독이 없고 drain 순서를 제어할 수 없으며, 함께 쓰면 close가 중복된다.
export function setupGracefulShutdown(
  app: ClosableApp,
  opts: ShutdownOptions,
): void {
  const runner = createShutdownRunner(app, opts);
  process.once('SIGTERM', () => void runner());
  process.once('SIGINT', () => void runner());
}
