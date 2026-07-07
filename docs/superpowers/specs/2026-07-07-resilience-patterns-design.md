# M12 회복탄력성 패턴 설계 — 카카오 OAuth (Retry·Circuit Breaker·Bulkhead)

> 작성: 2026-07-07. 근거 규칙: 개인 위키 `rules/stacks/resilience`(장애 대응 패턴 팀룰, NestJS+cockatiel 기준).

## 1. 배경 — 왜 필요한가

**회복탄력성(resilience) 패턴**은 외부 의존성이 느려지거나 죽었을 때 그 장애가 내 서비스 전체로 번지지 않도록 막는 방어 기법의 묶음입니다. 이 서버에서 외부 SaaS를 동기로 호출하는 유일한 지점은 `KakaoOAuthClient`(F1 소셜 로그인)이며, 현재 구현은 raw `fetch` 두 번(토큰 교환 POST → 프로필 조회 GET)에 **타임아웃·재시도·차단 장치가 전혀 없습니다**. 카카오가 응답을 멈추면:

1. 요청 스레드(이벤트 루프 태스크)가 무한 대기하고,
2. 로그인 시도가 쌓일수록 대기 중인 소켓·태스크가 늘어나 무관한 요청까지 느려지며(장애 전파),
3. 카카오가 완전히 죽어 있어도 매 로그인마다 풀 타임아웃을 기다립니다(빠른 실패 불가).

세 패턴이 각각 이 세 문제를 맡습니다:

- **타임아웃 + 재시도(retry)** — 오래 기다리지 않고 끊고, 일시적 오류는 짧게 다시 시도한다.
- **벌크헤드(bulkhead)** — 카카오 호출의 동시 진행 수에 상한을 둬, 느린 의존성이 서버 자원을 잠식하지 못하게 격리한다(선박의 격벽에서 온 이름).
- **서킷 브레이커(circuit breaker)** — 연속 실패가 임계를 넘으면 회로를 열어(open) 호출 자체를 즉시 거절하고, 일정 시간 후 반열림(half-open)으로 1건만 흘려보내 복구를 탐침한다.

## 2. 핵심 결정

| 결정 | 내용 | 근거 |
|---|---|---|
| 적용 대상 | 카카오 OAuth 호출 2건만 | 유일한 외부 SaaS 동기 호출. Kafka 발행은 Outbox(M9 백오프+DLQ)가 이미 재시도를 담당 — 중복 적용 금지 |
| 구현 | `cockatiel` 라이브러리 | TS 네이티브, 4개 정책(timeout·retry·circuitBreaker·bulkhead)을 `wrap`으로 표준 조합. 직접 구현은 half-open 상태 머신 등 버그 위험 대비 학습 이득이 낮다고 판단 |
| 재시도 범위 | **프로필 GET만** | OAuth 인가코드는 1회용 → 토큰 교환 POST는 비멱등. `Idempotency-Key` 미지원 POST 재시도는 위키 규칙상 금지 |
| 실패 시맨틱스 | fallback 없는 fail-fast | 로그인은 대체 데이터(캐시된 값·기본값)가 존재하지 않음 — 위키의 "가능하면 fallback" 조건 불충족을 명시적으로 기록 |
| 파라미터 | env(ConfigKey) + 코드 기본값 | 배포 없이 튜닝 가능. `.env.example`·`ConfigKey`에 등록, 미설정 시 코드 기본값 사용 |

## 3. 정책 조합 (위키 필수 순서)

`wrap()`은 첫 인자가 최외곽입니다. 위키의 장애 대응 정책 조합 규칙에 따라 **재시도(retry)를 가장 바깥, 타임아웃(timeout)을 가장 안쪽(시도당)** 으로 중첩합니다 — 정확한 중첩은 아래 다이어그램이 기준입니다(재시도 → 서킷 브레이커 → 벌크헤드 → 타임아웃).

```
프로필 GET :  retry ( circuitBreaker ( bulkhead ( timeout ( fetch ) ) ) )
토큰 POST  :          circuitBreaker ( bulkhead ( timeout ( fetch ) ) )
```

- **timeout이 최내곽** = 시도당 타임아웃. `TimeoutStrategy.Aggressive`로 AbortSignal을 만들어 fetch에 전달 — 시그널 없이는 "정책은 포기했는데 소켓은 계속 매달린" 유령 요청이 남는다.
- **retry가 circuitBreaker 바깥** = 각 재시도 시도가 브레이커 실패 카운트에 개별 집계되고, 재시도 도중 회로가 열리면 남은 시도가 즉시 차단된다. 순서 임의 변경 금지(위키).
- **브레이커·벌크헤드 인스턴스는 두 호출이 공유** — 토큰/프로필은 같은 로그인 플로우의 한 프로바이더(카카오)이고, 어느 쪽이 죽어도 로그인은 완성될 수 없으므로 하나의 의존성으로 취급한다. 단 위키 규칙(상태 섞임 금지)대로 **다른 의존성과는 절대 공유하지 않는다**. 정책은 앱 수명당 1회 생성(매 호출 생성 시 브레이커가 실패 카운트를 누적하지 못해 무력화됨).

## 4. 재시도 일시성 판별 — `handleAll` 금지

위키: 재시도는 "멱등 + 일시적 오류" 둘 다 통과할 때만. 4xx 재시도는 반려 대상.

현재 클라이언트는 실패를 문자열 `Error`로 던져 상태코드 구분이 불가능합니다. 이를 위해:

- **`KakaoApiError`**(HTTP status 보유) 커스텀 예외를 도입해 non-ok 응답에 던진다.
- 재시도 조건은 `handleWhen`으로 좁힌다 — **일시적 오류만**: 네트워크 오류(fetch TypeError), 타임아웃(TaskCancelledError는 별도 — timeout이 retry 안쪽이므로 시도 실패로 집계됨), `429`, `500/502/503/504`.
- `400/401/403/404`는 재시도하지 않고 즉시 전파(사용자·계약 오류).
- 백오프는 지수 + jitter(cockatiel `ExponentialBackoff` 기본이 jitter 포함). 고정 간격 금지.
- *한계(후속):* `429 Retry-After` 헤더 우선 존중 규칙은 인지하나, 로그인 플로우에서 429 비중이 낮아 이번 범위에서는 백오프로 단순화한다.

## 5. 관측 — 조용히 실패하는 서킷 금지 (위키 필수)

- `onBreak` → `Logger.warn('kakao circuit OPEN')` + **Sentry 캡처**(M10 인프라 재사용 — 회로 열림은 외부 의존성 장애 신호).
- `onHalfOpen` → `Logger.log`, `onReset` → `Logger.log('kakao circuit CLOSED')`.
- 벌크헤드 거절·타임아웃도 Logger에 원인별로 남긴다.

## 6. 에러 매핑 (M2.5 에러 봉투 연계)

`BrokenCircuitError`(회로 열림) / `BulkheadRejectedError`(포화) / `TaskCancelledError`(타임아웃) / 재시도 소진을 **각각 캐치해 원인별 로깅**하되, 사용자 응답은 새 카탈로그 항목 하나로 변환한다:

- `auth.errors.ts`에 추가: `KAKAO_UNAVAILABLE` — code `AUTH_KAKAO_UNAVAILABLE`, status `503 Service Unavailable`, message "카카오 로그인이 일시적으로 원활하지 않습니다. 잠시 후 다시 시도해주세요."
- 내부 에러 문자열은 사용자에게 노출하지 않는다(위키).
- `KakaoApiError` **5xx·429와 네트워크 오류는 재시도 유무와 무관하게**(토큰 POST의 단발 실패 포함) 최종 실패 시 `KAKAO_UNAVAILABLE`로 변환한다 — 카카오 측 장애라는 성격이 같기 때문이다.
- `KakaoApiError` **4xx**(인가코드 무효 등)는 기존 흐름대로 전파 — resilience 레이어가 삼키지 않는다(전역 필터 처리, 기존 동작 불변).

## 7. 구성 요소·배치

| 파일 | 역할 |
|---|---|
| `src/auth/infrastructure/kakao-resilience.ts` (신규) | env를 읽어 정책 4종을 조립·노출하는 NestJS 프로바이더. 소비자가 카카오 클라이언트뿐이라 `common/`이 아닌 auth 인프라에 둔다(둘째 의존성 등장 시 공용 추출) |
| `src/auth/infrastructure/kakao-api.error.ts` (신규) | status 보유 커스텀 예외(일시성 판별용) |
| `src/auth/infrastructure/kakao-oauth.client.ts` (수정) | 두 fetch를 각 정책 `.execute()`로 감싸고 signal 전달, cockatiel 예외 → `AppException(KAKAO_UNAVAILABLE)` 변환 |
| `src/auth/auth.errors.ts` (수정) | `KAKAO_UNAVAILABLE` 스펙 추가 |
| `src/config/config-keys.ts`·`.env.example` (수정) | 튜닝 키 등록 |

포트(`KakaoOAuth` 인터페이스)·유스케이스·컨트롤러는 변경하지 않는다 — resilience는 인프라 어댑터 내부 관심사다(헥사고날 경계 유지).

### 튜닝 파라미터 (env, 미설정 시 기본값)

| ConfigKey | env | 기본값 | 의미 |
|---|---|---|---|
| `KakaoTimeoutMs` | `KAKAO_TIMEOUT_MS` | 3000 | 시도당 타임아웃 |
| `KakaoRetryMaxAttempts` | `KAKAO_RETRY_MAX_ATTEMPTS` | 3 | 프로필 GET 최대 시도 수 |
| `KakaoBreakerThreshold` | `KAKAO_BREAKER_THRESHOLD` | 5 | 연속 실패 → open 임계(ConsecutiveBreaker) |
| `KakaoBreakerHalfOpenMs` | `KAKAO_BREAKER_HALF_OPEN_MS` | 10000 | open → half-open 대기 |
| `KakaoBulkheadConcurrent` | `KAKAO_BULKHEAD_CONCURRENT` | 10 | 동시 실행 상한 |
| `KakaoBulkheadQueue` | `KAKAO_BULKHEAD_QUEUE` | 20 | 대기열 크기 |
| `KakaoTotalTimeoutMs` | `KAKAO_TOTAL_TIMEOUT_MS` | 8000 | 프로필 재시도 전체의 벽시계 상한(느림 꼬리 지연 차단, 후속 실측으로 추가) |

*수치의 근거(위키: 추측값 금지에 대한 예외 명시):* 이 프로젝트에는 카카오 호출 실측(부하 테스트·트래픽 통계)이 없다. 위 값은 보수적 잠정값이며, 주석과 본 문서에 "실측 전 잠정값 — k6 실측 후 튜닝"을 명시해 규칙 위반을 투명하게 처리한다. 브레이커 open 기준을 연속 실패(ConsecutiveBreaker)로 두는 것은 트래픽이 적은 의존성에 대한 위키 기본값이다.

*브레이커 임계 × 재시도 배수 효과:* 재시도가 공유 브레이커 바깥에 있어(§3), 프로필 GET 한 번의 논리적 실패가 브레이커 연속 실패 카운트를 최대 `재시도 횟수 + 1`회 소모한다. 기본값(`breakerThreshold=5`, `retryMaxAttempts=3`)에서는 프로필 로그인 1~2회 실패만으로 회로가 열려 토큰 교환까지 차단될 수 있다. 실측 튜닝 시 `breakerThreshold`는 재시도 배수를 감안해 잡는다(대략 `임계치 ≳ (재시도 횟수 + 1) × 허용할 논리적 실패 수`). 상세: 학습 노트 §8.10.

## 8. 테스트 전략

외부(fetch)는 전부 mock. cockatiel은 실제 인스턴스를 사용해 정책 동작 자체를 검증한다(가짜 타이머 활용).

- **재시도**: 프로필 GET이 5xx/네트워크 오류 후 성공 시 재시도로 복구된다 / 4xx는 재시도 없이 즉시 전파된다 / **토큰 교환 POST는 어떤 실패에도 재시도되지 않는다**(호출 횟수 1 검증 — 이 스펙이 인가코드 이중 사용 회귀를 막는 안전망).
- **서킷**: 연속 실패 임계 도달 시 `BrokenCircuitError`로 즉시 거절되고 fetch가 호출되지 않는다 / onBreak 훅이 로깅을 남긴다.
- **벌크헤드**: 동시 실행+대기열 초과 시 `BulkheadRejectedError`.
- **타임아웃**: 응답 지연 시 시도당 타임아웃으로 취소된다.
- **에러 매핑**: 위 각 거절이 `AUTH_KAKAO_UNAVAILABLE`(503)로 변환된다 / 카카오 4xx는 그대로 전파된다.

## 9. 문서화

- README 마일스톤 표에 M12 행(본 커밋에서 *(예정)* 로 추가, 구현 완료 시 ✅ 전환) + 운영·견고함 후속 불릿.
- 학습 노트 새 절: 세 패턴의 개념과 역할 분담, 멱등성과 재시도 안전성(인가코드 1회용 문제), wrap 조합 순서의 의미, fail-fast vs fallback, Outbox 재시도(M9)와의 역할 구분(비동기 발행 경로 vs 동기 요청 경로).
- API 변화: 새 엔드포인트 없음. 카카오 로그인 실패 응답에 503(`AUTH_KAKAO_UNAVAILABLE`)이 추가되는 점을 README API 표·Swagger `@ApiResponse`에 반영.

## 10. 범위 밖 (후속 여지)

- `429 Retry-After` 헤더 존중(§4). 파라미터 실측 튜닝은 하네스로 진행([`load/results/m12-resilience.md`](../../../load/results/m12-resilience.md)), 그 과정에서 발견한 "느린 카카오 꼬리 지연"은 **전체 시간 예산(`KAKAO_TOTAL_TIMEOUT_MS`)으로 해소 완료**. 6종+1 값의 최종 확정은 프로덕션 실데이터 후속.
- Redis·DB 등 내부 인프라 I/O에의 확대 적용 — 위키 규칙상 대상이나, 이미 각자 드라이버 레벨 재연결·풀 상한이 있고 이번 학습 범위는 외부 SaaS 경로로 한정한다.
- 카카오 외 둘째 외부 의존성 등장 시 resilience 모듈 `common/` 승격.
