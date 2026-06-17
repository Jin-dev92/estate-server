# M9 Outbox DLQ·재시도 백오프 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Outbox relay의 무한 재시도를 없애고, 발행 실패를 **지수 백오프**로 재시도하다 **MAX_ATTEMPTS 초과 시 FAILED로 격리**(DLQ)한다.

**Architecture:** `OutboxEvent`에 `nextAttemptAt`/`lastError`/`failedAt` 컬럼과 `FAILED` 상태를 추가한다. `fetchPending`은 백오프 대기(`nextAttemptAt > now`) 행을 제외하고, `markFailed(id, attempts, error, tx)`가 백오프 재스케줄 vs FAILED 격리를 결정해 `{ quarantined }`를 반환한다. 백오프는 순수 함수 `computeBackoff`로 분리하고, 정책 파라미터(max/base/cap)는 DI 토큰으로 주입한다.

**Tech Stack:** NestJS, Prisma, PostgreSQL, Jest. 기존 `src/outbox/` 구조(domain/application/infrastructure)와 `OUTBOX_BATCH_SIZE` DI 토큰 패턴을 그대로 따른다.

> 설계 근거: [M9 설계 스펙](../specs/2026-06-17-m9-outbox-dlq-design.md)

---

## 사전 지식 (실행자가 알아야 할 것)

- **Transactional Outbox 현재 구조:** 도메인 변경 + `OutboxEvent` INSERT(PENDING)를 한 트랜잭션으로 커밋하고(`src/outbox/`), 별도 `outbox-relay` 워커가 `setInterval` 폴링으로 PENDING을 `SELECT … FOR UPDATE SKIP LOCKED`로 잠그며 가져와 Kafka 발행 후 PUBLISHED로 마킹한다.
- **현재 실패 처리(고치려는 것):** `markFailed`가 `attempts`만 +1 하고 status를 PENDING으로 유지 → 매 폴링 틱(기본 1초)마다 무한 재시도. poison message가 영영 안 빠진다.
- **테스트 스타일:** `prisma-outbox-store.spec.ts`는 Prisma client를 `jest.fn()`으로 mock(실 DB 아님)하고 `update`/`$queryRaw` **호출 인자**를 검증한다. `relay-outbox.use-case.spec.ts`는 `OutboxStore`/`EventPublisher`를 순수 객체로 mock한다.
- **DI 토큰 패턴:** 숫자 설정은 `outbox.tokens.ts`의 Symbol 토큰으로 만들고 `outbox.module.ts`에서 `ConfigService`로 값을 주입한다(기존 `OUTBOX_BATCH_SIZE` 참고).
- **매직넘버 금지:** 모든 설정값은 `ConfigKey`(`src/config/config-keys.ts`) + `.env.example`에 등록.

---

## File Structure

- **Modify:** `prisma/schema.prisma` — `OutboxEvent`에 컬럼 3개 + 인덱스 교체
- **Create:** `prisma/migrations/<ts>_add_outbox_dlq_backoff/migration.sql` — `prisma migrate dev`가 생성
- **Modify:** `src/outbox/domain/outbox-status.enum.ts` — `Failed` 추가
- **Create:** `src/outbox/domain/backoff.ts` — `computeBackoff` 순수 함수
- **Create:** `src/outbox/domain/backoff.spec.ts` — 단위 테스트
- **Modify:** `src/config/config-keys.ts` — `ConfigKey` 3개
- **Modify:** `.env.example` — env 3개
- **Modify:** `src/outbox/application/outbox.tokens.ts` — DI 토큰 3개
- **Modify:** `src/outbox/outbox.module.ts` — 토큰 provider 3개 + 스토어에 주입
- **Modify:** `src/outbox/domain/outbox-store.ts` — `markFailed` 시그니처 변경
- **Modify:** `src/outbox/infrastructure/prisma-outbox-store.ts` — 생성자 주입 + `markFailed` 분기 + `fetchPending` 필터
- **Modify:** `src/outbox/infrastructure/prisma-outbox-store.spec.ts` — 변경 반영
- **Modify:** `src/outbox/application/relay-outbox.use-case.ts` — 인자 전달 + WARN/ERROR 로깅
- **Modify:** `src/outbox/application/relay-outbox.use-case.spec.ts` — 변경 반영
- **Modify:** `README.md`, `docs/study/마일스톤-학습-노트.md` — 문서

---

## Task 1: 스키마 + 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma` (model OutboxEvent)

- [ ] **Step 1: schema.prisma의 OutboxEvent 모델 수정**

`prisma/schema.prisma`의 `model OutboxEvent { … }`를 아래로 바꾼다(컬럼 3개 추가, status 주석에 FAILED, 인덱스 교체):

```prisma
model OutboxEvent {
  id           String    @id @default(cuid())
  eventId      String    @unique // DomainEvent.eventId — 소비자 멱등 키와 동일
  eventType    String
  topic        String    // 발행 대상 토픽(적재 시 고정)
  partitionKey String    // = entityId, 파티션 순서 보장
  payload      Json      // DomainEvent 전체 봉투
  status       String    @default("PENDING") // OutboxStatus: PENDING | PUBLISHED | FAILED
  createdAt    DateTime  @default(now())
  publishedAt  DateTime?
  attempts     Int       @default(0) // 발행 시도 횟수

  nextAttemptAt DateTime? // 다음 재시도 가능 시각(백오프). NULL=즉시 가능(최초 미시도)
  lastError     String?   // 마지막 실패 사유(왜 poison인지 — DLQ 사후 조사용)
  failedAt      DateTime? // FAILED로 격리된 시각

  @@index([status, nextAttemptAt]) // 폴링 대상 조회(백오프 대기 행 제외)
}
```

- [ ] **Step 2: 마이그레이션 생성·적용 (DB 필요)**

인프라가 떠 있어야 한다(`docker compose up -d`). 실행:

```bash
npx prisma migrate dev --name add_outbox_dlq_backoff
```

Expected: `prisma/migrations/<timestamp>_add_outbox_dlq_backoff/migration.sql`이 생성되고, `ALTER TABLE "OutboxEvent" ADD COLUMN "nextAttemptAt" …, "lastError" …, "failedAt" …` + 인덱스 DROP/CREATE가 포함된다. Prisma Client도 재생성된다(exit 0).

- [ ] **Step 3: 생성된 migration.sql 확인**

Run: `cat prisma/migrations/*add_outbox_dlq_backoff/migration.sql`
Expected: 세 컬럼 `ADD COLUMN`(모두 nullable), 인덱스 `"OutboxEvent_status_createdAt_idx"` DROP + `"OutboxEvent_status_nextAttemptAt_idx"` CREATE. 기존 데이터 손실 구문(DROP COLUMN 등)이 없어야 한다.

- [ ] **Step 4: 빌드 확인**

Run: `npm run build`
Expected: 컴파일 성공(exit 0). 아직 새 컬럼을 쓰는 코드는 없으니 통과한다.

- [ ] **Step 5: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "[M9]feat: OutboxEvent에 백오프·격리 컬럼 추가(마이그레이션)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: OutboxStatus.Failed + computeBackoff 순수 함수 (TDD)

**Files:**
- Modify: `src/outbox/domain/outbox-status.enum.ts`
- Create: `src/outbox/domain/backoff.ts`
- Test: `src/outbox/domain/backoff.spec.ts`

- [ ] **Step 1: OutboxStatus에 Failed 추가**

`src/outbox/domain/outbox-status.enum.ts`를 아래로 수정:

```ts
// outbox 행 상태. 매직스트링 금지 — store·relay가 단일 출처로 참조.
export const enum OutboxStatus {
  Pending = 'PENDING',
  Published = 'PUBLISHED',
  Failed = 'FAILED', // 최대 재시도 초과로 격리된 poison message(더는 폴링 안 함)
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/outbox/domain/backoff.spec.ts` 생성:

```ts
import { computeBackoff } from './backoff';

describe('computeBackoff', () => {
  // 지수 백오프 = base * 2^attempts, 단 cap을 넘지 않는다.
  const BASE = 1000;
  const CAP = 60000;

  it('첫 실패(attempts=0)는 base만큼 기다린다', () => {
    expect(computeBackoff(0, BASE, CAP)).toBe(1000);
  });

  it('attempts가 늘면 2배씩 증가한다', () => {
    expect(computeBackoff(1, BASE, CAP)).toBe(2000);
    expect(computeBackoff(2, BASE, CAP)).toBe(4000);
    expect(computeBackoff(3, BASE, CAP)).toBe(8000);
    expect(computeBackoff(4, BASE, CAP)).toBe(16000);
  });

  it('cap을 넘으면 cap으로 고정된다', () => {
    // 2^6 * 1000 = 64000 > 60000 → cap
    expect(computeBackoff(6, BASE, CAP)).toBe(60000);
    expect(computeBackoff(100, BASE, CAP)).toBe(60000);
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test -- backoff.spec`
Expected: FAIL — `computeBackoff`가 없어 import 에러.

- [ ] **Step 4: computeBackoff 구현**

`src/outbox/domain/backoff.ts` 생성:

```ts
// 지수 백오프 계산(순수 함수). 재시도 간격 = base * 2^attempts, 단 cap을 상한으로.
// attempts는 "지금까지 실패한 횟수"(0-base) → 첫 실패(0)는 base, 그다음 2배씩.
// 순수 함수라 단위 테스트가 쉽고, store가 이 값을 nextAttemptAt 계산에 쓴다.
export function computeBackoff(
  attempts: number,
  baseMs: number,
  capMs: number,
): number {
  const delay = baseMs * 2 ** attempts;
  return Math.min(delay, capMs);
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npm test -- backoff.spec`
Expected: PASS (3 tests).

- [ ] **Step 6: 커밋**

```bash
git add src/outbox/domain/outbox-status.enum.ts src/outbox/domain/backoff.ts src/outbox/domain/backoff.spec.ts
git commit -m "[M9]feat: OutboxStatus.Failed + 지수 백오프 순수 함수(computeBackoff)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Config 키 + .env.example + DI 토큰 + 모듈 배선

**Files:**
- Modify: `src/config/config-keys.ts`
- Modify: `.env.example`
- Modify: `src/outbox/application/outbox.tokens.ts`
- Modify: `src/outbox/outbox.module.ts`

- [ ] **Step 1: ConfigKey 3개 추가**

`src/config/config-keys.ts`에서 `OutboxBatchSize` 줄 바로 아래에 추가:

```ts
  OutboxMaxAttempts = 'OUTBOX_MAX_ATTEMPTS',
  OutboxBackoffBaseMs = 'OUTBOX_BACKOFF_BASE_MS',
  OutboxBackoffCapMs = 'OUTBOX_BACKOFF_CAP_MS',
```

- [ ] **Step 2: .env.example 추가**

`.env.example`에서 `OUTBOX_BATCH_SIZE="100"` 줄 바로 아래에 추가:

```
OUTBOX_MAX_ATTEMPTS="5"
OUTBOX_BACKOFF_BASE_MS="1000"
OUTBOX_BACKOFF_CAP_MS="60000"
```

- [ ] **Step 3: DI 토큰 추가**

`src/outbox/application/outbox.tokens.ts`를 아래로 수정:

```ts
// DI로 주입하는 폴링 배치 크기 토큰(모듈에서 ConfigService로 값을 제공).
export const OUTBOX_BATCH_SIZE = Symbol('OUTBOX_BATCH_SIZE');

// DLQ·백오프 정책 파라미터(모듈에서 ConfigService로 값을 제공).
export const OUTBOX_MAX_ATTEMPTS = Symbol('OUTBOX_MAX_ATTEMPTS'); // 초과 시 FAILED 격리
export const OUTBOX_BACKOFF_BASE_MS = Symbol('OUTBOX_BACKOFF_BASE_MS'); // 지수 백오프 기준
export const OUTBOX_BACKOFF_CAP_MS = Symbol('OUTBOX_BACKOFF_CAP_MS'); // 백오프 상한
```

- [ ] **Step 4: 모듈에 provider 3개 추가**

`src/outbox/outbox.module.ts`의 import 줄을 갱신하고 providers에 토큰 3개를 추가한다.

import 변경(토큰 추가):
```ts
import {
  OUTBOX_BATCH_SIZE,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
} from './application/outbox.tokens';
```

providers 배열에서 `OUTBOX_BATCH_SIZE` provider 객체 바로 아래에 추가:
```ts
    {
      provide: OUTBOX_MAX_ATTEMPTS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxMaxAttempts)) || 5,
    },
    {
      provide: OUTBOX_BACKOFF_BASE_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxBackoffBaseMs)) || 1000,
    },
    {
      provide: OUTBOX_BACKOFF_CAP_MS,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        Number(config.get<string>(ConfigKey.OutboxBackoffCapMs)) || 60000,
    },
```

- [ ] **Step 5: 빌드 확인**

Run: `npm run build`
Expected: 컴파일 성공(exit 0). 토큰 provider는 추가됐지만 아직 주입처가 없어도 무방.

- [ ] **Step 6: 커밋**

```bash
git add src/config/config-keys.ts .env.example src/outbox/application/outbox.tokens.ts src/outbox/outbox.module.ts
git commit -m "[M9]feat: Outbox DLQ 정책 config(max/base/cap) + DI 토큰·모듈 배선

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: markFailed 백오프·격리 동작 (store + use-case, TDD)

> 한 태스크로 묶는 이유: `OutboxStore.markFailed` 시그니처를 바꾸면 store·use-case가 함께 바뀌어야 빌드가 깨지지 않는다.

**Files:**
- Modify: `src/outbox/domain/outbox-store.ts`
- Modify: `src/outbox/infrastructure/prisma-outbox-store.ts`
- Modify: `src/outbox/infrastructure/prisma-outbox-store.spec.ts`
- Modify: `src/outbox/application/relay-outbox.use-case.ts`
- Modify: `src/outbox/application/relay-outbox.use-case.spec.ts`

- [ ] **Step 1: OutboxStore 인터페이스의 markFailed 시그니처 변경**

`src/outbox/domain/outbox-store.ts`의 `markFailed` 줄을 아래로 바꾼다:

```ts
  // 발행 실패: attempts+1. 최대 횟수 미만이면 백오프(nextAttemptAt) 후 재시도,
  // 도달하면 FAILED로 격리한다. 격리 여부를 { quarantined }로 돌려준다(use-case가 로깅).
  markFailed(
    id: string,
    attempts: number,
    error: string,
    tx: TransactionClient,
  ): Promise<{ quarantined: boolean }>;
```

- [ ] **Step 2: store 실패 테스트 작성**

`src/outbox/infrastructure/prisma-outbox-store.spec.ts`를 수정한다.
(a) 맨 위 import에 backoff·status가 이미 있으면 두고, 생성자 호출을 위해 정책 상수를 둔다. 파일 상단(describe 위)에 추가:

```ts
const MAX_ATTEMPTS = 5;
const BASE_MS = 1000;
const CAP_MS = 60000;
```

(b) 기존 `'markFailed는 attempts만 증가시킨다(status 유지)'` 테스트를 **삭제**하고, 아래 두 테스트로 교체한다. 그리고 이 파일의 모든 `new PrismaOutboxStore()` 호출을 `new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS)`로 바꾼다:

```ts
  it('markFailed는 최대 미만이면 백오프(nextAttemptAt) 후 PENDING 유지', async () => {
    const update = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { update } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    const result = await store.markFailed('row1', 0, 'kafka down', tx);

    expect(result).toEqual({ quarantined: false });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: {
        attempts: 1,
        lastError: 'kafka down',
        nextAttemptAt: expect.any(Date) as Date,
      },
    });
  });

  it('markFailed는 최대 도달 시 FAILED로 격리한다', async () => {
    const update = jest.fn().mockResolvedValue({});
    const tx = { outboxEvent: { update } } as unknown as TransactionClient;
    const store = new PrismaOutboxStore(MAX_ATTEMPTS, BASE_MS, CAP_MS);

    // attempts=4 → +1=5 == MAX_ATTEMPTS → 격리
    const result = await store.markFailed('row1', 4, 'permanent', tx);

    expect(result).toEqual({ quarantined: true });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'row1' },
      data: {
        status: OutboxStatus.Failed,
        attempts: 5,
        lastError: 'permanent',
        failedAt: expect.any(Date) as Date,
      },
    });
  });
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `npm test -- prisma-outbox-store.spec`
Expected: FAIL — `new PrismaOutboxStore(...)` 인자 불일치 + `markFailed` 새 시그니처 미구현.

- [ ] **Step 4: PrismaOutboxStore 구현**

`src/outbox/infrastructure/prisma-outbox-store.ts`를 수정한다.

(a) import에 `Inject`, 토큰, `computeBackoff`, `OutboxStatus`(이미 있음) 추가:
```ts
import { Inject, Injectable } from '@nestjs/common';
import {
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_BACKOFF_BASE_MS,
  OUTBOX_BACKOFF_CAP_MS,
} from '../application/outbox.tokens';
import { computeBackoff } from '../domain/backoff';
```

(b) 클래스에 생성자(정책 주입) 추가:
```ts
@Injectable()
export class PrismaOutboxStore implements OutboxStore {
  constructor(
    @Inject(OUTBOX_MAX_ATTEMPTS) private readonly maxAttempts: number,
    @Inject(OUTBOX_BACKOFF_BASE_MS) private readonly baseMs: number,
    @Inject(OUTBOX_BACKOFF_CAP_MS) private readonly capMs: number,
  ) {}
```

(c) `fetchPending`의 WHERE에 백오프 필터 추가(raw SQL):
```ts
    const rows = await tx.$queryRaw<OutboxRow[]>(Prisma.sql`
      SELECT id, "eventId", "eventType", topic, "partitionKey", payload, attempts
      FROM "OutboxEvent"
      WHERE status = ${OutboxStatus.Pending}
        AND ("nextAttemptAt" IS NULL OR "nextAttemptAt" <= now())
      ORDER BY "createdAt" ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    `);
```

(d) `markFailed`를 새 시그니처·분기로 교체:
```ts
  async markFailed(
    id: string,
    attempts: number,
    error: string,
    tx: TransactionClient,
  ): Promise<{ quarantined: boolean }> {
    const nextAttempts = attempts + 1;
    // 최대 도달 → FAILED로 격리(더는 폴링되지 않는다).
    if (nextAttempts >= this.maxAttempts) {
      await tx.outboxEvent.update({
        where: { id },
        data: {
          status: OutboxStatus.Failed,
          attempts: nextAttempts,
          lastError: error,
          failedAt: new Date(),
        },
      });
      return { quarantined: true };
    }
    // 아직 여유 → 지수 백오프 후 재시도(status는 PENDING 유지).
    const delayMs = computeBackoff(attempts, this.baseMs, this.capMs);
    await tx.outboxEvent.update({
      where: { id },
      data: {
        attempts: nextAttempts,
        lastError: error,
        nextAttemptAt: new Date(Date.now() + delayMs),
      },
    });
    return { quarantined: false };
  }
```

- [ ] **Step 5: use-case 호출부·로깅 수정**

`src/outbox/application/relay-outbox.use-case.ts`의 `catch` 블록을 아래로 바꾼다:

```ts
        } catch (err) {
          // emit 실패: store가 백오프 재스케줄 vs FAILED 격리를 결정한다.
          // 한 행 실패가 배치를 막지 않도록 per-row로 처리한다.
          const message = (err as Error).message;
          const { quarantined } = await this.outbox.markFailed(
            row.id,
            row.attempts,
            message,
            tx,
          );
          if (quarantined) {
            // poison message: 더는 재시도하지 않고 DLQ(FAILED)로 격리됨.
            this.logger.error(
              `outbox 발행 영구 실패(FAILED 격리): ${row.eventId} attempts=${row.attempts + 1} ${message}`,
            );
          } else {
            this.logger.warn(
              `outbox 발행 실패(백오프 후 재시도): ${row.eventId} ${message}`,
            );
          }
        }
```

- [ ] **Step 6: use-case 테스트 수정**

`src/outbox/application/relay-outbox.use-case.spec.ts`를 수정한다.
(a) `deps`의 store mock `markFailed`를 새 시그니처로 바꾸고, 호출 인자를 캡처한다. `markFailed`가 기본적으로 `{ quarantined: false }`를 돌려주게 한다:

```ts
  const failed: Array<{ id: string; attempts: number; error: string }> = [];
  const store: OutboxStore = {
    add: () => Promise.resolve(),
    fetchPending: () => Promise.resolve(pending),
    markPublished: (id) => {
      published.push(id);
      return Promise.resolve();
    },
    markFailed: (id, attempts, error) => {
      failed.push({ id, attempts, error });
      return Promise.resolve({ quarantined: false });
    },
  };
```

(b) 기존 `'emit 실패 행은 markFailed(다음 폴링 재시도)…'` 테스트의 단언을 새 형태로 바꾼다(`failed`가 객체 배열이 됨):

```ts
    expect(failed).toEqual([{ id: '1', attempts: 0, error: 'kafka down' }]);
    expect(published).toEqual(['2']);
```

(c) 격리 시 ERROR 로깅을 검증하는 테스트를 describe 안에 추가:

```ts
  it('markFailed가 격리(quarantined)면 ERROR 로그를 남긴다', async () => {
    const { runner, published } = deps([record('1')]);
    const store: OutboxStore = {
      add: () => Promise.resolve(),
      fetchPending: () => Promise.resolve([record('1')]),
      markPublished: () => Promise.resolve(),
      markFailed: () => Promise.resolve({ quarantined: true }),
    };
    const publisher: EventPublisher = {
      publish: () => Promise.resolve(),
      publishOrThrow: () => Promise.reject(new Error('permanent')),
    };
    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);
    const useCase = new RelayOutboxUseCase(runner, store, publisher, BATCH);

    await useCase.execute();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain('FAILED 격리');
    errorSpy.mockRestore();
    expect(published).toEqual([]);
  });
```

(d) 파일 상단 import에 `Logger`를 추가:
```ts
import { Logger } from '@nestjs/common';
```

- [ ] **Step 7: 테스트·빌드 확인**

Run: `npm test -- outbox` (backoff·store·use-case 스펙 모두 포함)
Expected: PASS. 이어서 `npm run build` 도 exit 0.

- [ ] **Step 8: 커밋**

```bash
git add src/outbox/domain/outbox-store.ts src/outbox/infrastructure/prisma-outbox-store.ts src/outbox/infrastructure/prisma-outbox-store.spec.ts src/outbox/application/relay-outbox.use-case.ts src/outbox/application/relay-outbox.use-case.spec.ts
git commit -m "[M9]feat: markFailed 백오프 재스케줄·FAILED 격리 + fetchPending 백오프 필터

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: 문서 + 롤백 SQL

**Files:**
- Modify: `README.md`
- Modify: `docs/study/마일스톤-학습-노트.md`

- [ ] **Step 1: README 마일스톤 표 M9 ✅**

`README.md`의 마일스톤 표에서 `| **M9** *(예정)*` 행을 완료로 바꾼다:

```markdown
| **M9** ✅ | Outbox 견고화: DLQ(FAILED 격리)·재시도 백오프 | poison message·지수 백오프·운영 견고함 |
```

그리고 표 아래 "운영·견고함 후속" 블록쿼트의 M9 설명 줄(`- **M9 (Outbox DLQ):**`)에서 "현재 relay는 발행 실패를 무한 재시도한다…" 문장을 완료형으로 바꾸고, 한 줄 요약을 단다:

```markdown
> - **M9 (Outbox DLQ):** ✅ poison message(영원히 실패)를 `PENDING → FAILED`로 격리해 무한 재시도를 끊었다. 실패 시 지수 백오프(`base*2^n`, cap)로 재시도하다 `OUTBOX_MAX_ATTEMPTS` 초과 시 격리하고, `lastError`/`failedAt`로 사후 조사. replay(되살리기)는 후속.
```

- [ ] **Step 2: 학습 노트에 M9 추가**

`docs/study/마일스톤-학습-노트.md` 상단 마일스톤 표(§0)에서 Outbox 행 아래(또는 M7/M8 흐름 끝)에 M9 행을 추가한다:

```markdown
| **M9** | Outbox DLQ·재시도 백오프 | 지수 백오프(base*2^n, cap), MAX_ATTEMPTS 초과 시 FAILED 격리, at-least-once 유지 |
```

그리고 Outbox를 다루는 섹션(§8 부근) 끝에 M9 소절을 추가한다:

```markdown
### M9 — DLQ·재시도 백오프 (Outbox 견고화)
- **문제:** 기존 relay는 실패 시 status를 PENDING으로 둬 매 틱(1s) 무한 재시도 → poison message가 영영 안 빠지고 Kafka 호출·로그를 낭비.
- **해법:** ① 실패 시 `nextAttemptAt = now + computeBackoff(attempts)`로 **지수 백오프**(`base*2^n`, cap 60s) → `fetchPending`이 `nextAttemptAt > now`인 행을 제외해 즉시 재시도가 사라짐. ② `attempts`가 `MAX_ATTEMPTS`(기본 5) 도달 시 `PENDING → FAILED`로 **격리**(DLQ) → 더는 폴링 안 됨. `lastError`/`failedAt`가 사후 조사 근거.
- **트레이드오프:** 무한 재시도(언젠가 성공) ↔ 격리(정상 흐름 보호+사람 개입 전제). 즉시 재시도(빠른 복구) ↔ 백오프(부하 절감, 복구 지연). **at-least-once는 그대로** — 백오프·격리는 "유실 없음"을 안 바꾸고, 중복 발행도 여전히 가능(소비자 멱등이 흡수). 격리는 "무한 실패 행"만 빼낼 뿐.
- **범위 밖(후속):** replay(FAILED→PENDING 되살리기), 메트릭/알림(M10 Sentry).
```

- [ ] **Step 3: 커밋(롤백 SQL은 PR 본문에 첨부)**

```bash
git add README.md docs/study/마일스톤-학습-노트.md
git commit -m "[M9]docs: README·학습 노트에 Outbox DLQ·백오프 반영

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

> PR 본문에 첨부할 롤백 SQL(보상 마이그레이션):
> ```sql
> DROP INDEX "OutboxEvent_status_nextAttemptAt_idx";
> CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"(status, "createdAt");
> ALTER TABLE "OutboxEvent" DROP COLUMN "nextAttemptAt", DROP COLUMN "lastError", DROP COLUMN "failedAt";
> -- status='FAILED' 행이 있다면 사전 처리 필요(예: UPDATE … SET status='PENDING')
> ```

---

## 완료 기준 (전체 검증)

- [ ] `npm test` 전체 통과(backoff 3 + store + use-case 포함).
- [ ] `npm run build` exit 0.
- [ ] 마이그레이션이 컬럼 3개 추가 + 인덱스 교체만 하고 기존 데이터를 보존한다.
- [ ] `markFailed`가 최대 미만에선 `nextAttemptAt`(백오프)·PENDING 유지, 최대 도달 시 FAILED 격리 + `{ quarantined: true }`.
- [ ] `fetchPending`이 `nextAttemptAt > now`(백오프 대기) 행을 제외한다.
- [ ] 격리 시 use-case가 ERROR 로그를 남긴다.
- [ ] 모든 설정값이 `ConfigKey` + `.env.example`에 등록되어 하드코딩이 없다.
- [ ] README·학습 노트 갱신, PR에 롤백 SQL 첨부.
```
