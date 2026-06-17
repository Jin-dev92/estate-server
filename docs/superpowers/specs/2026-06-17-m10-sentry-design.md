# M10 — Sentry 연동: 에러 추적 + 성능 모니터링 (설계 스펙)

> 작성일: 2026-06-17
> 선행: M2.5 전역 에러 처리(`AllExceptionsFilter`), M3~M9 Kafka 워커·Outbox
> 참고: 이전 프로젝트(thub/tatoa)의 Sentry 적용 — 프로파일 토글·beforeSend 마스킹·UserContext 첨부·URL별 샘플링에서 아이디어 차용.

---

## 1. 목적과 범위

M2.5 에러 봉투는 **사용자에게** 깔끔한 응답을 주지만, **서버 내부에서 무슨 일이 있었는지는 로그뿐**이라 검색·집계·알림·성능 가시성이 없다. M10은 **Sentry**로 ① 에러 추적(풀 스택+컨텍스트), ② 성능 모니터링(HTTP 트랜잭션)을 얹는다(M7 부하측정의 운영판).

### 범위 (이번 M10 = A + B)
- **에러 추적:** main의 5xx·미처리 예외 + 워커(컨슈머·relay)의 미처리 예외/poison 격리를 Sentry로 캡처(풀 스택).
- **성능 모니터링:** main HTTP 요청을 트랜잭션으로 자동 계측, **tracesSampler로 경로별 샘플링**.
- **컨텍스트:** 인증된 요청이면 **userId·role을 이벤트에 첨부**("누구에게 난 에러인지").
- **DSN 없으면 no-op**, **PII 스크러빙**.

### 범위에서 제외 (후속)
- **분산 트레이싱(HTTP→Kafka→워커)** = **M10.5**(트레이스 컨텍스트를 Outbox 행/이벤트 봉투에 실어 잇는 작업). 워커 성능 스팬도 여기로.
- 릴리스 추적·소스맵 업로드·알림 룰·세션 리플레이 = 후속(일부는 CI 마일스톤).

### 성공 기준
- DSN 설정 시: 5xx를 내면 Sentry 대시보드에 **풀 스택 + path/method + userId(인증 시)**가 찍힌다. HTTP 요청이 트랜잭션으로 집계된다.
- DSN 미설정 시: SDK가 no-op → 외부 전송 없이 정상 동작(로컬·테스트).
- 4xx·도메인 예상 예외(AppException/DomainError, 보통 4xx/422)는 **Sentry로 안 감**(노이즈 제거). 에러 봉투(M2.5) 응답은 변화 없음.
- Authorization·Cookie·password·token류 민감정보가 이벤트에 실리지 않는다.

---

## 2. 구성 요소 (책임 분리)

이전 프로젝트처럼 작은 단위로 책임을 나눈다. 모두 `src/common/sentry/` 아래.

```
src/common/sentry/
  init-sentry.ts        # Sentry.init 캡슐화(공유) — main·워커가 부트스트랩 맨 앞에서 호출
  init-sentry.spec.ts
  sentry-scrub.ts       # beforeSend: 민감정보 스크러빙 (순수 함수로 분리)
  sentry-scrub.spec.ts
  traces-sampler.ts     # 경로별 샘플링 비율 결정 (순수 함수)
  traces-sampler.spec.ts
```

main HTTP 캡처는 기존 `src/common/errors/all-exceptions.filter.ts`에 더한다(새 파일 아님).

---

## 3. 초기화 · 설정 (init-sentry)

- **의존성:** `@sentry/nestjs`(전이 의존 `@sentry/node`) 추가.
- **`initSentry(opts)`**: `Sentry.init({ dsn, environment, tracesSampler, sendDefaultPii: false, beforeSend })`를 한 곳에 캡슐화.
  - `dsn`이 비면 **init을 건너뛴다**(no-op) — 외부 전송 없음.
  - env를 직접 안 읽고 **인자로 받는다**(테스트 용이). 호출부(main/워커)가 `process.env`/`ConfigService`에서 읽어 넘긴다.
- **호출 위치:** main(`src/main.ts`)·워커 4종(`src/workers/*.main.ts`) **각 부트스트랩의 가장 앞**(가능한 한 일찍 init해야 런타임·HTTP 계측이 붙는다).
- **Config(ConfigKey + .env.example):**
  | ConfigKey | env | 기본 | 의미 |
  |---|---|---|---|
  | `SentryDsn` | `SENTRY_DSN` | `""` | 비면 no-op. **서버 env로만**(클라이언트 노출 금지) |
  | `SentryEnvironment` | `SENTRY_ENVIRONMENT` | `NODE_ENV`(없으면 `development`) | 환경 구분 태그 |
  | `SentryTracesSampleRate` | `SENTRY_TRACES_SAMPLE_RATE` | `0.1` | tracesSampler의 기본 샘플링 비율 |

---

## 4. 성능 샘플링 (traces-sampler)

flat `tracesSampleRate` 대신 **`tracesSampler` 콜백**으로 경로별 비율을 정한다(이전 프로젝트의 `SamplingRulesMatcher` 차용).

- 순수 함수 `decideTraceSample(name, defaultRate)`:
  - 비즈니스 외 경로 → **0.0**(추적 안 함, 노이즈·비용 절감). 현재 대상: `/docs`·`/docs-json`(Swagger). (향후 헬스체크 등이 생기면 목록에 추가.)
  - 그 외 → `defaultRate`(env 기본 0.1).
- `Sentry.init`의 `tracesSampler: (ctx) => decideTraceSample(ctx.name ?? ctx.request?.url, defaultRate)`로 연결.
- 제외 경로 목록은 상수로 추출(하드코딩 금지). 정규/접두 매칭은 단순 startsWith로 충분.

---

## 5. 에러 캡처

### 5.1 main (HTTP) — AllExceptionsFilter 보강
기존 필터의 `body.statusCode >= 500` 분기(현재 `logger.error`)에 Sentry 캡처를 더한다. **에러 봉투 응답은 그대로.**

```ts
if (body.statusCode >= 500) {
  this.logger.error(...);                       // 기존 유지
  Sentry.captureException(exception, (scope) => {
    const user = req.user as TokenPayload | undefined; // sub·email·role
    if (user) scope.setUser({ id: user.sub });   // id만(email=PII 제외)
    if (user?.role) scope.setTag('role', user.role);
    scope.setTag('path', req.url);
    scope.setTag('method', req.method);
    return scope;
  });
}
```

- **5xx만 전송** → 4xx 및 도메인 예상 예외(AppException/DomainError, 보통 4xx/422)는 자연히 제외(노이즈 제거).
- **userId(sub)·role을 scope에 첨부** — "누구에게 난 에러인지". email은 PII라 제외.
- DSN 미설정이면 `captureException`은 SDK 내부에서 no-op.

### 5.2 워커 (Kafka 컨슈머 · outbox relay)
HTTP가 아니라 자동 캡처가 없으므로 **미처리 예외 경로에서 수동 캡처**.
- 각 워커 부트스트랩 맨 앞 `initSentry()` 호출(§3).
- 컨슈머 핸들러/relay 틱에서 미처리 예외 → `Sentry.captureException`. **정상 멱등 흐름**(P2002 중복 무시 등)은 에러로 안 보냄.
- **poison 격리(M9)**: relay가 `{ quarantined: true }`로 FAILED 전환할 때 `Sentry.captureException`(eventId·attempts·lastError 태그) → "영구 실패 이벤트"를 운영 가시화(M9 ERROR 로그의 Sentry판).
- 캡처는 공통 래퍼(작은 헬퍼)로 묶어 단위 테스트 가능하게.

### 5.3 PII 스크러빙 (sentry-scrub)
- `sendDefaultPii: false`(헤더·쿠키·IP 자동 첨부 안 함) +
- 순수 함수 `scrubEvent(event)`를 `beforeSend`로 연결: 이벤트에 혹시 실린 `Authorization`·`Cookie` 헤더, `password`·`token`·`secret`류 값을 `***`로 마스킹/제거. (이전 프로젝트 `SensitiveDataFilter`/`SentryBreadcrumbHelper` 차용.)

---

## 6. 성능 모니터링 (B)
- §4의 `tracesSampler`로 HTTP 요청이 트랜잭션으로 계측(응답시간·처리량을 대시보드에서 본다).
- `AppModule`에 **`SentryModule.forRoot()`** 추가 → NestJS 컨트롤러/핸들러 스팬 계측(NestJS SDK 진입점).
- **워커 성능 스팬은 제외**(M10.5).

---

## 7. 테스트 (TDD, 외부 전송 없이 — `@sentry/nestjs` mock)
- **init-sentry:** DSN 비면 `Sentry.init` 미호출(no-op); DSN 있으면 기대 옵션(environment·tracesSampler·sendDefaultPii=false·beforeSend)으로 호출.
- **sentry-scrub:** `Authorization`/`Cookie` 헤더 제거, `password`·`token`·`secret` 값 마스킹. 평범한 필드는 보존.
- **traces-sampler:** `/docs`·`/docs-json` → 0, 그 외 → defaultRate.
- **AllExceptionsFilter:** 5xx → `Sentry.captureException` 1회(scope에 user id·path·method), 4xx → 미호출. 기존 에러 봉투 스펙 유지.
- **워커 캡처 래퍼:** 미처리 예외 시 captureException 1회, 정상 흐름 0회.

---

## 8. 문서 산출물
- **README:** 마일스톤 표 `M10 ✅`(에러+성능, 분산 트레이싱은 M10.5로 분리 명시). §2 기술 스택에 **Sentry(observability)** 추가. "운영 후속" 문단 갱신.
- **학습 노트:** M10 소절 — observability(에러 추적 vs 로깅), 트랜잭션/스팬, tracesSampler 경로별 샘플링, PII 스크러빙, 외부 SaaS 트레이드오프. 마일스톤 표에 M10 행.
- **용어집:** Sentry·DSN·observability·트랜잭션/스팬·tracesSampleRate/sampler·PII 스크러빙·breadcrumb 추가.
- `.env.example`에 `SENTRY_*` 3종. **DSN은 PR/문서에 실제 값 노출 금지**(env로만).

---

## 9. 단계별 검증
| 단계 | 산출물 | 검증 |
|---|---|---|
| 1 | 의존성 + `init-sentry`·`sentry-scrub`·`traces-sampler` + config | 순수 함수 단위 테스트 green, no-op 동작 |
| 2 | main 배선(`main.ts` init + `AppModule` SentryModule + 필터 캡처) | 필터 spec(5xx 캡처/4xx 미캡처) green, 빌드 0 |
| 3 | 워커 배선(4종 init + 캡처 래퍼 + relay poison 캡처) | 캡처 래퍼 spec green, 빌드 0 |
| 4 | 문서(README·학습 노트·용어집·.env.example) | 링크·표 갱신 |
| 5 | (선택) 실제 DSN으로 5xx 1건 유발 → Sentry 대시보드 확인 | 풀 스택·userId·트랜잭션 노출 |

---

## 10. 트레이드오프 메모 (학습 포인트)
- **관측성 ↔ 외부 의존:** 놓치는 에러가 줄고 디버깅이 빨라지지만, 외부 SaaS 의존·DSN 관리·PII 스크러빙 책임이 생긴다.
- **에러 추적 ≠ 로깅:** 로그는 텍스트 스트림, Sentry는 **그룹핑·빈도·영향 사용자·알림**을 주는 구조화 추적. M2.5 봉투(사용자용)와 Sentry(개발자용)는 **역할이 다르다**.
- **무엇을 보낼지 통제:** 5xx만·예상 예외 제외·경로별 샘플링 0 → 노이즈와 비용(이벤트·트랜잭션 쿼터)을 함께 줄인다. "전부 보내기"는 대시보드를 못 쓰게 만든다.
- **PII:** userId(sub)·role은 디버깅에 유용해 첨부하되 email 등 식별정보는 제외 — 가시성과 개인정보 보호의 균형.
- **DSN은 비밀이 아니지만 env로:** ingest 전용 키라 치명적이진 않으나, 설정은 코드 밖(env)에 두는 원칙을 지킨다.
