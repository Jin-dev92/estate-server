# M13 — 그레이스풀 셧다운 before/after 실측 (부하 중 재시작)

## 방법

- **before = 같은 빌드에 `kill -9`(SIGKILL)** — 시그널 핸들러를 우회하므로 "그레이스풀 미구현" 상태(하드킬)를 그대로 재현한다. **after = `kill -TERM`(SIGTERM)** — M13이 구현한 드레인 경로. 변수는 신호 하나뿐인 통제 실험(M8·M11 형식).
- 환경: 로컬 단일 머신(docker compose: PG·Redis·Kafka), `SHUTDOWN_TIMEOUT_MS=10000`(기본).
- 세 시나리오: A(main HTTP in-flight), B(컨슈머 교체 재조인), C(relay 배치 중간 절단 → 중복 발행).

## 측정을 가로막은 것들 (정직 기록 — "측정이 측정을 방해" 3연타)

1. **쓰기 경로는 k6 부하 불가.** `POST /buildings/:id/posts`는 M6에서 라우트 데코레이터로 캡이 하드코딩돼 있어(`BOARD_RATE_LIMIT.CREATE_POST`, user 20·IP 30/분) env 상향(`RATE_LIMIT_*`)이 안 먹힌다 — M7의 login 사례(데코레이터 `ipMax:10`)와 같은 계열. → k6 지속 부하는 캡 없는 **GET(read-posts)** 으로 하고, 쓰기 검증은 시나리오 C에서 SQL 적립으로 대체했다.
2. **GET 부하로는 절단이 안 보인다.** k6(Go http 클라이언트)는 **멱등한 GET이 stale keep-alive에서 실패하면 조용히 재시도**한다 — SIGKILL로 소켓이 끊겨도 EOF가 지표에 안 잡힌다(실측: before에서도 EOF 0). 게다가 GET 응답이 ~7ms라 kill 순간 in-flight일 확률 자체가 낮다. → **in-flight 프로브**를 별도 제작: 비멱등 POST 중 가장 느린 **login(bcrypt ~114ms) 10발을 동시 발사하고 30ms 뒤 신호** — kill이 반드시 처리 도중에 떨어지는 결정적 측정(login ipMax 10/분 내에서 10발).
3. **relay 중복 발행 창은 소형 배치로는 못 잡는다.** 통상 배치(수십 행)는 수십 ms에 끝나 kill 조준(3회 시도)이 모두 빗나갔다(중복 0 — 창이 그만큼 좁다는 것 자체도 발견). → **SQL로 PENDING 500행 적립 + `OUTBOX_BATCH_SIZE=500`** 으로 한 틱을 수 초짜리 단일 트랜잭션 대형 배치로 만들어, 신호가 반드시 배치 중간에 떨어지게 했다.

## 시나리오 A — main: in-flight HTTP 완주 여부

k6 GET 부하(smoke 10VU·90s) 중 t=45s에 신호 → 3s 후 재기동. 신호 직전에 in-flight 프로브(login 10발 동시, 30ms 뒤 신호).

| 지표 | before (SIGKILL) | after (SIGTERM) |
|---|---|---|
| **in-flight 프로브 10발** | **10발 전부 절단**(ConnectionResetError) | **10발 전부 완주**(201) |
| k6 GET 성공/실패 | 606 / 284 | 840 / 50 |
| 실패 유형 | 전부 connection refused(공백 중 신규) | 전부 connection refused(공백 중 신규) |
| 절단(EOF/reset) | 0 (GET 멱등 재시도가 마스킹 — 위 §2) | 0 |
| 종료 로그 | 없음(즉사) | `종료 시작(예산 10000ms)` → 5초 후 `종료 완료`, exit 0 |
| 데이터(Post·Outbox) | 변화 없음(읽기 부하) | 변화 없음 |

- **핵심 대비는 프로브다: 처리 중이던 요청이 하드킬에선 10/10 끊기고, 그레이스풀에선 10/10 응답까지 완주한다.** `server.close()`가 신규 수신만 막고 in-flight를 기다린 뒤 종료함이 결정적으로 확인됐다.
- k6 실패(refused)는 두 케이스 모두 "공백 중 신규 요청"이며, 공백 폭은 셧다운 방식이 아니라 **재기동 부팅 비용이 지배**한다(관측: Kafka 토픽 초기화·연결에 ~26s까지 소요, 실행별 변동 큼 — before 284 vs after 50 차이도 부팅 변동이지 셧다운 효과가 아니다). 이 공백은 단일 인스턴스의 물리적 한계로, 해소는 멀티 인스턴스+LB(후속 마일스톤) 몫이다.

## 시나리오 B — 컨슈머 교체: 재조인 공백

audit-worker W1 기동·그룹 조인 → 신호 → 즉시 W2 기동 → W2가 그룹 조인(파티션 할당)까지 소요 시간.

| | before (SIGKILL) | after (SIGTERM) |
|---|---|---|
| W2 조인 완료까지 | **31초** | **6초** |
| 메커니즘 | 브로커가 W1 세션 만료(kafkajs sessionTimeout 기본 30s)까지 이탈을 감지 못해 W2 조인을 대기시킴 | W1이 오프셋 커밋 후 **LeaveGroup**을 보내 브로커가 즉시 리밸런스 |

- 하드킬은 "죽었다는 사실"조차 30초간 아무도 모른다 — 그동안 해당 파티션 소비가 정지한다. graceful leave는 그 공백을 세션 타임아웃과 무관하게 만든다(6초는 W2 부팅+조인 비용).

## 시나리오 C — relay: 배치 중간 절단 → 중복 발행

PENDING 500행(단일 틱·단일 트랜잭션 배치) 처리 도중(틱 시작 +0.7s) 신호 → relay2로 잔여 소진 → 토픽 전체를 다시 읽어 이번 케이스 eventId의 수신 횟수 집계.

| | before (SIGKILL) | after (SIGTERM) |
|---|---|---|
| 토픽 수신 | 500/500 (총 메시지 973) | 500/500 (총 메시지 **정확히 500**) |
| **중복 발행** | **473건** | **0건** |
| 종료 로그 | 없음(즉사) | `종료 시작` → 3초 후 `종료 완료`(틱 완주 대기) |

- **메커니즘(발견):** relay 배치는 fetch→행별 emit→행별 mark가 **한 트랜잭션**이다. SIGKILL이 배치 중간에 떨어지면 이미 Kafka로 나간 473건의 mark까지 통째로 **롤백**돼, 재기동한 relay가 500건 전체를 재발행한다 — 중복이 "절단 시점 이후"가 아니라 **"이미 발행된 부분 전체"** 로 증폭된다. at-least-once + 소비자 멱등(`eventId @unique`)이 이를 흡수하는 게 기존 설계(M9)고, 그레이스풀 셧다운은 **정상 종료에서 이 중복을 0으로** 만든다(`RelayLoop.stop()`이 진행 중 틱 완주를 기다린 뒤 종료).
- 통상 배치(40행, 수십 ms)에서는 3회 조준 모두 중복 0 — 창이 좁아 정상 운영에선 이 사고가 드물다는 것도 함께 확인됐다. 대형 배치·느린 브로커일수록 창이 커지므로 그레이스풀의 가치도 커진다.

## 결론

1. **in-flight 유실 0 달성** — 하드킬 10/10 절단 → 그레이스풀 10/10 완주(시나리오 A 프로브). 종료 로그·exit 0 시퀀스 정상.
2. **컨슈머 재조인 공백 31s → 6s** — graceful LeaveGroup이 세션 타임아웃 대기를 제거(시나리오 B).
3. **relay 정상 종료 중복 0** — 배치 tx 롤백에 의한 재발행 증폭(473건)이 사라짐(시나리오 C). 크래시(SIGKILL 급) 케이스는 여전히 멱등 소비가 최후 방어선 — 그레이스풀은 "배포가 사고를 만들지 않게" 하는 것이지 멱등의 대체재가 아니다.
4. **한계(정직):** 공백 중 신규 요청(connection refused)은 셧다운으로 못 막는다 — 단일 인스턴스의 물리적 한계이며 다운타임은 부팅 비용(Kafka 초기화 ~26s 관측)이 지배한다. 해소는 멀티 인스턴스+LB 롤링(후속). 또한 재기동 부팅 26s 자체가 다음 최적화 후보다.

## 재현 방법 (요약)

```bash
docker compose up -d && pnpm build && pnpm load:seed
# A: k6 GET 부하 중 45s 시점 kill(-9|-TERM) + login 10발 동시 프로브(30ms 뒤 신호)
# B: audit-worker 조인 → kill → 즉시 새 워커 기동 → 'joined the group' 로그까지 시간
# C: SQL로 PENDING 500행 적립 + OUTBOX_BATCH_SIZE=500 → 틱 시작 0.7s 뒤 kill →
#    잔여 소진 후 kafka-console-consumer --from-beginning으로 eventId 중복 집계
```
