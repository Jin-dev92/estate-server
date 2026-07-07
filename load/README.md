# 부하테스트 (k6)

성격이 다른 핵심 엔드포인트의 성능 baseline(p95·RPS·에러율)을 측정한다.

## 사전 준비
1. k6 설치: `brew install k6` (또는 https://k6.io/docs/get-started/installation/)
2. 인프라: `docker compose up -d`
3. 앱: `npm run build && node dist/main.js` (글작성 부하 시 `npm run start:worker:outbox`도 함께)
4. 시드: `npm run load:seed`

## 실행
| 명령 | 시나리오 |
|---|---|
| `npm run load:smoke` | 전체 smoke(정상성) |
| `npm run load:read` | GET 게시글 목록 |
| `npm run load:create` | POST 글작성 |
| `npm run load:login` | POST 로그인 |
| `npm run load:ratelimit` | 429 경계 |
| `npm run load:stress` | stress(create-post, DB 풀 고갈 knee 탐색) |
| `npm run load:spike` | spike(급증 시 rate limit 방어·회복) |

프로파일/규모: `PROFILE=load VUS=20 k6 run load/scenarios/read-posts.js`

## rate limit 주의
부하가 rate limit에 걸리므로, 측정 시 한도를 크게 띄운다:
`RATE_LIMIT_USER_MAX=100000 RATE_LIMIT_IP_MAX=100000 node dist/main.js`
rate-limit 시나리오는 반대로 낮은 한도로 띄워 429를 검증한다.

## stress/spike 실행 전제 (M8)

open(arrival-rate) 모델이라 closed(VU)와 띄우는 법이 다르다. 로컬 단일 머신에선
"머신이 먼저 한계"라 의미가 흐려지므로, **자원을 일부러 좁혀 앱이 먼저 터지게** 한다.

- **stress (DB 풀 병목 보기):** DB 커넥션 풀을 좁히고 rate limit은 풀어 띄운다.
  `DATABASE_URL="...&connection_limit=1&pool_timeout=1" RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js`
  (+ `npm run start:worker:outbox`) → `STRESS_STAGE=40s STRESS_PEAK_RATE=600 STRESS_MAX_VUS=2000`으로 오래·깊게 밀면 knee에서 5xx + 앱 로그에 Prisma 풀 타임아웃(P2024).
- **spike (방어·회복 보기):** rate limit을 **정상/유한 한도**로 띄운다(상향 X). window를 짧게 두면 회복을 빨리 본다.
  `RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js`

## 회복탄력성 하네스 (M12 — k6 아님)

회복탄력성 계층(카카오 OAuth의 재시도·서킷·벌크헤드·타임아웃)은 k6가 아니라 별도 ts-node 하네스로 잰다. 이유: 이 계층은 카카오가 오작동할 때만 작동하는데, 실제 카카오엔 부하·장애를 줄 수 없다. 그래서 실제 클라이언트 경로를 구동하되 `global.fetch`에 가짜 카카오(지연·에러)를 주입한다. 앱·Docker 불필요.

```bash
npx ts-node load/resilience/harness.ts
# 환경변수: HARNESS_CONCURRENCY(기본 20)·HARNESS_DURATION_MS(2500)·HARNESS_THINK_MS(120)
```

상세·결론: [`load/results/m12-resilience.md`](results/m12-resilience.md).

## 결과 기록
> 환경: 로컬 단일 머신(앱+PG+Redis+Kafka 동시 구동) — 절대치가 아니라 **상대 비교·회귀 감지**용.

| 일자 | 시나리오 | 프로파일 | p95(ms) | RPS | 에러율 | 비고 |
|---|---|---|---|---|---|---|
| 2026-06-16 | read-posts (GET 목록) | load 20VU | 6.89 | 16.0 | 0% | Redis read-through 캐시 경로(단일 building → 캐시 hit 최상) |
| 2026-06-16 | create-post (POST) | load 20VU | 19.6 | 15.9 | 0% | DB+Outbox 한 트랜잭션 쓰기 |
| 2026-06-16 | login (순수 bcrypt) | smoke 1VU | 114.5 | 0.9 | 0% | bcrypt rounds=10 검증 = CPU 바운드(읽기의 ~17배) |
| 2026-06-16 | login (부하) | load 20VU | 4.2 | 16.0 | 98.8% | `@RateLimit({ipMax:10})`에 막혀 대부분 429 — "측정이 측정을 방해"(아래) |
| 2026-06-16 | rate-limit (429 경계) | iter 20 | — | — | — | ipMax=10 → 429 관측 10회. 부하 하에서도 한도 정확 |
| 2026-06-17 | stress-create (POST, 풀=1) | ramping 10→600 RPS, 40s 유지 | 1734 | 95.1 | 0.23% | throughput 상한 ~95 RPS, P2024 풀 타임아웃 35건(병목=DB 커넥션 풀), dropped 812 |
| 2026-06-17 | spike-ratelimit (POST) | 5→300→5 RPS (window 10s, 한도 200) | 10.0 | — | 84.4%* | 429 차단 4032·통과 743·5xx 0(앱 생존), 윈도우 리셋 후 201 회복. *429 포함 실패율(정상 방어) |
| 2026-07-04 | read-posts 좋아요 집계 (M11, before→after) | load 20VU, 글 50×좋아요 0/200/2000 | before 10.61/19.53/73.46 → after 12.20/12.39/13.27 | 15.8~16.0 | 0% | 라이브 COUNT → Redis 카운터 전환. 상세: [`load/results/m11-like-counter.md`](results/m11-like-counter.md) |
| 2026-07-07 | 회복탄력성 카카오 OAuth (M12, 하네스) | conc 20, think 120ms, 시나리오별 | 정상 407 · 느림(default) p95 14864 · 장애 503평균 8 | — | — | k6 아님 — ts-node 하네스로 정책 계층 실측(가짜 카카오 장애주입). 정상 오탐 0·장애 fail-fast 확인, 느림 retry 스택 꼬리지연 발견. 상세: [`load/results/m12-resilience.md`](results/m12-resilience.md) |

### 읽어둘 발견
- **login은 데코레이터 rate limit 때문에 부하 측정이 막힌다.** `@RateLimit({ipMax:10})`은 라우트에 하드코딩이라 `RATE_LIMIT_*` env 상향으로 안 풀린다 → load에서 ~99% 429. **순수 bcrypt baseline은 smoke(윈도우당 ≤10회)로** 잰다. (이건 보안이 의도대로 동작한다는 증거이기도 하다.)
- **read 수치는 캐시 최상 시나리오다.** 모든 VU가 같은 building을 읽어 Redis hit이 100%에 가깝다. 실제론 여러 키를 섞어야 현실적 hit/miss가 나온다.
- **bcrypt가 가장 무겁다**(p95 114ms vs 읽기 7ms). 인증이 CPU 바운드라는 걸 숫자로 확인.

### stress 발견 (M8 — 병목은 latency로 먼저 드러난다)
- **knee = latency 폭증.** DB 풀을 좁히며 부하를 올리자 p95가 **13.6ms(풀2,250RPS) → 210ms(풀1,400RPS) → 1734ms(풀1,600RPS)** 로 뛰었다. 바꾼 변수는 `connection_limit` 하나뿐 → 병목이 **DB 커넥션 풀**임을 latency 상관으로 확정.
- **throughput은 풀 용량에서 평평해진다.** 풀=1이면 도착률을 600 RPS로 올려도 실제 처리량은 **~95 RPS**에 고정(= 풀 1개의 처리 한계). "RPS를 더 줘도 안 올라가는 천장"이 곧 용량.
- **병목을 이름으로:** 충분히 오래 밀자 앱 로그에 `Timed out fetching a new connection from the connection pool (connection limit: 1)`(Prisma P2024)가 35건 → 500. 단, 이 타임아웃은 **큐 대기가 `pool_timeout`을 넘겨야** 떠서, 짧게 밀면 latency만 오르고 타임아웃은 안 난다(자기안정화).
- **open 모델의 backpressure 위치:** maxVUs가 모자라면 초과분이 `dropped_iterations`로 버려진다(부하가 앱이 아니라 k6 쪽에 쌓임). 한계 탐색 땐 maxVUs를 넉넉히 줘야 앱 큐가 깊어져 진짜 한계가 보인다.

### spike 발견 (M8 — 방어가 작동하면 급증이 싸진다)
- **rate limit이 급증을 막는다.** 5→300 RPS 급증에서 한도 초과분 **4032건이 429**로 차단, 한도 내 **743건만 2xx**, **5xx=0**(앱 안 죽음). 방어선이 폭주를 흡수.
- **막는 게 값싸다 → p95 10ms.** 429 거부는 Redis 고정윈도우 카운터 O(1) 체크라 거의 공짜. *진짜 일(글 INSERT)을 안 하므로* 급증해도 앱이 가볍다(방어의 핵심 이점).
- **회복은 윈도우 리셋과 함께.** 고정 윈도우라 차단된 사용자도 **다음 윈도우(≤10s)면 다시 통과** → 스파이크 후 정상 글작성 201 확인. "회복이 즉시가 아니라 윈도우 경계"라는 점이 고정 윈도우의 성질.
- **k6 실패율 84%는 '실패'가 아니다.** http_req_failed는 429를 실패로 세지만 여기선 *의도된 방어*다 → spike 시나리오에 실패율 threshold를 두지 않는 이유.

### M11 발견 (좋아요 집계: 라이브 COUNT → Redis 카운터)
- **before는 볼륨에 비례해 느려지고, after는 평평하다.** 글당 좋아요 0→2000에서 before(COUNT) p95는 10.61ms→73.46ms(약 6.9배)로 상승하지만, after(Redis 카운터, 워밍 상태) p95는 12.20ms→13.27ms(약 8.8%)로 사실상 변화가 없다. 자세한 before/after 표·결론은 [`load/results/m11-like-counter.md`](results/m11-like-counter.md) 참고.
- **저볼륨에서는 카운터의 네트워크 왕복 비용이 오히려 드러난다.** 볼륨 0에서는 before(10.61ms)가 after(12.20ms)보다 낮다 — 좋아요가 거의 없을 땐 COUNT가 더 저렴할 수 있음을 보여준다. 교차점은 200~2000 사이이며, 이 실험 규모에서 이미 역전이 뚜렷하다.
