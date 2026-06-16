# M6: rate limit + 보안 점검 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 쓰기 엔드포인트에 Redis 기반 userId+IP 이중 rate limit(전역 가드)을 적용하고, 보안 점검 체크리스트로 인가·시크릿·에러 노출 표면을 한 번 훑어 발견 구멍을 수정한다.

**Architecture:** `RateLimitGuard`를 전역 가드(`APP_GUARD`)로 등록한다. 쓰기 메서드(또는 `@RateLimit` 지정)에만 적용하고, IP는 항상·userId는 best-effort(JWT verify)로 식별해 Redis 고정 윈도우(Lua INCR+EXPIRE)로 각각 카운트한다. 초과 시 M2.5 에러 봉투로 429 + `Retry-After`를 반환한다.

**Tech Stack:** NestJS(Guard·Reflector·APP_GUARD·JwtModule), ioredis(Lua `runScript`), Jest.

> **설계 스펙:** [docs/superpowers/specs/2026-06-15-m6-rate-limit-design.md](../specs/2026-06-15-m6-rate-limit-design.md)

---

## 사전 준비

- 작업 브랜치: `feat/m6-rate-limit` (이미 `dev`에서 분기됨).
- 인프라: `docker compose up -d`(redis 필요). 스모크 검증에 사용.
- 컨벤션: 매직스트링 금지(`ConfigKey`/상수), 테스트 `as any` 금지(`as unknown as T`), 커밋 `[M6]{타입}: {한글}`.

## 파일 구조 (생성/수정 맵)

**생성**
```
src/common/rate-limit/rate-limit.constants.ts   메타키·Lua·기본값·키빌더·옵션 타입·쓰기 메서드
src/common/rate-limit/rate-limit.errors.ts       RateLimitError.EXCEEDED (AppErrorSpec)
src/common/rate-limit/rate-limit.decorator.ts    @RateLimit(opts) · @SkipRateLimit()
src/common/rate-limit/rate-limit.store.ts        RATE_LIMIT_STORE 포트 + RedisRateLimitStore
src/common/rate-limit/rate-limit.guard.ts        RateLimitGuard(전역)
src/common/rate-limit/rate-limit.module.ts       store·JwtModule·APP_GUARD 배선
docs/security-review.md                          보안 점검 체크리스트 + 조치
(+ *.spec.ts)
```
**수정**
```
src/config/config-keys.ts                  RATE_LIMIT_* 3개 키
.env.example                               RATE_LIMIT_* 3개 키
src/app.module.ts                          RateLimitModule 임포트
src/auth/interface/auth.controller.ts      signup·login에 @RateLimit({ ipMax: 10 })
README.md                                  §7 에러표 RATE_LIMIT_EXCEEDED 행
docs/study/마일스톤-학습-노트.md            rate limit 학습 포인트(별도 커밋)
```

---

## Task 1: ConfigKey + .env.example (rate limit 설정 키)

**Files:**
- Modify: `src/config/config-keys.ts`
- Modify: `.env.example`

- [ ] **Step 1: ConfigKey에 3개 키 추가**

`src/config/config-keys.ts`의 `KafkaBrokers` 아래에 추가:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: .env.example에 추가**

`.env.example` 끝에 추가:

```
# Rate limit (M6) — 윈도우(초)당 허용 쓰기 수. userId·IP 이중 제한.
RATE_LIMIT_WINDOW_SEC="60"
RATE_LIMIT_USER_MAX="60"
RATE_LIMIT_IP_MAX="120"
```

- [ ] **Step 3: 타입 확인 + 커밋**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

```bash
git add src/config/config-keys.ts .env.example
git commit -m "[M6]chore: rate limit 설정 키(ConfigKey·.env.example) 추가"
```

---

## Task 2: 상수 · 에러 스펙 · 데코레이터

**Files:**
- Create: `src/common/rate-limit/rate-limit.constants.ts`
- Create: `src/common/rate-limit/rate-limit.errors.ts`
- Create: `src/common/rate-limit/rate-limit.decorator.ts`

> 순수 데이터/메타 선언이라 별도 단위 테스트 없이 `tsc`로 검증한다(동작은 store·guard 테스트가 커버).

- [ ] **Step 1: 상수**

`src/common/rate-limit/rate-limit.constants.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 에러 스펙**

`src/common/rate-limit/rate-limit.errors.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 3: 데코레이터**

`src/common/rate-limit/rate-limit.decorator.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 4: 타입 확인 + 커밋**

Run: `npx tsc --noEmit`
Expected: 에러 없음.

```bash
git add src/common/rate-limit/rate-limit.constants.ts src/common/rate-limit/rate-limit.errors.ts src/common/rate-limit/rate-limit.decorator.ts
git commit -m "[M6]feat: rate limit 상수·에러 스펙·데코레이터"
```

---

## Task 3: RedisRateLimitStore (고정 윈도우 카운터)

**Files:**
- Create: `src/common/rate-limit/rate-limit.store.ts`
- Test: `src/common/rate-limit/rate-limit.store.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/common/rate-limit/rate-limit.store.spec.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/common/rate-limit/rate-limit.store.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/common/rate-limit/rate-limit.store.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/common/rate-limit/rate-limit.store.spec.ts`
Expected: PASS (1 test)

- [ ] **Step 5: 커밋**

```bash
git add src/common/rate-limit/rate-limit.store.ts src/common/rate-limit/rate-limit.store.spec.ts
git commit -m "[M6]feat: RedisRateLimitStore(고정윈도우 INCR+EXPIRE Lua)"
```

---

## Task 4: RateLimitGuard (전역 가드 — 이중 제한 핵심)

**Files:**
- Create: `src/common/rate-limit/rate-limit.guard.ts`
- Test: `src/common/rate-limit/rate-limit.guard.spec.ts`

> 참고: `TokenPayload`는 `src/auth/domain/token-issuer.ts`에서 import(`{ sub: string; ... }`). `AppException`은 `src/common/errors/app-exception.ts`.

- [ ] **Step 1: 실패 테스트 작성**

`src/common/rate-limit/rate-limit.guard.spec.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/common/rate-limit/rate-limit.guard.spec.ts`
Expected: FAIL (모듈 없음)

- [ ] **Step 3: 구현**

`src/common/rate-limit/rate-limit.guard.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/common/rate-limit/rate-limit.guard.spec.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: lint + 커밋**

Run: `npx prettier --write "src/common/rate-limit/**/*.ts" && npx eslint src/common/rate-limit`
Expected: eslint 0 에러.

```bash
git add src/common/rate-limit/rate-limit.guard.ts src/common/rate-limit/rate-limit.guard.spec.ts
git commit -m "[M6]feat: RateLimitGuard(쓰기 기본·데코레이터 오버라이드·userId+IP 이중·429)"
```

---

## Task 5: 모듈 배선 + 전역 등록 + auth 라우트 강화

**Files:**
- Create: `src/common/rate-limit/rate-limit.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/auth/interface/auth.controller.ts`

- [ ] **Step 1: RateLimitModule**

`src/common/rate-limit/rate-limit.module.ts`:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 2: AppModule에 임포트**

`src/app.module.ts`의 import 목록과 `imports` 배열에 추가:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_
그리고 `imports: [...]` 배열 끝(`NotificationModule` 다음)에 `RateLimitModule,` 추가.

- [ ] **Step 3: auth signup·login에 @RateLimit**

`src/auth/interface/auth.controller.ts`:
- import 추가: `import { RateLimit } from '../../common/rate-limit/rate-limit.decorator';`
- `@Post('signup')` 라우트와 `@Post('login')` 라우트 각각에 데코레이터 추가:

> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_
> _(구현 코드는 PR diff·소스 파일 참조 — 계획 확정 후 코드 블록 제거)_

- [ ] **Step 4: 빌드 + 전체 테스트**

Run: `npm run build && npx jest`
Expected: 빌드 성공, 전체 테스트 통과.

- [ ] **Step 5: 부팅 확인**

Run: `node dist/main.js` (몇 초 후 Ctrl-C). 로그에 `Nest application successfully started`가 보이고 에러 없음.

- [ ] **Step 6: 커밋**

```bash
git add src/common/rate-limit/rate-limit.module.ts src/app.module.ts src/auth/interface/auth.controller.ts
git commit -m "[M6]feat: RateLimitGuard 전역 등록 + 로그인·회원가입 IP 한도 강화"
```

---

## Task 6: 스모크 검증(429 실동작) + README 에러표

**Files:**
- Modify: `README.md`

- [ ] **Step 1: 429 스모크 검증 (login ipMax=10)**

docker compose(redis) 기동 상태에서 서버를 띄우고, `/auth/login`을 11회 호출한다. login은 `@RateLimit({ ipMax: 10 })`이라 11번째 요청에서 IP 카운트가 10을 넘어 429가 떠야 한다(가드가 핸들러보다 먼저 실행되므로 자격 검증 전에 차단).

```bash
node dist/main.js &
sleep 3
for i in $(seq 1 11); do
  curl -s -o /dev/null -w "%{http_code} " -X POST localhost:3000/auth/login \
    -H 'Content-Type: application/json' -d '{"email":"x@x.com","password":"x"}'
done
echo
kill %1
```
Expected: 앞 10개는 `401`(자격 불일치 — 가드 통과 후 핸들러 도달), **11번째는 `429`**.

> 윈도우(기본 60초)가 지나면 카운트가 리셋되므로, 재시도 시 Redis 키를 비우거나(`redis-cli --scan --pattern 'ratelimit:*' | xargs redis-cli del`) 60초 후 다시 실행한다.

- [ ] **Step 2: 429 응답이 봉투 형태인지 확인**

Run(서버 띄운 상태, 한도 초과 후):
```bash
curl -s -X POST localhost:3000/auth/login -H 'Content-Type: application/json' -d '{"email":"x@x.com","password":"x"}' | head
```
Expected: `{"statusCode":429,"code":"RATE_LIMIT_EXCEEDED","message":"요청이 너무 많습니다...","path":"/auth/login","timestamp":"..."}` 형태 + 응답 헤더에 `Retry-After`.

- [ ] **Step 3: README §7 에러표에 행 추가**

`README.md`의 "에러 응답 형식" 표(`| code | status | 의미 |`)에서 `COMMON_INTERNAL_ERROR` 행 위에 추가:

```
| `RATE_LIMIT_EXCEEDED` | 429 | 요청이 너무 많음(userId·IP 이중 제한 초과) |
```

- [ ] **Step 4: 커밋**

```bash
git add README.md
git commit -m "[M6]docs: 에러표에 RATE_LIMIT_EXCEEDED(429) 추가"
```

---

## Task 7: 보안 점검 체크리스트 + 발견 구멍 수정

**Files:**
- Create: `docs/security-review.md`
- (수정: 점검 중 발견된 실제 구멍이 있으면 해당 파일)

- [ ] **Step 1: 점검 수행 + 문서 작성**

다음을 실제로 확인하며 `docs/security-review.md`를 작성한다(각 항목: 현황 → 판정 → 조치).

점검 명령 예:
```bash
# 1) 쓰기 라우트의 가드/소유권 — 컨트롤러별 @UseGuards·소유권 검사 확인
grep -rn "@Post\|@Patch\|@Put\|@Delete\|@UseGuards\|isMember\|ownerId\|NOT_AUTHOR\|NOT_BUILDING_MEMBER" src --include=*.ts | grep -v spec
# 2) 시크릿 하드코딩 여부(ConfigKey 외 직접 문자열 키 사용)
grep -rn "getOrThrow(\|process.env" src --include=*.ts | grep -v ConfigKey | grep -v spec
# 3) .env gitignore 확인
grep -n "env" .gitignore
```

`docs/security-review.md` 본문 구조(설계 §8 항목 6개):
```markdown
# 보안 점검 (M6)

> 점검일: 2026-06-15 · 대상: estate-server (M0~M6) · 기준: CLAUDE.md 보안 원칙

| # | 항목 | 현황 | 판정 | 조치 |
|---|------|------|------|------|
| 1 | RBAC + 리소스 소유권 우회 | (실제 확인 결과 기재) | OK/위험 | (조치/없음) |
| 2 | 인가 가드 누락 | … | … | … |
| 3 | 시크릿 노출(env·로그·에러) | … | … | … |
| 4 | 에러 정보 노출(500 마스킹) | … | … | … |
| 5 | rate limit 이중 제한 | … | … | … |
| 6 | 토큰 만료·초대코드 단일사용 | … | … | … |

## 발견 및 조치
- (발견된 구멍과 이번 PR에서의 수정 내역, 또는 "발견 없음")

## 후속 과제
- (범위 밖/수정 보류 항목)
```

> **실제 점검 결과를 채워라.** 표의 "현황/판정/조치"는 직접 코드를 확인한 사실로 작성한다(추측 금지). 위 항목 1~6을 각각 src에서 근거를 찾아 기재.

- [ ] **Step 2: 발견된 구멍 수정**

점검에서 **실제 위험**이 나오면 이번 PR에서 수정하고, 수정 내용을 위 "발견 및 조치"에 기록한다. 위험이 없으면 "발견 없음"으로 명시한다(억지 수정 금지).

- [ ] **Step 3: 발견 수정이 있었다면 회귀 테스트**

Run: `npx jest`
Expected: 전체 통과.

- [ ] **Step 4: 커밋**

```bash
git add docs/security-review.md
# (수정 파일이 있으면 함께 add)
git commit -m "[M6]docs: 보안 점검 체크리스트 작성 + 발견 구멍 조치"
```

---

## Task 8: 학습 노트 갱신 (별도 커밋)

**Files:**
- Modify: `docs/study/마일스톤-학습-노트.md`

> 팀 규칙: 마일스톤마다 학습 노트를 갱신한다. 기능 PR diff와 구분되도록 **별도 커밋**으로 둔다.

- [ ] **Step 1: §0 마일스톤 표에 M6 행 추가**

`docs/study/마일스톤-학습-노트.md`의 §0 "마일스톤 한눈에" 표 `M5` 행 아래에 추가:

```
| **M6** | rate limit(userId+IP 이중) + 보안 점검 | Redis 고정 윈도우 카운터, 전역 가드, 백엔드 이중 제한 |
```

- [ ] **Step 2: §2 Redis에 rate limit 학습 포인트 추가**

`### 2. Redis` 섹션의 용례 표에서 "원자적 카운터" 행 아래에 추가:

```
| **rate limit(고정 윈도우)** | RateLimitGuard(M6) | `ratelimit:{scope}:{id}:{창}` 키에 Lua로 INCR+EXPIRE 원자 실행, 카운트>한도면 429 |
```

그리고 `### 스스로 점검`(§2) 목록 끝에 추가:

```
- [ ] 고정 윈도우의 '경계 2배 버스트'가 왜 생기는지, 슬라이딩 윈도우가 어떻게 완화하는지 설명할 수 있는가?
- [ ] INCR과 EXPIRE를 왜 한 Lua로 묶나? (분리 시 TTL 없는 영구 키 race)
- [ ] 프론트엔드 rate limit만으로 부족한 이유(우회 가능)와 백엔드 userId+IP 이중 제한의 의미는?
```

- [ ] **Step 3: §6 인증·인가에 한 줄 보강 + "다음 예고" 갱신**

`### 6. 인증 · 인가`의 `더 팔 키워드` 줄에 `고정/슬라이딩 윈도우`가 없으면 추가하고, 문서 끝 "다음(M6) 예고"를 "다음(Outbox) 예고"로 갱신:

```
> **다음(Outbox) 예고:** Transactional Outbox로 dual-write 이벤트 유실(§3·§4·§8의 숙제)을 정면으로 푼다. rate limit·보안 점검은 M6에서 완료.
```

- [ ] **Step 4: 링크 점검 + 커밋**

Run: `grep -n "src/common/rate-limit" docs/study/마일스톤-학습-노트.md` (추가한 경로가 있으면 존재 확인)
Expected: 깨진 링크 없음(참조한 파일은 이미 생성됨).

```bash
git add docs/study/마일스톤-학습-노트.md
git commit -m "[M6]docs: 학습 노트에 rate limit(고정 윈도우) 포인트 추가"
```

---

## 완료 기준 체크리스트

- [ ] 쓰기 엔드포인트가 userId·IP 이중으로 제한되고, 초과 시 429 봉투 + `Retry-After` 반환(스모크 확인).
- [ ] 읽기(GET)는 기본 적용 제외, `@SkipRateLimit`/`@RateLimit` 오버라이드 동작.
- [ ] 로그인·회원가입은 IP 한도 강화(`ipMax: 10`).
- [ ] 고정 윈도우 카운터가 Lua로 원자 실행(INCR+EXPIRE).
- [ ] `docs/security-review.md`에 점검 결과 기록 + 발견 구멍 조치(또는 "발견 없음").
- [ ] 전체 테스트 통과 + 빌드 + eslint 0.
- [ ] 학습 노트에 M6/rate limit 포인트 반영(별도 커밋).

---

## 실행 핸드오프

이 계획은 **superpowers:subagent-driven-development**로 task 단위 실행을 권장한다. 또는 **superpowers:executing-plans**로 인라인 실행.
