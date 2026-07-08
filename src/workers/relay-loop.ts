import { Logger } from '@nestjs/common';

// outbox-relay 폴링 루프. 기존 bootstrap 안의 setInterval을 start/stop 가능한
// 클래스로 추출 — stop()이 "진행 중 틱"을 완주 대기해, Kafka 발행↔PUBLISHED 마킹
// 사이에서 종료되는 창(재기동 시 중복 발행 원인)을 없앤다.
export class RelayLoop {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<void> | null = null;

  constructor(
    private readonly tick: () => Promise<void>,
    private readonly pollMs: number,
    private readonly logger = new Logger(RelayLoop.name),
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.inFlight) return; // 이전 틱 진행 중이면 건너뜀(틱 누적 방지)
      this.inFlight = this.tick()
        .catch((err: Error) =>
          this.logger.error(`폴링 틱 실패: ${err.message}`),
        )
        .finally(() => {
          this.inFlight = null;
        });
    }, this.pollMs);
  }

  // 인터벌을 해제하고, 진행 중 틱이 있으면 완주를 기다린다.
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.inFlight) await this.inFlight;
  }
}
