# M13 그레이스풀 셧다운 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 5개 프로세스(main + 컨슈머 워커 3종 + outbox-relay)가 SIGTERM에 "하던 일을 완주하고 자원을 정리한 뒤" 종료하게 만들고, k6 부하 중 재시작으로 before/after를 실측한다.

**Architecture:** 공용 오케스트레이터 `setupGracefulShutdown(app, { name, timeoutMs, drain })`가 시그널 1회 수신 → 워치독 시작 → `drain()`(프로세스별 "신규 유입 중단 + in-flight 완주") → `app.close()`(기존 `OnModuleDestroy` 인프라 정리 재사용) → exit 0 순서를 지휘한다. **drain을 `app.close()` 앞에서 직접 실행하는 이유(스펙 §3 정정):** Nest 훅 순서가 `onModuleDestroy` → `beforeApplicationShutdown` → dispose 라서, 드레인을 Nest 훅에 두면 Redis/Prisma가 먼저 닫혀 in-flight 작업이 실패한다. 같은 이유로 `enableShutdownHooks()`는 쓰지 않는다(워치독 없음 + close 중복).

**Tech Stack:** NestJS 11, Node 24(`server.closeIdleConnections`/`closeAllConnections` 내장), socket.io 4, kafkajs(Nest Kafka transport), Jest, k6.

**참조 스펙:** `docs/superpowers/specs/2026-07-07-graceful-shutdown-design.md`

> 이 문서는 PR 검토용으로 예시 구현·테스트 코드 블록을 제거한 상태다(파일 책임·시그니처·실행/검증/커밋 명령만 남김). 실제 코드는 저장소 소스를 참조한다.

## Global Constraints

- **종료 시퀀스(필수 순서):** 시그널 1회 수신(중복 무시) → 워치독(`SHUTDOWN_TIMEOUT_MS`, 기본 10000) → `drain()` → `app.close()` → exit 0. 워치독 발화 시 로그+Sentry 후 exit 1. "수도꼭지 잠금 → 배수 대기 → 파이프 해체" 순서 위반 금지.
- **드레인 정의(프로세스별):** main = WS 정상 disconnect + HTTP `server.close()`+`closeIdleConnections()`(예산 만료 1초 전 `closeAllConnections()` 강제) / 컨슈머 3종 = `microservice.close()`(in-flight 핸들러 완주→오프셋 커밋→LeaveGroup) / relay = 인터벌 해제 + **진행 중 틱 완주 대기**.
- **라이브러리 추가 0.** Node 18+/Nest 내장 API만.
- 새 env 키는 `ConfigKey`(`ShutdownTimeoutMs = 'SHUTDOWN_TIMEOUT_MS'`)와 `.env.example`에 함께 등록. 매직 스트링·넘버 금지.
- 커밋 `[M13]{type}: {한글}`. push 전 `npm run lint:check`(경고 0) — **exit code로 확인**(출력 tail만 보지 말 것).
- 테스트 규칙: `*.spec.ts` 동일 디렉토리, `describe → describe(context) → it`, AAA, `as any` 금지. Sentry는 `jest.mock('@sentry/nestjs')` 관례.
- API 변화 없음 — Swagger/README API 표 갱신 대상 없음.

---

### Task 1: 공용 오케스트레이터 `setupGracefulShutdown` + env 키 + 스펙 정정

**Files:**
- Create: `src/common/shutdown/graceful-shutdown.ts`
- Test: `src/common/shutdown/graceful-shutdown.spec.ts`
- Modify: `src/config/config-keys.ts` (enum 끝에 키 1개), `.env.example`
- Modify: `docs/superpowers/specs/2026-07-07-graceful-shutdown-design.md` (§2·§3 훅 매핑 정정)

**Interfaces:**
- Produces:
  - `interface ClosableApp { close(): Promise<void> }`
  - `interface ShutdownOptions { name: string; timeoutMs: number; drain?: () => Promise<void>; exit?: (code: number) => void }`
  - `createShutdownRunner(app: ClosableApp, opts: ShutdownOptions): () => Promise<void>` — 테스트 가능한 순수 러너
  - `setupGracefulShutdown(app: ClosableApp, opts: ShutdownOptions): void` — SIGTERM/SIGINT에 러너 등록
  - `ConfigKey.ShutdownTimeoutMs = 'SHUTDOWN_TIMEOUT_MS'` (기본 10000)
- Consumes: `@sentry/nestjs`(captureMessage/captureException), Nest `Logger`.

- [ ] **Step 1: 실패하는 스펙 작성**

Create `src/common/shutdown/graceful-shutdown.spec.ts`:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/common/shutdown/graceful-shutdown.spec.ts`
Expected: FAIL — `Cannot find module './graceful-shutdown'`.

- [ ] **Step 3: 구현**

Create `src/common/shutdown/graceful-shutdown.ts`:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 4: env 키 등록**

`src/config/config-keys.ts`의 enum 끝(`KakaoTotalTimeoutMs` 뒤)에 추가:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

`.env.example`의 Infra 블록 위(카카오 회복탄력성 블록 뒤)에 추가:

```bash
# 그레이스풀 셧다운(M13) — SIGTERM 후 드레인 예산(ms). 초과 시 강제 종료(exit 1).
SHUTDOWN_TIMEOUT_MS="10000"
```

- [ ] **Step 5: 스펙 §2·§3 정정**

`docs/superpowers/specs/2026-07-07-graceful-shutdown-design.md`:
- §2 "구현 접근" 셀의 `enableShutdownHooks()`로 SIGTERM→`app.close()` 연결` 문구를 다음으로 교체: `자체 시그널 핸들러(setupGracefulShutdown)가 SIGTERM→drain→app.close()를 지휘(워치독·드레인 순서 제어를 위해 enableShutdownHooks 대신 사용 — Nest 훅 순서가 onModuleDestroy→beforeApplicationShutdown이라 드레인을 훅에 두면 인프라가 먼저 닫힌다). 기존 OnModuleDestroy 정리는 app.close()를 통해 그대로 재사용`
- §3 시퀀스의 `2a. beforeApplicationShutdown 훅` → `2a. drain() — app.close() 이전에 오케스트레이터가 직접 실행`으로, `2b. onModuleDestroy 훅` → `2b. app.close() → onModuleDestroy 훅(기존 코드 재사용)`으로 수정.
- §4 표의 `http-drain.service.ts` 행을 `http-drain.ts` (평범한 헬퍼 함수 — 라이프사이클 서비스 아님)로 수정.

- [ ] **Step 6: 통과 확인 + build/lint + Commit**

Run: `npx jest src/common/shutdown/` → PASS(4 케이스).
Run: `npm run build && npm run lint:check; echo "EXIT=$?"` → EXIT=0.

```bash
git add src/common/shutdown/ src/config/config-keys.ts .env.example docs/superpowers/specs/2026-07-07-graceful-shutdown-design.md
git commit -m "[M13]feat: 그레이스풀 셧다운 오케스트레이터(워치독·드레인 순서 지휘)"
```

---

### Task 2: HTTP 드레인 헬퍼 + main 배선

**Files:**
- Create: `src/common/shutdown/http-drain.ts`
- Test: `src/common/shutdown/http-drain.spec.ts`
- Modify: `src/main.ts`

**Interfaces:**
- Consumes: `setupGracefulShutdown`(Task 1), Node `http.Server`(`close`/`closeIdleConnections`/`closeAllConnections`), `ChatGateway.server`/`NotificationGateway.server`(socket.io, `disconnectSockets(true)`).
- Produces: `drainHttpServer(server: Server, forceCloseAfterMs: number): Promise<void>`.

- [ ] **Step 1: 실패하는 스펙 작성**

Create `src/common/shutdown/http-drain.spec.ts`:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/common/shutdown/http-drain.spec.ts`
Expected: FAIL — `Cannot find module './http-drain'`.

- [ ] **Step 3: 구현**

Create `src/common/shutdown/http-drain.ts`:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 4: main.ts 배선**

`src/main.ts`:
- import 추가:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- `await app.listen(...)` 뒤에 추가:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 5: 통과 확인 + build/lint + Commit**

Run: `npx jest src/common/shutdown/` → PASS.
Run: `npm run build && npm run lint:check; echo "EXIT=$?"` → EXIT=0.

```bash
git add src/common/shutdown/http-drain.ts src/common/shutdown/http-drain.spec.ts src/main.ts
git commit -m "[M13]feat: main HTTP·WS 드레인 — in-flight 완주 후 종료"
```

---

### Task 3: RelayLoop 추출 + outbox-relay 배선

**Files:**
- Create: `src/workers/relay-loop.ts`
- Test: `src/workers/relay-loop.spec.ts`
- Modify: `src/workers/outbox-relay.main.ts`

**Interfaces:**
- Consumes: `setupGracefulShutdown`(Task 1).
- Produces: `class RelayLoop { constructor(tick: () => Promise<void>, pollMs: number); start(): void; stop(): Promise<void> }` — `stop()`은 인터벌 해제 + 진행 중 틱 완주 대기.

- [ ] **Step 1: 실패하는 스펙 작성**

Create `src/workers/relay-loop.spec.ts`:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/workers/relay-loop.spec.ts`
Expected: FAIL — `Cannot find module './relay-loop'`.

- [ ] **Step 3: 구현**

Create `src/workers/relay-loop.ts`:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 4: outbox-relay.main.ts 배선**

`src/workers/outbox-relay.main.ts`의 `setInterval` 블록(let running… 포함)을 다음으로 교체하고 import를 추가:

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 5: 통과 확인 + build/lint + Commit**

Run: `npx jest src/workers/relay-loop.spec.ts` → PASS(5 케이스).
Run: `npm run build && npm run lint:check; echo "EXIT=$?"` → EXIT=0.

```bash
git add src/workers/relay-loop.ts src/workers/relay-loop.spec.ts src/workers/outbox-relay.main.ts
git commit -m "[M13]feat: relay 폴링 루프 start/stop 추출 — 진행 중 틱 완주 후 종료"
```

---

### Task 4: 컨슈머 워커 3종 배선 + 전체 회귀

**Files:**
- Modify: `src/workers/audit-worker.main.ts`, `src/workers/persistence-worker.main.ts`, `src/workers/notification-worker.main.ts`

**Interfaces:**
- Consumes: `setupGracefulShutdown`(Task 1), `app.connectMicroservice(...)`의 반환값 `INestMicroservice`(`close(): Promise<void>`).
- Produces: 없음(배선만). 부트스트랩 파일은 이 저장소 관례상 spec 없음 — 검증은 build+전체 회귀.

- [ ] **Step 1: 세 워커 main에 동일 패턴 적용**

각 파일에서 ①`const microservice =`로 `connectMicroservice` 반환값을 잡고 ②`startAllMicroservices()` 뒤에 셧다운 배선을 추가한다. audit-worker 예(다른 두 파일은 `name`만 `'persistence-worker'`/`'notification-worker'`로):

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

> *(예시 구현 코드는 PR 정리 규칙에 따라 제거 — 최종 코드는 위 **Files** 경로의 실제 소스·spec 파일 참조)*

- [ ] **Step 2: 이중 close 안전성 확인**

`node_modules/@nestjs/microservices/server/server-kafka.js`(또는 `.d.ts`)의 `close()`를 열어 consumer/producer가 null 가드(`?.` 또는 if)로 보호되는지 확인한다. 보호돼 있지 않으면 drain을 `microservice.close()` 대신 플래그로 감싸고 그 사실을 보고에 남긴다.

- [ ] **Step 3: 전체 회귀 + build/lint + Commit**

Run: `npm test` → 전 스위트 PASS. `npm run build && npm run lint:check; echo "EXIT=$?"` → EXIT=0.

```bash
git add src/workers/audit-worker.main.ts src/workers/persistence-worker.main.ts src/workers/notification-worker.main.ts
git commit -m "[M13]feat: 컨슈머 워커 3종 graceful leave — 커밋 후 즉시 리밸런스"
```

---

### Task 5: 실측 — k6 부하 중 재시작 before/after (Docker 필요)

**Files:**
- Create: `load/results/m13-graceful-shutdown.md`
- Modify: `load/README.md` (결과 행 + 실험 방법 소절)

**Interfaces:**
- Consumes: 기존 k6 시나리오 `load/scenarios/create-post.js`, seed(`pnpm load:seed`), Task 1~4의 셧다운 구현.
- Produces: before(SIGKILL)/after(SIGTERM) 비교 표. **before = 같은 빌드에 SIGKILL**(핸들러 우회 = 하드킬 재현), after = SIGTERM.

> **전제:** Docker(PG·Redis·Kafka) 구동 필요. 실행 환경에 Docker가 없으면 이 태스크는 결과 문서에 "실행 대기(runbook 완비)"로 남기고 BLOCKED가 아닌 DONE_WITH_CONCERNS로 보고한다.

- [ ] **Step 1: 환경 기동**

```bash
docker compose up -d && pnpm build && pnpm load:seed
```

- [ ] **Step 2: 시나리오 A — main HTTP in-flight (before/after)**

터미널1(앱): `RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js`
터미널2(k6): `PROFILE=load VUS=20 k6 run load/scenarios/create-post.js`
터미널3: k6 30초 경과 시점에 `kill -9 <main pid>`(before) / `kill -TERM <main pid>`(after) → 3초 후 앱 재기동.

기록 지표(각 케이스): k6 `http_req_failed` 내역에서 ①5xx·request interrupted(소켓 끊김) 수 ②connection refused 수(공백 — 별도 집계) ③k6 201 응답 수 vs `SELECT COUNT(*) FROM "Post"`(시드 이후 증가분) 일치 여부 ④outbox `PENDING` 잔량이 재기동 후 전량 `PUBLISHED`로 소진되는지.

- [ ] **Step 3: 시나리오 B — 컨슈머 리밸런스 (before/after)**

audit-worker 2개를 같은 그룹으로 기동(`npm run start:worker:audit` ×2). k6 create-post 부하로 이벤트를 흘리며 한쪽에 `kill -9`(before) / `kill -TERM`(after). 남은 워커 로그에서 파티션 재할당(리밸런스) 완료까지의 공백 시간(마지막 소비 로그 ~ 재개 로그)을 기록. 기대: before ~수십 초(session timeout), after ~수 초 내.

- [ ] **Step 4: 시나리오 C — relay 중복 발행 (before/after)**

k6 create-post 부하 중 outbox-relay에 `kill -9`(before) / `kill -TERM`(after)를 각 3회 반복 → 재기동. audit-worker 로그·AuditLog 테이블에서 같은 `eventId` 중복 수신 수를 집계(멱등 스킵 로그 카운트). 기대: after는 0, before는 >0 가능.

- [ ] **Step 5: 결과 문서 작성**

`load/results/m13-graceful-shutdown.md`에 M12 결과 문서(`m12-resilience.md`) 형식을 따라 작성: 방법(before=SIGKILL 프록시인 이유 포함)·한계(단일 인스턴스라 공백 중 connection refused는 불가피 — 수치와 함께 명시, 해소는 멀티 인스턴스 마일스톤)·시나리오별 표·결론. `load/README.md` 결과 기록 표에 한 행 추가 + "그레이스풀 셧다운 실험(M13)" 소절(위 runbook 요약).

- [ ] **Step 6: Commit**

```bash
git add load/results/m13-graceful-shutdown.md load/README.md
git commit -m "[M13]test: 부하 중 재시작 before/after 실측 결과"
```

---

### Task 6: 마일스톤·학습 노트 문서화 + 최종 회귀

**Files:**
- Modify: `README.md` (M13 행 ✅ + 운영·견고함 불릿), `docs/study/마일스톤-학습-노트.md` (§8.11 신설)

**Interfaces:**
- Consumes: Task 5 실측 수치. 어투는 글로벌 CLAUDE.md 문서 규칙(해설 격식체) — 단, 학습 노트는 기존 파일의 `~다` 평서체 관례를 따른다(M12 선례).

- [ ] **Step 1: README 갱신**

- 마일스톤 표 M13 행을 `*(예정)*` → `✅`로.
- 운영·견고함 후속 불릿 목록(M12 불릿 뒤)에 M13 불릿 추가: 배경(SIGTERM 무처리 = 모든 배포가 작은 장애) → 구현(오케스트레이터·드레인 순서·워치독·graceful leave·틱 완주) → 실측 결과(시나리오 A/B/C 수치) → 한계(단일 인스턴스 공백은 LB 필요 — 후속) 순으로, M12 불릿과 같은 밀도로.
- 헤더 나열(`M8·M9·M10·M11·M12·CI`)에 `M13` 추가.

- [ ] **Step 2: 학습 노트 §8.11 신설**

`docs/study/마일스톤-학습-노트.md`의 §8.10과 §9 사이. 기존 §8.x 구조(`### 개념`/`### 트레이드오프`/`### 스스로 점검`/`### 더 팔 키워드`) 미러링. 포함할 내용:
- 그레이스풀 셧다운 개념과 "수도꼭지 → 배수 → 파이프" 순서 원칙. Nest 훅 순서 함정(onModuleDestroy가 먼저라 드레인을 훅에 못 두는 이유).
- keep-alive 유휴 소켓이 close를 막는 함정과 `closeIdleConnections`/`closeAllConnections`.
- WS는 드레인이 아니라 "정상 disconnect + 클라이언트 재연결"인 이유. Kafka graceful leave와 session timeout 리밸런스 차이.
- 종료 예산 워치독 — "조용히 매달린 채 죽지 않기"(M12 '조용히 실패하는 서킷 금지'와 같은 원칙).
- **배포 전략과의 역할 분담(블루그린 Q&A):** LB 스위칭은 "새 요청(B)"의 방향만 바꾸고, 이미 받아둔 요청(A)은 그레이스풀 셧다운이 완주시킨다 — 블루그린·롤링·k8s 모두 종료의 시작은 SIGTERM이므로 셧다운 로직은 배포 전략 중립적 전제 조건. keep-alive 연결이 L4 LB에서 스위칭 후에도 구 인스턴스로 향할 수 있는 꼬리 문제 포함.
- 스스로 점검 3~4문항 + 더 팔 키워드(`SIGTERM vs SIGKILL`, `connection draining/deregistration delay`, `kafka session.timeout vs LeaveGroup`, `k8s preStop hook`, `readiness probe`).

- [ ] **Step 3: 최종 회귀 + Commit**

Run: `npm test` → 전 스위트 PASS. `npm run build && npm run lint:check; echo "EXIT=$?"` → EXIT=0.

```bash
git add README.md docs/study/마일스톤-학습-노트.md
git commit -m "[M13]docs: 그레이스풀 셧다운 마일스톤·학습 노트 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- §2 결정(5개 프로세스·in-flight 유실 0·접근 A·종료 예산) → Task 1(오케스트레이터·env)·2(main)·3(relay)·4(컨슈머) ✓ / 합격 기준·정직한 한계 집계 → Task 5 지표 ✓
- §3 종료 시퀀스 → Task 1 러너 순서(워치독→drain→close→exit). 훅 매핑 오류는 Task 1 Step 5에서 스펙 정정 ✓
- §4 구성 요소 표 → 파일별 Task 1~4와 일치(`http-drain.service.ts`→`http-drain.ts` 정정 포함) ✓
- §5 프로세스별 세부(keep-alive·graceful leave·틱 완주) → Task 2·3·4 구현·주석 ✓
- §6 실측 계획(시나리오 A/B/C·결과 문서) → Task 5 ✓ / §7 단위 테스트 → Task 1·2·3 spec ✓
- §8 범위 밖(멀티 인스턴스·프로브) → Task 5·6 문서에 한계로만 기록 ✓

**2. Placeholder scan:** TBD/TODO 없음. Task 4는 배선 전용이라 코드 예시 1개 + "name만 교체" 지시(세 파일이 동일 구조임을 Step 1에 명시). Task 5는 실행 runbook — 코드가 아닌 명령·지표 목록으로 완결.

**3. Type consistency:**
- `ClosableApp`/`ShutdownOptions`/`createShutdownRunner`/`setupGracefulShutdown` — Task 1 정의 = Task 2·3·4 사용 일치.
- `drainHttpServer(server, forceCloseAfterMs)` — Task 2 정의·main 배선 일치.
- `RelayLoop(tick, pollMs)`/`start()`/`stop()` — Task 3 정의·relay 배선 일치.
- `ConfigKey.ShutdownTimeoutMs = 'SHUTDOWN_TIMEOUT_MS'` — Task 1 enum = .env.example = 각 main 배선 일치.

**참고:** 계획 md의 예시 코드 블록은 구현 중 유지, PR 직전 산문화한다(프로젝트 관례). Task 5는 Docker 전제 — 실행 불가 시 runbook 완비 상태로 보고하고 측정만 뒤로 미룬다.
