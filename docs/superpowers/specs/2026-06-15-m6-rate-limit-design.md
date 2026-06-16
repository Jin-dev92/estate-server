# M6: rate limit + 보안 점검 — 설계 스펙

> **상위 설계:** [building-owner-platform-design](2026-06-11-building-owner-platform-design.md) §6(보안 원칙), §6 마일스톤 M6
> **선행:** M0(JWT 인증·가드), M2.5(에러 봉투), Redis 인프라(`RedisService.runScript` Lua)
> **범위 메모:** M6은 **rate limit + 보안 점검**까지다. Transactional Outbox(dual-write 유실 해소)는 **별도 사이클**로 분리한다.

## 1. 목표

쓰기 엔드포인트에 **백엔드 rate limit**을 적용한다. CLAUDE.md 보안 원칙대로 **userId + IP 이중 제한**을 백엔드(서버)에서 구현하고, 스팸 요청이 과금/부하로 이어지는 것을 막는다. 더불어 지금까지 쌓인 인가·시크릿·에러 노출 표면을 **보안 점검 체크리스트**로 한 번 훑고 발견된 구멍을 수정한다.

**성공 기준**
- 쓰기 엔드포인트(POST/PATCH/PUT/DELETE)가 **userId·IP 두 축으로 각각 제한**되고, 둘 중 하나라도 한도를 넘으면 `429`를 M2.5 에러 봉투로 반환한다(`Retry-After` 포함).
- 로그인·회원가입 등 인증 라우트는 **IP 기반으로 더 빡센 한도**가 적용된다(브루트포스 방어).
- 읽기(GET)는 기본 적용 대상이 아니다.
- `docs/security-review.md`에 점검 결과가 기록되고, 발견된 실제 구멍은 이번 PR에서 수정된다.
- rate limit 로직이 단위 테스트로 검증된다(쓰기만 적용·GET 통과·오버라이드·이중 제한·429).

## 2. 비범위 (YAGNI / 별도 사이클)

- **Transactional Outbox** — dual-write 이벤트 유실 해소. 크고 독립적인 주제라 별도 spec/plan/PR.
- **슬라이딩 윈도우/토큰 버킷** — 1차는 고정 윈도우. 경계 버스트 한계는 문서로 명시.
- **분산 동기화·전역 레이트(글로벌 쿼터)·과금 연동** — 범위 밖.
- **부하 테스트** — 선택, 이번 범위 밖.

---

## 3. 적용 모델 & 가드

`RateLimitGuard`를 **전역 가드(`APP_GUARD`)** 로 등록한다.

판정 순서:
1. 핸들러/클래스에 `@SkipRateLimit()` 메타가 있으면 **통과**.
2. `@RateLimit(opts)` 메타가 있으면 그 한도(`{ userMax?, ipMax?, windowSec? }`)를 사용.
3. 메타가 없으면 **HTTP 메서드가 쓰기(POST/PATCH/PUT/DELETE)일 때만** 기본 한도를 적용하고, **GET 등 읽기는 통과**.
4. **IP는 항상**, **userId는 best-effort**로 식별해 두 키를 각각 검사한다(이중 제한). 둘 중 하나라도 한도를 넘으면 429.

### 3.1 userId 식별 (가드 실행 순서 문제)

전역 가드는 컨트롤러의 `JwtAuthGuard`보다 **먼저** 실행되므로 `req.user`가 아직 채워지지 않는다. 따라서 `RateLimitGuard`는 `Authorization: Bearer` 토큰을 **`JwtService.verify`로 best-effort 검증**해 `sub`만 얻는다.

- 토큰이 없거나 검증 실패면 **거부하지 않고** `userId = null`로 두어 **IP-only**로 진행한다(실제 인증 거부는 기존 `JwtAuthGuard` 책임 — 관심사 분리).
- 결과적으로 미인증 라우트(로그인·회원가입)는 자연히 IP-only가 된다.
- 비용: 인증 라우트에서 토큰이 두 번 검증된다(가드 + Passport). 학습 범위에서 허용하는 트레이드오프이며, 대안(인터셉터로 미루기)은 "접근 제어=가드" 관용을 깨므로 택하지 않는다.

---

## 4. Redis 고정 윈도우 (Lua 원자 연산)

레이트 카운팅은 도메인 로직이 아니므로 작은 **포트 + Redis 어댑터**(`rate-limit.store.ts`)로 둔다(테스트 격리).

- 키: `ratelimit:{scope}:{id}:{windowStart}` — `scope ∈ {user, ip}`, `windowStart = floor(now/windowSec)`.
- `RedisService.runScript`로 **원자적 INCR + 최초 1회 EXPIRE**:
  ```lua
  local c = redis.call('INCR', KEYS[1])
  if c == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return c
  ```
- 어댑터는 새 count(number)를 반환하고, **한도 비교는 가드(애플리케이션)** 가 한다(`count > max` → 초과).
- INCR과 EXPIRE를 한 스크립트로 묶는 이유: 둘이 분리되면 "INCR 후 EXPIRE 직전 크래시" 시 **TTL 없는 영구 키**가 남아 카운터가 영원히 초과 상태가 된다. Lua 원자성으로 방지.
- **고정 윈도우의 경계 버스트(최대 2배) 한계**는 주석·학습 노트로 명시한다(정확도 vs 단순성 트레이드오프 — 학습 포인트).

---

## 5. 한도 · 설정

`ConfigKey`(+ `.env.example`)에 추가:

| 키 | 기본값 | 의미 |
|---|---|---|
| `RATE_LIMIT_WINDOW_SEC` | `60` | 윈도우 길이(초) |
| `RATE_LIMIT_USER_MAX` | `60` | 윈도우당 userId 허용 쓰기 수 |
| `RATE_LIMIT_IP_MAX` | `120` | 윈도우당 IP 허용 쓰기 수(NAT 뒤 다중 사용자 고려해 더 큼) |

- 로그인·회원가입 라우트엔 `@RateLimit({ ipMax: 10 })`로 한도를 강화한다(브루트포스 방어).
- IP는 `req.ip`를 사용한다. **운영에서 프록시/LB 뒤에 있으면** `app.set('trust proxy', …)` 설정이 필요하다(스푸핑 방지 위해 신뢰 프록시만) — 설계 주석으로 명시하고, 본 단계는 직접 연결 가정.
- 모든 매직값(키 prefix, 메타데이터 키, Lua, 기본 한도)은 상수/`ConfigKey`로 둔다(하드코딩 금지).

---

## 6. 429 응답 (M2.5 봉투 재사용)

- `src/common/rate-limit/rate-limit.errors.ts`에 `RateLimitError.EXCEEDED` (`AppErrorSpec`): `{ code: 'RATE_LIMIT_EXCEEDED', status: 429(TOO_MANY_REQUESTS), message: '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' }`.
- 가드는 초과 시 **`Retry-After`(윈도우 잔여 초) 헤더**를 응답에 설정한 뒤 `new AppException(RateLimitError.EXCEEDED)`를 던진다 → 기존 `AllExceptionsFilter`가 봉투(`statusCode·code·message·path·timestamp`)로 렌더.
- README §7 "에러 응답 형식" 표에 `RATE_LIMIT_EXCEEDED | 429` 행을 추가한다.
- 코드 주석에 CLAUDE.md 보안 원칙(스팸 요청이 사용량 과금·부하로 이어질 수 있음)을 명시한다.

---

## 7. 파일 구조

```
src/common/rate-limit/
  rate-limit.constants.ts    메타데이터 키·Lua 스크립트·기본값 상수·키 빌더
  rate-limit.errors.ts       RateLimitError.EXCEEDED (AppErrorSpec)
  rate-limit.decorator.ts    @RateLimit(opts) · @SkipRateLimit()
  rate-limit.store.ts        RATE_LIMIT_STORE 포트 + RedisRateLimitStore(고정윈도우 INCR+EXPIRE)
  rate-limit.guard.ts        RateLimitGuard(식별·이중 검사·429+Retry-After)
  rate-limit.module.ts       store 제공 + JwtModule + APP_GUARD 등록(또는 AppModule에서 등록)
수정:
  src/config/config-keys.ts  3개 키 추가
  .env.example               3개 키 추가
  src/app.module.ts          RateLimitModule 임포트(또는 APP_GUARD provider)
  src/auth/interface/auth.controller.ts  로그인·회원가입에 @RateLimit({ ipMax: 10 })
  README.md                  §7 에러표에 RATE_LIMIT_EXCEEDED 행
docs/security-review.md      보안 점검 체크리스트 + 조치
```

> **모듈 배선:** `RateLimitGuard`는 `RATE_LIMIT_STORE`·`JwtService`·`ConfigService`를 주입받는다. `APP_GUARD`로 전역 등록하려면 provider가 DI 컨테이너에 있어야 하므로, `RateLimitModule`이 store·JwtModule을 구성하고 `{ provide: APP_GUARD, useClass: RateLimitGuard }`를 제공한다. `RedisModule`·`ConfigModule`은 전역.

---

## 8. 보안 점검 (체크리스트 + 발견 수정)

`docs/security-review.md`를 작성한다. 항목별 **현황 → 판정(OK/위험) → 조치**:

1. **RBAC + 리소스 소유권 우회** — 모든 쓰기 라우트가 역할 + "이 건물/방/글의 소유자·멤버인가"까지 검사하는가? 다른 건물 데이터 접근 우회 경로가 있는가? (property·board·chat·notification 전 컨텍스트)
2. **인가 가드 누락** — 인증이 필요한데 `@UseGuards(JwtAuthGuard)`가 빠진 라우트가 있는가?
3. **시크릿 노출** — JWT 시크릿·DB/Redis/Kafka 접속 정보가 `ConfigKey`(env)로만 접근되는가? `.env`가 gitignore인가? 로그·에러 응답에 시크릿이 새지 않는가?
4. **에러 정보 노출** — 500 에러가 스택/내부 구조를 노출하지 않고 `COMMON_INTERNAL_ERROR`로 마스킹되는가?
5. **rate limit** — 쓰기·인증 엔드포인트에 이중 제한이 적용됐는가(본 마일스톤 산출물 자체 점검)?
6. **인증 토큰/초대코드** — JWT 만료가 설정돼 있는가? 초대코드는 단일 사용·TTL인가?

발견된 **실제 구멍은 이번 PR에서 수정**하고, 수정 불가/범위 밖은 후속 이슈로 기록한다.

---

## 9. 테스트

- **단위**
  - `RedisRateLimitStore`: INCR 반환·최초 1회 EXPIRE 호출(mock Redis/`runScript`), 키 포맷.
  - `RateLimitGuard`:
    - 쓰기(POST)만 기본 적용, GET은 통과.
    - `@SkipRateLimit()` 통과, `@RateLimit(opts)` 한도 오버라이드.
    - userId+IP 이중 검사 — 한쪽만 초과해도 429.
    - 토큰 best-effort 식별(유효 토큰 → userId 키 검사, 무효/없음 → IP-only).
    - 초과 시 `AppException(RATE_LIMIT_EXCEEDED)` + `Retry-After` 헤더 설정.
- **회귀:** 전 스위트 통과(가드가 기존 라우트 동작을 깨지 않음 — 한도 내 정상 통과).

## 10. 알려진 한계 / 후속

- **고정 윈도우 경계 버스트:** 윈도우 경계에서 최대 2배까지 통과 가능 → 정밀 제어가 필요하면 슬라이딩 윈도우로 후속 개선.
- **단일 Redis 인스턴스 가정:** 분산/HA·프록시 IP 신뢰 설정은 운영 단계 과제.
- **Transactional Outbox(dual-write):** 별도 사이클에서 해소.
