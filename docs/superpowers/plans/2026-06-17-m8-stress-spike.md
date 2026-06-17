# M8 stress/spike 부하 한계 탐색 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** k6 open(arrival-rate) executor로 stress(create-post의 DB 커넥션 풀 고갈 knee 탐색)와 spike(rate limit 방어·회복 검증) 시나리오를 추가하고, 실측 결과를 문서화한다.

**Architecture:** 기존 closed-model 시나리오(`load/scenarios/*.js`, smoke/load)는 손대지 않고, open-model 시나리오 2개를 새 파일로 추가한다. 각 파일은 `scenarios`(arrival-rate executor)를 인라인 정의하고 BASE_URL·auth 헬퍼만 공유한다. 로컬 단일 머신 한계를 우회하려 stress는 DB 풀을 `connection_limit=5`로 좁혀 앱이 머신보다 먼저 터지게 만든다. 병목 관찰은 k6 출력 + 앱 로그(Prisma 풀 타임아웃 메시지) 최소 수준.

**Tech Stack:** k6 (JS, k6 런타임), NestJS, Prisma, PostgreSQL, Redis. 부하 실행은 자동화 테스트가 아니라 수동 실행 + 결과 기록이다.

> 설계 근거: [M8 설계 스펙](../specs/2026-06-17-m8-stress-spike-load-design.md)

---

## 사전 지식 (실행자가 알아야 할 것)

- **k6 open vs closed 모델:** 기존 시나리오는 `vus`/`stages`(closed) — 응답을 기다렸다 다음 요청을 보내므로 시스템이 느려지면 부하가 자동으로 줄어든다(backpressure가 숨음). 이번 시나리오는 `executor: 'ramping-arrival-rate'`(open) — **초당 요청수(도착률)를 고정**해 시스템이 느려져도 부하를 안 줄이고 밀어붙인다 → 적체·한계가 드러난다.
- **arrival-rate 필수 옵션:** `startRate`(시작 도착률), `timeUnit`(보통 `'1s'`), `preAllocatedVUs`(미리 잡아둘 VU 수), `maxVUs`(상한). 요청이 느려지면 k6가 도착률 유지를 위해 VU를 더 쓰므로, `maxVUs`가 모자라면 "Insufficient VUs" 경고가 뜬다.
- **rate limit 기본값**(`src/common/rate-limit/rate-limit.constants.ts`): window 60s, userMax 60, ipMax 120. `POST /buildings/:id/posts`는 쓰기 메서드라 전역 rate limit 대상.
- **병목 신호:** DB 풀이 고갈되면 Prisma가 `Timed out fetching a connection from the pool (connection limit: N)`을 던지고, 앱의 전역 ExceptionFilter가 이를 **500(`COMMON_INTERNAL_ERROR`)** 으로 변환해 응답한다. 즉 **k6의 5xx 증가 = 병목 도달**, **앱 로그의 풀 타임아웃 메시지 = 병목 이름**.

---

## File Structure

- **Create:** `load/scenarios/stress-create.js` — stress 시나리오(ramping-arrival-rate, create-post)
- **Create:** `load/scenarios/spike-ratelimit.js` — spike 시나리오(급증, 429 방어·회복)
- **Modify:** `package.json` — `load:stress`, `load:spike` 스크립트 추가
- **Modify:** `load/README.md` — 실행 표·실행 전제·결과 표에 stress/spike 추가
- **Modify:** `docs/study/마일스톤-학습-노트.md` — §8.5 "후속(미구현)" → 구현 완료 전환 + 실측 발견
- **Modify:** `README.md` — 마일스톤 표 M8 ✅, §3.5 결과 표에 stress/spike 추가

---

## Task 1: stress 시나리오 파일 작성

**Files:**
- Create: `load/scenarios/stress-create.js`
- Modify: `package.json` (scripts에 `load:stress` 추가)

- [ ] **Step 1: stress 시나리오 파일 작성**

`load/scenarios/stress-create.js`:

```js
// 시나리오 ⑤(M8): stress — 한계점·병목(DB 커넥션 풀) 탐색
// 무엇을 보나: POST 글작성의 도착률(RPS)을 단계적으로 올릴 때, 어느 지점에서 p95가
//   급증하고 5xx가 시작되는가(=knee). 그 순간 앱 로그에 Prisma 풀 타임아웃이 찍히면
//   "병목 = DB 커넥션 풀"이라는 증거다.
// 실행 전제(중요): 앱을 DB 풀을 좁혀 띄운다 → 머신보다 풀이 먼저 고갈돼 통제된 실험이 된다.
//   DATABASE_URL="...?...&connection_limit=5" \
//   RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js
//   (+ npm run start:worker:outbox — 글작성은 Outbox 경로를 함께 쓴다)
// 실행: STRESS_PEAK_RATE=100 k6 run load/scenarios/stress-create.js
// (k6 생명주기·open/closed 모델 설명은 ../config.js 맨 위 주석 참고)

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

// 단계별 도착률(초당 요청수). __ENV로 조절(하드코딩 금지). 기본은 10→30→60→PEAK.
const PEAK_RATE = Number(__ENV.STRESS_PEAK_RATE) || 100;
const STAGE = __ENV.STRESS_STAGE || '30s'; // 각 단계 유지 시간

// 5xx(서버 에러) 누적 카운터 — knee에서 몇 건이나 터졌는지 숫자로 본다.
const errors5xx = new Counter('server_errors_5xx');

export const options = {
  scenarios: {
    stress: {
      // open 모델: 도착률을 고정해 시스템이 느려져도 부하를 안 줄인다 → 한계가 드러난다.
      executor: 'ramping-arrival-rate',
      startRate: 10, // 초당 10건으로 시작
      timeUnit: '1s', // 'target/timeUnit' = 초당 도착률
      preAllocatedVUs: 50, // 미리 잡아둘 VU(요청이 느려지면 더 필요)
      maxVUs: 500, // 상한. 부족하면 k6가 "Insufficient VUs" 경고
      stages: [
        { target: 10, duration: STAGE },
        { target: 30, duration: STAGE },
        { target: 60, duration: STAGE },
        { target: PEAK_RATE, duration: STAGE },
      ],
    },
  },
  // stress는 합격/불합격 게이트가 아니라 knee 탐색 → threshold를 두지 않는다(곡선을 기록).
};

// setup(): 토큰·건물id를 1번만 준비(로그인 비용이 측정에 섞이지 않게).
export function setup() {
  const token = login();
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  const payload = JSON.stringify({
    category: 'FREE',
    title: `stress ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  // 201=성공. 5xx면 병목 도달 신호 → 카운터를 올린다.
  check(res, { 'create 201': (r) => r.status === 201 });
  if (res.status >= 500) errors5xx.add(1);
  // arrival-rate는 executor가 페이싱하므로 sleep(think time)을 넣지 않는다.
}

// 끝나면 5xx 누적을 찍어 knee 규모를 요약한다.
export function handleSummary(data) {
  const count = data.metrics.server_errors_5xx
    ? data.metrics.server_errors_5xx.values.count
    : 0;
  console.log(`5xx(병목 도달) 관측 횟수: ${count}`);
  return {};
}
```

- [ ] **Step 2: package.json에 load:stress 스크립트 추가**

`package.json`의 `scripts`에서 `"load:ratelimit"` 줄 바로 아래에 추가:

```json
    "load:stress": "k6 run load/scenarios/stress-create.js",
```

- [ ] **Step 3: 파일이 k6 문법상 유효한지 확인(짧게 실행)**

먼저 인프라·앱을 띄운다(풀 좁힘 + rate limit 상향 + outbox 워커):

```bash
docker compose up -d
npm run build
DATABASE_URL="postgresql://estate:estate@localhost:5433/estate?schema=public&connection_limit=5" \
  RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js   # 별도 터미널
npm run start:worker:outbox                                                 # 또 다른 터미널
npm run load:seed                                                           # 시드(최초 1회)
```

스크립트가 도는지 아주 작은 규모로 확인:

```bash
STRESS_PEAK_RATE=20 STRESS_STAGE=5s npm run load:stress
```

Expected: k6가 정상 실행되어 요약을 출력(에러 없이 `5xx(병목 도달) 관측 횟수: N` 로그가 보임). "Insufficient VUs" 경고가 뜨면 `maxVUs`를 올린다.

- [ ] **Step 4: 커밋**

```bash
git add load/scenarios/stress-create.js package.json
git commit -m "[M8]feat: stress 시나리오(create-post DB 풀 고갈 knee 탐색) 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: stress 실측 실행 + 결과 기록

**Files:**
- Modify: `load/README.md` (결과 표)

- [ ] **Step 1: stress 실측 실행**

Task 1 Step 3의 앱(풀 `connection_limit=5`, rate limit 상향)이 떠 있는 상태에서:

```bash
STRESS_PEAK_RATE=100 npm run load:stress
```

관찰할 것:
1. k6 요약에서 단계가 올라갈수록 `http_req_duration` p95가 급증하는 지점(knee)과 `http_req_failed`(실패율) 상승, `5xx(병목 도달) 관측 횟수`.
2. **앱 터미널 로그**에 `Timed out fetching a connection from the pool (connection limit: 5)` 메시지가 찍히는지 — 이게 병목을 이름으로 확인하는 핵심 증거.

knee가 안 보이면(풀이 안 터지면) `STRESS_PEAK_RATE`를 올리거나 `connection_limit`을 더 낮춘다(예: 3). 반대로 머신이 먼저 죽으면 PEAK_RATE를 낮춘다.

- [ ] **Step 2: load/README.md 결과 표에 stress 행 추가**

`load/README.md`의 결과 표(`| 일자 | 시나리오 | ...`)에 실측값으로 행을 추가한다. 예시 형식(실제 측정치로 채움):

```markdown
| 2026-06-17 | stress-create (POST, 풀=5) | ramping 10→100 RPS | <knee p95> | <RPS> | <에러율> | knee ≈ <N>RPS에서 5xx 시작, Prisma 풀 타임아웃 로그 확인(병목=DB 커넥션 풀) |
```

- [ ] **Step 3: 커밋**

```bash
git add load/README.md
git commit -m "[M8]docs: stress 실측 결과 기록(knee·DB 풀 병목)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: spike 시나리오 파일 작성

**Files:**
- Create: `load/scenarios/spike-ratelimit.js`
- Modify: `package.json` (scripts에 `load:spike` 추가)

- [ ] **Step 1: spike 시나리오 파일 작성**

`load/scenarios/spike-ratelimit.js`:

```js
// 시나리오 ⑥(M8): spike — 급증 충격에 rate limit이 막아내고, 끝난 뒤 회복하는가
// 무엇을 보나: 평상시 낮은 RPS를 유지하다 짧게 확 치솟게(급증) 한 뒤 다시 낮춘다.
//   ① 급증분이 429(RATE_LIMIT_EXCEEDED)로 차단되고 앱이 안 죽는가(5xx 없음),
//   ② 급증 후 평상시 구간에서 지표가 baseline 수준으로 회복되는가.
// 실행 전제(중요): 방어가 관심사 → rate limit을 "정상/유한 한도"로 띄운다(상향 X).
//   window를 짧게(10s) 두면 회복(윈도우 리셋)을 빨리 관찰할 수 있다.
//   RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js
//   (+ npm run start:worker:outbox)
// 실행: SPIKE_PEAK_RATE=300 k6 run load/scenarios/spike-ratelimit.js

import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import { BASE_URL } from '../config.js';
import { login, firstBuildingId, authHeaders } from '../lib/auth.js';

const BASE_RATE = Number(__ENV.SPIKE_BASE_RATE) || 5; // 평상시 초당 요청
const PEAK_RATE = Number(__ENV.SPIKE_PEAK_RATE) || 300; // 급증 정점

// 차단된 429와 통과한 2xx를 따로 세어 "막은 양 vs 통과한 양"을 숫자로 본다.
const blocked429 = new Counter('blocked_429');
const passed2xx = new Counter('passed_2xx');

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-arrival-rate',
      startRate: BASE_RATE,
      timeUnit: '1s',
      preAllocatedVUs: 50,
      maxVUs: 800, // 급증 시 도착률 유지를 위해 넉넉히
      stages: [
        { target: BASE_RATE, duration: '20s' }, // 평상시(baseline 구간)
        { target: PEAK_RATE, duration: '5s' }, // 급증(확 치솟음)
        { target: PEAK_RATE, duration: '10s' }, // 급증 유지
        { target: BASE_RATE, duration: '5s' }, // 복귀
        { target: BASE_RATE, duration: '30s' }, // 회복 관찰
      ],
    },
  },
};

export function setup() {
  const token = login(); // 로그인은 1회뿐(데코레이터 ipMax:10에 안 걸림)
  const buildingId = firstBuildingId(token);
  return { token, buildingId };
}

export default function (data) {
  const payload = JSON.stringify({
    category: 'FREE',
    title: `spike ${Date.now()}`,
    content: 'load test',
  });
  const res = http.post(
    `${BASE_URL}/buildings/${data.buildingId}/posts`,
    payload,
    authHeaders(data.token),
  );
  if (res.status === 429) blocked429.add(1);
  else if (res.status >= 200 && res.status < 300) passed2xx.add(1);
  // 핵심 합격 조건: 급증해도 앱이 죽지 않는다(5xx가 아니다).
  check(res, { 'no server error (<500)': (r) => r.status < 500 });
}

export function handleSummary(data) {
  const b = data.metrics.blocked_429
    ? data.metrics.blocked_429.values.count
    : 0;
  const p = data.metrics.passed_2xx
    ? data.metrics.passed_2xx.values.count
    : 0;
  console.log(`차단(429): ${b}건 / 통과(2xx): ${p}건`);
  return {};
}
```

- [ ] **Step 2: package.json에 load:spike 스크립트 추가**

`package.json`의 `scripts`에서 `"load:stress"` 줄 바로 아래에 추가:

```json
    "load:spike": "k6 run load/scenarios/spike-ratelimit.js",
```

- [ ] **Step 3: 파일이 유효한지 짧게 확인**

앱을 정상 한도(상향 X, window 짧게)로 다시 띄운다:

```bash
# (앞서 띄운 앱은 종료) 정상/유한 한도로 기동
RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js
npm run start:worker:outbox   # 별도 터미널(이미 떠 있으면 생략)
```

작은 규모로 실행:

```bash
SPIKE_PEAK_RATE=50 npm run load:spike
```

Expected: k6 정상 실행, `차단(429): N건 / 통과(2xx): M건` 로그 출력.

- [ ] **Step 4: 커밋**

```bash
git add load/scenarios/spike-ratelimit.js package.json
git commit -m "[M8]feat: spike 시나리오(급증 시 rate limit 방어·회복 검증) 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: spike 실측 실행 + 결과 기록

**Files:**
- Modify: `load/README.md` (결과 표)

- [ ] **Step 1: spike 실측 실행**

Task 3 Step 3의 앱(정상 한도, window 10s)이 떠 있는 상태에서:

```bash
SPIKE_PEAK_RATE=300 npm run load:spike
```

관찰할 것:
1. **막아내는가:** 급증 구간에서 `차단(429)` 카운트가 크게 늘고, `no server error (<500)` check가 100% 통과(앱이 안 죽음).
2. **회복하는가:** 급증 종료 후 평상시 구간에서 p95·에러율이 baseline(20s 구간) 수준으로 돌아오는가. 고정 윈도우라 회복은 윈도우 리셋(≤10s) 후에 일어난다는 점을 함께 기록.

조정: baseline 구간에서 이미 429가 많이 나오면(한도가 너무 낮음) `RATE_LIMIT_USER_MAX`/`RATE_LIMIT_IP_MAX`를 올려 baseline은 깨끗하고 급증에서만 429가 나도록 맞춘다. 반대로 급증해도 429가 안 나오면 한도를 낮춘다.

- [ ] **Step 2: load/README.md 결과 표에 spike 행 추가**

실측값으로 행 추가(예시 형식):

```markdown
| 2026-06-17 | spike-ratelimit (POST) | ramping 5→300→5 RPS | <p95> | <RPS> | <전체 에러율> | 급증분 429 <N>건 차단·5xx 0(앱 생존), 윈도우 리셋 후 회복 |
```

- [ ] **Step 3: 커밋**

```bash
git add load/README.md
git commit -m "[M8]docs: spike 실측 결과 기록(429 방어·회복)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: load/README.md 실행 가이드 보강

**Files:**
- Modify: `load/README.md`

- [ ] **Step 1: 실행 표에 stress/spike 추가**

`load/README.md`의 실행 표(`| 명령 | 시나리오 |`)에 2줄 추가:

```markdown
| `npm run load:stress` | stress(create-post, DB 풀 고갈 knee 탐색) |
| `npm run load:spike` | spike(급증 시 rate limit 방어·회복) |
```

- [ ] **Step 2: 실행 전제 섹션 추가**

`load/README.md`의 "## rate limit 주의" 섹션 아래에 stress/spike 전제를 명시하는 섹션을 추가:

```markdown
## stress/spike 실행 전제 (M8)

open(arrival-rate) 모델이라 closed(VU)와 띄우는 법이 다르다. 로컬 단일 머신에선
"머신이 먼저 한계"라 의미가 흐려지므로, **자원을 일부러 좁혀 앱이 먼저 터지게** 한다.

- **stress (DB 풀 병목 보기):** DB 커넥션 풀을 좁히고 rate limit은 풀어 띄운다.
  `DATABASE_URL="...&connection_limit=5" RATE_LIMIT_USER_MAX=1000000 RATE_LIMIT_IP_MAX=1000000 node dist/main.js`
  (+ `npm run start:worker:outbox`) → RPS를 올리면 풀 고갈 knee에서 5xx + 앱 로그에 Prisma 풀 타임아웃.
- **spike (방어·회복 보기):** rate limit을 **정상/유한 한도**로 띄운다(상향 X). window를 짧게 두면 회복을 빨리 본다.
  `RATE_LIMIT_WINDOW_SEC=10 RATE_LIMIT_USER_MAX=200 RATE_LIMIT_IP_MAX=200 node dist/main.js`
```

- [ ] **Step 3: 커밋**

```bash
git add load/README.md
git commit -m "[M8]docs: load/README에 stress/spike 실행 가이드 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: 학습 노트 §8.5 갱신 (후속 → 구현 완료)

**Files:**
- Modify: `docs/study/마일스톤-학습-노트.md`

- [ ] **Step 1: §8.5 "후속: stress / spike ... (미구현)" 섹션을 구현 완료로 전환**

`docs/study/마일스톤-학습-노트.md`의 `### 후속: stress / spike — ... (미구현)` 제목에서 `(미구현)`을 제거하고 `(M8 구현)`으로 바꾼다. "우리는 앞 둘만(아래 후속)." 같은 미구현 표현을 갱신하고, 섹션 끝에 실측 발견을 추가한다:

```markdown
### M8 실측 발견 (stress / spike)
- **stress — DB 풀 병목 확인:** create-post 도착률을 올리자 knee(≈ <N>RPS)에서 p95 급증·5xx 발생, 동시에 앱 로그에 `Timed out fetching a connection from the pool (connection limit: 5)` → 병목이 **DB 커넥션 풀**임을 이름으로 확인. 로컬 머신 한계를 풀을 좁혀 통제 실험으로 우회.
- **spike — 방어·회복:** 5→300 RPS 급증에서 급증분이 429로 차단되고 5xx=0(앱 생존). **고정 윈도우라 회복은 윈도우 리셋(≤10s) 후** 일어남 — 회복이 "즉시"가 아니라는 점을 숫자로 확인.
- **마일스톤 표(라인 26 부근) M7 행 아래에 M8 행을 추가**하거나, M8 학습 포커스(open executor·knee·병목·spike 회복)를 반영한다.
```

(위 `<N>` 등은 Task 2·4의 실측값으로 채운다. 마일스톤 표 갱신은 같은 파일 상단 표에서 처리.)

- [ ] **Step 2: §8.5 "스스로 점검" 체크박스 갱신**

미구현 전제로 적힌 체크 항목(예: "로컬 단일 머신에서 stress/spike를 돌리면 왜 결과가 왜곡되나?")은 그대로 두되, M8에서 답을 얻었으므로 답을 한 줄씩 덧붙이거나 체크 표시한다.

- [ ] **Step 3: 커밋**

```bash
git add docs/study/마일스톤-학습-노트.md
git commit -m "[M8]docs: 학습 노트 §8.5 stress/spike 구현 완료·실측 발견 반영

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 7: README.md 마일스톤·결과표 갱신

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 마일스톤 표 M8 ✅ 처리**

`README.md`의 마일스톤 표에서 `| **M8** *(예정)*` 행을 완료로 바꾼다:

```markdown
| **M8** ✅ | 부하 한계 탐색: stress/spike (로컬·DB 풀 좁힘으로 통제 실험) | k6 arrival-rate·병목·용량 계획 |
```

그리고 표 아래 "운영·견고함 후속(M8·M9·M10·CI)" 설명 문단에서 M8을 "예정/전제"가 아니라 "완료"로 다듬는다(별도 부하 머신 없이 로컬에서 풀을 좁혀 통제 실험으로 진행했음을 한 줄로).

- [ ] **Step 2: §3.5 부하테스트 결과에 stress/spike 추가**

`README.md` §3.5의 결과 표(`| 시나리오 | 프로파일 | p95 | 에러율 | 무엇을 보나 |`)에 2줄을 추가하고(실측값), 표 아래 불릿에 stress/spike 핵심 발견 1~2줄을 더한다:

```markdown
| `POST .../posts` stress(풀=5) | ramping 10→100 RPS | **<knee p95>** | <에러율> | knee에서 DB 커넥션 풀 고갈(Prisma 풀 타임아웃 로그) |
| `POST .../posts` spike | 5→300→5 RPS | **<p95>** | <에러율> | 급증분 429 차단·앱 생존, 윈도우 리셋 후 회복 |
```

```markdown
- **stress로 병목을 이름으로 확인:** 로컬은 머신이 먼저 터지므로 DB 풀을 5로 좁혀 *앱이 먼저* 터지게 한 통제 실험 → knee에서 Prisma 풀 타임아웃. 숫자는 머신 한계이지 절대 한계가 아님.
- **spike는 방어·회복 검증:** 급증분이 429로 막히고 5xx=0, 고정 윈도우라 회복은 윈도우 리셋 후.
```

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "[M8]docs: README 마일스톤 M8 완료·§3.5 stress/spike 결과 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 완료 기준 (전체 검증)

- [ ] `npm run load:stress` / `npm run load:spike`가 정상 실행된다.
- [ ] stress 실행 시 knee가 관측되고 앱 로그에 Prisma 풀 타임아웃 메시지가 찍힌다(병목 = DB 풀 증거).
- [ ] spike 실행 시 급증분이 429로 차단되고 5xx=0(앱 생존), 회복이 관측된다.
- [ ] `load/README.md`·`docs/study/마일스톤-학습-노트.md`·`README.md` 3종 문서에 실측 결과가 반영됐다.
- [ ] 기존 closed-model 시나리오(smoke/load/read/create/login/ratelimit)는 변경되지 않았다.
```
