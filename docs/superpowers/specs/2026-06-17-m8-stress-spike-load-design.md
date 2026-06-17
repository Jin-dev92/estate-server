# M8 — 부하 한계 탐색: stress / spike (설계 스펙)

> 작성일: 2026-06-17
> 선행: [M7 부하테스트(k6) baseline](../../../load/README.md), [학습 노트 §8.5](../../study/마일스톤-학습-노트.md)
> 상위 설계: [건물주 플랫폼 설계 스펙](2026-06-11-building-owner-platform-design.md)

---

## 1. 목적과 범위

M7에서 성격이 다른 대표 엔드포인트 4개의 **baseline(p95·RPS·에러율)** 을 잡았다. M8은 그 위에서
**한계점·병목 탐색(stress)** 과 **급증 충격·회복(spike)** 을 다룬다.

### 방법론 전환 (M7 → M8)
- M7은 **closed(VU) 모델**(`vus`/`stages`) — 시스템이 느려지면 부하가 자동으로 줄어 **backpressure가 숨는다**(baseline엔 충분).
- M8은 **open(arrival-rate) 모델** — 시스템 속도와 무관히 도착률(RPS)을 밀어붙여 **적체·한계를 노출**한다. stress/spike는 이 모델이 아니면 의미가 없다.

### 측정 환경 (확정된 전제 / 한계)
- **로컬 단일 머신**에서 진행한다(k6+앱+PG+Redis+Kafka 동시 구동).
- 따라서 M8의 목표는 **절대 한계 수치 확보가 아니라** ① open executor 방법론 체득, ② **병목을 눈으로 관찰하는 기법** 학습이다.
- 로컬에선 보통 "앱이 아니라 머신이 먼저 한계"라 stress가 무의미해진다 → 이를 역이용해 **앱의 특정 자원(DB 커넥션 풀)을 일부러 좁혀** 머신보다 *앱이 먼저, 예측한 지점에서* 무너지게 만드는 **통제된 실험**으로 전환한다.
- 모든 결과 숫자에는 "내 머신의 한계이지 estate-server의 절대 한계가 아님"을 명시한다.

### 범위에서 명시적으로 제외 (YAGNI)
- Grafana/Prometheus 대시보드, 별도 부하 머신 — 제외(관측은 k6 결과 + 앱 로그 최소 수준).
- Outbox DLQ·재시도 백오프(**M9**), Sentry 관측성(**M10**) — 별도 마일스톤.

---

## 2. 구조 (접근법 A — 새 시나리오 파일 + open-model 인라인)

closed-model 자산(`smoke`/`load`)과 open-model을 **물리적으로 분리**한다. closed/open이 왜 다른지가
파일 구조로 드러나고(학습 가치), 기존 자산 회귀 위험이 0이다.

```
load/
  config.js                       # (변경 최소) closed PROFILES 그대로 유지, 공유 자원만 import
  lib/auth.js                     # (재사용) login·buildingId·authHeaders
  scenarios/
    read-posts.js / create-post.js / login.js / rate-limit.js   # (기존, 손대지 않음)
    stress-create.js              # (신규) ramping-arrival-rate → DB 풀 고갈 knee 탐색
    spike-ratelimit.js            # (신규) 급증 → rate limit 방어/회복 검증
```

- open-model 파라미터(단계별 RPS·duration, preAllocatedVUs/maxVUs)는 각 시나리오 파일에 인라인 정의하되,
  하드코딩 금지 원칙에 따라 `__ENV`로 조절 가능하게 한다(예: `STRESS_PEAK_RATE`, `SPIKE_PEAK_RATE`).
- BASE_URL·SEED·auth 헬퍼는 `config.js`/`lib/auth.js`에서 import해 재사용한다.

---

## 3. stress 시나리오 — "어디서 무너지나(병목)"

**파일:** `load/scenarios/stress-create.js`

- **executor:** `ramping-arrival-rate`. 초당 요청수(RPS)를 단계적으로 올린다
  (예: 10 → 30 → 60 → 100 RPS, 각 단계 30s~1m 유지). VU가 아니라 **도착률**을 고정하므로
  앱이 느려져도 부하가 줄지 않아 **적체·한계가 드러난다**.
- **대상:** `POST /buildings/:id/posts` (DB+Outbox 한 트랜잭션 쓰기).
- **병목 유도:** 앱을 `DATABASE_URL=...?connection_limit=5`로 띄운다 → **DB 커넥션 풀 고갈이 머신 한계보다 먼저** 온다.
- **rate limit:** 여기선 DB 풀을 보는 게 목적이므로 M7처럼 `RATE_LIMIT_USER_MAX`/`RATE_LIMIT_IP_MAX`를 크게 띄워 rate limit을 풀어둔다.
- **threshold:** stress는 통과/실패 게이트가 아니라 **knee(무너지는 지점) 탐색**이 목적이라
  threshold로 죽이지 않고(또는 매우 느슨하게) **에러율·p95 곡선을 단계별로 기록**한다.
- **관측(최소):** k6 요약(단계별 에러율·p95 상승) + **앱 로그의 Prisma 풀 타임아웃 메시지**
  (`Timed out fetching a connection from the pool (connection limit: 5)`) — 이 메시지가 병목을 이름으로 알려준다.

**성공 기준:** RPS를 올릴 때 어느 단계에서 p95가 급증하고 에러가 시작되는 **knee를 식별**하고,
그 시점에 **Prisma 풀 타임아웃 로그**가 찍혀 "병목 = DB 커넥션 풀"임을 증거로 확인한다.

---

## 4. spike 시나리오 — "급증을 막아내고 회복하나"

**파일:** `load/scenarios/spike-ratelimit.js`

- **executor:** `ramping-arrival-rate`로 **급증 형태**를 만든다 — 평상시 낮게(예: 5 RPS) 유지하다
  짧은 구간(예: 5s)에 **확 치솟음**(예: 300~500 RPS), 잠깐 유지 후 평상시로 복귀.
  마지막에 **회복 구간**을 둬 "스파이크 후 정상으로 돌아오는가"를 본다.
- **대상:** `POST /buildings/:id/posts` (stress와 같은 엔드포인트로 통일 — 시드·auth 재사용, 전역 userId+IP rate limit 적용). *대안: login(데코레이터 `ipMax:10` 하드코딩)도 가능하나, 한도가 env로 조절되는 create-post가 다루기 쉬워 기본으로 둔다.*
- **rate limit:** 방어 자체가 관심사이므로 서버를 **정상/기본 한도**로 띄운다(stress와 반대 — 한도를 풀지 않는다). 급증 RPS가 한도를 초과해 429가 발생하도록 한다.
- **무엇을 보나:**
  1. **막아내는가** — 급증분이 429(`RATE_LIMIT_EXCEEDED`)로 차단되고, 한도 내 요청은 정상(2xx)으로 통과하며 **앱이 죽지 않는가**.
  2. **회복하는가** — 스파이크 종료 후 평상시 구간에서 p95·에러율이 **스파이크 이전 수준으로 복귀**하는가(밀린 게 계속 밀리지 않는가).
- **집계:** `k6/metrics`의 `Counter`로 429 비율과 2xx 비율을 별도 custom metric으로 잡아
  "막힌 양 vs 통과한 양"을 숫자로 본다.

**성공 기준:** 급증 구간에서 429가 정상적으로 발생하고(방어 동작), 앱이 크래시 없이 버티며,
스파이크 후 지표가 baseline 수준으로 회복됨을 확인한다.

---

## 5. 스크립트·문서 산출물

### package.json
- `load:stress` → `k6 run load/scenarios/stress-create.js`
- `load:spike` → `k6 run load/scenarios/spike-ratelimit.js`

### 문서 갱신 (CLAUDE.md "API 문서화"·학습 노트 룰 준수)
- **`load/README.md`**: 실행 표에 stress/spike 2줄 추가 + 실행 전제 명시
  (DB 풀 좁혀 띄우는 법 `connection_limit=5`, stress=rate limit 한도 상향 / spike=정상 한도) + 결과 표에 실측·발견 기록.
- **`docs/study/마일스톤-학습-노트.md` §8.5**: "후속(미구현)" → **구현 완료**로 전환,
  open executor·knee·DB 풀 고갈 병목·spike 회복의 실측 발견을 채운다.
- **`README.md`**:
  - 마일스톤 표 `M8 *(예정)*` → `M8 ✅`.
  - **§3.5 부하테스트 결과에 stress/spike 실측 결과를 M7 baseline 표와 같은 형식으로 추가**(knee RPS·병목·429 차단량·회복 여부).

---

## 6. 단계별 검증

| 단계 | 산출물 | 검증 기준 |
|---|---|---|
| 1 | `stress-create.js` | `connection_limit=5`로 띄운 앱에 RPS 상승 → knee 식별 + Prisma 풀 타임아웃 로그 확인 |
| 2 | `spike-ratelimit.js` | 기본 한도로 띄운 앱에 급증 → 429 발생·앱 생존 + 스파이크 후 baseline 회복 확인 |
| 3 | package.json 스크립트 | `npm run load:stress` / `load:spike` 정상 실행 |
| 4 | 문서 3종 | load/README·학습 노트 §8.5·README(§3.5 결과표 + 마일스톤 ✅) 갱신 |

---

## 7. 트레이드오프 메모 (학습 포인트)

- **closed(VU) ↔ open(arrival-rate):** closed는 backpressure를 숨겨 baseline에 정직, open은 한계를 드러내 stress/spike에 필수. 모델 선택이 곧 "무엇을 보려는가".
- **환경 한계 ↔ 통제 실험:** 로컬에선 머신이 먼저 터지는 한계를, **자원을 일부러 좁혀** 앱이 먼저 터지게 만드는 통제 실험으로 우회. 숫자의 절대성은 포기하되 **병목 관찰**이라는 학습 목표는 달성.
- **stress의 threshold:** baseline과 달리 게이트가 아니라 탐색 → threshold로 죽이지 않고 곡선을 기록.
- **관측 깊이 ↔ 단순성:** Grafana 대신 k6 출력+로그라는 최소 관측 — 풀 타임아웃 에러 메시지가 병목을 이름으로 알려주는 "값싼 신호"라 가능.
