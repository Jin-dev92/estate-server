# M12 회복탄력성 패턴 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카카오 OAuth 호출 2건(토큰 교환 POST·프로필 GET)을 cockatiel 정책(타임아웃·재시도·서킷 브레이커·벌크헤드)으로 감싸, 카카오 장애가 서버 전체로 번지지 않게 한다.

**Architecture:** `KakaoResilience` 프로바이더가 env 파라미터로 정책을 1회 조립하고, `KakaoOAuthClient`가 각 fetch를 정책 `.execute()`로 감싼다. non-ok 판정은 정책 **안**에서 `KakaoApiError`(status 보유)로 던져 재시도·브레이커가 5xx를 실패로 집계하게 한다. 거절(회로 open·포화·타임아웃)·일시 오류 소진은 `AppException(AUTH_KAKAO_UNAVAILABLE, 503)`으로, 4xx는 기존대로 전파. 포트·유스케이스·컨트롤러 로직 불변.

**Tech Stack:** NestJS, cockatiel(^3), @sentry/nestjs(기존), Jest.

**참조 스펙:** `docs/superpowers/specs/2026-07-07-resilience-patterns-design.md`

## Global Constraints

- **조합 순서(위키 필수)**: 프로필 GET `wrap(retry, circuitBreaker, bulkhead, timeout)`, 토큰 POST `wrap(circuitBreaker, bulkhead, timeout)`. `wrap`은 첫 인자가 최외곽. timeout 최내곽=시도당(`TimeoutStrategy.Aggressive`), AbortSignal을 fetch에 전달.
- **재시도는 프로필 GET만**. 토큰 교환 POST는 비멱등(인가코드 1회용) — 어떤 실패에도 재시도 금지.
- **`handleAll` 금지**: 재시도·브레이커 집계는 일시적 오류만 — 네트워크 오류(TypeError)·타임아웃(TaskCancelledError)·`KakaoApiError.transient`(429·5xx). 4xx는 제외. `BrokenCircuitError`도 제외(open 시 남은 재시도 즉시 중단).
- **브레이커·벌크헤드 인스턴스는 두 호출이 공유**(카카오 = 한 의존성), 다른 의존성과 공유 금지. 정책은 앱 수명당 1회 생성.
- **서킷 상태 변화 로깅 필수**: `onBreak`(warn + Sentry) / `onHalfOpen` / `onReset`. 조용히 실패하는 서킷 금지.
- 파라미터 6종은 env(ConfigKey)+코드 기본값: timeout 3000ms, retry 3, breaker 임계 5, half-open 10000ms, bulkhead 10/20. 주석에 "실측 전 잠정값" 명시.
- 매직 스트링·넘버 금지(ConfigKey·상수). 커밋 `[M12]{type}: {한글}`. push 전 `npm run lint:check`.
- 테스트 규칙: `*.spec.ts` 동일 디렉토리, AAA, `as any` 금지.

---

### Task 1: KakaoApiError — status 보유 예외 + 일시성 판별

**Files:**
- Create: `src/auth/infrastructure/kakao-api.error.ts`
- Test: `src/auth/infrastructure/kakao-api.error.spec.ts`

**Interfaces:**
- Produces: `class KakaoApiError extends Error { constructor(label: string, readonly status: number); get transient(): boolean }` — 메시지는 `카카오 ${label} 실패: ${status}` (기존 클라이언트 에러 메시지 프리픽스와 호환).

- [ ] **Step 1: 실패하는 스펙 작성**

Create `src/auth/infrastructure/kakao-api.error.spec.ts`:

```ts
import { KakaoApiError } from './kakao-api.error';

describe('KakaoApiError', () => {
  it('메시지에 라벨과 status를 담는다', () => {
    const err = new KakaoApiError('토큰 교환', 400);

    expect(err.message).toBe('카카오 토큰 교환 실패: 400');
    expect(err.status).toBe(400);
  });

  describe('transient (일시성 판별)', () => {
    it.each([429, 500, 502, 503, 504])('%i은 일시적(재시도 대상)', (status) => {
      expect(new KakaoApiError('프로필 조회', status).transient).toBe(true);
    });

    it.each([400, 401, 403, 404])('%i는 일시적이 아님(재시도 금지)', (status) => {
      expect(new KakaoApiError('프로필 조회', status).transient).toBe(false);
    });
  });
});
```

- [ ] **Step 2: 실패 확인**

Run: `npx jest src/auth/infrastructure/kakao-api.error.spec.ts`
Expected: FAIL — `Cannot find module './kakao-api.error'`.

- [ ] **Step 3: 구현**

Create `src/auth/infrastructure/kakao-api.error.ts`:

```ts
// 카카오 HTTP non-ok 응답용 예외. status를 보존해 일시성(재시도 가능) 판별에 쓴다.
// 문자열 Error로는 4xx/5xx를 구분할 수 없어 handleAll 재시도가 강제되는 문제를 푼다.
export class KakaoApiError extends Error {
  constructor(
    label: string,
    readonly status: number,
  ) {
    super(`카카오 ${label} 실패: ${status}`);
    this.name = 'KakaoApiError';
  }

  // 일시적(카카오 측) 오류 — 429·5xx만. 4xx는 사용자·계약 오류라 재시도 금지(위키 팀룰).
  get transient(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}
```

- [ ] **Step 4: 통과 확인**

Run: `npx jest src/auth/infrastructure/kakao-api.error.spec.ts`
Expected: PASS (10 케이스).

- [ ] **Step 5: Commit**

```bash
npm run build && npm run lint:check
git add src/auth/infrastructure/kakao-api.error.ts src/auth/infrastructure/kakao-api.error.spec.ts
git commit -m "[M12]feat: KakaoApiError — status 보유·일시성 판별 예외"
```

---

### Task 2: cockatiel 설치 + env 키 + KakaoResilience 프로바이더

**Files:**
- Modify: `package.json` (cockatiel 설치)
- Modify: `src/config/config-keys.ts` (키 6종)
- Modify: `.env.example` (키 6종 + 주석)
- Create: `src/auth/infrastructure/kakao-resilience.ts`
- Test: `src/auth/infrastructure/kakao-resilience.spec.ts`

**Interfaces:**
- Consumes: `KakaoApiError`(Task 1), `ConfigService`, cockatiel.
- Produces: `@Injectable() class KakaoResilience { readonly tokenPolicy: IPolicy; readonly profilePolicy: IPolicy }` — Task 3의 클라이언트가 주입받아 `.execute(({ signal }) => ...)`로 사용.

- [ ] **Step 1: cockatiel 설치**

```bash
npm install cockatiel
```

Expected: `package.json` dependencies에 `"cockatiel": "^3.x"` 추가.

- [ ] **Step 2: ConfigKey·.env.example 등록**

`src/config/config-keys.ts`의 `ConfigKey` enum 끝(Sentry 키들 뒤)에 추가:

```ts
  KakaoTimeoutMs = 'KAKAO_TIMEOUT_MS',
  KakaoRetryMaxAttempts = 'KAKAO_RETRY_MAX_ATTEMPTS',
  KakaoBreakerThreshold = 'KAKAO_BREAKER_THRESHOLD',
  KakaoBreakerHalfOpenMs = 'KAKAO_BREAKER_HALF_OPEN_MS',
  KakaoBulkheadConcurrent = 'KAKAO_BULKHEAD_CONCURRENT',
  KakaoBulkheadQueue = 'KAKAO_BULKHEAD_QUEUE',
```

`.env.example`의 카카오 블록(`KAKAO_CLIENT_SECRET` 아래)에 추가:

```bash
# 카카오 호출 회복탄력성(M12) — 미설정 시 코드 기본값. 실측 전 잠정값(k6 튜닝 후속).
KAKAO_TIMEOUT_MS="3000"
KAKAO_RETRY_MAX_ATTEMPTS="3"
KAKAO_BREAKER_THRESHOLD="5"
KAKAO_BREAKER_HALF_OPEN_MS="10000"
KAKAO_BULKHEAD_CONCURRENT="10"
KAKAO_BULKHEAD_QUEUE="20"
```

- [ ] **Step 3: 실패하는 스펙 작성**

Create `src/auth/infrastructure/kakao-resilience.spec.ts`:

```ts
import { ConfigService } from '@nestjs/config';
import { KakaoResilience } from './kakao-resilience';
import { KakaoApiError } from './kakao-api.error';

// env 미설정(기본값) ConfigService stub. overrides로 특정 키만 주입.
function stubConfig(overrides?: Record<string, string>): ConfigService {
  return {
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
}

describe('KakaoResilience', () => {
  it('tokenPolicy·profilePolicy를 노출하고 성공 결과를 그대로 반환한다', async () => {
    const r = new KakaoResilience(stubConfig());

    const result = await r.tokenPolicy.execute(() => Promise.resolve('ok'));

    expect(result).toBe('ok');
  });

  it('profilePolicy는 일시 오류(5xx) 후 성공하면 재시도로 복구한다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    const result = await r.profilePolicy.execute(() => {
      calls += 1;
      if (calls === 1)
        return Promise.reject(new KakaoApiError('프로필 조회', 500));
      return Promise.resolve('recovered');
    });

    expect(result).toBe('recovered');
    expect(calls).toBe(2);
  });

  it('profilePolicy도 4xx는 재시도하지 않는다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    await expect(
      r.profilePolicy.execute(() => {
        calls += 1;
        return Promise.reject(new KakaoApiError('프로필 조회', 401));
      }),
    ).rejects.toThrow('카카오 프로필 조회 실패: 401');

    expect(calls).toBe(1);
  });

  it('tokenPolicy는 일시 오류(5xx)라도 재시도하지 않는다', async () => {
    const r = new KakaoResilience(stubConfig());
    let calls = 0;

    await expect(
      r.tokenPolicy.execute(() => {
        calls += 1;
        return Promise.reject(new KakaoApiError('토큰 교환', 500));
      }),
    ).rejects.toThrow('카카오 토큰 교환 실패: 500');

    expect(calls).toBe(1);
  });
});
```

- [ ] **Step 4: 실패 확인**

Run: `npx jest src/auth/infrastructure/kakao-resilience.spec.ts`
Expected: FAIL — `Cannot find module './kakao-resilience'`.

- [ ] **Step 5: 프로바이더 구현**

Create `src/auth/infrastructure/kakao-resilience.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as Sentry from '@sentry/nestjs';
import {
  bulkhead,
  circuitBreaker,
  ConsecutiveBreaker,
  ExponentialBackoff,
  handleWhen,
  IPolicy,
  retry,
  TaskCancelledError,
  timeout,
  TimeoutStrategy,
  wrap,
} from 'cockatiel';
import { ConfigKey } from '../../config/config-keys';
import { KakaoApiError } from './kakao-api.error';

// 실측 전 잠정값(스펙 §7 — 카카오 트래픽 실측 후 k6로 튜닝). env 미설정 시 사용.
const DEFAULTS = {
  timeoutMs: 3000,
  retryMaxAttempts: 3,
  breakerThreshold: 5,
  breakerHalfOpenMs: 10_000,
  bulkheadConcurrent: 10,
  bulkheadQueue: 20,
} as const;

// 일시적(카카오 측) 오류만 재시도·브레이커 집계 대상(handleAll 금지 — 위키 팀룰).
// - TaskCancelledError: 시도당 타임아웃(최내곽 timeout 정책)
// - TypeError: fetch 네트워크 오류(연결 거부·DNS 등)
// - KakaoApiError.transient: 429·5xx (4xx는 사용자·계약 오류라 제외)
// BrokenCircuitError는 의도적으로 제외 — 회로 open 시 남은 재시도가 즉시 중단된다.
const transientOnly = handleWhen(
  (err) =>
    err instanceof TaskCancelledError ||
    err instanceof TypeError ||
    (err instanceof KakaoApiError && err.transient),
);

// 카카오 의존성 전용 정책 세트(앱 수명당 1회 생성 — 매 호출 생성 시 브레이커가
// 실패 카운트를 누적하지 못해 무력화된다). 다른 의존성과 인스턴스 공유 금지.
@Injectable()
export class KakaoResilience {
  private readonly logger = new Logger(KakaoResilience.name);

  // 토큰 교환 POST: 비멱등(인가코드 1회용) → 재시도 없음.
  readonly tokenPolicy: IPolicy;
  // 프로필 GET: 멱등 → 재시도 포함.
  readonly profilePolicy: IPolicy;

  constructor(config: ConfigService) {
    // env는 문자열로 오므로 숫자 변환. 미설정 시 코드 기본값.
    const num = (key: ConfigKey, fallback: number): number => {
      const raw = config.get<string>(key);
      return raw != null ? Number(raw) : fallback;
    };

    // 시도당 타임아웃. Aggressive = 콜백 완료를 기다리지 않고 즉시 거절 + AbortSignal 전파.
    const timeoutPolicy = timeout(
      num(ConfigKey.KakaoTimeoutMs, DEFAULTS.timeoutMs),
      TimeoutStrategy.Aggressive,
    );

    // 동시 실행 격리(세마포어) — 느린 카카오가 이벤트 루프 태스크를 잠식하지 못하게.
    const bulkheadPolicy = bulkhead(
      num(ConfigKey.KakaoBulkheadConcurrent, DEFAULTS.bulkheadConcurrent),
      num(ConfigKey.KakaoBulkheadQueue, DEFAULTS.bulkheadQueue),
    );

    // 연속 실패 임계 초과 시 open → 즉시 거절, half-open으로 복구 탐침.
    const breaker = circuitBreaker(transientOnly, {
      halfOpenAfter: num(
        ConfigKey.KakaoBreakerHalfOpenMs,
        DEFAULTS.breakerHalfOpenMs,
      ),
      breaker: new ConsecutiveBreaker(
        num(ConfigKey.KakaoBreakerThreshold, DEFAULTS.breakerThreshold),
      ),
    });
    // 조용히 실패하는 서킷 금지(위키) — 상태 변화 로깅, open은 Sentry로 알린다.
    breaker.onBreak(() => {
      this.logger.warn('카카오 circuit OPEN — 호출 차단 시작');
      Sentry.captureMessage('kakao circuit OPEN', 'warning');
    });
    breaker.onHalfOpen(() => this.logger.log('카카오 circuit HALF-OPEN — 복구 탐침'));
    breaker.onReset(() => this.logger.log('카카오 circuit CLOSED — 복구'));

    // 지수 백오프 + jitter(cockatiel 기본이 decorrelated jitter). 고정 간격 금지.
    const retryPolicy = retry(transientOnly, {
      maxAttempts: num(
        ConfigKey.KakaoRetryMaxAttempts,
        DEFAULTS.retryMaxAttempts,
      ),
      backoff: new ExponentialBackoff(),
    });

    // wrap은 첫 인자가 최외곽(위키 필수 순서: Retry → CB → Bulkhead → Timeout).
    // retry가 breaker 바깥이라 각 재시도가 브레이커에 개별 집계되고,
    // 도중 open되면 남은 재시도가 즉시 차단된다. 순서 임의 변경 금지.
    this.tokenPolicy = wrap(breaker, bulkheadPolicy, timeoutPolicy);
    this.profilePolicy = wrap(retryPolicy, breaker, bulkheadPolicy, timeoutPolicy);
  }
}
```

- [ ] **Step 6: 통과 확인**

Run: `npx jest src/auth/infrastructure/kakao-resilience.spec.ts`
Expected: PASS (4 케이스). 재시도 케이스는 백오프(~130ms+jitter) 때문에 수백 ms 걸릴 수 있음 — 정상.

- [ ] **Step 7: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add package.json package-lock.json src/config/config-keys.ts .env.example src/auth/infrastructure/kakao-resilience.ts src/auth/infrastructure/kakao-resilience.spec.ts
git commit -m "[M12]feat: KakaoResilience — cockatiel 정책 조립(타임아웃·재시도·서킷·벌크헤드)"
```

---

### Task 3: 클라이언트 배선 + 에러 매핑 (503 KAKAO_UNAVAILABLE)

**Files:**
- Modify: `src/auth/auth.errors.ts` (`KAKAO_UNAVAILABLE` 추가)
- Modify: `src/auth/infrastructure/kakao-oauth.client.ts`
- Modify: `src/auth/auth.module.ts` (`KakaoResilience` 프로바이더 등록)
- Test: `src/auth/infrastructure/kakao-oauth.client.spec.ts` (기존 갱신 + 케이스 추가)

**Interfaces:**
- Consumes: `KakaoApiError`(Task 1), `KakaoResilience`(Task 2), `AppException`/`AuthError`(기존).
- Produces: `KakaoOAuthClient` 생성자 `(config: ConfigService, resilience: KakaoResilience)`. 외부 계약(`KakaoOAuth` 포트) 불변.

- [ ] **Step 1: 에러 카탈로그 추가**

`src/auth/auth.errors.ts`의 `AuthError`에 추가(`INVALID_ONBOARDING` 뒤):

```ts
  KAKAO_UNAVAILABLE: {
    code: 'AUTH_KAKAO_UNAVAILABLE',
    status: HttpStatus.SERVICE_UNAVAILABLE,
    message:
      '카카오 로그인이 일시적으로 원활하지 않습니다. 잠시 후 다시 시도해주세요.',
  },
```

- [ ] **Step 2: 실패하는 스펙 작성 (기존 spec 갱신 + 신규 케이스)**

`src/auth/infrastructure/kakao-oauth.client.spec.ts` 전체를 다음으로 교체한다. 기존 4개 행위는 유지하고(생성자 변경 반영), resilience 신규 케이스를 추가:

```ts
import { ConfigService } from '@nestjs/config';
import { KakaoOAuthClient } from './kakao-oauth.client';
import { KakaoResilience } from './kakao-resilience';
import { AppException } from '../../common/errors/app-exception';
import { ConfigKey } from '../../config/config-keys';

const KAKAO_UNAVAILABLE_CODE = 'AUTH_KAKAO_UNAVAILABLE';

// client id/secret + resilience env(overrides로 키별 주입) stub.
function stubConfig(overrides?: Record<string, string>): ConfigService {
  return {
    getOrThrow: (key: ConfigKey) =>
      key === ConfigKey.KakaoClientId ? 'cid' : 'csecret',
    get: (key: string) => overrides?.[key],
  } as unknown as ConfigService;
}

// 정책 상태(브레이커)가 테스트 간 새어 나가지 않도록 매번 새로 조립한다.
function makeClient(overrides?: Record<string, string>): KakaoOAuthClient {
  const config = stubConfig(overrides);
  return new KakaoOAuthClient(config, new KakaoResilience(config));
}

function jsonRes(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const PROFILE_BODY = {
  id: 12345,
  kakao_account: { email: 'a@b.com', profile: { nickname: '홍길동' } },
};

describe('KakaoOAuthClient', () => {
  afterEach(() => jest.restoreAllMocks());

  it('code→token 교환 후 프로필을 매핑한다', async () => {
    const fetchMock = jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonRes(PROFILE_BODY));

    const profile = await makeClient().exchangeAndFetch(
      'code',
      'http://localhost:3000/cb',
    );

    expect(profile).toEqual({
      providerId: '12345',
      email: 'a@b.com',
      name: '홍길동',
    });
    // 토큰 교환은 POST, 프로필은 Bearer 호출.
    expect((fetchMock.mock.calls[0][1] as RequestInit).method).toBe('POST');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('이메일/닉네임 없으면 email=null·name 기본값', async () => {
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
      .mockResolvedValueOnce(jsonRes({ id: 9, kakao_account: {} }));

    const profile = await makeClient().exchangeAndFetch('code', 'cb');

    expect(profile).toEqual({
      providerId: '9',
      email: null,
      name: '카카오사용자',
    });
  });

  describe('4xx — 재시도·변환 없이 전파', () => {
    it('토큰 교환 400이면 KakaoApiError 전파, 프로필 호출 안 함', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({}, false, 400));

      await expect(makeClient().exchangeAndFetch('bad', 'cb')).rejects.toThrow(
        '카카오 토큰 교환 실패: 400',
      );

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('프로필 401이면 재시도 없이 전파(fetch 총 2회)', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
        .mockResolvedValueOnce(jsonRes({}, false, 401));

      await expect(makeClient().exchangeAndFetch('code', 'cb')).rejects.toThrow(
        '카카오 프로필 조회 실패: 401',
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('재시도 — 프로필 GET만', () => {
    it('프로필 5xx 후 성공하면 재시도로 복구한다', async () => {
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({ access_token: 'AT' }))
        .mockResolvedValueOnce(jsonRes({}, false, 502))
        .mockResolvedValueOnce(jsonRes(PROFILE_BODY));

      const profile = await makeClient().exchangeAndFetch('code', 'cb');

      expect(profile.providerId).toBe('12345');
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('토큰 교환 5xx는 재시도 없이 503으로 변환된다(인가코드 이중 사용 방지)', async () => {
      expect.assertions(3);
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce(jsonRes({}, false, 500));

      try {
        await makeClient().exchangeAndFetch('code', 'cb');
      } catch (err) {
        expect(err).toBeInstanceOf(AppException);
        expect((err as AppException).code).toBe(KAKAO_UNAVAILABLE_CODE);
      }

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('서킷 브레이커', () => {
    it('연속 실패 임계 도달 후 호출은 fetch 없이 즉시 503', async () => {
      expect.assertions(3);
      // 임계 2로 좁혀 빠르게 open. 재시도는 프로필에만 있으므로 토큰 500 사용.
      const overrides = { KAKAO_BREAKER_THRESHOLD: '2' };
      const client = makeClient(overrides);
      const fetchMock = jest
        .spyOn(global, 'fetch')
        .mockResolvedValue(jsonRes({}, false, 500));

      await expect(client.exchangeAndFetch('c1', 'cb')).rejects.toThrow();
      await expect(client.exchangeAndFetch('c2', 'cb')).rejects.toThrow();
      // 임계 도달 → open. 3번째는 차단되어 fetch가 늘지 않는다.
      try {
        await client.exchangeAndFetch('c3', 'cb');
      } catch (err) {
        expect((err as AppException).code).toBe(KAKAO_UNAVAILABLE_CODE);
      }

      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  describe('벌크헤드·타임아웃', () => {
    it('동시 상한 초과는 즉시 503, 매달린 호출은 시도당 타임아웃으로 503', async () => {
      // 동시 1·큐 0·타임아웃 100ms. 브레이커는 넉넉히 둬 간섭 배제.
      const overrides = {
        KAKAO_BULKHEAD_CONCURRENT: '1',
        KAKAO_BULKHEAD_QUEUE: '0',
        KAKAO_TIMEOUT_MS: '100',
        KAKAO_BREAKER_THRESHOLD: '10',
      };
      const client = makeClient(overrides);
      // 영원히 매달리는 fetch(타임아웃이 끊어야 함).
      jest
        .spyOn(global, 'fetch')
        .mockImplementation(() => new Promise<Response>(() => undefined));

      const hanging = client.exchangeAndFetch('c1', 'cb');
      const rejected = client.exchangeAndFetch('c2', 'cb');

      await expect(rejected).rejects.toMatchObject({
        code: KAKAO_UNAVAILABLE_CODE, // 벌크헤드 포화
      });
      await expect(hanging).rejects.toMatchObject({
        code: KAKAO_UNAVAILABLE_CODE, // 타임아웃
      });
    });
  });
});
```

- [ ] **Step 3: 실패 확인**

Run: `npx jest src/auth/infrastructure/kakao-oauth.client.spec.ts`
Expected: FAIL — `KakaoOAuthClient` 생성자가 2번째 인자를 받지 않음 / 503 변환 부재.

- [ ] **Step 4: 클라이언트 구현 수정**

`src/auth/infrastructure/kakao-oauth.client.ts` 전체 교체:

```ts
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BrokenCircuitError,
  BulkheadRejectedError,
  IPolicy,
  TaskCancelledError,
} from 'cockatiel';
import { ConfigKey } from '../../config/config-keys';
import { KakaoOAuth, KakaoProfile } from '../domain/kakao-oauth';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { KakaoApiError } from './kakao-api.error';
import { KakaoResilience } from './kakao-resilience';

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const PROFILE_URL = 'https://kapi.kakao.com/v2/user/me';
const TOKEN_LABEL = '토큰 교환';
const PROFILE_LABEL = '프로필 조회';

@Injectable()
export class KakaoOAuthClient implements KakaoOAuth {
  private readonly logger = new Logger(KakaoOAuthClient.name);

  constructor(
    private readonly config: ConfigService,
    private readonly resilience: KakaoResilience,
  ) {}

  async exchangeAndFetch(
    code: string,
    redirectUri: string,
  ): Promise<KakaoProfile> {
    const clientId = this.config.getOrThrow<string>(ConfigKey.KakaoClientId);
    const clientSecret = this.config.getOrThrow<string>(
      ConfigKey.KakaoClientSecret,
    );

    // 토큰 교환(POST·비멱등): 재시도 없는 tokenPolicy.
    const token = (await this.callKakao(
      this.resilience.tokenPolicy,
      TOKEN_LABEL,
      (signal) =>
        fetch(TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code',
            client_id: clientId,
            client_secret: clientSecret,
            redirect_uri: redirectUri,
            code,
          }),
          signal,
        }),
    )) as { access_token: string };

    // 프로필 조회(GET·멱등): 재시도 포함 profilePolicy.
    const p = (await this.callKakao(
      this.resilience.profilePolicy,
      PROFILE_LABEL,
      (signal) =>
        fetch(PROFILE_URL, {
          headers: { Authorization: `Bearer ${token.access_token}` },
          signal,
        }),
    )) as {
      id: number;
      kakao_account?: { email?: string; profile?: { nickname?: string } };
    };

    return {
      providerId: String(p.id),
      email: p.kakao_account?.email ?? null,
      name: p.kakao_account?.profile?.nickname ?? '카카오사용자',
    };
  }

  // 정책으로 감싼 카카오 호출. non-ok 판정을 정책 "안"에서 던져야
  // 재시도·브레이커가 5xx를 실패로 집계한다. AbortSignal은 타임아웃 정책이 공급.
  private async callKakao(
    policy: IPolicy,
    label: string,
    request: (signal: AbortSignal) => Promise<Response>,
  ): Promise<unknown> {
    try {
      return await policy.execute(async ({ signal }) => {
        const res = await request(signal);
        if (!res.ok) throw new KakaoApiError(label, res.status);
        return res.json() as Promise<unknown>;
      });
    } catch (err) {
      throw this.mapFailure(err, label);
    }
  }

  // 실패 매핑(스펙 §6): 4xx는 그대로(사용자·계약 오류), 거절·일시 오류는
  // 원인별 로깅 후 공통 503으로. 내부 에러 문자열은 사용자에게 노출하지 않는다.
  private mapFailure(err: unknown, label: string): unknown {
    if (err instanceof KakaoApiError && !err.transient) return err;
    if (err instanceof BrokenCircuitError) {
      this.logger.warn(`카카오 ${label} 거부 — circuit open(빠른 실패)`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    if (err instanceof BulkheadRejectedError) {
      this.logger.warn(`카카오 ${label} 거부 — 벌크헤드 포화`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    if (err instanceof TaskCancelledError) {
      this.logger.warn(`카카오 ${label} 실패 — 시도당 타임아웃 초과`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    if (err instanceof KakaoApiError || err instanceof TypeError) {
      this.logger.warn(`카카오 ${label} 실패 — 일시 오류(5xx·네트워크) 소진`);
      return new AppException(AuthError.KAKAO_UNAVAILABLE);
    }
    return err;
  }
}
```

- [ ] **Step 5: AuthModule에 프로바이더 등록**

`src/auth/auth.module.ts`:
- import 추가: `import { KakaoResilience } from './infrastructure/kakao-resilience';`
- `providers` 배열에 `KakaoResilience,` 추가(`{ provide: KAKAO_OAUTH, ... }` 위).

- [ ] **Step 6: 통과 확인 + 전체 회귀**

Run: `npx jest src/auth/infrastructure/` → PASS(신규 포함 전부).
Run: `npm test` → 전 스위트 PASS.

- [ ] **Step 7: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/auth/auth.errors.ts src/auth/infrastructure/kakao-oauth.client.ts src/auth/infrastructure/kakao-oauth.client.spec.ts src/auth/auth.module.ts
git commit -m "[M12]feat: 카카오 클라이언트에 회복탄력성 정책 배선 + 503 매핑"
```

---

### Task 4: Swagger 503 + README API 표

**Files:**
- Modify: `src/auth/interface/auth.controller.ts` (`POST /auth/kakao` 라우트)
- Modify: `README.md` (auth API 표 262행 부근)

**Interfaces:**
- Consumes: 없음(문서·데코레이터만). `/auth/kakao/complete`는 카카오를 호출하지 않으므로 대상 아님.

- [ ] **Step 1: Swagger 503 응답 추가**

`src/auth/interface/auth.controller.ts`의 `kakaoLoginHandler` 데코레이터 블록(기존 404 `@ApiResponse` 뒤)에 추가:

```ts
  @ApiResponse({
    status: 503,
    type: ErrorResponseDto,
    description: '카카오 일시 장애(circuit open·포화·타임아웃) — M12',
  })
```

- [ ] **Step 2: README API 표 갱신**

`README.md`의 `POST /auth/kakao` 행을 다음으로 교체:

```markdown
| `POST /auth/kakao` | 카카오 로그인(code 교환) — 기존 유저 `{accessToken}`, 신규 `{onboardingToken}`. 카카오 장애 시 `503 AUTH_KAKAO_UNAVAILABLE`(M12) | 공개 |
```

- [ ] **Step 3: build + lint + Commit**

```bash
npm run build && npm run lint:check
git add src/auth/interface/auth.controller.ts README.md
git commit -m "[M12]docs: 카카오 로그인 503 응답 Swagger·README 표기"
```

---

### Task 5: 마일스톤·학습 노트 문서화 + 최종 회귀

**Files:**
- Modify: `README.md` (M12 행 ✅ 전환 + 후속 불릿)
- Modify: `docs/study/마일스톤-학습-노트.md` (§8.10 신설)

**Interfaces:**
- Consumes: 없음(문서만). 어투는 글로벌 CLAUDE.md 문서 규칙(해설 격식체·용어 첫 등장 시 설명·근거 없는 최상급 금지).

- [ ] **Step 1: README 마일스톤 표 갱신**

M12 행을 다음으로 교체:

```markdown
| **M12** ✅ | 회복탄력성 패턴: 카카오 OAuth에 재시도·서킷 브레이커·벌크헤드(cockatiel) | 멱등성과 재시도 안전성·fail-fast·정책 조합 순서·동시성 격리 |
```

운영·견고함 후속 불릿 목록(M11 불릿 뒤)에 추가:

```markdown
> - **M12 (회복탄력성 패턴):** ✅ 유일한 외부 SaaS 동기 호출인 카카오 OAuth에 cockatiel로 타임아웃·재시도·서킷 브레이커·벌크헤드를 적용했다. 재시도는 멱등한 프로필 GET에만 건다 — OAuth 인가코드는 1회용이라 토큰 교환 POST 재시도는 코드 이중 사용을 낳는다. 조합은 `retry → circuitBreaker → bulkhead → timeout(시도당)` 순 wrap이며, 거절(회로 open·포화·타임아웃)은 `503 AUTH_KAKAO_UNAVAILABLE`로 변환하고 4xx는 그대로 전파한다. 서킷 상태 변화는 로깅+Sentry로 남긴다(조용히 실패하는 서킷 금지). 파라미터 6종은 env로 튜닝 가능(실측 전 잠정값). 상세: 학습 노트 §8.10.
```

- [ ] **Step 2: 학습 노트 §8.10 추가**

`docs/study/마일스톤-학습-노트.md`의 §8.9(분산 트레이싱)와 §9 사이에 신설. 포함할 내용(해설 격식체로 서술):

- **세 패턴의 역할 분담**: 타임아웃(오래 기다리지 않기)·재시도(일시 오류 흡수)·벌크헤드(동시성 격리 — Node는 세마포어 방식, 스레드 풀 아님)·서킷 브레이커(연속 실패 시 fail-fast + half-open 복구 탐침). 넷이 한 세트로 wrap 조합되는 이유.
- **멱등성과 재시도 안전성**: OAuth 인가코드 1회용 문제 — 토큰 교환 POST를 재시도하면 왜 위험한지(요청 도달+응답 유실 시나리오), `Idempotency-Key` 없는 POST 재시도 금지 규칙, 그래서 프로필 GET만 재시도.
- **일시성 판별**: `handleAll`이 왜 위험한지(4xx 폭주가 브레이커를 열고, 사용자 오류를 재시도) → `KakaoApiError.transient`(429·5xx)·네트워크 오류·타임아웃만 집계.
- **wrap 조합 순서의 의미**: retry가 breaker 바깥 = 각 시도 개별 집계 + open 시 남은 재시도 즉시 중단. timeout 최내곽 = 시도당. AbortSignal 전달 없이는 "정책은 포기, 소켓은 매달림".
- **fail-fast vs fallback**: 로그인은 대체 데이터가 없어 fallback 불가 → 503 즉시 실패가 옳은 선택인 이유.
- **M9 Outbox 재시도와의 구분**: 비동기 발행 경로(시간 무제한·DLQ)와 동기 요청 경로(사용자 대기·즉시 실패)의 재시도는 설계가 다르다.
- 스스로 점검 3~4문항 + 더 팔 키워드(`half-open`, `ConsecutiveBreaker vs SamplingBreaker`, `decorrelated jitter`, `Retry-After`, `bulkhead vs rate limit`, `Idempotency-Key`).

- [ ] **Step 3: 최종 회귀**

Run: `npm test` → 전 스위트 PASS. `npm run build` → 에러 없음. `npm run lint:check` → 경고 0.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/study/마일스톤-학습-노트.md
git commit -m "[M12]docs: 회복탄력성 마일스톤·학습 노트 갱신"
```

---

## Self-Review

**1. Spec coverage:**
- §2 결정(대상·cockatiel·GET만 재시도·fail-fast·env) → Task 2(설치·env·정책)·Task 3(배선) ✓
- §3 조합 순서·인스턴스 공유·AbortSignal → Task 2 Step 5(wrap·공유 breaker/bulkhead)·Task 3 Step 4(signal 전달) ✓
- §4 KakaoApiError·handleWhen·4xx 금지 → Task 1·Task 2(transientOnly) ✓ (429 Retry-After는 스펙 §10 범위 밖)
- §5 서킷 로깅+Sentry → Task 2 Step 5(onBreak/onHalfOpen/onReset) ✓
- §6 에러 매핑(원인별 캐치→503, 4xx 전파, 토큰 단발 5xx도 503) → Task 3 Step 4(mapFailure)·spec 케이스 ✓
- §7 파일 배치·env 표 → Task 2·3 파일 목록과 일치 ✓
- §8 테스트 전략(재시도/무재시도/브레이커/벌크헤드/타임아웃/매핑) → Task 2 Step 3·Task 3 Step 2 ✓
- §9 문서화(README 표·Swagger 503·학습 노트) → Task 4·5 ✓

**2. Placeholder scan:** TBD/TODO 없음. Task 5 학습 노트는 서술형 지시지만 포함 항목을 구체적으로 열거(기존 노트 형식이 자유 산문이라 코드 블록 강제 부적합).

**3. Type consistency:**
- `KakaoApiError(label, status)`·`transient` — Task 1 정의 = Task 2 predicate = Task 3 사용 일치.
- `KakaoResilience.tokenPolicy/profilePolicy: IPolicy` — Task 2 정의 = Task 3 `callKakao(policy: IPolicy, ...)` 일치.
- ConfigKey 6종 문자열 — Task 2 enum = .env.example = 테스트 overrides 키 일치.
- `AuthError.KAKAO_UNAVAILABLE.code = 'AUTH_KAKAO_UNAVAILABLE'` — Task 3 카탈로그 = spec 단언 상수 일치.

**참고:** cockatiel `maxAttempts`는 "초기 시도를 제외한 재시도 횟수"다(3이면 최대 총 4회 호출). 스펙 표의 "최대 시도 수" 표현과 어긋나지 않게 주석은 "재시도 횟수"로 명확화했다. 벌크헤드·타임아웃 테스트는 실제 타이머(100ms)를 쓰므로 fake timer를 켜지 않는다.
