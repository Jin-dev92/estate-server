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

  constructor(
    @Inject(METRICS_REGISTRY) registry: Registry,
    private readonly prisma: PrismaService,
  ) {
    // collect 콜백은 두 Gauge 중 하나에만 건다. 둘 다에 걸면 registry.metrics()
    // 한 번에 collect()가 두 번 실행되어 DB 쿼리가 중복 발생한다 — collect()
    // 안에서 두 Gauge 값을 함께 갱신하므로 하나만으로 충분하다.
    this.pendingGauge = new Gauge({
      name: OUTBOX_EVENTS_PENDING_METRIC,
      help: 'PENDING 상태로 대기 중인 outbox 이벤트 수 (scrape 시점 조회)',
      registers: [registry],
      collect: () => this.collect(),
    });
    this.failedGauge = new Gauge({
      name: OUTBOX_EVENTS_FAILED_METRIC,
      help: 'FAILED(poison) 상태로 격리된 outbox 이벤트 수 (scrape 시점 조회)',
      registers: [registry],
    });
  }

  async collect(): Promise<void> {
    // 조회 실패/타임아웃 시 이전 scrape의 값이 그대로 남지 않도록 먼저
    // reset한다 — 실패했는데 stale한 값이 계속 노출되는 걸 막기 위함이다.
    this.pendingGauge.reset();
    this.failedGauge.reset();

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
      // 쿼리 실패/타임아웃은 조용히 삼킨다 — scrape 자체(registry.metrics())가
      // 실패하면 안 되고, 이번 회차는 reset된(=stale하지 않은) 상태로 넘어간다.
      return;
    } finally {
      // Promise.race에서 진 쪽 타이머가 남아있으면 M13 그레이스풀 셧다운을
      // 방해할 수 있으므로 성공/실패 무관하게 항상 해제한다.
      clearTimeout(timeoutHandle);
    }
  }
}
