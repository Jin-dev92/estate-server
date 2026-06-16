# M7: k6 API 부하테스트 — 설계 스펙

> **상위 설계:** [building-owner-platform-design](2026-06-11-building-owner-platform-design.md) §6(마일스톤)
> **선행:** M0~M6 + Outbox(전 엔드포인트·rate limit·비동기 파이프라인 완성)
> **목적 한 줄:** 핵심 플로우의 성능 **baseline**(p95·RPS·에러율)을 k6로 확보하고, 합격 기준을 `thresholds`로 코드화한다.

## 1. 목표

지금까지 만든 분산 구조(캐시·DB 트랜잭션·인증·rate limit)가 부하에서 **어느 정도 견디고 어디가 느린지**의 출발선을 만든다. "완벽한 성능 튜닝"이 아니라 **측정 습관·도구·임계치 감각**을 익히는 게 1차 목표다.

**성공 기준**
- 성격이 다른 대표 엔드포인트 4개에 k6 부하 시나리오가 있다.
- 각 시나리오가 `thresholds`(p95 응답시간·에러율)로 **합격/불합격을 자동 판정**한다(미달 시 k6 exit 1).
- `smoke`(정상성)와 `load`(baseline) 두 프로파일을 env로 전환해 실행한다.
- 부하테스트용 시드를 멱등하게 준비하는 스크립트가 있다.
- README에 실행법·프로파일·결과 기록 표가 있고, 학습 노트에 부하테스트 포인트가 정리된다.

## 2. 비범위 (YAGNI / 후속)

- **stress/spike(한계점·스파이크 탐색)** — 로컬 장비 한계 + 결과 해석 부담이 커 baseline 이후 후속.
- **컨슈머 lag·Outbox 적체 등 비동기 파이프라인 부하 검증** — k6(HTTP)만으로 부족(컨슈머 메트릭 수집 필요). 후속.
- **CI 자동 실행** — 확장 경로로 §9에 골격만 명시(이번 구현 범위 밖).
- **결과 자동 리포트 저장·시각화**(Grafana 등) — 수동 기록으로 충분.
- **전 엔드포인트 망라** — 대표 4개로 시스템의 서로 다른 면을 커버(YAGNI).

---

## 3. 측정 지표

- **응답시간 분포:** p95·p99(꼬리 지연이 평균보다 중요).
- **처리량:** RPS(`http_reqs` rate).
- **에러율:** `http_req_failed` rate(비-2xx/3xx 비율 — 단, rate-limit 시나리오의 429는 "정상"으로 취급해 별도 처리).
- **thresholds 예시(엔드포인트별 조정):**
  - 읽기(캐시): `http_req_duration: ['p95<300']`, `http_req_failed: ['rate<0.01']`
  - 쓰기(DB+Outbox): `http_req_duration: ['p95<800']`
  - 로그인(bcrypt): `http_req_duration: ['p95<1000']`(해시 검증이 CPU 바운드라 느림이 정상)

---

## 4. 대상 엔드포인트 (성격별 대표 4개)

각 시나리오가 시스템의 **서로 다른 축**을 측정한다.

| 시나리오 파일 | 엔드포인트 | 측정 의도 |
|---|---|---|
| `read-posts.js` | `GET /buildings/:id/posts` | Redis read-through 캐시 효과, 읽기 처리량 |
| `create-post.js` | `POST /buildings/:id/posts` | 트랜잭션 쓰기(글+outbox 한 커밋) 비용 |
| `login.js` | `POST /auth/login` | bcrypt 검증(CPU 바운드) 응답시간 |
| `rate-limit.js` | `POST /auth/login` 반복 | 부하 하에서도 429 한도가 정확한지 |

---

## 5. 부하 프로파일 (2종)

`config.js`에서 env `PROFILE`로 전환한다.

- **smoke:** `vus: 1, duration: '30s'` — 스크립트·기능 정상성 확인(부하 아님). CI 후보.
- **load:** `stages: [{duration:'30s', target:20}, {duration:'1m', target:20}, {duration:'10s', target:0}]` — 점증→유지→감소로 baseline 측정.
- VU 수·duration은 env(`VUS`, `DURATION`)로 오버라이드 가능(로컬 장비에 맞춤).

---

## 6. 시드 & 인증 (Prisma seed + k6 setup)

부하 대상이 인증·건물 멤버십을 요구하므로 고정 데이터가 필요하다.

### 6.1 Prisma seed 스크립트 (`prisma/seed-load.ts`)
멱등하게(여러 번 실행 가능) 부하테스트용 고정 데이터를 만든다:
- 부하용 **OWNER 유저**(고정 email/password). `signup`이 role을 받지 않으므로 seed에서 직접 `role: 'OWNER'`로 생성/업서트.
- 그 OWNER 소유 **건물 1개**(고정 id 또는 고정 name으로 조회 가능).
- 읽기 시나리오용 **글 몇 개**(목록이 비지 않게).
- 비밀번호는 앱과 동일한 bcrypt 해시로 저장(로그인 가능해야 함) — 앱의 해시 유틸/라운드와 일치시킨다.
- 실행: `npx ts-node prisma/seed-load.ts` 또는 `package.json`의 `load:seed` 스크립트.

### 6.2 k6 `setup()` (`lib/auth.js`)
- 시드 OWNER로 `POST /auth/login` → accessToken 획득 → 시나리오 VU들이 공유(`setup()` 반환값).
- buildingId도 seed가 만든 고정 건물에서 얻는다(로그인 후 `GET /buildings` 또는 고정 id).

---

## 7. rate limit과의 충돌 처리 (핵심 트레이드오프)

부하테스트는 본질적으로 "짧은 시간 다수 요청" → **우리가 만든 rate limit(M6)이 부하를 막는다.** "측정 대상이 측정을 방해하는" 부하테스트의 전형적 딜레마다.

- **read/create/login 부하 측정 시:** env로 **한도를 크게**(`RATE_LIMIT_USER_MAX`, `RATE_LIMIT_IP_MAX`) 띄워 측정한다. **rate limit 가드 자체는 켜둔다**(가드 오버헤드도 측정 대상). 가드를 끄지 않는 이유: "실제 운영에 가까운 경로"를 재기 위함.
- **rate-limit.js 시나리오:** 반대로 **낮은 한도**로 띄워 429가 정확히·일관되게 뜨는지 검증(부하 하에서도 한도가 새지 않는가). 이 시나리오의 429는 `http_req_failed`에서 제외(예상된 응답).
- 이 충돌과 처리 방식을 **학습 노트에 기록**한다(부하테스트 설계의 일반 교훈).

---

## 8. 환경 & 실행

- **인프라:** 로컬 `docker compose up -d`(PG·Redis·Kafka).
- **앱:** `node dist/main.js`(또는 `npm run start`). 글작성 부하 시 `OutboxEvent` PENDING이 쌓이므로 **outbox-relay 워커를 함께 띄워** 적체 없이 발행되는지 관찰한다(필수는 아니나 권장).
- **k6 설치:** 코드 외부(brew `k6` 등) — repo엔 스크립트만 두고 README에 설치·실행 안내.
- **실행 예:** `BASE_URL=http://localhost:3000 PROFILE=load k6 run load/scenarios/read-posts.js`
- `package.json` 스크립트: `load:seed`, `load:smoke`, `load:read`, `load:create`, `load:login`, `load:ratelimit`(k6 호출을 감싸 env 기본값 제공).

## 9. CI 연동 (확장 경로 — 이번 범위 밖)

후속 사이클에서 GitHub Actions로:
- service container로 PG·Redis·Kafka 기동 → 마이그레이션·시드 → 앱 백그라운드 기동 → **smoke 프로파일만** k6 실행 → threshold 실패 시 CI red.
- 트레이드오프: 자동화 가치 ↑ vs Actions에서 인프라 4종 기동·시드·앱 부팅의 셋업 복잡도·불안정성 ↑. 그래서 baseline(로컬)을 먼저 익힌 뒤 smoke만 얇게 붙인다.

## 10. 산출물 검증(메타)

k6 스크립트는 jest 대상이 아니다. 검증은:
- `load:smoke`가 0 에러로 통과(스크립트 정상성·시드·인증 흐름 확인).
- threshold가 의도대로 동작: 일부러 비현실적으로 낮은 p95로 설정해 exit 1을 확인한 뒤 되돌린다.
- README 결과 표에 최소 1회 측정값(p95·RPS·에러율)을 기록.

## 11. 파일 구조

```
load/
  README.md                실행법·프로파일·threshold·결과 기록 표
  config.js                base URL·VU·stage·threshold + env 오버라이드(PROFILE 분기)
  lib/auth.js              login 헬퍼(setup용 토큰·buildingId 획득)
  scenarios/
    read-posts.js          GET 게시글 목록 (smoke+load)
    create-post.js         POST 글작성
    login.js               POST 로그인
    rate-limit.js          429 경계 검증
prisma/seed-load.ts        부하테스트용 시드(OWNER·건물·글, 멱등)
수정:
  package.json             load:seed / load:smoke / load:* 스크립트
  README.md                §6 마일스톤 M7 + load/ 안내·k6 설치
  docs/study/마일스톤-학습-노트.md   부하테스트 학습 포인트(별도 커밋)
```

## 12. 알려진 한계 / 후속

- **로컬 장비가 곧 상한:** k6·앱·인프라가 한 머신에서 도므로 측정값은 절대 성능이 아니라 **상대 비교·회귀 감지**용이다.
- **단일 인스턴스:** 수평 확장(여러 main·워커) 부하는 측정하지 않는다.
- **비동기 파이프라인 lag**(Kafka/Outbox)는 HTTP 부하로는 간접적으로만 보인다 → 후속.
- **stress/spike·CI·리포트 시각화**는 후속.
