# M13 그레이스풀 셧다운 설계 — 5개 프로세스의 "죽는 방법" + 부하 중 재시작 실측

> 작성: 2026-07-07. 선행: M9(Outbox DLQ)·M12(회복탄력성). 측정 자산: k6(M7·M8)·경량 하네스(M12).

## 1. 배경 — 왜 필요한가

**그레이스풀 셧다운(graceful shutdown)**은 프로세스가 종료 신호(SIGTERM)를 받았을 때 "하던 일을 마저 끝내고, 잡은 자원을 정리한 뒤" 종료하는 것을 말합니다. 배포·스케일 조정·컨테이너 재스케줄링은 모두 SIGTERM으로 시작되므로, 이 처리가 없으면 **모든 배포가 작은 장애**가 됩니다.

현재 이 프로젝트는 5개 프로세스(main + 컨슈머 워커 3종 + outbox-relay) 전부 **SIGTERM 처리가 전혀 없습니다** (`enableShutdownHooks()` 미호출). 즉 지금의 종료는 하드킬이며, 프로세스별로 다음이 발생합니다.

| 프로세스 | 하드킬 시 발생하는 일 |
|---|---|
| main (HTTP+WS) | 처리 중이던 HTTP 요청이 응답 없이 끊김. WS 연결 비정상 절단. 기존 `OnModuleDestroy` 정리(Redis quit·Prisma disconnect·pub/sub duplicate 정리)가 **한 번도 실행되지 않음** |
| 컨슈머 워커 3종 | 컨슈머 그룹을 graceful leave 없이 이탈 → 브로커가 session timeout까지 기다린 후에야 리밸런스 → 그동안 해당 파티션 소비 정지. 처리 중이던 메시지는 오프셋 커밋 전 중단(멱등이 흡수하나 재처리 발생) |
| outbox-relay | 폴링 틱 중간에 죽으면 "Kafka 발행됨 + PUBLISHED 마킹 전" 창에서 종료 → 재기동 시 중복 발행(소비자 멱등이 흡수하나 불필요한 중복) |

M13은 5개 프로세스 모두에 그레이스풀 셧다운을 구현하고, **k6 부하 중 재시작 실험**으로 before(하드킬)/after(그레이스풀)를 실측 비교합니다.

## 2. 핵심 결정

| 결정 | 내용 | 근거 |
|---|---|---|
| 적용 범위 | 5개 프로세스 전부 | 패턴이 공유돼 증분 비용이 낮고, "프로세스별 죽는 방법"으로 스토리 완성 |
| 합격 기준 | **in-flight 유실 0** (단일 인스턴스) | 받아둔 요청은 전부 정상 완료 + 데이터 유실 0. 공백 중 신규 요청의 connection refused는 **서버 1대의 물리적 한계로 정직하게 별도 집계·문서화**(해소는 멀티 인스턴스 마일스톤에서 — 롤링 배포 + LB 필요) |
| 구현 접근 | **자체 시그널 핸들러 + 기존 Nest 훅 재사용** | 자체 시그널 핸들러(`setupGracefulShutdown`)가 SIGTERM→drain→app.close()를 지휘(워치독·드레인 순서 제어를 위해 enableShutdownHooks 대신 사용 — Nest 훅 순서가 onModuleDestroy→beforeApplicationShutdown이라 드레인을 훅에 두면 인프라가 먼저 닫힌다). 기존 OnModuleDestroy 정리는 app.close()를 통해 그대로 재사용 |
| 종료 예산 | `SHUTDOWN_TIMEOUT_MS` (ConfigKey, 기본 10000) | 드레인이 예산 내에 안 끝나면 로그+Sentry 후 exit 1(강제 종료). 조용히 매달린 채 죽지 않는 프로세스 금지 — M12 "조용히 실패하는 서킷 금지"와 같은 원칙 |

## 3. 종료 시퀀스 (공통 골격)

```
SIGTERM/SIGINT (1회만 수신 — 중복 신호는 무시)
  1. 워치독 시작 (SHUTDOWN_TIMEOUT_MS)
  2a. drain() — app.close() 이전에 오케스트레이터가 직접 실행
      · main: HTTP server.close()(신규 수신 중단) + closeIdleConnections()
              (유휴 keep-alive 정리 — 없으면 close가 영원히 안 끝남),
              socket.io close(클라이언트 정상 disconnect → 재연결 루프 진입)
      · 워커: Nest Kafka transport close → 오프셋 커밋 + 컨슈머 그룹 graceful leave
      · relay: 인터벌 해제 + 진행 중 틱 완주 대기
  2b. app.close() → onModuleDestroy 훅(기존 코드 재사용) — 인프라 정리
      · Redis quit, Prisma disconnect, pub/sub duplicate 정리
  3-a. 정상 완료 → 워치독 해제 → exit 0
  3-b. 워치독 발화 → "드레인 예산 초과" 로그 + Sentry capture → exit 1
```

핵심 순서 원칙: **수도꼭지를 먼저 잠그고(신규 유입 중단) → 배수를 기다린 뒤(in-flight 완주) → 파이프를 해체한다(커넥션 정리)**. 역순이면 하던 일이 잃을 자원을 먼저 끊게 된다.

## 4. 구성 요소

| 파일 | 역할 |
|---|---|
| `src/common/shutdown/graceful-shutdown.ts` (신규) | `setupGracefulShutdown(app, { name, timeoutMs })` — 시그널 1회 수신·워치독·app.close() 오케스트레이션·exit code 결정. **5개 부트스트랩이 공유**하는 유일한 공용 코드 |
| `src/common/shutdown/http-drain.ts` (신규) | main 전용. 평범한 헬퍼 함수 — HTTP `server.close()` + `closeIdleConnections()` + (예산 임박 시) `closeAllConnections()`. socket.io 서버 close 포함 |
| `src/main.ts` (수정) | `enableShutdownHooks()` + `setupGracefulShutdown()` 배선 |
| `src/workers/*.main.ts` 4종 (수정) | 동일 배선. 컨슈머 3종은 `app.close()`가 Kafka graceful leave를 수행(추가 코드 최소) |
| `src/workers/outbox-relay.main.ts` + relay 루프 (리팩터) | `setInterval` 루프를 `start()/stop()` 가능한 서비스로 추출 — `stop()`은 인터벌 해제 후 **진행 중 틱의 Promise를 await**(발행↔마킹 사이 종료 창 제거) |
| `src/config/config-keys.ts`·`.env.example` (수정) | `ShutdownTimeoutMs = 'SHUTDOWN_TIMEOUT_MS'` (기본 10000) |

포트·유스케이스·컨트롤러 로직 불변. API 변화 없음(Swagger/README API 표 갱신 대상 없음).

## 5. 프로세스별 세부

- **main**: `server.close()`는 신규 연결만 막고 in-flight는 응답까지 기다린다. 함정은 **keep-alive 유휴 소켓** — 요청이 없어도 연결이 열려 있어 close 완료를 영원히 막는다. Node 18+ `closeIdleConnections()`로 유휴만 즉시 정리하고, 종료 예산 만료 1초 전(`SHUTDOWN_TIMEOUT_MS - 1000`)까지 드레인이 안 끝나면 `closeAllConnections()`로 잔여를 강제 정리한다(그래도 안 끝나면 워치독이 exit 1). WS(socket.io)는 `io.close()`로 정상 disconnect를 보내 클라이언트가 재연결 루프(socket.io 내장)를 타게 한다 — 채팅 메시지 자체는 영속화가 Kafka 경로(persistence-worker)라 유실 없음.
- **컨슈머 워커 3종**: Nest Kafka transport의 close가 kafkajs `consumer.disconnect()`를 호출 — 처리 중 메시지의 오프셋 커밋 후 **LeaveGroup 요청**을 보내 브로커가 즉시 리밸런스한다. before(하드킬)는 브로커가 session timeout(기본 30s)까지 기다려야 이탈을 감지 → 그동안 해당 파티션 소비 정지. **측정 포인트: 리밸런스 소요.**
- **outbox-relay**: 현재 `bootstrap()` 안의 `setInterval`+`running` 플래그를 서비스로 추출한다. `stop()`은 ①`clearInterval` ②진행 중 틱이 있으면 그 Promise 완주 대기 ③이후 `app.close()`. 이렇게 하면 "발행은 됐는데 마킹 전" 종료 창이 사라져 재기동 중복 발행이 0이 된다(그래도 남는 크래시 케이스는 기존 at-least-once+멱등이 커버 — 그레이스풀은 이를 "정상 종료에서는 발생 0"으로 좁히는 것).

## 6. 실측 계획 (k6 — before/after 통제 실험)

M8·M11과 같은 통제 실험 형식. 변수는 "그레이스풀 구현 유무" 하나.

- **시나리오 A (main, HTTP in-flight)**: k6 `create-post` 부하(20VU) 중 `kill -TERM <main pid>` → 재기동. 지표: ①5xx·중단(request interrupted) 수 ②connection refused 수(별도 집계 — 한계 문서화) ③**데이터 정합**: k6가 받은 201 수 == DB Post 행 수(+outbox 전량 PUBLISHED). before는 끊긴 요청·유실이 관측될 것, after는 ①·③이 0/일치여야 합격.
- **시나리오 B (컨슈머, 리밸런스)**: 이벤트 흐르는 중 audit-worker에 SIGTERM vs SIGKILL. 지표: 남은 컨슈머(또는 재기동 컨슈머)가 소비를 재개하기까지의 공백(로그 타임스탬프) — graceful leave(즉시) vs session timeout 대기(~수십초).
- **시나리오 C (relay, 중복 발행)**: 발행 부하 중 relay에 SIGTERM vs SIGKILL 반복 → 재기동 후 같은 `eventId`의 Kafka 중복 발행 수(AuditLog 유니크 충돌 로그 또는 컨슈머 로그로 집계). after(SIGTERM)는 0이어야 합격.
- 결과는 `load/results/m13-graceful-shutdown.md`에 기록(방법·한계·표·결론). Docker(PG·Redis·Kafka) 필요 — 실행은 로컬에서.

## 7. 테스트 전략 (단위)

- `graceful-shutdown.spec.ts`: 시그널 1회만 처리(중복 무시) / app.close 정상 완료 시 exit 0 경로 / 워치독 발화 시 exit 1 경로(가짜 타이머·process.exit mock) / close 예외 시에도 워치독이 정리.
- relay 루프 서비스 spec: `stop()`이 진행 중 틱을 완주 대기하는지(지연 틱 fake) / stop 후 새 틱이 돌지 않는지.
- http-drain spec: `beforeApplicationShutdown`에서 server.close·closeIdleConnections 호출 배선(서버 mock).
- 기존 `OnModuleDestroy` 정리 코드는 이미 spec 존재 — 재사용 확인만.

## 8. 범위 밖 (후속)

- **공백 중 신규 요청(connection refused) 해소** — 멀티 인스턴스 + LB 롤링 배포 마일스톤에서. M13 결과 문서에 실측 수치와 함께 한계로 명시.
- readiness/liveness 프로브 엔드포인트(k8s 전제) — LB 도입 시 함께.
- pm2/systemd 등 프로세스 매니저 연동 문서화.
