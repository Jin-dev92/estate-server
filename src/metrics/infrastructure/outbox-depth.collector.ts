import { Inject, Injectable } from '@nestjs/common';
import { Gauge, Registry } from 'prom-client';
import { OutboxStatus } from '../../outbox/domain/outbox-status.enum';
import { PrismaService } from '../../prisma/prisma.service';
import { METRICS_REGISTRY } from './metrics.registry';

// 메트릭 이름. 매직 스트링 중복을 막기 위해 상수로 추출한다.
const OUTBOX_EVENTS_PENDING_METRIC = 'outbox_events_pending';
const OUTBOX_EVENTS_FAILED_METRIC = 'outbox_events_failed';

// Outbox depth 조회 타임아웃(ms). scrape 경로가 DB 지연에 물려 오래 걸리는
// 것을 막기 위한 상한. 초과하면 조회를 포기하고 이번 scrape는 값을 갱신하지
// 않는다(reset된 상태 유지).
const OUTBOX_DEPTH_QUERY_TIMEOUT_MS = 1000;

// Prometheus가 GET /metrics를 스크레이프하는 시점에만 Outbox PENDING/FAILED
// 적재량을 조회하는 Collector. setInterval 등 별도 타이머를 두지 않는다 —
// M13 그레이스풀 셧다운에서 미해제 타이머가 프로세스 종료를 막지 않게 하기
// 위함이다. prom-client Gauge의 async `collect` 콜백이 registry.metrics()
// 호출 시점에만 실행되는 특성을 그대로 활용한다.
@Injectable()
export class OutboxDepthCollector {
  private readonly pendingGauge: Gauge;
  private readonly failedGauge: Gauge;

  // registry.metrics()는 등록된 모든 메트릭의 get()을 Promise.all로 "병렬"
  // 호출한다. 두 Gauge 모두에 collect 콜백을 걸어야 하지만(그래야 둘 다
  // scrape마다 최신값을 반영), 그대로 두면 pendingGauge.get()이 DB 조회를
  // 기다리는 동안 failedGauge.get()은 그 순간의 값을 즉시 스냅샷해버려
  // "직전 scrape 값"이 섞여 나온다. 진행 중인 조회를 하나의 Promise로 공유해
  // 두 Gauge의 get() 모두 같은 결과를 기다리게 만든다(scrape당 쿼리 1회 보장).
  private inFlight: Promise<void> | undefined;

  constructor(
    @Inject(METRICS_REGISTRY) registry: Registry,
    private readonly prisma: PrismaService,
  ) {
    this.pendingGauge = new Gauge({
      name: OUTBOX_EVENTS_PENDING_METRIC,
      help: 'PENDING 상태로 대기 중인 outbox 이벤트 수 (scrape 시점 조회)',
      registers: [registry],
      collect: () => this.collectOnce(),
    });
    this.failedGauge = new Gauge({
      name: OUTBOX_EVENTS_FAILED_METRIC,
      help: 'FAILED(poison) 상태로 격리된 outbox 이벤트 수 (scrape 시점 조회)',
      registers: [registry],
      collect: () => this.collectOnce(),
    });
  }

  private collectOnce(): Promise<void> {
    this.inFlight ??= this.collect().finally(() => {
      this.inFlight = undefined;
    });
    return this.inFlight;
  }

  async collect(): Promise<void> {
    let timeoutHandle: NodeJS.Timeout | undefined;

    try {
      const timeout = new Promise<never>((_resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error('outbox depth query timed out'));
        }, OUTBOX_DEPTH_QUERY_TIMEOUT_MS);
      });

      const rows = await Promise.race([
        this.prisma.outboxEvent.groupBy({
          by: ['status'],
          _count: { _all: true },
          where: {
            status: { in: [OutboxStatus.Pending, OutboxStatus.Failed] },
          },
        }),
        timeout,
      ]);

      const countByStatus = new Map(
        rows.map((row) => [row.status, row._count._all]),
      );

      this.pendingGauge.set(countByStatus.get(OutboxStatus.Pending) ?? 0);
      this.failedGauge.set(countByStatus.get(OutboxStatus.Failed) ?? 0);
    } catch {
      // 쿼리 실패/타임아웃 시 값을 0으로 두면 "정상적으로 0건"과 "조회
      // 실패"가 구분되지 않는다. remove()로 샘플 자체를 노출 목록에서
      // 빼(scrape 자체는 실패시키지 않음) 애매한 값을 남기지 않는다.
      this.pendingGauge.remove();
      this.failedGauge.remove();
      return;
    } finally {
      // Promise.race에서 진 쪽 타이머가 남아있으면 M13 그레이스풀 셧다운을
      // 방해할 수 있으므로 성공/실패 무관하게 항상 해제한다.
      clearTimeout(timeoutHandle);
    }
  }
}
