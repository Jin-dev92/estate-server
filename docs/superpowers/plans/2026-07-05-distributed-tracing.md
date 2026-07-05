# M10.5 분산 트레이싱 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** HTTP 요청에서 시작된 Sentry trace가 Outbox·Kafka·워커까지 하나로 이어지도록 프로세스 경계에서 trace 컨텍스트를 전파한다.

**Architecture:** `@sentry/nestjs`(v10, OpenTelemetry 기반)의 `getTraceData()`(inject)·`continueTrace()`(extract)를 얇은 헬퍼로 감싼다. 발행 측은 "현재 활성 trace"를 Kafka 메시지 헤더에 싣고, 지연 발행되는 Outbox 경로는 컨텍스트를 `OutboxEvent.traceContext` 컬럼에 캡처했다 relay가 `continueTrace`로 되살려 재발행한다. 워커는 헤더에서 컨텍스트를 복원해 처리를 자식 span으로 실행한다.

**Tech Stack:** NestJS, `@sentry/nestjs@^10.58`, `@nestjs/microservices@^11.1`(Kafka), Prisma(PostgreSQL), Jest.

**참조 스펙:** `docs/superpowers/specs/2026-07-04-distributed-tracing-design.md`

## Global Constraints

- **비침습**: 트레이싱 코드는 실패·비활성(Sentry DSN 없음)·헤더 부재에도 이벤트 발행/소비를 절대 막지 않는다. 모든 트레이싱 호출은 try/catch로 감싸 폴백한다.
- **전파 캐리어 = Kafka 메시지 헤더.** 키는 Sentry 표준 `sentry-trace`·`baggage`(상수로 관리). 도메인 이벤트 봉투(payload)에 관측 정보를 넣지 않는다.
- **EventPublisher 포트 시그니처는 변경하지 않는다.** publisher는 항상 "현재 활성 trace"를 캡처한다. Outbox 경로의 컨텍스트 복원은 relay가 `continueTrace`로 담당한다.
- 범위: 프로세스 경계 전파만. 프로세스 내부 DB·Redis 커스텀 span은 추가하지 않는다(Sentry 자동 계측에 위임).
- 매직 스트링 금지: 헤더 키·span 이름은 상수/옵션 객체로. 커밋 `[M10.5]{type}: {한글}`. push 전 `npm run lint:check` 필수.

---

### Task 1: 트레이싱 헬퍼 (deep module)

**Files:**
- Create: `src/common/tracing/trace-propagation.ts`
- Test: `src/common/tracing/trace-propagation.spec.ts`

**Interfaces:**
- Consumes: `@sentry/nestjs`(`getTraceData`, `continueTrace`, `startSpan`), `@nestjs/microservices`(`KafkaContext` 타입).
- Produces:
  - `SENTRY_TRACE_HEADER = 'sentry-trace'`, `BAGGAGE_HEADER = 'baggage'`
  - `interface SpanOptions { name: string; op: string }`
  - `captureTraceHeaders(): Record<string, string>`
  - `continueTraceFromHeaders<T>(headers: Record<string, string | undefined>, span: SpanOptions, fn: () => T): T`
  - `kafkaTraceHeaders(ctx: KafkaContext): Record<string, string>`

- [ ] **Step 1: 실패하는 스펙 작성**

Create `src/common/tracing/trace-propagation.spec.ts`:

```ts
import {
  captureTraceHeaders,
  continueTraceFromHeaders,
  SENTRY_TRACE_HEADER,
} from './trace-propagation';

describe('trace-propagation', () => {
  describe('captureTraceHeaders', () => {
    it('Sentry 미초기화 상태에서도 던지지 않고 객체를 반환한다', () => {
      const headers = captureTraceHeaders();

      expect(typeof headers).toBe('object');
      expect(headers).not.toBeNull();
    });
  });

  describe('continueTraceFromHeaders', () => {
    it('헤더가 있어도 fn을 실행하고 그 반환값을 돌려준다', () => {
      const span = { name: 'test', op: 'test' };
      const headers = { [SENTRY_TRACE_HEADER]: 'abc-123-1' };

      const result = continueTraceFromHeaders(headers, span, () => 42);

      expect(result).toBe(42);
    });

    it('헤더가 없으면 폴백으로 fn을 그대로 실행한다', () => {
      const span = { name: 'test', op: 'test' };

      const result = continueTraceFromHeaders({}, span, () => 'ok');

      expect(result).toBe('ok');
    });

    it('비동기 fn의 Promise를 그대로 전달한다', async () => {
      const span = { name: 'test', op: 'test' };

      const result = continueTraceFromHeaders({}, span, () =>
        Promise.resolve('async-ok'),
      );

      await expect(result).resolves.toBe('async-ok');
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npm test -- trace-propagation`
Expected: FAIL — `Cannot find module './trace-propagation'`.

- [ ] **Step 3: 헬퍼 구현**

Create `src/common/tracing/trace-propagation.ts`:

```ts
import * as Sentry from '@sentry/nestjs';
import { KafkaContext } from '@nestjs/microservices';

// Kafka 헤더로 실어 나를 trace 전파 헤더 키(Sentry 표준). W3C baggage와 호환.
export const SENTRY_TRACE_HEADER = 'sentry-trace';
export const BAGGAGE_HEADER = 'baggage';

export interface SpanOptions {
  name: string; // span 표시 이름(예: 'outbox.publish')
  op: string; // span 종류(예: 'queue.publish')
}

// 현재 활성 trace를 전파용 헤더 맵으로 직렬화한다(inject).
// Sentry 비활성/실패 시 빈 맵 — 호출부는 그대로 Kafka 헤더에 펼치면 된다(비침습).
export function captureTraceHeaders(): Record<string, string> {
  try {
    const data = Sentry.getTraceData();
    const headers: Record<string, string> = {};
    const trace = data[SENTRY_TRACE_HEADER];
    const baggage = data[BAGGAGE_HEADER];
    if (trace) headers[SENTRY_TRACE_HEADER] = trace;
    if (baggage) headers[BAGGAGE_HEADER] = baggage;
    return headers;
  } catch {
    return {};
  }
}

// 헤더에서 trace를 복원(extract)해 fn을 그 trace의 자식 span으로 실행한다.
// 헤더 없음/실패 시 fn을 그대로 실행(새 trace로 폴백). 비침습.
export function continueTraceFromHeaders<T>(
  headers: Record<string, string | undefined>,
  span: SpanOptions,
  fn: () => T,
): T {
  try {
    const sentryTrace = headers[SENTRY_TRACE_HEADER];
    const baggage = headers[BAGGAGE_HEADER];
    if (!sentryTrace) return fn();
    return Sentry.continueTrace({ sentryTrace, baggage }, () =>
      Sentry.startSpan(span, () => fn()),
    );
  } catch {
    return fn();
  }
}

// Kafka 메시지 헤더(Buffer 값)에서 전파 헤더 2개를 문자열로 뽑는다.
export function kafkaTraceHeaders(ctx: KafkaContext): Record<string, string> {
  try {
    const raw = ctx.getMessage().headers ?? {};
    const out: Record<string, string> = {};
    for (const key of [SENTRY_TRACE_HEADER, BAGGAGE_HEADER]) {
      const v = raw[key];
      if (v != null) out[key] = v.toString();
    }
    return out;
  } catch {
    return {};
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- trace-propagation`
Expected: PASS (4 케이스). (Sentry 미초기화 시 `getTraceData`/`continueTrace`/`startSpan`은 콜백을 그대로 실행하는 no-op이라 테스트가 통과한다.)

- [ ] **Step 5: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/common/tracing/trace-propagation.ts src/common/tracing/trace-propagation.spec.ts
git commit -m "[M10.5]feat: trace 전파 헬퍼(캡처·이어받기·Kafka 헤더 추출)"
```

---

### Task 2: OutboxEvent.traceContext 컬럼 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (`model OutboxEvent`)

**Interfaces:**
- Produces: Prisma Client `OutboxEvent.traceContext` (nullable Json).

- [ ] **Step 1: 스키마에 컬럼 추가**

`prisma/schema.prisma`의 `model OutboxEvent { ... }`에서 `lastError`/`failedAt` 근처(스칼라 필드 영역)에 추가:

```prisma
  traceContext Json? // 발행 시점 trace 전파 헤더({ 'sentry-trace', baggage }). 없으면 null.
```

- [ ] **Step 2: 마이그레이션 생성·적용**

로컬 DB 필요(`docker compose up -d`).

Run: `npx prisma migrate dev --name add_outbox_trace_context`
Expected: `Applying migration ...add_outbox_trace_context`, `✔ Generated Prisma Client`. `prisma/migrations/<ts>_add_outbox_trace_context/migration.sql` 생성(=`ALTER TABLE "OutboxEvent" ADD COLUMN "traceContext" JSONB;`).

- [ ] **Step 3: 빌드로 타입 생성 확인**

Run: `npm run build`
Expected: 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "[M10.5]feat: OutboxEvent에 traceContext 컬럼 추가"
```

---

### Task 3: Outbox 캡처·전달 (store)

**Files:**
- Modify: `src/outbox/domain/outbox-record.ts`
- Modify: `src/outbox/infrastructure/prisma-outbox-store.ts`
- Test: `src/outbox/infrastructure/prisma-outbox-store.spec.ts` (케이스 추가)

**Interfaces:**
- Consumes: `captureTraceHeaders`(Task 1).
- Produces: `OutboxRecord.traceContext?: Record<string, string>` — relay(Task 5)가 읽는다.

- [ ] **Step 1: OutboxRecord에 필드 추가**

`src/outbox/domain/outbox-record.ts`의 `OutboxRecord`에 추가:

```ts
  traceContext?: Record<string, string>; // 발행 시점 trace 전파 헤더(없으면 undefined)
```

- [ ] **Step 2: 스펙에 실패 케이스 추가**

`src/outbox/infrastructure/prisma-outbox-store.spec.ts`를 연다. 기존 mock prisma 패턴을 따라 `add`가 `traceContext`를 저장하는지 검증하는 케이스를 추가한다. 기존 파일의 mock 구조에 맞춰, `outboxEvent.create` 호출 인자에 `traceContext` 키가 포함되는지 확인:

```ts
  it('add는 캡처한 trace 헤더를 traceContext로 저장한다', async () => {
    // Sentry 미초기화라 captureTraceHeaders()는 {} 를 반환 → traceContext에 {}가 담긴다.
    // (핵심: create data에 traceContext 키가 전달되는지)
    const create = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { create } } as unknown as TransactionClient;

    await store.add(sampleEvent, tx);

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          traceContext: expect.any(Object) as object,
        }) as object,
      }),
    );
  });
```

> 파일 상단 import·`sampleEvent`·`store` 구성은 기존 spec의 것을 재사용한다. 없으면 기존 spec의 셋업 패턴(mock prisma + `new PrismaOutboxStore(...)`)을 그대로 따른다.

- [ ] **Step 3: 실패 확인**

Run: `npm test -- prisma-outbox-store`
Expected: FAIL — `create` 인자에 `traceContext` 없음.

- [ ] **Step 4: add 구현 수정**

`src/outbox/infrastructure/prisma-outbox-store.ts`:
- 상단 import 추가: `import { captureTraceHeaders } from '../../common/tracing/trace-propagation';`
- `add`의 `create({ data: {...} })`에 `traceContext` 추가:

```ts
  async add(event: DomainEvent, tx: TransactionClient): Promise<void> {
    await tx.outboxEvent.create({
      data: {
        eventId: event.eventId,
        eventType: event.eventType,
        topic: topicForEvent(event.eventType),
        partitionKey: event.entityId,
        payload: event as unknown as Prisma.InputJsonValue,
        status: OutboxStatus.Pending,
        // 발행 시점(=요청 컨텍스트)의 trace를 캡처해 저장. relay가 되살려 재발행한다.
        traceContext: captureTraceHeaders() as unknown as Prisma.InputJsonValue,
      },
    });
  }
```

- `OutboxRow` 인터페이스에 `traceContext: Record<string, string> | null;` 추가.
- `fetchPending`의 SELECT 목록에 `"traceContext"` 추가:
  ```ts
  SELECT id, "eventId", "eventType", topic, "partitionKey", payload, attempts, "traceContext"
  ```
- `fetchPending`의 `rows.map`에 매핑 추가:
  ```ts
      traceContext: r.traceContext ?? undefined,
  ```

- [ ] **Step 5: 통과 확인 + 전체 회귀**

Run: `npm test -- prisma-outbox-store` → PASS.
Run: `npm test` → 전 스위트 PASS.

- [ ] **Step 6: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/outbox/domain/outbox-record.ts src/outbox/infrastructure/prisma-outbox-store.ts src/outbox/infrastructure/prisma-outbox-store.spec.ts
git commit -m "[M10.5]feat: Outbox add가 trace 캡처·저장, fetchPending이 전달"
```

---

### Task 4: 발행 측 Kafka 헤더 부착 (publisher)

**Files:**
- Modify: `src/events/kafka-event.publisher.ts`
- Test: `src/events/kafka-event.publisher.spec.ts` (케이스 추가)

**Interfaces:**
- Consumes: `captureTraceHeaders`(Task 1).
- Produces: 모든 발행(`publish`·`publishOrThrow`)이 현재 활성 trace 헤더를 Kafka 메시지 `headers`에 실어 보낸다. 포트 시그니처 불변.

- [ ] **Step 1: 스펙에 실패 케이스 추가**

`src/events/kafka-event.publisher.spec.ts`를 연다. 기존 mock `ClientKafka`(`emit` mock) 패턴을 따라, emit 호출 시 메시지에 `headers`가 포함되는지 검증하는 케이스를 추가:

```ts
  it('emit 메시지에 trace 전파용 headers를 포함한다', async () => {
    // Sentry 미초기화라 headers는 {} 지만, 메시지에 headers 키 자체가 실려야 한다.
    await publisher.publishOrThrow(sampleEvent);

    expect(emit).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        key: sampleEvent.entityId,
        value: sampleEvent,
        headers: expect.any(Object) as object,
      }),
    );
  });
```

> `emit`·`publisher`·`sampleEvent` 셋업은 기존 spec의 것을 재사용한다(`emit`은 `of(undefined)` 등 observable을 반환하도록 mock돼 있을 것).

- [ ] **Step 2: 실패 확인**

Run: `npm test -- kafka-event.publisher`
Expected: FAIL — emit 인자에 `headers` 없음.

- [ ] **Step 3: emit 수정**

`src/events/kafka-event.publisher.ts`:
- 상단 import 추가: `import { captureTraceHeaders } from '../common/tracing/trace-propagation';`
- `emit` private 메서드 수정:

```ts
  private emit(event: DomainEvent): Promise<void> {
    const topic = topicForEvent(event.eventType);
    // 현재 활성 trace를 Kafka 헤더로 전파(직접 발행 경로). Outbox 경로는 relay가
    // continueTrace로 컨텍스트를 되살린 뒤 이 메서드를 타므로, 여기 한 곳이면 충분하다.
    const headers = captureTraceHeaders();
    return firstValueFrom(
      this.client.emit(topic, { key: event.entityId, value: event, headers }),
    ).then(() => undefined);
  }
```

- [ ] **Step 4: 통과 확인**

Run: `npm test -- kafka-event.publisher`
Expected: PASS.

- [ ] **Step 5: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/events/kafka-event.publisher.ts src/events/kafka-event.publisher.spec.ts
git commit -m "[M10.5]feat: Kafka 발행 메시지에 현재 trace 헤더 부착"
```

---

### Task 5: relay가 저장된 컨텍스트로 발행 (continueTrace)

**Files:**
- Modify: `src/outbox/application/relay-outbox.use-case.ts`
- Test: `src/outbox/application/relay-outbox.use-case.spec.ts` (케이스 보강)

**Interfaces:**
- Consumes: `continueTraceFromHeaders`(Task 1), `OutboxRecord.traceContext`(Task 3).
- Produces: relay가 각 outbox 행의 `traceContext`를 되살린 컨텍스트 안에서 `publishOrThrow`를 호출 → 원본 trace가 이어짐.

- [ ] **Step 1: 스펙 보강(발행이 여전히 호출되는지)**

`src/outbox/application/relay-outbox.use-case.spec.ts`에서 기존 "정상 발행" 케이스를 확인한다. `continueTraceFromHeaders`로 감싸도 `publishOrThrow`가 호출되고 `markPublished`가 뒤따르는지 검증하는 단언이 있는지 보고, 없으면 추가한다(예: `publishOrThrow`가 `row.payload`로 1회 호출). `traceContext`가 있는 행과 없는(undefined) 행 모두 발행되는지 케이스를 둔다:

```ts
  it('traceContext 유무와 무관하게 각 행을 발행한다', async () => {
    // fetchPending fake가 traceContext 있는 행 1 + 없는 행 1을 반환하도록 구성
    // (기존 spec의 row 팩토리에 traceContext 필드만 추가)
    await useCase.execute();

    expect(published).toHaveLength(2); // publishOrThrow가 두 행 모두에 대해 호출됨
  });
```

> 기존 spec의 fake `outbox`/`publisher` 구조를 재사용한다. `published`는 `publishOrThrow`가 받은 payload를 모으는 스파이.

- [ ] **Step 2: 실패/현행 확인**

Run: `npm test -- relay-outbox.use-case`
Expected: 기존 케이스는 통과. 새 케이스가 row 팩토리에 `traceContext`를 요구하면 그에 맞춰 통과하도록 한다(구현 전이라도 발행 자체는 동작하므로, 이 태스크의 실패 지점은 "continueTrace 배선"이 아니라 회귀 없음 확인이다).

- [ ] **Step 3: relay 발행부 수정**

`src/outbox/application/relay-outbox.use-case.ts`:
- 상단 import 추가: `import { continueTraceFromHeaders } from '../../common/tracing/trace-propagation';`
- 발행 루프에서 `publishOrThrow` 호출을 `continueTraceFromHeaders`로 감싼다:

```ts
      for (const row of rows) {
        try {
          await continueTraceFromHeaders(
            row.traceContext ?? {},
            { name: 'outbox.publish', op: 'queue.publish' },
            () => this.publisher.publishOrThrow(row.payload),
          );
          await this.outbox.markPublished(row.id, tx);
        } catch (err) {
          // 기존 markFailed 재시도 로직은 그대로 둔다.
          ...
        }
      }
```

> 기존 try/catch·markFailed 구조는 유지하고, `publishOrThrow` 호출만 `continueTraceFromHeaders(...)`로 감싼다. 저장된 컨텍스트를 되살린 상태에서 발행하므로, publisher(Task 4)의 `captureTraceHeaders()`가 원본 trace를 그대로 Kafka 헤더에 싣는다.

- [ ] **Step 4: 통과 확인 + 전체 회귀**

Run: `npm test -- relay-outbox.use-case` → PASS.
Run: `npm test` → 전 스위트 PASS.

- [ ] **Step 5: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/outbox/application/relay-outbox.use-case.ts src/outbox/application/relay-outbox.use-case.spec.ts
git commit -m "[M10.5]feat: relay가 저장된 컨텍스트를 되살려 발행(continueTrace)"
```

---

### Task 6: 워커가 헤더에서 trace 이어받기 (consumer)

**Files:**
- Modify: `src/notification/interface/notification-worker.controller.ts`
- Modify: `src/audit/interface/audit-worker.controller.ts`
- Modify: `src/chat/infrastructure/chat-persistence.controller.ts`
- Test: 위 3개의 `*.spec.ts` (핸들러 시그니처 변경 반영)

**Interfaces:**
- Consumes: `continueTraceFromHeaders`·`kafkaTraceHeaders`(Task 1), `@Ctx() KafkaContext`.
- Produces: 각 워커 핸들러가 Kafka 헤더에서 trace를 복원한 자식 span 안에서 use-case를 실행.

- [ ] **Step 1: notification-worker 스펙 갱신**

`src/notification/interface/notification-worker.controller.spec.ts`: 핸들러가 이제 `(event, ctx)` 2인자다. 가짜 `KafkaContext`(헤더 맵 제공)를 만들어 넘기고, `handle.execute`가 여전히 event로 호출되는지 검증:

```ts
  const fakeCtx = {
    getMessage: () => ({ headers: {} }),
  } as unknown as import('@nestjs/microservices').KafkaContext;
```
기존 `controller.onChatEvent(event)` 호출을 `controller.onChatEvent(event, fakeCtx)`로, `onBoardEvent`도 동일하게 바꾸고 `expect(handled).toHaveLength(2)` 단언은 유지.

- [ ] **Step 2: 실패 확인**

Run: `npm test -- notification-worker.controller`
Expected: FAIL — 핸들러가 2번째 인자를 아직 안 받음(또는 타입 불일치).

- [ ] **Step 3: notification-worker 컨트롤러 수정**

`src/notification/interface/notification-worker.controller.ts`:
- import 추가:
  ```ts
  import { EventPattern, Payload, Ctx, KafkaContext } from '@nestjs/microservices';
  import {
    continueTraceFromHeaders,
    kafkaTraceHeaders,
  } from '../../common/tracing/trace-propagation';
  ```
- 두 핸들러를 각각 수정:
  ```ts
  @EventPattern(KafkaTopic.ChatEvents)
  async onChatEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      { name: 'notification.handle', op: 'queue.process' },
      () => this.handle.execute(event),
    );
  }

  @EventPattern(KafkaTopic.BoardEvents)
  async onBoardEvent(
    @Payload() event: DomainEvent,
    @Ctx() ctx: KafkaContext,
  ): Promise<void> {
    await continueTraceFromHeaders(
      kafkaTraceHeaders(ctx),
      { name: 'notification.handle', op: 'queue.process' },
      () => this.handle.execute(event),
    );
  }
  ```

- [ ] **Step 4: notification-worker 통과 확인**

Run: `npm test -- notification-worker.controller`
Expected: PASS.

- [ ] **Step 5: audit-worker 동일 적용**

`src/audit/interface/audit-worker.controller.ts`의 핸들러(들)에 같은 패턴 적용(`@Ctx() ctx` 추가 + `continueTraceFromHeaders(kafkaTraceHeaders(ctx), { name: 'audit.handle', op: 'queue.process' }, () => ...)`). 해당 spec도 fakeCtx 인자를 넘기도록 갱신. `npm test -- audit-worker.controller` → PASS.

- [ ] **Step 6: chat-persistence 동일 적용**

`src/chat/infrastructure/chat-persistence.controller.ts`의 핸들러에 같은 패턴 적용(span 이름 `{ name: 'chat.persist', op: 'queue.process' }`). 해당 spec 갱신. `npm test -- chat-persistence` → PASS.

- [ ] **Step 7: 전체 회귀 + build + lint + Commit**

Run: `npm test` → 전 스위트 PASS. `npm run build` → 에러 없음.
```bash
npm run lint:check
git add src/notification/interface/notification-worker.controller.ts src/notification/interface/notification-worker.controller.spec.ts src/audit/interface/audit-worker.controller.ts src/audit/interface/audit-worker.controller.spec.ts src/chat/infrastructure/chat-persistence.controller.ts
git add src/chat/infrastructure/*persistence*.spec.ts 2>/dev/null || true
git commit -m "[M10.5]feat: 워커 3종이 Kafka 헤더에서 trace 이어받기(continueTrace)"
```

---

### Task 7: README·학습 노트 문서화

**Files:**
- Modify: `README.md` (마일스톤 표 M10.5 상태 갱신)
- Modify: `docs/study/마일스톤-학습-노트.md` (M10.5 항목)

**Interfaces:**
- Consumes: 없음(문서만).

- [ ] **Step 1: README 마일스톤 표 갱신**

`README.md`의 개발 마일스톤 표에서 M10.5 행을 `*(예정)*` → `✅`로 바꾸고 설명을 갱신:
```markdown
| **M10.5** ✅ | 분산 트레이싱: HTTP→Outbox→Kafka→워커 trace 컨텍스트 전파 | W3C/Sentry 컨텍스트 전파·Kafka 헤더 캐리어·Outbox 지연 발행 연계 |
```

- [ ] **Step 2: 학습 노트 항목 추가**

`docs/study/마일스톤-학습-노트.md`에 M10.5 섹션 추가(기존 노트 형식·번호 체계를 따른다). 내용: trace/span/컨텍스트 전파 개념, 프로세스 경계에서 trace가 끊기는 이유, Outbox 지연 발행 때문에 컨텍스트를 DB에 저장했다 되살리는 설계, `getTraceData`/`continueTrace` API, best-effort 비침습 원칙. 어투는 CLAUDE.md 문서 규칙(해설 격식체)을 따른다.

- [ ] **Step 3: Commit**

```bash
git add README.md docs/study/마일스톤-학습-노트.md
git commit -m "[M10.5]docs: 분산 트레이싱 마일스톤·학습 노트 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- §2 결정(Sentry 확장·Kafka 헤더·비침습) → 전 태스크 Global Constraints ✓
- §3 흐름(경로 A 직접발행 / 경로 B outbox / 워커 continue) → Task 4(A·emit)·Task 3+5(B)·Task 6(워커) ✓
- §4.1 헬퍼 → Task 1 ✓ / §4.2 발행 측 → Task 3(캡처)·4(emit)·5(relay) ✓ / §4.3 소비 측 → Task 6 ✓
- §5 스키마 traceContext → Task 2, 읽기경로 → Task 3 ✓
- §6 비침습(try/catch·폴백) → Task 1 헬퍼가 전담, 호출부는 빈 맵/폴백 ✓
- §7 테스트(헬퍼·배선·폴백) → Task 1·3·4·5·6 스펙 ✓
- §8 API 확정 → 플랜 작성 중 Sentry 문서·설치본으로 확정(getTraceData/continueTrace, emit headers, KafkaContext) ✓
- §9 검증(문서 데모는 DSN 필요) → 코드는 no-op 안전, 데모는 수동 ✓

**2. Placeholder scan:** TBD/TODO 없음. 기존 spec 셋업 재사용 지시는 "기존 파일의 mock 구조를 따른다"로 구체화(해당 spec들이 실재).

**3. Type consistency:**
- `captureTraceHeaders(): Record<string,string>` / `continueTraceFromHeaders(headers, span, fn)` / `kafkaTraceHeaders(ctx)` 시그니처가 Task 1 정의와 Task 3·4·5·6 사용에서 일치.
- `SpanOptions {name, op}` 형태가 relay·워커 호출에서 일치.
- `OutboxRecord.traceContext?: Record<string,string>`가 Task 3 정의·Task 5 사용에서 일치.
- 헤더 키 상수 `SENTRY_TRACE_HEADER`/`BAGGAGE_HEADER`가 캡처·추출·Kafka 변환에서 단일 출처.

**참고**: 실제 trace 연결 시각화는 Sentry DSN 설정 시에만 확인 가능(§9). 단위 테스트는 헤더가 경로를 타고 흐르는 배선만 검증한다.
