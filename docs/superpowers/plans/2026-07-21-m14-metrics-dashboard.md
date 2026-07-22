# M14 메트릭 대시보드 Implementation Plan
> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
**Goal:** main 프로세스의 `/metrics`에서 RED·Outbox depth·Kafka consumer lag을 노출하고 Prometheus와 Grafana로 수집·시각화해 Sentry가 포착하지 못하는 무예외 적체를 검증한다.
**Architecture:** `MetricsModule`은 `AppModule`에만 등록하여 HTTP를 여는 main을 유일한 메트릭 노출점으로 유지하고, HTTP 없는 워커 4종의 M13 설계를 보존한다. RED는 요청 종료 시 갱신하고, Outbox depth와 Kafka lag은 별도 타이머 없이 Prometheus scrape 시점에 공유 DB와 Kafka offset을 조회한다.
**Tech Stack:** prom-client, kafkajs Admin, Prisma, Prometheus, Grafana

## Global Constraints
- NestJS 11 + Express + TypeScript
- 신규 의존성 prom-client
- 매직 스트링 금지 → 상수/ConfigKey 참조 (consumer group 이름 포함)
- 신규 엔드포인트(/metrics)는 Swagger 데코레이터 필수(@ApiTags·@ApiOperation·@ApiResponse)
- 테스트는 CLAUDE.md의 NestJS Test Rules 준수(Jest, describe→describe(context)→it, AAA, Partial<jest.Mocked<T>> — as any 금지, factory 픽스처, 공부용 설명 주석)
- 커밋 메시지 형식: [M14]{type}: {한글 설명}
- 브랜치: feature/M14-metrics-dashboard

---

### Task 1: prom-client Registry와 `/metrics` 단일 노출점

**Files:**
- Create: `src/metrics/infrastructure/metrics.registry.ts`
- Create: `src/metrics/interface/metrics.controller.ts`
- Create: `src/metrics/interface/metrics.controller.spec.ts`
- Create: `src/metrics/metrics.module.ts`
- Modify: `src/app.module.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `prom-client.Registry`, `collectDefaultMetrics`, Nest `@Inject`, Express HTTP 응답 처리.
- Produces: `METRICS_REGISTRY: unique symbol`, `createMetricsRegistry(): Registry`, `MetricsController.metrics(): Promise<string>`, `MetricsModule`; `GET /metrics`은 `registry.contentType`으로 Prometheus 텍스트를 반환한다.

- [ ] **Step 1: 의존성을 설치하고 실패하는 HTTP 스펙 작성**

Run: `pnpm add prom-client`

Create `src/metrics/interface/metrics.controller.spec.ts`:

```ts
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Registry, collectDefaultMetrics } from 'prom-client';
import request from 'supertest';
import { METRICS_REGISTRY } from '../infrastructure/metrics.registry';
import { MetricsController } from './metrics.controller';

describe('MetricsController', () => {
  let app: INestApplication;
  let registry: Registry;

  beforeEach(async () => {
    registry = new Registry();
    collectDefaultMetrics({ register: registry, prefix: 'estate_' });
    const moduleRef = await Test.createTestingModule({
      controllers: [MetricsController],
      providers: [{ provide: METRICS_REGISTRY, useValue: registry }],
    }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    jest.clearAllMocks();
    registry.clear();
    await app.close();
  });

  describe('GET /metrics 요청 시', () => {
    it('Prometheus content type과 기본 프로세스 메트릭을 반환한다', async () => {
      // Arrange: beforeEach에서 독립 Registry가 등록된 Nest 앱을 준비한다.

      // Act
      const response = await request(app.getHttpServer()).get('/metrics');

      // Assert
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toBe(registry.contentType);
      expect(response.text).toContain('estate_process_cpu_user_seconds_total');
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec jest src/metrics/interface/metrics.controller.spec.ts --runInBand`

Expected: FAIL — `Cannot find module '../infrastructure/metrics.registry'`.

- [ ] **Step 3: Registry, Controller, Module을 최소 구현**

Create `src/metrics/infrastructure/metrics.registry.ts`:

```ts
import { Registry, collectDefaultMetrics } from 'prom-client';

export const METRICS_REGISTRY = Symbol('METRICS_REGISTRY');
const DEFAULT_METRIC_PREFIX = 'estate_';

export function createMetricsRegistry(): Registry {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry, prefix: DEFAULT_METRIC_PREFIX });
  return registry;
}
```

Create `src/metrics/interface/metrics.controller.ts`:

```ts
import { Controller, Get, Inject, Res } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { Registry } from 'prom-client';
import { SWAGGER_TAG_METRICS } from '../../common/swagger/swagger.constants';
import { METRICS_REGISTRY } from '../infrastructure/metrics.registry';

@ApiTags(SWAGGER_TAG_METRICS)
@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS_REGISTRY) private readonly registry: Registry) {}

  @Get()
  @ApiOperation({ summary: 'Prometheus 메트릭 조회' })
  @ApiResponse({ status: 200, description: 'Prometheus text exposition format' })
  metrics(@Res({ passthrough: true }) response: Response): Promise<string> {
    response.type(this.registry.contentType);
    return this.registry.metrics();
  }
}
```

Create `src/metrics/metrics.module.ts`:

```ts
import { Module } from '@nestjs/common';
import { METRICS_REGISTRY, createMetricsRegistry } from './infrastructure/metrics.registry';
import { MetricsController } from './interface/metrics.controller';

@Module({
  controllers: [MetricsController],
  providers: [{ provide: METRICS_REGISTRY, useFactory: createMetricsRegistry }],
  exports: [METRICS_REGISTRY],
})
export class MetricsModule {}
```

In `src/common/swagger/swagger.constants.ts`, add `export const SWAGGER_TAG_METRICS = 'metrics';` and append `SWAGGER_TAG_METRICS` to the existing `SWAGGER_TAGS` array. Then import `MetricsModule` in `src/app.module.ts` and append it to `imports`. This keeps the controller tag and Swagger root tag on one constant source while the response uses the injected `registry.contentType`.

- [ ] **Step 4: 단위 테스트·빌드·린트 통과 확인**

Run: `pnpm exec jest src/metrics/interface/metrics.controller.spec.ts --runInBand`

Expected: PASS — 1 test.

Run: `pnpm build && pnpm lint:check`

Expected: 두 명령 모두 exit code 0. Swagger 상수 형태가 객체가 아니라면 기존 선언 형태를 보존해 `Metrics` 항목만 추가한다.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/metrics src/app.module.ts src/common/swagger/swagger.constants.ts
git commit -m "[M14]feat: Prometheus Registry와 메트릭 엔드포인트 추가"
```

---

### Task 2: consumer group 이름 중앙 상수화

**Files:**
- Create: `src/events/consumer-groups.ts`
- Create: `src/events/consumer-groups.spec.ts`
- Modify: `src/workers/persistence-worker.main.ts`
- Modify: `src/workers/audit-worker.main.ts`
- Modify: `src/workers/notification-worker.main.ts`

**Interfaces:**
- Consumes: Nest Kafka transport의 `consumer.groupId: string`.
- Produces: `ConsumerGroup.Persistence`, `ConsumerGroup.Audit`, `ConsumerGroup.Notification`, `CONSUMER_GROUPS: readonly ConsumerGroupId[]`, `type ConsumerGroupId`.

- [ ] **Step 1: 상수 계약의 실패하는 스펙 작성**

Create `src/events/consumer-groups.spec.ts`:

```ts
import { CONSUMER_GROUPS, ConsumerGroup } from './consumer-groups';

describe('ConsumerGroup', () => {
  describe('워커와 lag collector가 그룹 목록을 공유할 때', () => {
    it('세 consumer group의 브로커 식별자를 고정한다', () => {
      // Arrange
      const expected = ['persistence-worker', 'audit-worker', 'notification-worker'];

      // Act
      const groups = [...CONSUMER_GROUPS];

      // Assert
      expect(ConsumerGroup.Persistence).toBe('persistence-worker');
      expect(ConsumerGroup.Audit).toBe('audit-worker');
      expect(ConsumerGroup.Notification).toBe('notification-worker');
      expect(groups).toStrictEqual(expected);
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec jest src/events/consumer-groups.spec.ts --runInBand`

Expected: FAIL — `Cannot find module './consumer-groups'`.

- [ ] **Step 3: 상수 구현 후 세 워커를 동일 출처로 교체**

Create `src/events/consumer-groups.ts`:

```ts
export const ConsumerGroup = {
  Persistence: 'persistence-worker',
  Audit: 'audit-worker',
  Notification: 'notification-worker',
} as const;

export type ConsumerGroupId = (typeof ConsumerGroup)[keyof typeof ConsumerGroup];

export const CONSUMER_GROUPS: readonly ConsumerGroupId[] = [
  ConsumerGroup.Persistence,
  ConsumerGroup.Audit,
  ConsumerGroup.Notification,
];
```

In each worker import `ConsumerGroup` and replace only the `groupId` value:

```ts
consumer: { groupId: ConsumerGroup.Persistence },
consumer: { groupId: ConsumerGroup.Audit },
consumer: { groupId: ConsumerGroup.Notification },
```

- [ ] **Step 4: 테스트와 하드코딩 제거 확인**

Run: `pnpm exec jest src/events/consumer-groups.spec.ts --runInBand`

Expected: PASS — 1 test.

Run: `rg "groupId: '(persistence|audit|notification)-worker'" src/workers`

Expected: 출력 없음, exit code 1. 이어서 `pnpm build && pnpm lint:check`는 exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/events/consumer-groups.ts src/events/consumer-groups.spec.ts src/workers/persistence-worker.main.ts src/workers/audit-worker.main.ts src/workers/notification-worker.main.ts
git commit -m "[M14]refactor: Kafka consumer group 이름을 중앙 상수화"
```

---

### Task 3: HTTP RED 메트릭 전역 인터셉터

**Files:**
- Create: `src/metrics/infrastructure/http-metrics.interceptor.ts`
- Create: `src/metrics/infrastructure/http-metrics.interceptor.spec.ts`
- Modify: `src/metrics/metrics.module.ts`

**Interfaces:**
- Consumes: `METRICS_REGISTRY`, Nest `ExecutionContext`, `CallHandler`, `PATH_METADATA`; handler/class 라우트 메타데이터.
- Produces: `HttpMetricsInterceptor implements NestInterceptor`; `http_requests_total{method,route,status}` Counter와 `http_request_duration_seconds{method,route,status}` Histogram. Histogram buckets are `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5]`.

- [ ] **Step 1: 실패하는 인터셉터 스펙 작성**

Create `src/metrics/infrastructure/http-metrics.interceptor.spec.ts` with a fixture controller (`@Controller('buildings/:buildingId')`, `@Get('posts')`) and a testing module that registers the interceptor as `APP_INTERCEPTOR`. Send `GET /buildings/building-1/posts`, then assert:

```ts
const counter = await registry.getSingleMetricAsString('http_requests_total');
const histogram = await registry.getSingleMetricAsString('http_request_duration_seconds');

expect(counter).toContain('method="GET",route="/buildings/:buildingId/posts",status="200"} 1');
expect(counter).not.toContain('building-1');
expect(histogram).toContain('http_request_duration_seconds_count');
expect(histogram).toContain('route="/buildings/:buildingId/posts"');
```

Use `beforeEach` to create a new `Registry` and Nest app, `afterEach` to clear mocks/registry and close the app, and retain the mandatory `describe → describe(context) → it` nesting and AAA comments.

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec jest src/metrics/infrastructure/http-metrics.interceptor.spec.ts --runInBand`

Expected: FAIL — `Cannot find module './http-metrics.interceptor'`.

- [ ] **Step 3: 최소 인터셉터 구현 및 전역 등록**

Implement `HttpMetricsInterceptor` with constructor injection of `Registry` and `Reflector`. Create both metrics once in the constructor with `registers: [registry]`. Resolve route using `reflector.get<string>(PATH_METADATA, context.getClass())` and the handler metadata, normalize slashes, and never read `request.originalUrl`, `request.url`, or path parameter values. Use `defer` to start `process.hrtime.bigint()`, and `finalize` to read `request.method` and `response.statusCode`, increment the Counter, and observe elapsed seconds in the Histogram.

Register in `MetricsModule`:

```ts
{
  provide: APP_INTERCEPTOR,
  useClass: HttpMetricsInterceptor,
}
```

The route helper must return `'/'` for empty metadata and produce exactly `/buildings/:buildingId/posts` for the fixture.

- [ ] **Step 4: 통과 및 회귀 확인**

Run: `pnpm exec jest src/metrics/infrastructure/http-metrics.interceptor.spec.ts --runInBand`

Expected: PASS — Counter 1, Histogram count 1, raw ID absent.

Run: `pnpm test -- --runInBand && pnpm build && pnpm lint:check`

Expected: all suites PASS and both validation commands exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/infrastructure/http-metrics.interceptor.ts src/metrics/infrastructure/http-metrics.interceptor.spec.ts src/metrics/metrics.module.ts
git commit -m "[M14]feat: 라우트 패턴 기반 HTTP RED 메트릭 계측"
```

---

### Task 4: OutboxDepthCollector on-scrape 집계

**Files:**
- Create: `src/metrics/infrastructure/outbox-depth.collector.ts`
- Create: `src/metrics/infrastructure/outbox-depth.collector.spec.ts`
- Modify: `src/metrics/metrics.module.ts`

**Interfaces:**
- Consumes: `PrismaService.outboxEvent.groupBy({ by: ['status'], _count: { _all: true }, where: { status: { in: [...] } } })`, `OutboxStatus.Pending`, `OutboxStatus.Failed`, `METRICS_REGISTRY`.
- Produces: `OutboxDepthCollector.collect(): Promise<void>`; Gauges `outbox_events_pending`, `outbox_events_failed`; query timeout constant 1,000ms. 실패·타임아웃 시 두 Gauge를 reset하고 샘플을 생략한다.

- [ ] **Step 1: Prisma mock 기반 실패 스펙 작성**

Create `src/metrics/infrastructure/outbox-depth.collector.spec.ts`. Define a factory returning status/count rows and a mock with `groupBy: jest.fn()` using `satisfies Partial<jest.Mocked<PrismaService['outboxEvent']>>`; do not use `as any`. In nested contexts assert Pending=7 and Failed=2 after `await collector.collect()`, and assert both metric strings contain the expected scalar values. Add an error case where `groupBy` rejects and `registry.metrics()` resolves without either gauge sample line.

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec jest src/metrics/infrastructure/outbox-depth.collector.spec.ts --runInBand`

Expected: FAIL — `Cannot find module './outbox-depth.collector'`.

- [ ] **Step 3: 최소 구현과 모듈 등록**

Create two `Gauge` instances registered only in the injected Registry. Assign their async `collect` callback to `() => this.collect()` so `registry.metrics()` performs the query on scrape. In `collect()`, reset both gauges, run one status `groupBy` inside `Promise.race` against a rejecting 1,000ms timeout, map absent statuses to zero on successful queries, and set the two values. Catch query/timeout failures and return without rethrowing; always clear the timeout handle in `finally` so M13 shutdown gains no persistent timer.

Add `OutboxDepthCollector` to `MetricsModule.providers`; `PrismaModule` is global/imported by `AppModule`, so do not introduce an outbox-domain dependency.

- [ ] **Step 4: 통과 및 query shape 확인**

Run: `pnpm exec jest src/metrics/infrastructure/outbox-depth.collector.spec.ts --runInBand`

Expected: PASS — successful scrape exposes 7/2, failed scrape omits both sample values.

Assert the mock was called once with the exact `groupBy` shape above, then run `pnpm build && pnpm lint:check`; expected exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/infrastructure/outbox-depth.collector.ts src/metrics/infrastructure/outbox-depth.collector.spec.ts src/metrics/metrics.module.ts
git commit -m "[M14]feat: scrape 시점 Outbox PENDING·FAILED depth 수집"
```

---

### Task 5: KafkaLagCollector on-scrape offset 비교

**Files:**
- Create: `src/metrics/infrastructure/kafka-lag.collector.ts`
- Create: `src/metrics/infrastructure/kafka-lag.collector.spec.ts`
- Modify: `src/metrics/metrics.module.ts`

**Interfaces:**
- Consumes: kafkajs `Admin.connect(): Promise<void>`, `disconnect(): Promise<void>`, `fetchOffsets({ groupId, topics }): Promise<GroupOverview>`, `fetchTopicOffsets(topic): Promise<SeekEntry[]>`; `ConsumerGroup`, `KafkaTopic`, `ConfigKey.KafkaBrokers`, `METRICS_REGISTRY`.
- Produces: `KAFKA_ADMIN: unique symbol`; `KafkaLagCollector implements OnModuleInit, OnModuleDestroy`; `collect(): Promise<void>`; Gauge `kafka_consumer_lag{group,topic,partition}`. 조회 timeout은 1,000ms이고 실패 시 Gauge reset 상태를 유지해 해당 scrape의 샘플을 생략한다.

- [ ] **Step 1: Admin mock offset의 실패 스펙 작성**

Create `src/metrics/infrastructure/kafka-lag.collector.spec.ts`. Build `Partial<jest.Mocked<Admin>>` with `connect`, `disconnect`, `fetchOffsets`, `fetchTopicOffsets`. For `ConsumerGroup.Persistence` + `KafkaTopic.ChatEvents`, return committed offset `7` and latest offset `10` for partition `0`; return empty topic arrays for the other configured group/topic calls. After `collect()`, assert the Gauge includes `group="persistence-worker",topic="chat-events",partition="0"} 3`. Also assert `onModuleInit()` calls `connect`, `onModuleDestroy()` calls `disconnect`, and a rejected `fetchOffsets` makes `collect()` resolve while emitting no lag sample.

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec jest src/metrics/infrastructure/kafka-lag.collector.spec.ts --runInBand`

Expected: FAIL — `Cannot find module './kafka-lag.collector'`.

- [ ] **Step 3: lag 계산과 lifecycle 최소 구현**

Use this fixed group/topic ownership map, with no string literals:

```ts
const TOPICS_BY_GROUP: Readonly<Record<ConsumerGroupId, readonly KafkaTopic[]>> = {
  [ConsumerGroup.Persistence]: [KafkaTopic.ChatEvents],
  [ConsumerGroup.Audit]: [
    KafkaTopic.ChatEvents,
    KafkaTopic.BoardEvents,
    KafkaTopic.MembershipEvents,
  ],
  [ConsumerGroup.Notification]: [KafkaTopic.ChatEvents, KafkaTopic.BoardEvents],
};
```

Create one Gauge in the injected Registry. Its async collect callback invokes `collect()`. Reset before each scrape. For each group call `fetchOffsets({ groupId, topics })`; for each topic call `fetchTopicOffsets(topic)`, match partitions, parse decimal offsets with `Number`, and set `Math.max(0, latest - committed)`. Treat committed `'-1'` as lag `latest` (no committed message). Wrap the complete collection in the same clearable 1,000ms timeout pattern as T4 and catch failure without rethrowing.

Implement `onModuleInit`/`onModuleDestroy` as direct `admin.connect()`/`admin.disconnect()` awaits.

- [ ] **Step 4: Kafka Admin provider 배선과 통과 확인**

In `MetricsModule`, create the provider without new env keys:

```ts
{
  provide: KAFKA_ADMIN,
  inject: [ConfigService],
  useFactory: (config: ConfigService): Admin =>
    new Kafka({
      brokers: config.getOrThrow<string>(ConfigKey.KafkaBrokers).split(','),
    }).admin(),
},
KafkaLagCollector,
```

Run: `pnpm exec jest src/metrics/infrastructure/kafka-lag.collector.spec.ts --runInBand`

Expected: PASS — lag 3, lifecycle connect/disconnect, failure omission. Run `pnpm build && pnpm lint:check`; expected exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/metrics/infrastructure/kafka-lag.collector.ts src/metrics/infrastructure/kafka-lag.collector.spec.ts src/metrics/metrics.module.ts
git commit -m "[M14]feat: Kafka Admin 기반 consumer lag 수집"
```

---

### Task 6: `/metrics` Sentry tracing 제외

**Files:**
- Modify: `src/common/sentry/traces-sampler.ts`
- Modify: `src/common/sentry/traces-sampler.spec.ts`
- Modify: `src/common/sentry/init-sentry.ts` (주석만 `/docs·/metrics`로 동기화)

**Interfaces:**
- Consumes: `decideTraceSample(name: string | undefined, defaultRate: number): number`.
- Produces: `decideTraceSample('GET /metrics', rate) === 0`; 기존 `/docs`, `/docs-json`, 비즈니스 경로 동작 유지.

- [ ] **Step 1: 실패 단언 추가**

In `traces-sampler.spec.ts`, NestJS Test Rules에 맞게 기존 flat describe를 `describe('비즈니스 외 경로일 때')` context로 감싸고 add:

```ts
it('/metrics는 추적하지 않는다', () => {
  // Arrange
  const transactionName = 'GET /metrics';

  // Act
  const rate = decideTraceSample(transactionName, RATE);

  // Assert
  expect(rate).toBe(0);
});
```

- [ ] **Step 2: 실패 확인**

Run: `pnpm exec jest src/common/sentry/traces-sampler.spec.ts --runInBand`

Expected: FAIL — received `0.1`, expected `0`.

- [ ] **Step 3: 제외 상수 최소 수정**

In `traces-sampler.ts` replace the constant only:

```ts
const EXCLUDED_PATHS = ['/docs', '/metrics'];
```

Update the adjacent explanation and `init-sentry.ts` comment to say `/docs·/metrics`; do not change `initSentry` wiring.

- [ ] **Step 4: 통과 및 회귀 확인**

Run: `pnpm exec jest src/common/sentry/traces-sampler.spec.ts --runInBand`

Expected: PASS — `/docs`, `/docs-json`, `/metrics` are 0; business/undefined cases retain default rate.

Run: `pnpm lint:check`; Expected: exit code 0.

- [ ] **Step 5: Commit**

```bash
git add src/common/sentry/init-sentry.ts src/common/sentry/traces-sampler.ts src/common/sentry/traces-sampler.spec.ts
git commit -m "[M14]test: 메트릭 스크레이프를 Sentry 추적에서 제외"
```

---

### Task 7: Prometheus·Grafana 재현 가능한 프로비저닝

**Files:**
- Create: `ops/prometheus/prometheus.yml`
- Create: `ops/grafana/provisioning/datasources/prometheus.yml`
- Create: `ops/grafana/provisioning/dashboards/dashboard-provider.yml`
- Create: `ops/grafana/provisioning/dashboards/m14-metrics-dashboard.json`
- Modify: `docker-compose.yml`

**Interfaces:**
- Consumes: main `host.docker.internal:3000/metrics`; Prometheus HTTP `prometheus:9090`.
- Produces: 15s scrape job `estate-server`; Grafana datasource UID `prometheus`; dashboard UID `estate-server-m14` with request rate, error rate, p95, p99, PENDING, FAILED, and lag panels.

- [ ] **Step 1: 구성 부재를 실패로 확인**

Run: `docker compose config --services`

Expected before change: output contains `postgres`, `redis`, `kafka` but not `prometheus` or `grafana`.

- [ ] **Step 2: Prometheus scrape와 datasource 파일 작성**

Create `ops/prometheus/prometheus.yml`:

```yaml
global:
  scrape_interval: 15s
scrape_configs:
  - job_name: estate-server
    static_configs:
      - targets: ['host.docker.internal:3000']
```

Create datasource provisioning with `apiVersion: 1`, name/uid `prometheus`, type `prometheus`, access `proxy`, url `http://prometheus:9090`, and `isDefault: true`. Create dashboard provider with `options.path: /var/lib/grafana/dashboards`, `updateIntervalSeconds: 10`, and `allowUiUpdates: false`.

- [ ] **Step 3: Compose와 dashboard JSON 작성**

Add `prometheus` (`prom/prometheus`, port `9090:9090`, read-only config mount) and `grafana` (`grafana/grafana`, port `3001:3000`, provisioning and dashboard mounts) services. Add `extra_hosts: ['host.docker.internal:host-gateway']` to Prometheus for Linux compatibility; preserve existing PG/Redis/Kafka services.

Dashboard JSON must be valid JSON and contain these exact PromQL expressions:

```text
sum(rate(http_requests_total[5m]))
sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 1)
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
histogram_quantile(0.99, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
outbox_events_pending
outbox_events_failed
sum by (group) (kafka_consumer_lag)
```

Set dashboard title `Estate Server M14 Metrics`, refresh `15s`, datasource UID `prometheus`, and panel units `reqps`, `percentunit`, `s`, `short`, `short`, `short`, `short` respectively.

- [ ] **Step 4: 정적 문법과 수동 scrape 검증**

Run: `docker compose config --quiet`

Expected: no output, exit code 0.

Run: `pnpm start:dev` in terminal A; `docker compose up -d prometheus grafana` in terminal B; then `curl -fsS http://localhost:9090/api/v1/targets`.

Expected: JSON contains `"health":"up"` and `host.docker.internal:3000`. `curl -fsS http://localhost:3001/api/health` expected `"database":"ok"`.

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml ops/prometheus/prometheus.yml ops/grafana/provisioning
git commit -m "[M14]feat: Prometheus 수집과 Grafana 대시보드 프로비저닝"
```

---

### Task 8: 통제 실험과 결과 문서

**Files:**
- Create: `load/results/m14-metrics.md`

**Interfaces:**
- Consumes: T1~T7 전체 스택, `pnpm load:read`, `pnpm load:create`, outbox relay/consumer worker scripts, Grafana panels, Sentry 프로젝트.
- Produces: 실행 환경·시간 구간·명령·관측값·스크린샷/쿼리 근거를 담은 RED/PENDING/lag/Sentry 비교 결과 문서.

- [ ] **Step 1: 실험 전 실패 기준선과 환경을 기록**

Create the document with sections `환경`, `RED 기준선`, `Outbox PENDING 통제 실험`, `Kafka lag 통제 실험`, `Sentry와 metrics 비교`, `한계와 결론`. Before starting main, run `curl -fsS http://localhost:9090/api/v1/query?query=up%7Bjob%3D%22estate-server%22%7D`; expected value `0` or empty result. Record Node/pnpm/k6/Docker versions and experiment timestamp instead of estimated values.

- [ ] **Step 2: RED baseline을 k6와 교차 검증**

Start dependencies, main, all workers and relay. Run `pnpm load:seed`, `pnpm load:read`, then `pnpm load:create`. Record k6 `http_reqs`, `http_req_failed`, `http_req_duration p(95)` and query Prometheus over the same window:

```promql
sum(increase(http_requests_total[5m]))
sum(rate(http_requests_total{status=~"5.."}[5m])) / clamp_min(sum(rate(http_requests_total[5m])), 1)
histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket[5m])))
```

Expected: request totals are directionally equal after excluding `/metrics` scrape traffic by route, error rate matches k6, and p95 is in the same order of magnitude. Record actual deltas and explain histogram-window/bucket differences; do not manufacture equality.

- [ ] **Step 3: relay 정지 전후 PENDING 증가·배수 실험**

Stop only `pnpm start:worker:outbox`, run `pnpm load:create`, and query `outbox_events_pending` every 15s. Expected: PENDING rises above its pre-stop baseline while Sentry receives no new exception. Restart the relay and wait until `outbox_events_pending` returns to 0; record peak, time-to-peak, drain duration, and `outbox_events_failed`.

- [ ] **Step 4: consumer 정지 전후 lag 증가·소진 실험**

Stop only `pnpm start:worker:persistence`, generate chat events through the existing chat flow, and query `kafka_consumer_lag{group="persistence-worker"}`. Expected: lag rises above 0. Restart the same worker and wait until all partitions return to 0; record peak group sum, affected topic/partitions, and drain duration. Keep relay and other consumers running so the worker stop is the only changed variable.

- [ ] **Step 5: 비교 결론·검증·Commit**

In the final table contrast: stack trace/root cause (Sentry), aggregated backlog/time trend (metrics), relay pause signal, consumer pause signal. Explicitly record that the two controlled backlogs generated no Sentry event while metrics captured and drained them; if reality differs, record the exception and cause.

Run: `rg -n "RED 기준선|PENDING|kafka_consumer_lag|Sentry|한계와 결론" load/results/m14-metrics.md`

Expected: all six evidence categories present.

```bash
git add load/results/m14-metrics.md
git commit -m "[M14]test: RED와 이벤트 적체 통제 실험 결과 기록"
```

---

### Task 9: README 마일스톤·관측성·API 문서화

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: T8의 실제 수치와 한계, unauthenticated `GET /metrics`, Prometheus `:9090`, Grafana `:3001`.
- Produces: M14 `✅`, 관측성 스택/실행법, 운영·견고함 M14 완료 서술, §6 API 표의 메트릭 endpoint.

- [ ] **Step 1: 문서의 현재 미완료 상태 확인**

Run: `rg -n "M14.*📋|관측성.*Sentry|GET /metrics" README.md`

Expected: M14 `📋`, 관측성 행은 Sentry만 포함, `GET /metrics` API 행 없음.

- [ ] **Step 2: 마일스톤과 관측성 설명 갱신**

Change M14 row `📋` to `✅`. Change the tech-stack observability row to `Sentry, prom-client, Prometheus, Grafana` and distinguish individual error tracing from aggregated time series. Update the `운영·견고함 후속` heading to include M14 and replace the planned M14 paragraph with completed implementation, T8 measured peaks/drain durations, Sentry silence comparison, and network-level protection requirement for the unauthenticated endpoint.

- [ ] **Step 3: 실행 섹션과 §6 API 표 갱신**

Add commands:

```bash
docker compose up -d prometheus grafana
# main은 호스트 :3000, Prometheus UI는 :9090, Grafana는 :3001
```

Add an `Observability (M14)` API table under §6:

```markdown
| 메서드·경로 | 기능 | 인가 |
|---|---|---|
| `GET /metrics` | Prometheus 형식의 RED·Outbox depth·Kafka consumer lag 조회 | 인증 없음(운영망에서 네트워크 접근 제한 필수) |
```

Also state that Swagger documents the endpoint and that no API key belongs in `VITE_`/`NEXT_PUBLIC_` variables.

- [ ] **Step 4: 최종 회귀와 문서 검증**

Run: `pnpm test -- --runInBand && pnpm build && pnpm lint:check`

Expected: all tests PASS, build/lint exit code 0.

Run: `rg -n "M14.*✅|GET /metrics|Prometheus.*Grafana|네트워크 접근 제한" README.md`

Expected: each completion/API/security statement appears at least once.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "[M14]docs: 메트릭 대시보드 실행법과 API 문서화"
```

---

## Final Verification

- [ ] Checkout/use branch `feature/M14-metrics-dashboard`; confirm `git status --short` contains no unrelated files.
- [ ] Run `pnpm test -- --runInBand`; expected all Jest suites PASS.
- [ ] Run `pnpm build && pnpm lint:check`; expected exit code 0 and lint warning 0.
- [ ] Run `docker compose config --quiet`; expected exit code 0.
- [ ] With the stack running, run `curl -fsS http://localhost:3000/metrics | rg "http_requests_total|http_request_duration_seconds|outbox_events_pending|outbox_events_failed|kafka_consumer_lag"`; expected all five application metric names.
- [ ] Verify `/metrics` is not internet-public in the deployment network policy/firewall. The endpoint intentionally has no application authentication; infrastructure restriction is mandatory.
- [ ] Before PR, attach this plan path and `load/results/m14-metrics.md` in the Korean PR body. Rebase and push exactly as required: `git fetch origin`, `git rebase origin/<base>`, `git push --force-with-lease`.

## Self-Review

**1. Spec coverage:** §3 main single exposure and HTTP-less workers → T1/T2/T5; §4 module components → T1/T3/T4/T5; §5 five metrics, histogram buckets, route cardinality → T3/T4/T5; §6 on-scrape, timeouts, Admin lifecycle → T4/T5; §7 Prometheus/Grafana provisioning and seven panels → T7; §8 controlled experiments → T8; §9 no new env toggle, unauthenticated endpoint/network restriction, Sentry exclusion → T5/T6/T9; §10 excluded worker process metrics/Alertmanager/Pushgateway remain absent.

**2. Placeholder scan:** `TBD`, `TODO`, `적절히 처리`, 내용 없는 “테스트 추가”, 후속 구현 placeholder가 없다. T7/T8의 환경 의존 검증은 실행 명령, 관측 쿼리, 기록 필드와 기대 상태를 모두 명시했다.

**3. Type/signature consistency:** T1의 `METRICS_REGISTRY`를 T3~T5가 공유하고, T2의 `ConsumerGroupId`를 T5 map key가 사용한다. T4/T5의 public `collect(): Promise<void>`는 test와 prom-client async collect 양쪽에서 동일하며, T5 `KAFKA_ADMIN` provider의 `Admin` lifecycle이 collector signature와 일치한다.

**4. Security review:** `/metrics`는 스펙대로 인증하지 않되 T9와 Final Verification에서 네트워크 제한을 필수화한다. 신규 사용자/구독/사용량 테이블이나 민감 API 키가 없어 RLS·RBAC 변경 대상은 아니며, client-exposed env도 추가하지 않는다.
