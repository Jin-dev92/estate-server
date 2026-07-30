# 리프레시 토큰 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 액세스 토큰 하나로만 동작하는 인증에 리프레시 토큰을 도입해, 회전·재사용 탐지·세션 폐기를 갖춘 토큰 정책으로 전환한다.

**Architecture:** 리프레시 토큰은 불투명 랜덤 32바이트로 발급하고 DB에는 SHA-256 해시만 저장한다. 하나의 로그인에서 파생된 토큰들을 `familyId`로 묶어(가족 = 세션) 회전 시 그 값을 유지하고, 이미 소비된 토큰이 재제출되면 침해로 판단해 가족 전체를 폐기한다. 기존 auth 컨텍스트의 DDD 레이어(domain 포트 → application 유스케이스 → infrastructure 어댑터)를 그대로 따르며, `node:crypto` 호출은 포트 뒤로 감춘다.

**Tech Stack:** NestJS, Prisma, PostgreSQL, `node:crypto`, `@nestjs/jwt`, Jest

**설계 스펙:** [`docs/superpowers/specs/2026-07-30-refresh-token-design.md`](../specs/2026-07-30-refresh-token-design.md)

## Global Constraints

- 커밋 메시지는 `[티켓명]{기능}: {한글 설명}` 형식. 이 작업의 티켓명은 `M15`
- env 키는 문자열 하드코딩 금지. `src/config/config-keys.ts`의 `ConfigKey` enum 참조. 새 키는 `.env.example`에도 함께 등록
- 신규·변경 엔드포인트에 Swagger 데코레이터 필수: `@ApiOperation` + 성공 `@ApiResponse`, 4xx는 `@ApiResponse({ type: ErrorResponseDto })`, 보호 라우트는 `@ApiBearerAuth(SWAGGER_BEARER_AUTH)`
- 테스트에서 `as any` 금지. `Partial<jest.Mocked<T>>` 사용. AAA 패턴(Arrange/Act/Assert 사이 빈 줄). 매직값은 상수로 추출
- 공부용 프로젝트이므로 설명이 필요한 부분에 한글 주석을 단다
- 리프레시 토큰 원문을 DB·로그·Sentry에 남기지 않는다
- 액세스 토큰 만료 기본값: `15m` (기존 `1h`에서 변경)
- 리프레시 토큰 수명 기본값: `14`일 / 엔트로피: `32`바이트
- `/auth/refresh`에 라우트별 `@RateLimit` override를 두지 않는다 (전역 기본값 사용 — 근거는 스펙 §9)

---

## File Structure

**신규 생성**

| 파일 | 책임 |
|---|---|
| `src/auth/domain/refresh-token.entity.ts` | 리프레시 토큰 불변식 — 유효성 판정, 소비, 폐기 |
| `src/auth/domain/refresh-token.repository.ts` | 저장소 포트(Symbol 토큰) |
| `src/auth/domain/refresh-token-generator.ts` | 생성·해시 포트 |
| `src/auth/infrastructure/crypto-refresh-token-generator.ts` | `node:crypto` 어댑터 |
| `src/auth/infrastructure/prisma-refresh-token.repository.ts` | Prisma 어댑터 |
| `src/auth/application/issue-session.service.ts` | 로그인 3곳이 공유하는 세션 발급(가족 생성 + 토큰 쌍) |
| `src/auth/application/refresh-tokens.use-case.ts` | 갱신 + 회전 + 재사용 탐지 |
| `src/auth/application/logout.use-case.ts` | 현재 가족 폐기 |
| `src/auth/application/logout-all.use-case.ts` | 전체 가족 폐기 |
| `src/auth/application/list-sessions.use-case.ts` | 세션 목록 |
| `src/auth/application/revoke-session.use-case.ts` | 개별 세션 폐기(소유권 검사) |
| `src/auth/interface/dto/refresh.dto.ts` | 갱신·로그아웃 요청/응답 DTO |
| `src/auth/interface/dto/session.dto.ts` | 세션 목록 응답 DTO |

**수정**

| 파일 | 변경 |
|---|---|
| `prisma/schema.prisma` | `RefreshToken` 모델 추가, `User`에 역방향 관계 |
| `src/config/config-keys.ts` | `RefreshTokenTtlDays`, `RefreshTokenBytes` 추가 |
| `.env.example` | 위 두 키 + `JWT_EXPIRES_IN` 기본값 변경 |
| `src/auth/domain/token-issuer.ts` | `TokenPayload`에 `fam` 추가 |
| `src/auth/auth.errors.ts` | 에러 3개 추가 |
| `src/auth/application/login.use-case.ts` | 토큰 쌍 반환 |
| `src/auth/application/kakao-login.use-case.ts` | 토큰 쌍 반환 |
| `src/auth/application/complete-kakao-signup.use-case.ts` | 토큰 쌍 반환 |
| `src/auth/application/change-password.use-case.ts` | 성공 시 전체 폐기 |
| `src/auth/interface/auth.controller.ts` | 엔드포인트 5개 추가 |
| `src/auth/auth.module.ts` | provider 배선 |
| `src/app.module.ts` | (확인만) `AuthModule`이 `PrismaModule`을 쓸 수 있는지 |
| `README.md` | API 표 + 에러 코드 |

**`issue-session.service.ts`를 두는 이유:** 로그인 유스케이스 3곳(`login`·`kakao-login`·`complete-kakao-signup`)이 "가족 생성 → 리프레시 토큰 발급 → 그 `familyId`로 액세스 토큰 발급"이라는 같은 절차를 밟는다. 세 곳에 복붙하면 발급 순서 제약(스펙 §6.3)이 어긋날 위험이 있으므로 한 곳에 모은다.

---

## Task 1: RefreshToken 스키마와 마이그레이션

**Files:**
- Modify: `prisma/schema.prisma`

**Interfaces:**
- Consumes: 없음
- Produces: Prisma Client의 `refreshToken` delegate. 필드 — `id: string`, `userId: string`, `tokenHash: string`, `familyId: string`, `expiresAt: Date`, `usedAt: Date | null`, `revokedAt: Date | null`, `createdAt: Date`

- [ ] **Step 1: `RefreshToken` 모델 추가**

`prisma/schema.prisma` 파일 끝에 추가한다.

```prisma
// 리프레시 토큰. 원문은 저장하지 않고 sha256 해시만 보관한다.
// familyId = 로그인 1회에서 파생된 토큰들의 계보(= 세션). 회전해도 유지된다.
// 상태는 enum이 아니라 nullable 타임스탬프로 표현한다(soft delete·Outbox와 동일 방식).
model RefreshToken {
  id        String    @id @default(cuid())
  userId    String
  tokenHash String    @unique
  familyId  String
  expiresAt DateTime
  usedAt    DateTime? // 회전으로 소비된 시각
  revokedAt DateTime? // 폐기된 시각(로그아웃·비밀번호 변경·재사용 탐지)
  createdAt DateTime  @default(now())

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([familyId])
  @@index([expiresAt])
}
```

- [ ] **Step 2: `User` 모델에 역방향 관계 추가**

`prisma/schema.prisma`의 `model User` 안, `accounts  Account[]` 줄 아래에 추가한다.

```prisma
  refreshTokens RefreshToken[]
```

- [ ] **Step 3: 마이그레이션 생성**

Run: `pnpm exec prisma migrate dev --name add_refresh_token`
Expected: `migrations/<timestamp>_add_refresh_token/migration.sql` 생성. `Your database is now in sync with your schema.` 출력

- [ ] **Step 4: drift 검사 통과 확인**

Run: `pnpm exec prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --shadow-database-url "$DATABASE_URL" --exit-code`
Expected: exit code 0 (스키마와 마이그레이션 일치)

- [ ] **Step 5: 커밋**

```bash
git add prisma/schema.prisma prisma/migrations
git commit -m "[M15]feat: RefreshToken 스키마 추가

원문 대신 sha256 해시를 저장하고, familyId로 로그인 1회에서 파생된
토큰들을 묶는다. 상태는 nullable 타임스탬프(usedAt·revokedAt)로 표현해
soft delete·Outbox와 방식을 맞춘다."
```

---

## Task 2: Config 키와 env 등록

**Files:**
- Modify: `src/config/config-keys.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: 없음
- Produces: `ConfigKey.RefreshTokenTtlDays` (`'REFRESH_TOKEN_TTL_DAYS'`), `ConfigKey.RefreshTokenBytes` (`'REFRESH_TOKEN_BYTES'`)

- [ ] **Step 1: `ConfigKey`에 두 키 추가**

`src/config/config-keys.ts`의 `JwtExpiresIn` 줄 아래에 추가한다.

```typescript
  RefreshTokenTtlDays = 'REFRESH_TOKEN_TTL_DAYS',
  RefreshTokenBytes = 'REFRESH_TOKEN_BYTES',
```

- [ ] **Step 2: `.env.example` 갱신**

`JWT_EXPIRES_IN` 줄을 찾아 값을 `"15m"`으로 바꾸고, 바로 아래에 두 줄을 추가한다.

```bash
# 액세스 토큰 수명. 짧게 두고 리프레시 토큰으로 갱신한다(탈취 피해 창 축소).
JWT_EXPIRES_IN="15m"
# 리프레시 토큰 수명(일). 2주면 일상 사용에서 재로그인이 드물다.
REFRESH_TOKEN_TTL_DAYS="14"
# 리프레시 토큰 엔트로피(바이트). 32 = 256비트.
REFRESH_TOKEN_BYTES="32"
```

- [ ] **Step 3: 타입체크**

Run: `pnpm exec nest build`
Expected: 에러 없이 완료

- [ ] **Step 4: 커밋**

```bash
git add src/config/config-keys.ts .env.example
git commit -m "[M15]feat: 리프레시 토큰 env 키 추가 및 액세스 토큰 수명 15m으로 단축

액세스 토큰을 1시간으로 두면 리프레시 토큰을 도입해도 보안상 얻는 것이
거의 없다. 짧은 액세스 토큰과 회전하는 리프레시 토큰은 한 세트다."
```

---

## Task 3: 에러 코드 3개 추가

**Files:**
- Modify: `src/auth/auth.errors.ts`

**Interfaces:**
- Consumes: 없음
- Produces: `AuthError.INVALID_REFRESH_TOKEN`, `AuthError.REFRESH_TOKEN_REUSED`, `AuthError.NOT_SESSION_OWNER`

- [ ] **Step 1: `AuthError`에 3개 추가**

`src/auth/auth.errors.ts`의 `KAKAO_UNAVAILABLE` 항목 뒤, `} as const satisfies` 앞에 추가한다.

```typescript
  INVALID_REFRESH_TOKEN: {
    code: 'AUTH_INVALID_REFRESH_TOKEN',
    status: HttpStatus.UNAUTHORIZED,
    message: '세션이 만료되었습니다. 다시 로그인해주세요.',
  },
  // 이미 회전으로 소비된 토큰의 재제출 = 사본 존재 = 침해 의심.
  // INVALID_REFRESH_TOKEN과 분리하는 이유: 같은 코드로 뭉치면 Sentry에서
  // 침해 신호가 흔한 만료 노이즈에 묻힌다. status는 둘 다 401로 같게 두어
  // 공격자에게 내부 상태를 알려주지 않는다.
  REFRESH_TOKEN_REUSED: {
    code: 'AUTH_REFRESH_TOKEN_REUSED',
    status: HttpStatus.UNAUTHORIZED,
    message: '세션이 만료되었습니다. 다시 로그인해주세요.',
  },
  // 역할 부족(INSUFFICIENT_ROLE)이 아니라 소유권 위반이므로 별도 코드를 둔다.
  // 존재하지 않는 familyId도 이 코드로 응답한다 — 404로 구분하면 남의
  // familyId 존재 여부를 알려주는 정보 노출이 된다.
  NOT_SESSION_OWNER: {
    code: 'AUTH_NOT_SESSION_OWNER',
    status: HttpStatus.FORBIDDEN,
    message: '해당 세션에 대한 권한이 없습니다.',
  },
```

- [ ] **Step 2: 타입체크**

Run: `pnpm exec nest build`
Expected: 에러 없이 완료

- [ ] **Step 3: 커밋**

```bash
git add src/auth/auth.errors.ts
git commit -m "[M15]feat: 리프레시 토큰 에러 코드 3개 추가

만료(INVALID_REFRESH_TOKEN)와 재사용 탐지(REFRESH_TOKEN_REUSED)를
분리해 Sentry에서 침해 신호가 만료 노이즈에 묻히지 않게 한다."
```

---

## Task 4: RefreshToken 도메인 엔티티

**Files:**
- Create: `src/auth/domain/refresh-token.entity.ts`
- Test: `src/auth/domain/refresh-token.entity.spec.ts`

**Interfaces:**
- Consumes: 없음
- Produces:
  - `RefreshToken` 클래스
  - `RefreshToken.create(input: { userId: string; tokenHash: string; familyId: string; expiresAt: Date }): RefreshToken`
  - `RefreshToken.reconstitute(props: RefreshTokenProps): RefreshToken`
  - getter: `id: string | null`, `userId: string`, `tokenHash: string`, `familyId: string`, `expiresAt: Date`, `usedAt: Date | null`, `revokedAt: Date | null`
  - `isUsable(now: Date): boolean`
  - `isUsed(): boolean`
  - `markUsed(now: Date): RefreshToken`
  - `revoke(now: Date): RefreshToken`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/auth/domain/refresh-token.entity.spec.ts` 생성.

```typescript
import { RefreshToken } from './refresh-token.entity';

const USER_ID = 'user-1';
const TOKEN_HASH = 'hash-1';
const FAMILY_ID = 'family-1';
const NOW = new Date('2026-07-30T00:00:00.000Z');
const FUTURE = new Date('2026-08-13T00:00:00.000Z');
const PAST = new Date('2026-07-29T00:00:00.000Z');

function createToken(overrides?: { expiresAt?: Date }): RefreshToken {
  return RefreshToken.create({
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    expiresAt: overrides?.expiresAt ?? FUTURE,
  });
}

describe('RefreshToken', () => {
  describe('create', () => {
    it('should start usable with no usedAt and no revokedAt', () => {
      const token = createToken();

      const usable = token.isUsable(NOW);

      expect(usable).toBe(true);
      expect(token.usedAt).toBeNull();
      expect(token.revokedAt).toBeNull();
    });
  });

  describe('isUsable', () => {
    it('should return false when expired', () => {
      const token = createToken({ expiresAt: PAST });

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });

    it('should return false when already used', () => {
      const token = createToken().markUsed(NOW);

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });

    it('should return false when revoked', () => {
      const token = createToken().revoke(NOW);

      const usable = token.isUsable(NOW);

      expect(usable).toBe(false);
    });
  });

  describe('isUsed', () => {
    it('should distinguish a consumed token from a merely invalid one', () => {
      const used = createToken().markUsed(NOW);
      const expired = createToken({ expiresAt: PAST });

      expect(used.isUsed()).toBe(true);
      expect(expired.isUsed()).toBe(false);
    });
  });

  describe('markUsed', () => {
    it('should record the consumption time without mutating the original', () => {
      const token = createToken();

      const consumed = token.markUsed(NOW);

      expect(consumed.usedAt).toEqual(NOW);
      expect(token.usedAt).toBeNull();
    });
  });

  describe('revoke', () => {
    it('should record the revocation time without mutating the original', () => {
      const token = createToken();

      const revoked = token.revoke(NOW);

      expect(revoked.revokedAt).toEqual(NOW);
      expect(token.revokedAt).toBeNull();
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/domain/refresh-token.entity.spec.ts`
Expected: FAIL — `Cannot find module './refresh-token.entity'`

- [ ] **Step 3: 엔티티 구현**

`src/auth/domain/refresh-token.entity.ts` 생성.

```typescript
export interface RefreshTokenProps {
  id: string | null;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

// 리프레시 토큰의 상태 판정을 도메인에 모은다.
// 상태 변경 메서드는 새 인스턴스를 반환한다(불변) — 원본을 그대로 두면
// 유스케이스에서 "변경 전/후"를 함께 다루기 쉽다.
export class RefreshToken {
  private constructor(private readonly props: RefreshTokenProps) {}

  static create(input: {
    userId: string;
    tokenHash: string;
    familyId: string;
    expiresAt: Date;
  }): RefreshToken {
    return new RefreshToken({
      id: null,
      userId: input.userId,
      tokenHash: input.tokenHash,
      familyId: input.familyId,
      expiresAt: input.expiresAt,
      usedAt: null,
      revokedAt: null,
    });
  }

  static reconstitute(props: RefreshTokenProps): RefreshToken {
    return new RefreshToken(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get tokenHash(): string {
    return this.props.tokenHash;
  }
  get familyId(): string {
    return this.props.familyId;
  }
  get expiresAt(): Date {
    return this.props.expiresAt;
  }
  get usedAt(): Date | null {
    return this.props.usedAt;
  }
  get revokedAt(): Date | null {
    return this.props.revokedAt;
  }

  // 갱신에 쓸 수 있는 상태인가. 세 조건이 각각 다른 무효 상태를 배제한다.
  isUsable(now: Date): boolean {
    return (
      this.props.usedAt === null &&
      this.props.revokedAt === null &&
      this.props.expiresAt.getTime() > now.getTime()
    );
  }

  // 이미 회전으로 소비됐는가. 재사용 탐지의 판정 근거이므로
  // "그냥 무효(만료·폐기)"와 반드시 구분해야 한다.
  isUsed(): boolean {
    return this.props.usedAt !== null;
  }

  markUsed(now: Date): RefreshToken {
    return new RefreshToken({ ...this.props, usedAt: now });
  }

  revoke(now: Date): RefreshToken {
    return new RefreshToken({ ...this.props, revokedAt: now });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/domain/refresh-token.entity.spec.ts`
Expected: PASS — 7 tests

- [ ] **Step 5: 커밋**

```bash
git add src/auth/domain/refresh-token.entity.ts src/auth/domain/refresh-token.entity.spec.ts
git commit -m "[M15]feat: RefreshToken 도메인 엔티티 추가

isUsed()를 isUsable()과 별도로 두는 이유는 재사용 탐지 때문이다.
'이미 소비된 토큰'과 '그냥 무효한 토큰'의 대응이 다르다 — 전자는
가족 전체 폐기, 후자는 해당 요청만 거절."
```

---

## Task 5: 포트 2개 정의

**Files:**
- Create: `src/auth/domain/refresh-token.repository.ts`
- Create: `src/auth/domain/refresh-token-generator.ts`

**Interfaces:**
- Consumes: `RefreshToken` (Task 4)
- Produces:
  - `REFRESH_TOKEN_REPOSITORY: symbol`
  - `RefreshTokenRepository` 인터페이스:
    - `save(token: RefreshToken, tx?: TransactionClient): Promise<RefreshToken>`
    - `findByHash(tokenHash: string): Promise<RefreshToken | null>`
    - `markUsed(id: string, usedAt: Date, tx?: TransactionClient): Promise<void>`
    - `revokeFamily(familyId: string, revokedAt: Date, tx?: TransactionClient): Promise<number>`
    - `revokeAllByUser(userId: string, revokedAt: Date, tx?: TransactionClient): Promise<number>`
    - `findActiveFamilies(userId: string, now: Date): Promise<SessionSummary[]>`
    - `findFamilyOwner(familyId: string): Promise<string | null>`
  - `SessionSummary` 타입: `{ familyId: string; createdAt: Date }`
  - `REFRESH_TOKEN_GENERATOR: symbol`
  - `RefreshTokenGenerator` 인터페이스:
    - `generate(): { token: string; tokenHash: string }`
    - `hash(token: string): string`

- [ ] **Step 1: 저장소 포트 작성**

`src/auth/domain/refresh-token.repository.ts` 생성.

```typescript
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { RefreshToken } from './refresh-token.entity';

export const REFRESH_TOKEN_REPOSITORY = Symbol('REFRESH_TOKEN_REPOSITORY');

// 세션 목록 한 줄. ip·userAgent를 저장하지 않기로 했으므로(스펙 §1 제외 4번)
// 노출할 수 있는 정보는 가족 식별자와 로그인 시각뿐이다.
export interface SessionSummary {
  familyId: string;
  createdAt: Date;
}

export interface RefreshTokenRepository {
  save(token: RefreshToken, tx?: TransactionClient): Promise<RefreshToken>;
  findByHash(tokenHash: string): Promise<RefreshToken | null>;
  markUsed(id: string, usedAt: Date, tx?: TransactionClient): Promise<void>;
  // 반환값은 폐기된 행 수. 재사용 탐지 로깅에 쓴다.
  revokeFamily(
    familyId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number>;
  revokeAllByUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number>;
  // 활성 가족 목록. createdAt은 그 가족의 최초 발급 시각(= 로그인 시각).
  findActiveFamilies(userId: string, now: Date): Promise<SessionSummary[]>;
  // 소유권 검사용. 가족이 없으면 null.
  findFamilyOwner(familyId: string): Promise<string | null>;
}
```

- [ ] **Step 2: 생성기 포트 작성**

`src/auth/domain/refresh-token-generator.ts` 생성.

```typescript
export const REFRESH_TOKEN_GENERATOR = Symbol('REFRESH_TOKEN_GENERATOR');

// 랜덤 생성과 해시를 포트 뒤로 감춘다. 목적은 두 가지다.
// 1) 도메인·application이 node:crypto를 모르게 한다(의존성 역전)
// 2) 유스케이스 테스트에서 결정적 값을 반환하는 가짜로 갈아끼울 수 있다
//    — 난수를 직접 호출하면 "어떤 토큰이 발급됐는가"를 단정할 수 없다
export interface RefreshTokenGenerator {
  // 원문과 해시를 함께 반환한다. 원문은 클라이언트에게만 주고 저장하지 않는다.
  generate(): { token: string; tokenHash: string };
  // 들어온 토큰을 조회용으로 해시한다.
  hash(token: string): string;
}
```

- [ ] **Step 3: 타입체크**

Run: `pnpm exec nest build`
Expected: 에러 없이 완료

- [ ] **Step 4: 커밋**

```bash
git add src/auth/domain/refresh-token.repository.ts src/auth/domain/refresh-token-generator.ts
git commit -m "[M15]feat: 리프레시 토큰 포트 2개 정의

저장소와 생성기를 Symbol 토큰 포트로 둔다. 생성기를 분리하는 이유는
유스케이스 테스트에서 난수를 결정적 값으로 갈아끼우기 위함이다."
```

---

## Task 6: crypto 생성기 어댑터

**Files:**
- Create: `src/auth/infrastructure/crypto-refresh-token-generator.ts`
- Test: `src/auth/infrastructure/crypto-refresh-token-generator.spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenGenerator`, `ConfigKey.RefreshTokenBytes`
- Produces: `CryptoRefreshTokenGenerator` 클래스 (`RefreshTokenGenerator` 구현)

- [ ] **Step 1: 실패하는 테스트 작성**

`src/auth/infrastructure/crypto-refresh-token-generator.spec.ts` 생성.

```typescript
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { CryptoRefreshTokenGenerator } from './crypto-refresh-token-generator';

const TOKEN_BYTES = 32;

function createGenerator(): CryptoRefreshTokenGenerator {
  const config = {
    get: jest.fn().mockReturnValue(String(TOKEN_BYTES)),
  } satisfies Partial<jest.Mocked<ConfigService>>;

  return new CryptoRefreshTokenGenerator(config as unknown as ConfigService);
}

describe('CryptoRefreshTokenGenerator', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('generate', () => {
    it('should return a token whose hash is sha256 of the token', () => {
      const generator = createGenerator();

      const { token, tokenHash } = generator.generate();

      expect(tokenHash).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
    });

    it('should never return the raw token as its own hash', () => {
      const generator = createGenerator();

      const { token, tokenHash } = generator.generate();

      expect(tokenHash).not.toBe(token);
    });

    it('should produce a different token on each call', () => {
      const generator = createGenerator();

      const first = generator.generate();
      const second = generator.generate();

      expect(first.token).not.toBe(second.token);
    });

    it('should use base64url encoding without padding characters', () => {
      const generator = createGenerator();

      const { token } = generator.generate();

      expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    });
  });

  describe('hash', () => {
    it('should be deterministic for the same input', () => {
      const generator = createGenerator();
      const input = 'some-token';

      const first = generator.hash(input);
      const second = generator.hash(input);

      expect(first).toBe(second);
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/infrastructure/crypto-refresh-token-generator.spec.ts`
Expected: FAIL — `Cannot find module './crypto-refresh-token-generator'`

- [ ] **Step 3: 어댑터 구현**

`src/auth/infrastructure/crypto-refresh-token-generator.ts` 생성.

```typescript
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { ConfigKey } from '../../config/config-keys';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';

const DEFAULT_TOKEN_BYTES = 32;

@Injectable()
export class CryptoRefreshTokenGenerator implements RefreshTokenGenerator {
  private readonly bytes: number;

  constructor(config: ConfigService) {
    const raw = config.get<string>(
      ConfigKey.RefreshTokenBytes,
      String(DEFAULT_TOKEN_BYTES),
    );
    const parsed = Number.parseInt(raw, 10);
    this.bytes = Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_TOKEN_BYTES;
  }

  generate(): { token: string; tokenHash: string } {
    // base64url = URL·쿠키에 안전한 인코딩. 패딩(=)이 없다.
    const token = randomBytes(this.bytes).toString('base64url');
    return { token, tokenHash: this.hash(token) };
  }

  // SHA-256을 쓰는 이유: 토큰은 256비트 랜덤이라 무차별 대입이 성립하지
  // 않으므로 bcrypt처럼 느릴 필요가 없다. bcrypt를 쓰면 M8에서 확인한
  // CPU 바운드 비용(login p95 114ms)을 갱신 경로에 옮겨오게 된다.
  hash(token: string): string {
    return createHash('sha256').update(token).digest('hex');
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/infrastructure/crypto-refresh-token-generator.spec.ts`
Expected: PASS — 5 tests

- [ ] **Step 5: 커밋**

```bash
git add src/auth/infrastructure/crypto-refresh-token-generator.ts src/auth/infrastructure/crypto-refresh-token-generator.spec.ts
git commit -m "[M15]feat: crypto 기반 리프레시 토큰 생성기 추가

randomBytes(32) base64url로 발급하고 sha256으로 해시한다.
해시가 원문과 다른지 검증하는 테스트를 둔다 — 원문 저장은 동작이
정상이라 다른 테스트가 잡지 못하는 조용한 사고다."
```

---

## Task 7: Prisma 저장소 어댑터

**Files:**
- Create: `src/auth/infrastructure/prisma-refresh-token.repository.ts`
- Test: `src/auth/infrastructure/prisma-refresh-token.repository.spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenRepository`, `SessionSummary`, `RefreshToken`, `PrismaService`, `TransactionClient`
- Produces: `PrismaRefreshTokenRepository` 클래스

**참고:** `src/auth/infrastructure/prisma-user.repository.ts`를 먼저 읽어 `PrismaService` 주입 방식과 import 경로를 확인한다.

- [ ] **Step 1: 실패하는 테스트 작성**

`src/auth/infrastructure/prisma-refresh-token.repository.spec.ts` 생성.

```typescript
import { PrismaService } from '../../prisma/prisma.service';
import { RefreshToken } from '../domain/refresh-token.entity';
import { PrismaRefreshTokenRepository } from './prisma-refresh-token.repository';

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const TOKEN_HASH = 'hash-1';
const TOKEN_ID = 'token-1';
const NOW = new Date('2026-07-30T00:00:00.000Z');
const EXPIRES_AT = new Date('2026-08-13T00:00:00.000Z');

function createDelegate() {
  return {
    create: jest.fn(),
    findUnique: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    findMany: jest.fn(),
    findFirst: jest.fn(),
  };
}

function createRepo(delegate: ReturnType<typeof createDelegate>) {
  const prisma = { refreshToken: delegate };
  return new PrismaRefreshTokenRepository(
    prisma as unknown as PrismaService,
  );
}

describe('PrismaRefreshTokenRepository', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('findByHash', () => {
    it('should map a row to a RefreshToken entity', async () => {
      const delegate = createDelegate();
      delegate.findUnique.mockResolvedValue({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: EXPIRES_AT,
        usedAt: null,
        revokedAt: null,
      });
      const repo = createRepo(delegate);

      const found = await repo.findByHash(TOKEN_HASH);

      expect(found?.id).toBe(TOKEN_ID);
      expect(found?.familyId).toBe(FAMILY_ID);
      expect(found?.isUsable(NOW)).toBe(true);
    });

    it('should return null when no row matches', async () => {
      const delegate = createDelegate();
      delegate.findUnique.mockResolvedValue(null);
      const repo = createRepo(delegate);

      const found = await repo.findByHash(TOKEN_HASH);

      expect(found).toBeNull();
    });
  });

  describe('revokeFamily', () => {
    it('should only revoke rows that are not already revoked', async () => {
      const delegate = createDelegate();
      delegate.updateMany.mockResolvedValue({ count: 3 });
      const repo = createRepo(delegate);

      const count = await repo.revokeFamily(FAMILY_ID, NOW);

      expect(count).toBe(3);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { familyId: FAMILY_ID, revokedAt: null },
        data: { revokedAt: NOW },
      });
    });
  });

  describe('revokeAllByUser', () => {
    it('should revoke every non-revoked row of the user', async () => {
      const delegate = createDelegate();
      delegate.updateMany.mockResolvedValue({ count: 5 });
      const repo = createRepo(delegate);

      const count = await repo.revokeAllByUser(USER_ID, NOW);

      expect(count).toBe(5);
      expect(delegate.updateMany).toHaveBeenCalledWith({
        where: { userId: USER_ID, revokedAt: null },
        data: { revokedAt: NOW },
      });
    });
  });

  describe('findActiveFamilies', () => {
    it('should group rows by familyId and keep the earliest createdAt', async () => {
      const delegate = createDelegate();
      delegate.findMany.mockResolvedValue([
        { familyId: 'fam-a', createdAt: new Date('2026-07-28T10:00:00.000Z') },
        { familyId: 'fam-a', createdAt: new Date('2026-07-29T10:00:00.000Z') },
        { familyId: 'fam-b', createdAt: new Date('2026-07-25T09:00:00.000Z') },
      ]);
      const repo = createRepo(delegate);

      const sessions = await repo.findActiveFamilies(USER_ID, NOW);

      expect(sessions).toEqual([
        { familyId: 'fam-a', createdAt: new Date('2026-07-28T10:00:00.000Z') },
        { familyId: 'fam-b', createdAt: new Date('2026-07-25T09:00:00.000Z') },
      ]);
    });

    it('should query only rows that are usable right now', async () => {
      const delegate = createDelegate();
      delegate.findMany.mockResolvedValue([]);
      const repo = createRepo(delegate);

      await repo.findActiveFamilies(USER_ID, NOW);

      expect(delegate.findMany).toHaveBeenCalledWith({
        where: {
          userId: USER_ID,
          usedAt: null,
          revokedAt: null,
          expiresAt: { gt: NOW },
        },
        select: { familyId: true, createdAt: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  });

  describe('findFamilyOwner', () => {
    it('should return the owner userId', async () => {
      const delegate = createDelegate();
      delegate.findFirst.mockResolvedValue({ userId: USER_ID });
      const repo = createRepo(delegate);

      const owner = await repo.findFamilyOwner(FAMILY_ID);

      expect(owner).toBe(USER_ID);
    });

    it('should return null when the family does not exist', async () => {
      const delegate = createDelegate();
      delegate.findFirst.mockResolvedValue(null);
      const repo = createRepo(delegate);

      const owner = await repo.findFamilyOwner(FAMILY_ID);

      expect(owner).toBeNull();
    });
  });

  describe('save', () => {
    it('should persist the entity and return it with the generated id', async () => {
      const delegate = createDelegate();
      delegate.create.mockResolvedValue({
        id: TOKEN_ID,
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: EXPIRES_AT,
        usedAt: null,
        revokedAt: null,
      });
      const repo = createRepo(delegate);
      const token = RefreshToken.create({
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: EXPIRES_AT,
      });

      const saved = await repo.save(token);

      expect(saved.id).toBe(TOKEN_ID);
      expect(delegate.create).toHaveBeenCalledWith({
        data: {
          userId: USER_ID,
          tokenHash: TOKEN_HASH,
          familyId: FAMILY_ID,
          expiresAt: EXPIRES_AT,
        },
      });
    });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/infrastructure/prisma-refresh-token.repository.spec.ts`
Expected: FAIL — `Cannot find module './prisma-refresh-token.repository'`

- [ ] **Step 3: 어댑터 구현**

`src/auth/infrastructure/prisma-refresh-token.repository.ts` 생성. `PrismaService` import 경로는 Step 0에서 확인한 `prisma-user.repository.ts`와 동일하게 맞춘다.

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { RefreshToken } from '../domain/refresh-token.entity';
import {
  RefreshTokenRepository,
  SessionSummary,
} from '../domain/refresh-token.repository';

// Prisma 행 → 도메인 엔티티 매핑에 쓰는 최소 형태.
interface RefreshTokenRow {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expiresAt: Date;
  usedAt: Date | null;
  revokedAt: Date | null;
}

@Injectable()
export class PrismaRefreshTokenRepository implements RefreshTokenRepository {
  constructor(private readonly prisma: PrismaService) {}

  // tx가 주어지면 그 트랜잭션 클라이언트를 쓴다(회전의 원자성 확보).
  private client(tx?: TransactionClient) {
    return (tx ?? this.prisma).refreshToken;
  }

  private toEntity(row: RefreshTokenRow): RefreshToken {
    return RefreshToken.reconstitute({
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      familyId: row.familyId,
      expiresAt: row.expiresAt,
      usedAt: row.usedAt,
      revokedAt: row.revokedAt,
    });
  }

  async save(
    token: RefreshToken,
    tx?: TransactionClient,
  ): Promise<RefreshToken> {
    const row = await this.client(tx).create({
      data: {
        userId: token.userId,
        tokenHash: token.tokenHash,
        familyId: token.familyId,
        expiresAt: token.expiresAt,
      },
    });
    return this.toEntity(row as RefreshTokenRow);
  }

  async findByHash(tokenHash: string): Promise<RefreshToken | null> {
    const row = await this.prisma.refreshToken.findUnique({
      where: { tokenHash },
    });
    return row ? this.toEntity(row as RefreshTokenRow) : null;
  }

  async markUsed(
    id: string,
    usedAt: Date,
    tx?: TransactionClient,
  ): Promise<void> {
    await this.client(tx).update({ where: { id }, data: { usedAt } });
  }

  async revokeFamily(
    familyId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number> {
    // revokedAt: null 조건을 두어 이미 폐기된 행의 시각을 덮어쓰지 않는다.
    // 최초 폐기 시각이 사후 조사의 근거이므로 보존해야 한다.
    const { count } = await this.client(tx).updateMany({
      where: { familyId, revokedAt: null },
      data: { revokedAt },
    });
    return count;
  }

  async revokeAllByUser(
    userId: string,
    revokedAt: Date,
    tx?: TransactionClient,
  ): Promise<number> {
    const { count } = await this.client(tx).updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
    return count;
  }

  async findActiveFamilies(
    userId: string,
    now: Date,
  ): Promise<SessionSummary[]> {
    const rows = await this.prisma.refreshToken.findMany({
      where: {
        userId,
        usedAt: null,
        revokedAt: null,
        expiresAt: { gt: now },
      },
      select: { familyId: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    // 가족별로 묶고 최초 createdAt(= 로그인 시각)만 남긴다.
    // orderBy asc 이므로 먼저 만난 행이 가장 이르다.
    const byFamily = new Map<string, Date>();
    for (const row of rows) {
      if (!byFamily.has(row.familyId)) {
        byFamily.set(row.familyId, row.createdAt);
      }
    }
    return [...byFamily].map(([familyId, createdAt]) => ({
      familyId,
      createdAt,
    }));
  }

  async findFamilyOwner(familyId: string): Promise<string | null> {
    const row = await this.prisma.refreshToken.findFirst({
      where: { familyId },
      select: { userId: true },
    });
    return row?.userId ?? null;
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/infrastructure/prisma-refresh-token.repository.spec.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/auth/infrastructure/prisma-refresh-token.repository.ts src/auth/infrastructure/prisma-refresh-token.repository.spec.ts
git commit -m "[M15]feat: Prisma 리프레시 토큰 저장소 추가

폐기 시 revokedAt: null 조건을 두어 최초 폐기 시각을 덮어쓰지 않는다.
사후 조사 근거이므로 보존해야 한다. tx를 받아 회전의 원자성을 지원한다."
```

---

## Task 8: 세션 발급 서비스

**Files:**
- Create: `src/auth/application/issue-session.service.ts`
- Test: `src/auth/application/issue-session.service.spec.ts`
- Modify: `src/auth/domain/token-issuer.ts`

**Interfaces:**
- Consumes: `TokenIssuer`, `RefreshTokenGenerator`, `RefreshTokenRepository`, `RefreshToken`, `Role`, `ConfigKey.RefreshTokenTtlDays`
- Produces:
  - `TokenPayload`에 `fam: string` 추가
  - `TokenPair` 타입: `{ accessToken: string; refreshToken: string }`
  - `IssueSessionService` 클래스
  - `issue(input: { userId: string; email: string; role: Role }, familyId?: string, tx?: TransactionClient): Promise<TokenPair>`
    - `familyId`를 주지 않으면 새 가족을 만든다(로그인). 주면 그 값을 유지한다(회전)

- [ ] **Step 1: `TokenPayload`에 `fam` 추가**

`src/auth/domain/token-issuer.ts`를 수정한다.

```typescript
import { Role } from './role.enum';

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');

export interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
  // 이 액세스 토큰이 파생된 리프레시 토큰 가족(= 세션) 식별자.
  // GET /auth/sessions 가 current 세션을 표시하기 위해 필요하다.
  // 회전해도 값이 유지되므로 갱신 후에도 같은 세션으로 인식된다.
  fam: string;
}

export interface TokenIssuer {
  issue(payload: TokenPayload): Promise<string>;
}
```

- [ ] **Step 2: 실패하는 테스트 작성**

`src/auth/application/issue-session.service.spec.ts` 생성.

```typescript
import { ConfigService } from '@nestjs/config';
import { Role } from '../domain/role.enum';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { TokenIssuer } from '../domain/token-issuer';
import { RefreshToken } from '../domain/refresh-token.entity';
import { IssueSessionService } from './issue-session.service';

const USER_ID = 'user-1';
const EMAIL = 'tenant@example.com';
const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'token-hash';
const ACCESS_TOKEN = 'access-token';
const EXISTING_FAMILY = 'family-existing';
const TTL_DAYS = 14;

function setup() {
  const tokenIssuer = {
    issue: jest.fn().mockResolvedValue(ACCESS_TOKEN),
  } satisfies Partial<jest.Mocked<TokenIssuer>>;

  const generator = {
    generate: jest
      .fn()
      .mockReturnValue({ token: RAW_TOKEN, tokenHash: TOKEN_HASH }),
    hash: jest.fn(),
  } satisfies Partial<jest.Mocked<RefreshTokenGenerator>>;

  const repo = {
    save: jest
      .fn()
      .mockImplementation((token: RefreshToken) => Promise.resolve(token)),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const config = {
    get: jest.fn().mockReturnValue(String(TTL_DAYS)),
  } satisfies Partial<jest.Mocked<ConfigService>>;

  const service = new IssueSessionService(
    tokenIssuer as unknown as TokenIssuer,
    generator as unknown as RefreshTokenGenerator,
    repo as unknown as RefreshTokenRepository,
    config as unknown as ConfigService,
  );

  return { service, tokenIssuer, generator, repo };
}

describe('IssueSessionService', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('issue without familyId (login)', () => {
    it('should return both tokens', async () => {
      const { service } = setup();

      const pair = await service.issue({
        userId: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
      });

      expect(pair).toEqual({
        accessToken: ACCESS_TOKEN,
        refreshToken: RAW_TOKEN,
      });
    });

    it('should put the newly created familyId into the access token payload', async () => {
      const { service, tokenIssuer, repo } = setup();

      await service.issue({
        userId: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
      });

      const savedToken = repo.save.mock.calls[0][0] as RefreshToken;
      expect(tokenIssuer.issue).toHaveBeenCalledWith({
        sub: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
        fam: savedToken.familyId,
      });
    });

    it('should persist only the hash, never the raw token', async () => {
      const { service, repo } = setup();

      await service.issue({
        userId: USER_ID,
        email: EMAIL,
        role: Role.TENANT,
      });

      const savedToken = repo.save.mock.calls[0][0] as RefreshToken;
      expect(savedToken.tokenHash).toBe(TOKEN_HASH);
      expect(savedToken.tokenHash).not.toBe(RAW_TOKEN);
    });
  });

  describe('issue with familyId (rotation)', () => {
    it('should keep the given familyId', async () => {
      const { service, tokenIssuer, repo } = setup();

      await service.issue(
        { userId: USER_ID, email: EMAIL, role: Role.TENANT },
        EXISTING_FAMILY,
      );

      const savedToken = repo.save.mock.calls[0][0] as RefreshToken;
      expect(savedToken.familyId).toBe(EXISTING_FAMILY);
      expect(tokenIssuer.issue).toHaveBeenCalledWith(
        expect.objectContaining({ fam: EXISTING_FAMILY }),
      );
    });
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/application/issue-session.service.spec.ts`
Expected: FAIL — `Cannot find module './issue-session.service'`

- [ ] **Step 4: 서비스 구현**

`src/auth/application/issue-session.service.ts` 생성.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { ConfigKey } from '../../config/config-keys';
import { TransactionClient } from '../../outbox/domain/transaction-runner';
import { Role } from '../domain/role.enum';
import { RefreshToken } from '../domain/refresh-token.entity';
import {
  REFRESH_TOKEN_GENERATOR,
  RefreshTokenGenerator,
} from '../domain/refresh-token-generator';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

const DEFAULT_TTL_DAYS = 14;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
}

// 로그인 3곳(login·kakao-login·complete-kakao-signup)과 갱신이 공유하는
// 세션 발급 절차. 한 곳에 모으는 이유는 발급 순서 제약 때문이다 —
// 액세스 토큰이 fam 클레임을 담아야 하므로 리프레시 토큰을 먼저 발급해
// familyId를 확정한 뒤 액세스 토큰을 만들어야 한다.
@Injectable()
export class IssueSessionService {
  constructor(
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
    @Inject(REFRESH_TOKEN_GENERATOR)
    private readonly generator: RefreshTokenGenerator,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    private readonly config: ConfigService,
  ) {}

  private ttlDays(): number {
    const raw = this.config.get<string>(
      ConfigKey.RefreshTokenTtlDays,
      String(DEFAULT_TTL_DAYS),
    );
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_DAYS;
  }

  // familyId 를 주지 않으면 새 가족을 만든다(로그인).
  // 주면 그 값을 유지한다(회전) — 같은 세션으로 이어진다.
  async issue(
    input: { userId: string; email: string; role: Role },
    familyId?: string,
    tx?: TransactionClient,
  ): Promise<TokenPair> {
    const { token, tokenHash } = this.generator.generate();
    const expiresAt = new Date(Date.now() + this.ttlDays() * MS_PER_DAY);

    const saved = await this.refreshTokens.save(
      RefreshToken.create({
        userId: input.userId,
        tokenHash,
        familyId: familyId ?? randomUUID(),
        expiresAt,
      }),
      tx,
    );

    const accessToken = await this.tokenIssuer.issue({
      sub: input.userId,
      email: input.email,
      role: input.role,
      fam: saved.familyId,
    });

    return { accessToken, refreshToken: token };
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/application/issue-session.service.spec.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: 커밋**

```bash
git add src/auth/application/issue-session.service.ts src/auth/application/issue-session.service.spec.ts src/auth/domain/token-issuer.ts
git commit -m "[M15]feat: 세션 발급 서비스 추가 및 TokenPayload에 fam 클레임 추가

발급 순서에 제약이 있다 — 액세스 토큰이 fam을 담아야 하므로 리프레시
토큰을 먼저 발급해 familyId를 확정한 뒤 액세스 토큰을 만든다. 로그인
3곳에 복붙하면 이 순서가 어긋날 위험이 있어 한 곳에 모았다."
```

---

## Task 9: 갱신 유스케이스 (회전 + 재사용 탐지)

**Files:**
- Create: `src/auth/application/refresh-tokens.use-case.ts`
- Test: `src/auth/application/refresh-tokens.use-case.spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenRepository`, `RefreshTokenGenerator`, `UserRepository`, `IssueSessionService`, `TransactionRunner`, `TokenPair`
- Produces: `RefreshTokensUseCase` 클래스, `execute(refreshToken: string): Promise<TokenPair>`

- [ ] **Step 1: 실패하는 테스트 작성**

`src/auth/application/refresh-tokens.use-case.spec.ts` 생성.

```typescript
import { Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { TransactionRunner } from '../../outbox/domain/transaction-runner';
import { RefreshToken } from '../domain/refresh-token.entity';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { Role } from '../domain/role.enum';
import { User } from '../domain/user.entity';
import { UserRepository } from '../domain/user.repository';
import { IssueSessionService } from './issue-session.service';
import { RefreshTokensUseCase } from './refresh-tokens.use-case';

const USER_ID = 'user-1';
const EMAIL = 'tenant@example.com';
const FAMILY_ID = 'family-1';
const TOKEN_ID = 'token-1';
const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'token-hash';
const NEW_PAIR = { accessToken: 'new-access', refreshToken: 'new-refresh' };
const FUTURE = new Date(Date.now() + 60_000);
const PAST = new Date(Date.now() - 60_000);

function persisted(overrides?: {
  usedAt?: Date | null;
  revokedAt?: Date | null;
  expiresAt?: Date;
}): RefreshToken {
  return RefreshToken.reconstitute({
    id: TOKEN_ID,
    userId: USER_ID,
    tokenHash: TOKEN_HASH,
    familyId: FAMILY_ID,
    expiresAt: overrides?.expiresAt ?? FUTURE,
    usedAt: overrides?.usedAt ?? null,
    revokedAt: overrides?.revokedAt ?? null,
  });
}

function setup(found: RefreshToken | null) {
  const repo = {
    findByHash: jest.fn().mockResolvedValue(found),
    markUsed: jest.fn().mockResolvedValue(undefined),
    revokeFamily: jest.fn().mockResolvedValue(2),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const generator = {
    hash: jest.fn().mockReturnValue(TOKEN_HASH),
    generate: jest.fn(),
  } satisfies Partial<jest.Mocked<RefreshTokenGenerator>>;

  const users = {
    findById: jest.fn().mockResolvedValue(
      User.reconstitute({
        id: USER_ID,
        email: EMAIL,
        name: '입주자',
        passwordHash: 'hash',
        role: Role.TENANT,
      }),
    ),
  } satisfies Partial<jest.Mocked<UserRepository>>;

  const issueSession = {
    issue: jest.fn().mockResolvedValue(NEW_PAIR),
  } satisfies Partial<jest.Mocked<IssueSessionService>>;

  // 트랜잭션 러너는 콜백을 그대로 실행한다(단위 테스트에서는 실제 tx 불필요).
  const txRunner = {
    run: jest.fn().mockImplementation((fn) => fn({} as never)),
  } satisfies Partial<jest.Mocked<TransactionRunner>>;

  const useCase = new RefreshTokensUseCase(
    repo as unknown as RefreshTokenRepository,
    generator as unknown as RefreshTokenGenerator,
    users as unknown as UserRepository,
    issueSession as unknown as IssueSessionService,
    txRunner as unknown as TransactionRunner,
  );

  return { useCase, repo, issueSession, txRunner };
}

describe('RefreshTokensUseCase', () => {
  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('when the token is usable', () => {
    it('should consume the old token and issue a new pair', async () => {
      const { useCase, repo, issueSession } = setup(persisted());

      const pair = await useCase.execute(RAW_TOKEN);

      expect(pair).toEqual(NEW_PAIR);
      expect(repo.markUsed).toHaveBeenCalledWith(
        TOKEN_ID,
        expect.any(Date),
        expect.anything(),
      );
    });

    it('should keep the same familyId so the session continues', async () => {
      const { useCase, issueSession } = setup(persisted());

      await useCase.execute(RAW_TOKEN);

      expect(issueSession.issue).toHaveBeenCalledWith(
        { userId: USER_ID, email: EMAIL, role: Role.TENANT },
        FAMILY_ID,
        expect.anything(),
      );
    });

    it('should perform consume and issue inside one transaction', async () => {
      const { useCase, txRunner } = setup(persisted());

      await useCase.execute(RAW_TOKEN);

      expect(txRunner.run).toHaveBeenCalledTimes(1);
    });

    // 스펙 §11-6(회전 원자성). 실제 DB 롤백은 Prisma가 담당하므로 단위
    // 테스트로는 확인할 수 없다. 여기서 검증하는 것은 "새 토큰 발급 실패가
    // 트랜잭션 콜백 밖으로 전파되는가"다 — 전파되지 않으면 러너가 커밋해
    // 소비 처리만 남는다.
    it('should propagate a failure from issuing so the transaction rolls back', async () => {
      const { useCase, issueSession } = setup(persisted());
      const failure = new Error('insert failed');
      issueSession.issue.mockRejectedValue(failure);
      expect.assertions(1);

      await expect(useCase.execute(RAW_TOKEN)).rejects.toThrow(failure);
    });

    // 스펙 §11-15(회전 후 current 유지). 이 유스케이스는 기존 familyId를
    // 그대로 넘기는 것까지 책임진다. 그 familyId가 액세스 토큰의 fam으로
    // 들어가는 것은 IssueSessionService 테스트가 검증한다(Task 8).
    it('should not create a new family on rotation', async () => {
      const { useCase, issueSession } = setup(persisted());

      await useCase.execute(RAW_TOKEN);

      const passedFamilyId = issueSession.issue.mock.calls[0][1];
      expect(passedFamilyId).toBe(FAMILY_ID);
    });
  });

  describe('when the token was already consumed', () => {
    it('should revoke the whole family and throw REFRESH_TOKEN_REUSED', async () => {
      const { useCase, repo } = setup(persisted({ usedAt: new Date() }));
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        const error = e as AppException;
        expect(error).toBeInstanceOf(AppException);
        expect(error.spec.code).toBe('AUTH_REFRESH_TOKEN_REUSED');
      }

      expect(repo.revokeFamily).toHaveBeenCalledWith(
        FAMILY_ID,
        expect.any(Date),
      );
    });
  });

  describe('when the token is expired', () => {
    it('should throw INVALID_REFRESH_TOKEN without revoking the family', async () => {
      const { useCase, repo } = setup(persisted({ expiresAt: PAST }));
      expect.assertions(2);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).spec.code).toBe(
          'AUTH_INVALID_REFRESH_TOKEN',
        );
      }

      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });
  });

  describe('when the token is revoked', () => {
    it('should throw INVALID_REFRESH_TOKEN without revoking again', async () => {
      const { useCase, repo } = setup(persisted({ revokedAt: new Date() }));
      expect.assertions(2);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).spec.code).toBe(
          'AUTH_INVALID_REFRESH_TOKEN',
        );
      }

      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });
  });

  describe('when no token row matches', () => {
    it('should throw INVALID_REFRESH_TOKEN and change nothing', async () => {
      const { useCase, repo } = setup(null);
      expect.assertions(3);

      try {
        await useCase.execute(RAW_TOKEN);
      } catch (e) {
        expect((e as AppException).spec.code).toBe(
          'AUTH_INVALID_REFRESH_TOKEN',
        );
      }

      expect(repo.markUsed).not.toHaveBeenCalled();
      expect(repo.revokeFamily).not.toHaveBeenCalled();
    });
  });
});
```

> `User.reconstitute`가 존재하지 않으면 `src/auth/domain/user.entity.ts`를 읽어 실제 복원 메서드 이름으로 바꾼다.

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/application/refresh-tokens.use-case.spec.ts`
Expected: FAIL — `Cannot find module './refresh-tokens.use-case'`

- [ ] **Step 3: 유스케이스 구현**

`src/auth/application/refresh-tokens.use-case.ts` 생성.

```typescript
import { Inject, Injectable, Logger } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';
import { AuthError } from '../auth.errors';
import {
  REFRESH_TOKEN_GENERATOR,
  RefreshTokenGenerator,
} from '../domain/refresh-token-generator';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { IssueSessionService, TokenPair } from './issue-session.service';

@Injectable()
export class RefreshTokensUseCase {
  private readonly logger = new Logger(RefreshTokensUseCase.name);

  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    @Inject(REFRESH_TOKEN_GENERATOR)
    private readonly generator: RefreshTokenGenerator,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    private readonly issueSession: IssueSessionService,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
  ) {}

  async execute(refreshToken: string): Promise<TokenPair> {
    const now = new Date();
    const found = await this.refreshTokens.findByHash(
      this.generator.hash(refreshToken),
    );

    if (!found) throw new AppException(AuthError.INVALID_REFRESH_TOKEN);

    // 이미 소비된 토큰의 재제출 = 사본 존재 = 침해 신호.
    // 정상 클라이언트는 회전으로 교체된 토큰을 다시 쓸 이유가 없다.
    // 대응은 가족 전체 폐기다 — 누가 진짜 사용자인지 서버가 구분할 수
    // 없으므로 둘 다 끊고 재인증을 요구하는 편이 안전하다.
    if (found.isUsed()) {
      const revoked = await this.refreshTokens.revokeFamily(
        found.familyId,
        now,
      );
      this.logger.warn(
        `리프레시 토큰 재사용 탐지 — 가족 폐기. userId=${found.userId} familyId=${found.familyId} revoked=${revoked}`,
      );
      throw new AppException(AuthError.REFRESH_TOKEN_REUSED);
    }

    // 만료·폐기는 침해가 아니므로 가족을 폐기하지 않는다.
    // 여기서 폐기하면 "만료 토큰을 늦게 제출했다는 이유로 다른 기기까지
    // 끊기는" 오작동이 된다.
    if (!found.isUsable(now)) {
      throw new AppException(AuthError.INVALID_REFRESH_TOKEN);
    }

    const user = await this.users.findById(found.userId);
    if (!user) throw new AppException(AuthError.INVALID_REFRESH_TOKEN);

    // 소비 처리와 새 발급을 한 트랜잭션으로 묶는다. 나누면 "기존 토큰은
    // 소비됐는데 새 토큰이 없는" 상태가 가능해져 사용자가 튕긴다.
    return this.txRunner.run(async (tx) => {
      await this.refreshTokens.markUsed(found.id!, now, tx);
      return this.issueSession.issue(
        { userId: user.id!, email: user.email, role: user.role },
        found.familyId,
        tx,
      );
    });
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/application/refresh-tokens.use-case.spec.ts`
Expected: PASS — 9 tests

- [ ] **Step 5: 커밋**

```bash
git add src/auth/application/refresh-tokens.use-case.ts src/auth/application/refresh-tokens.use-case.spec.ts
git commit -m "[M15]feat: 갱신 유스케이스 추가 — 회전 + 재사용 탐지

usedAt이 있는 토큰의 재제출을 침해로 판단해 가족 전체를 폐기한다.
만료·폐기는 침해가 아니므로 가족을 건드리지 않고 해당 요청만 거절한다.
이 구분을 흐리면 만료 토큰을 늦게 제출한 것만으로 다른 기기까지 끊긴다."
```

---

## Task 10: 로그아웃 · 전체 로그아웃 유스케이스

**Files:**
- Create: `src/auth/application/logout.use-case.ts`
- Create: `src/auth/application/logout-all.use-case.ts`
- Test: `src/auth/application/logout.use-case.spec.ts`
- Test: `src/auth/application/logout-all.use-case.spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenRepository`, `RefreshTokenGenerator`
- Produces:
  - `LogoutUseCase.execute(refreshToken: string): Promise<void>`
  - `LogoutAllUseCase.execute(userId: string): Promise<void>`

- [ ] **Step 1: 로그아웃 테스트 작성**

`src/auth/application/logout.use-case.spec.ts` 생성.

```typescript
import { RefreshToken } from '../domain/refresh-token.entity';
import { RefreshTokenGenerator } from '../domain/refresh-token-generator';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { LogoutUseCase } from './logout.use-case';

const USER_ID = 'user-1';
const FAMILY_ID = 'family-1';
const RAW_TOKEN = 'raw-token';
const TOKEN_HASH = 'token-hash';

function setup(found: RefreshToken | null) {
  const repo = {
    findByHash: jest.fn().mockResolvedValue(found),
    revokeFamily: jest.fn().mockResolvedValue(1),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const generator = {
    hash: jest.fn().mockReturnValue(TOKEN_HASH),
    generate: jest.fn(),
  } satisfies Partial<jest.Mocked<RefreshTokenGenerator>>;

  const useCase = new LogoutUseCase(
    repo as unknown as RefreshTokenRepository,
    generator as unknown as RefreshTokenGenerator,
  );

  return { useCase, repo };
}

describe('LogoutUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should revoke the family of the submitted token', async () => {
    const { useCase, repo } = setup(
      RefreshToken.reconstitute({
        id: 'token-1',
        userId: USER_ID,
        tokenHash: TOKEN_HASH,
        familyId: FAMILY_ID,
        expiresAt: new Date(Date.now() + 60_000),
        usedAt: null,
        revokedAt: null,
      }),
    );

    await useCase.execute(RAW_TOKEN);

    expect(repo.revokeFamily).toHaveBeenCalledWith(
      FAMILY_ID,
      expect.any(Date),
    );
  });

  // 로그아웃은 멱등해야 한다. 알 수 없는 토큰으로 호출해도 에러를 내지 않는다
  // — 클라이언트가 이미 세션을 버린 뒤 재시도하는 경우가 정상적으로 있다.
  it('should succeed silently when the token is unknown', async () => {
    const { useCase, repo } = setup(null);

    await expect(useCase.execute(RAW_TOKEN)).resolves.toBeUndefined();

    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: 전체 로그아웃 테스트 작성**

`src/auth/application/logout-all.use-case.spec.ts` 생성.

```typescript
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { LogoutAllUseCase } from './logout-all.use-case';

const USER_ID = 'user-1';

describe('LogoutAllUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should revoke every session of the user', async () => {
    const repo = {
      revokeAllByUser: jest.fn().mockResolvedValue(3),
    } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;
    const useCase = new LogoutAllUseCase(
      repo as unknown as RefreshTokenRepository,
    );

    await useCase.execute(USER_ID);

    expect(repo.revokeAllByUser).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Date),
    );
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/application/logout.use-case.spec.ts src/auth/application/logout-all.use-case.spec.ts`
Expected: FAIL — 두 모듈 모두 `Cannot find module`

- [ ] **Step 4: 두 유스케이스 구현**

`src/auth/application/logout.use-case.ts` 생성.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  REFRESH_TOKEN_GENERATOR,
  RefreshTokenGenerator,
} from '../domain/refresh-token-generator';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

@Injectable()
export class LogoutUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    @Inject(REFRESH_TOKEN_GENERATOR)
    private readonly generator: RefreshTokenGenerator,
  ) {}

  async execute(refreshToken: string): Promise<void> {
    const found = await this.refreshTokens.findByHash(
      this.generator.hash(refreshToken),
    );
    // 알 수 없는 토큰이어도 에러를 내지 않는다. 로그아웃은 멱등해야 하고,
    // 클라이언트가 이미 세션을 버린 뒤 재시도하는 경우가 정상적으로 있다.
    if (!found) return;

    await this.refreshTokens.revokeFamily(found.familyId, new Date());
  }
}
```

`src/auth/application/logout-all.use-case.ts` 생성.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

@Injectable()
export class LogoutAllUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  async execute(userId: string): Promise<void> {
    await this.refreshTokens.revokeAllByUser(userId, new Date());
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/application/logout.use-case.spec.ts src/auth/application/logout-all.use-case.spec.ts`
Expected: PASS — 3 tests

- [ ] **Step 6: 커밋**

```bash
git add src/auth/application/logout.use-case.ts src/auth/application/logout.use-case.spec.ts src/auth/application/logout-all.use-case.ts src/auth/application/logout-all.use-case.spec.ts
git commit -m "[M15]feat: 로그아웃·전체 로그아웃 유스케이스 추가

로그아웃은 알 수 없는 토큰에도 에러를 내지 않는다. 멱등해야 하고,
클라이언트가 세션을 이미 버린 뒤 재시도하는 경우가 정상적으로 있다."
```

---

## Task 11: 세션 목록 · 개별 폐기 유스케이스

**Files:**
- Create: `src/auth/application/list-sessions.use-case.ts`
- Create: `src/auth/application/revoke-session.use-case.ts`
- Test: `src/auth/application/list-sessions.use-case.spec.ts`
- Test: `src/auth/application/revoke-session.use-case.spec.ts`

**Interfaces:**
- Consumes: `RefreshTokenRepository`, `SessionSummary`
- Produces:
  - `SessionView` 타입: `{ familyId: string; createdAt: Date; current: boolean }`
  - `ListSessionsUseCase.execute(userId: string, currentFamilyId?: string): Promise<SessionView[]>`
  - `RevokeSessionUseCase.execute(userId: string, familyId: string): Promise<void>`

- [ ] **Step 1: 세션 목록 테스트 작성**

`src/auth/application/list-sessions.use-case.spec.ts` 생성.

```typescript
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { ListSessionsUseCase } from './list-sessions.use-case';

const USER_ID = 'user-1';
const FAMILY_A = 'family-a';
const FAMILY_B = 'family-b';
const CREATED_A = new Date('2026-07-28T10:00:00.000Z');
const CREATED_B = new Date('2026-07-25T09:00:00.000Z');

function setup() {
  const repo = {
    findActiveFamilies: jest.fn().mockResolvedValue([
      { familyId: FAMILY_A, createdAt: CREATED_A },
      { familyId: FAMILY_B, createdAt: CREATED_B },
    ]),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const useCase = new ListSessionsUseCase(
    repo as unknown as RefreshTokenRepository,
  );

  return { useCase, repo };
}

describe('ListSessionsUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should mark only the requesting family as current', async () => {
    const { useCase } = setup();

    const sessions = await useCase.execute(USER_ID, FAMILY_A);

    expect(sessions).toEqual([
      { familyId: FAMILY_A, createdAt: CREATED_A, current: true },
      { familyId: FAMILY_B, createdAt: CREATED_B, current: false },
    ]);
  });

  // 배포 시점에 이미 발급된 액세스 토큰에는 fam 클레임이 없다.
  // 예외를 던지지 않고 전부 false로 둔다 — 최대 15분 뒤 자연히 해소된다.
  it('should mark nothing as current when fam claim is missing', async () => {
    const { useCase } = setup();

    const sessions = await useCase.execute(USER_ID, undefined);

    expect(sessions.every((s) => s.current === false)).toBe(true);
  });
});
```

- [ ] **Step 2: 개별 폐기 테스트 작성**

`src/auth/application/revoke-session.use-case.spec.ts` 생성.

```typescript
import { AppException } from '../../common/errors/app-exception';
import { RefreshTokenRepository } from '../domain/refresh-token.repository';
import { RevokeSessionUseCase } from './revoke-session.use-case';

const USER_ID = 'user-1';
const OTHER_USER_ID = 'user-2';
const FAMILY_ID = 'family-1';

function setup(owner: string | null) {
  const repo = {
    findFamilyOwner: jest.fn().mockResolvedValue(owner),
    revokeFamily: jest.fn().mockResolvedValue(1),
  } satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

  const useCase = new RevokeSessionUseCase(
    repo as unknown as RefreshTokenRepository,
  );

  return { useCase, repo };
}

describe('RevokeSessionUseCase', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should revoke the family when the requester owns it', async () => {
    const { useCase, repo } = setup(USER_ID);

    await useCase.execute(USER_ID, FAMILY_ID);

    expect(repo.revokeFamily).toHaveBeenCalledWith(
      FAMILY_ID,
      expect.any(Date),
    );
  });

  it('should reject revoking a family owned by someone else', async () => {
    const { useCase, repo } = setup(OTHER_USER_ID);
    expect.assertions(2);

    try {
      await useCase.execute(USER_ID, FAMILY_ID);
    } catch (e) {
      expect((e as AppException).spec.code).toBe('AUTH_NOT_SESSION_OWNER');
    }

    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });

  // 404로 구분하면 남의 familyId 존재 여부를 알려주는 정보 노출이 된다.
  it('should reject an unknown familyId with the same error as a foreign one', async () => {
    const { useCase, repo } = setup(null);
    expect.assertions(2);

    try {
      await useCase.execute(USER_ID, FAMILY_ID);
    } catch (e) {
      expect((e as AppException).spec.code).toBe('AUTH_NOT_SESSION_OWNER');
    }

    expect(repo.revokeFamily).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/application/list-sessions.use-case.spec.ts src/auth/application/revoke-session.use-case.spec.ts`
Expected: FAIL — 두 모듈 모두 `Cannot find module`

- [ ] **Step 4: 두 유스케이스 구현**

`src/auth/application/list-sessions.use-case.ts` 생성.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

export interface SessionView {
  familyId: string;
  createdAt: Date;
  current: boolean;
}

@Injectable()
export class ListSessionsUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  // currentFamilyId 는 요청한 액세스 토큰의 fam 클레임이다.
  // 없으면(배포 전 발급된 구 토큰) 전부 false로 둔다 — 예외를 던지지 않는다.
  async execute(
    userId: string,
    currentFamilyId?: string,
  ): Promise<SessionView[]> {
    const families = await this.refreshTokens.findActiveFamilies(
      userId,
      new Date(),
    );
    return families.map((family) => ({
      familyId: family.familyId,
      createdAt: family.createdAt,
      current: family.familyId === currentFamilyId,
    }));
  }
}
```

`src/auth/application/revoke-session.use-case.ts` 생성.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';

@Injectable()
export class RevokeSessionUseCase {
  constructor(
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
  ) {}

  async execute(userId: string, familyId: string): Promise<void> {
    const owner = await this.refreshTokens.findFamilyOwner(familyId);
    // 소유권 검사. 인증만 통과했다고 임의의 familyId를 받으면 타인의 세션을
    // 끊을 수 있다(설계 결정 8 — RBAC + 리소스 소유권 이중 인가).
    // 존재하지 않는 familyId도 같은 에러로 응답한다 — 404로 구분하면
    // 남의 familyId 존재 여부를 알려주는 정보 노출이 된다.
    if (owner !== userId) {
      throw new AppException(AuthError.NOT_SESSION_OWNER);
    }

    await this.refreshTokens.revokeFamily(familyId, new Date());
  }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/application/list-sessions.use-case.spec.ts src/auth/application/revoke-session.use-case.spec.ts`
Expected: PASS — 5 tests

- [ ] **Step 6: 커밋**

```bash
git add src/auth/application/list-sessions.use-case.ts src/auth/application/list-sessions.use-case.spec.ts src/auth/application/revoke-session.use-case.ts src/auth/application/revoke-session.use-case.spec.ts
git commit -m "[M15]feat: 세션 목록·개별 폐기 유스케이스 추가

개별 폐기에 소유권 검사를 둔다. 존재하지 않는 familyId도 소유권 위반과
같은 403으로 응답한다 — 404로 구분하면 남의 familyId 존재 여부를
알려주는 정보 노출이 된다."
```

---

## Task 12: 로그인 3곳을 토큰 쌍 반환으로 전환

**Files:**
- Modify: `src/auth/application/login.use-case.ts`
- Modify: `src/auth/application/kakao-login.use-case.ts`
- Modify: `src/auth/application/complete-kakao-signup.use-case.ts`
- Test: `src/auth/application/login.use-case.spec.ts` (기존 수정)

**Interfaces:**
- Consumes: `IssueSessionService`, `TokenPair`
- Produces: 세 유스케이스가 `TokenPair`(`{ accessToken, refreshToken }`)를 반환

**작업 방식:** 세 파일 모두 `@Inject(TOKEN_ISSUER) tokenIssuer` 의존을 `IssueSessionService`로 교체하고, `tokenIssuer.issue({ sub, email, role })` 호출을 `issueSession.issue({ userId, email, role })`로 바꾼다.

- [ ] **Step 1: 기존 login 테스트를 토큰 쌍 기대로 수정**

`src/auth/application/login.use-case.spec.ts`를 읽고, `TOKEN_ISSUER` mock을 `IssueSessionService` mock으로 교체한다. 반환값 검증을 다음처럼 바꾼다.

```typescript
const TOKEN_PAIR = { accessToken: 'access-token', refreshToken: 'refresh-token' };

// setup() 안에서
const issueSession = {
  issue: jest.fn().mockResolvedValue(TOKEN_PAIR),
} satisfies Partial<jest.Mocked<IssueSessionService>>;

// 성공 케이스 검증
it('should return both tokens when credentials are valid', async () => {
  const { useCase } = setup();

  const result = await useCase.execute({ email: EMAIL, password: PASSWORD });

  expect(result).toEqual(TOKEN_PAIR);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/application/login.use-case.spec.ts`
Expected: FAIL — `IssueSessionService`를 주입받지 않아 타입 불일치 또는 `issue is not a function`

- [ ] **Step 3: `login.use-case.ts` 수정**

`TOKEN_ISSUER` import와 주입을 제거하고 `IssueSessionService`를 주입한다.

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { IssueSessionService, TokenPair } from './issue-session.service';

export interface LoginInput {
  email: string;
  password: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly issueSession: IssueSessionService,
  ) {}

  async execute(input: LoginInput): Promise<TokenPair> {
    const user = await this.users.findByEmail(input.email);
    if (!user) throw new AppException(AuthError.INVALID_CREDENTIALS);
    // OAuth 가입 유저는 passwordHash가 null — 비밀번호 로그인 불가.
    if (!user.passwordHash)
      throw new AppException(AuthError.INVALID_CREDENTIALS);
    const ok = await this.hasher.compare(input.password, user.passwordHash);
    if (!ok) throw new AppException(AuthError.INVALID_CREDENTIALS);

    // familyId를 주지 않으므로 새 가족(= 새 세션)이 만들어진다.
    return this.issueSession.issue({
      userId: user.id!,
      email: user.email,
      role: user.role,
    });
  }
}
```

- [ ] **Step 4: `kakao-login.use-case.ts` 수정**

세 곳을 바꾼다. `onboardingToken` 분기는 건드리지 않는다.

(1) import — `TOKEN_ISSUER, TokenIssuer` import를 제거하고 추가한다.

```typescript
import { IssueSessionService, TokenPair } from './issue-session.service';
```

(2) constructor — 마지막 주입을 교체한다.

```typescript
    @Inject(ONBOARDING_TOKEN)
    private readonly onboarding: OnboardingTokenIssuer,
    private readonly issueSession: IssueSessionService,
  ) {}
```

(3) 기존 유저 분기 — `if (account) { ... }` 블록 안의 발급부를 교체한다.

```typescript
    if (account) {
      const user = await this.users.findById(account.userId);
      if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
      // familyId를 주지 않으므로 새 가족(= 새 세션)이 만들어진다.
      return this.issueSession.issue({
        userId: user.id!,
        email: user.email,
        role: user.role,
      });
    }
```

`KakaoLoginResult` 타입 선언을 찾아 `accessToken`만 갖던 분기를 `TokenPair`로 바꾼다. 파일 상단 근처에 있다.

```typescript
export type KakaoLoginResult = TokenPair | { onboardingToken: string };
```

- [ ] **Step 5: `complete-kakao-signup.use-case.ts` 수정**

`tokenIssuer.issue` 호출이 두 곳 있다. 둘 다 바꾼다.

(1) import와 constructor는 Step 4의 (1)·(2)와 같은 방식으로 교체한다.

(2) 멱등 분기(이미 연결된 Account) — `if (existing) { ... }` 블록의 return을 교체한다.

```typescript
    if (existing) {
      const user = await this.users.findById(existing.userId);
      if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
      return this.issueSession.issue({
        userId: user.id!,
        email: user.email,
        role: user.role,
      });
    }
```

(3) 신규 생성 분기 — 파일 끝의 return을 교체한다.

```typescript
    return this.issueSession.issue({
      userId: user.id!,
      email: user.email,
      role: user.role,
    });
```

반환 타입 선언을 `Promise<TokenPair>`로 바꾼다.

- [ ] **Step 6: 전체 auth 테스트 통과 확인**

Run: `pnpm exec jest src/auth`
Expected: PASS — 기존 테스트가 모두 통과. 실패하면 해당 spec의 mock을 `IssueSessionService`로 교체한다

- [ ] **Step 7: 커밋**

```bash
git add src/auth/application
git commit -m "[M15]feat: 로그인 3곳을 토큰 쌍 반환으로 전환

login·kakao-login·complete-kakao-signup이 TOKEN_ISSUER 대신
IssueSessionService에 의존하게 한다. 발급 순서 제약(리프레시 먼저,
그 familyId로 액세스)이 한 곳에서만 관리된다."
```

---

## Task 13: 비밀번호 변경 시 전체 세션 폐기

**Files:**
- Modify: `src/auth/application/change-password.use-case.ts`
- Test: `src/auth/application/change-password.use-case.spec.ts` (기존 수정)

**Interfaces:**
- Consumes: `RefreshTokenRepository`, `TransactionRunner`
- Produces: 변경 없음 (반환 타입 `Promise<void>` 유지)

- [ ] **Step 1: 테스트에 폐기 검증 추가**

`src/auth/application/change-password.use-case.spec.ts`의 성공 케이스에 추가한다.

```typescript
it('should revoke every session so the leaked password cannot be reused', async () => {
  const { useCase, refreshTokens } = setup();

  await useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD);

  expect(refreshTokens.revokeAllByUser).toHaveBeenCalledWith(
    USER_ID,
    expect.any(Date),
    expect.anything(),
  );
});

it('should update the hash and revoke sessions in one transaction', async () => {
  const { useCase, txRunner } = setup();

  await useCase.execute(USER_ID, CURRENT_PASSWORD, NEW_PASSWORD);

  expect(txRunner.run).toHaveBeenCalledTimes(1);
});
```

`setup()`에 두 mock을 추가한다.

```typescript
const refreshTokens = {
  revokeAllByUser: jest.fn().mockResolvedValue(2),
} satisfies Partial<jest.Mocked<RefreshTokenRepository>>;

const txRunner = {
  run: jest.fn().mockImplementation((fn) => fn({} as never)),
} satisfies Partial<jest.Mocked<TransactionRunner>>;
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `pnpm exec jest src/auth/application/change-password.use-case.spec.ts`
Expected: FAIL — 생성자 인자 수 불일치 또는 `revokeAllByUser` 미호출

- [ ] **Step 3: 유스케이스 수정**

```typescript
import { Inject, Injectable } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import {
  REFRESH_TOKEN_REPOSITORY,
  RefreshTokenRepository,
} from '../domain/refresh-token.repository';
import {
  TRANSACTION_RUNNER,
  TransactionRunner,
} from '../../outbox/domain/transaction-runner';

@Injectable()
export class ChangePasswordUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(REFRESH_TOKEN_REPOSITORY)
    private readonly refreshTokens: RefreshTokenRepository,
    @Inject(TRANSACTION_RUNNER) private readonly txRunner: TransactionRunner,
  ) {}

  async execute(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const user = await this.users.findById(userId);
    if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
    // OAuth 가입 유저는 passwordHash가 null — 비밀번호 변경 불가.
    if (!user.passwordHash)
      throw new AppException(AuthError.INVALID_CREDENTIALS);
    const ok = await this.hasher.compare(currentPassword, user.passwordHash);
    if (!ok) throw new AppException(AuthError.INVALID_CREDENTIALS);
    const newHash = await this.hasher.hash(newPassword);

    // 해시 갱신과 세션 폐기를 한 트랜잭션으로 묶는다. 나누면 "비밀번호는
    // 바뀌었지만 기존 세션이 살아있는" 창이 생긴다.
    // 본인도 함께 튕긴다 — 비밀번호를 바꿨으니 다시 로그인하는 흐름이다.
    await this.txRunner.run(async (tx) => {
      await this.users.update(user.changePassword(newHash), tx);
      await this.refreshTokens.revokeAllByUser(userId, new Date(), tx);
    });
  }
}
```

**함께 수정: `UserRepository.update`에 `tx` 추가 (확인됨 — 현재 시그니처는 `update(user: User): Promise<User>`로 `tx`를 받지 않는다)**

`src/auth/domain/user.repository.ts`의 선언을 바꾼다.

```typescript
  update(user: User, tx?: TransactionClient): Promise<User>;
```

파일 상단에 import를 추가한다.

```typescript
import { TransactionClient } from '../../outbox/domain/transaction-runner';
```

`src/auth/infrastructure/prisma-user.repository.ts`의 `update` 구현에서 `this.prisma` 대신 `(tx ?? this.prisma)`를 쓰도록 바꾼다. 다른 호출처(`update-profile.use-case.ts`)는 인자를 생략하므로 영향이 없다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `pnpm exec jest src/auth/application/change-password.use-case.spec.ts`
Expected: PASS

- [ ] **Step 5: 커밋**

```bash
git add src/auth/application/change-password.use-case.ts src/auth/application/change-password.use-case.spec.ts src/auth/domain/user.repository.ts src/auth/infrastructure/prisma-user.repository.ts
git commit -m "[M15]feat: 비밀번호 변경 시 전체 세션 폐기

비밀번호를 바꾸는 상황은 대개 '유출됐을지 모른다'다. 기존 세션을
살려두면 공격자가 그대로 남는다. 해시 갱신과 폐기를 한 트랜잭션으로
묶어 그 사이 창을 없앤다."
```

---

## Task 14: DTO와 컨트롤러 엔드포인트 5개

**Files:**
- Create: `src/auth/interface/dto/refresh.dto.ts`
- Create: `src/auth/interface/dto/session.dto.ts`
- Modify: `src/auth/interface/auth.controller.ts`

**Interfaces:**
- Consumes: `RefreshTokensUseCase`, `LogoutUseCase`, `LogoutAllUseCase`, `ListSessionsUseCase`, `RevokeSessionUseCase`, `TokenPayload`
- Produces: `POST /auth/refresh`, `POST /auth/logout`, `POST /auth/logout-all`, `GET /auth/sessions`, `DELETE /auth/sessions/:familyId`

- [ ] **Step 1: DTO 작성**

`src/auth/interface/dto/refresh.dto.ts` 생성.

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class RefreshTokenDto {
  @ApiProperty({
    description: '발급받은 리프레시 토큰',
    example: 'YWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXo',
  })
  @IsString()
  @IsNotEmpty()
  refreshToken: string;
}

export class TokenPairResponseDto {
  @ApiProperty({ description: '액세스 토큰(JWT). 기본 수명 15분' })
  accessToken: string;

  @ApiProperty({
    description: '리프레시 토큰. 갱신할 때마다 새 값으로 교체된다(회전)',
  })
  refreshToken: string;
}
```

`src/auth/interface/dto/session.dto.ts` 생성.

```typescript
import { ApiProperty } from '@nestjs/swagger';

export class SessionResponseDto {
  @ApiProperty({ description: '세션(리프레시 토큰 가족) 식별자' })
  familyId: string;

  @ApiProperty({ description: '이 세션이 시작된 시각(= 로그인 시각)' })
  createdAt: Date;

  @ApiProperty({
    description: '이 요청을 보낸 세션인지 여부',
  })
  current: boolean;
}
```

- [ ] **Step 2: 컨트롤러에 엔드포인트 추가**

`src/auth/interface/auth.controller.ts`의 constructor에 5개 유스케이스를 주입하고, 클래스 끝에 라우트를 추가한다.

```typescript
  @Post('refresh')
  @ApiOperation({
    summary: '토큰 갱신(회전)',
    description:
      '리프레시 토큰으로 새 토큰 쌍을 받는다. 기존 리프레시 토큰은 무효화된다. ' +
      '이미 사용된 토큰을 다시 제출하면 침해로 판단해 해당 세션 전체가 폐기된다.',
  })
  @ApiResponse({ status: 201, type: TokenPairResponseDto })
  @ApiResponse({
    status: 401,
    type: ErrorResponseDto,
    description: '무효한 리프레시 토큰 또는 재사용 탐지',
  })
  refresh(@Body() dto: RefreshTokenDto) {
    return this.refreshTokens.execute(dto.refreshToken);
  }

  @Post('logout')
  @ApiOperation({
    summary: '로그아웃(현재 세션 폐기)',
    description:
      '액세스 토큰이 이미 만료됐을 수 있으므로 리프레시 토큰으로 인증한다. 멱등하다.',
  })
  @ApiResponse({ status: 201, description: '폐기 완료' })
  async logout(@Body() dto: RefreshTokenDto): Promise<void> {
    await this.logoutUseCase.execute(dto.refreshToken);
  }

  @Post('logout-all')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({ summary: '전체 로그아웃(내 모든 세션 폐기)' })
  @ApiResponse({ status: 201, description: '폐기 완료' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '인증 필요' })
  async logoutAll(@CurrentUser() user: TokenPayload): Promise<void> {
    await this.logoutAllUseCase.execute(user.sub);
  }

  @Get('sessions')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @ApiOperation({
    summary: '내 활성 세션 목록',
    description:
      'ip·User-Agent를 저장하지 않으므로 기기 식별 정보는 제공하지 않는다. ' +
      '로그인 시각과 current 여부로만 구분한다.',
  })
  @ApiResponse({ status: 200, type: [SessionResponseDto] })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: '인증 필요' })
  sessions(@CurrentUser() user: TokenPayload) {
    return this.listSessions.execute(user.sub, user.fam);
  }

  @Delete('sessions/:familyId')
  @UseGuards(JwtAuthGuard)
  @ApiBearerAuth(SWAGGER_BEARER_AUTH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: '특정 세션 폐기' })
  @ApiResponse({ status: 204, description: '폐기 완료' })
  @ApiResponse({
    status: 403,
    type: ErrorResponseDto,
    description: '본인 세션이 아님(존재하지 않는 세션도 동일)',
  })
  async revokeSessionById(
    @CurrentUser() user: TokenPayload,
    @Param('familyId') familyId: string,
  ): Promise<void> {
    await this.revokeSession.execute(user.sub, familyId);
  }
```

첫 줄의 import에 `Delete`, `Param`, `HttpCode`, `HttpStatus`를 추가하고, DTO와 유스케이스 import도 함께 추가한다.

- [ ] **Step 3: 빌드 확인**

Run: `pnpm exec nest build`
Expected: 에러 없이 완료. `Nest can't resolve dependencies` 류는 Task 15에서 배선 후 해소된다

- [ ] **Step 4: 커밋**

```bash
git add src/auth/interface
git commit -m "[M15]feat: 갱신·로그아웃·세션 관리 엔드포인트 5개 추가

/auth/refresh 와 /auth/logout 은 공개다. 액세스 토큰이 이미 만료된
상태에서 호출되는 경로라 JwtAuthGuard를 걸면 갱신 자체가 불가능하다.
리프레시 토큰 자체가 인증 수단이다."
```

---

## Task 15: 모듈 배선과 통합 확인

**Files:**
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Consumes: 모든 이전 태스크의 산출물
- Produces: 동작하는 `AuthModule`

- [ ] **Step 1: provider 배선**

`src/auth/auth.module.ts`의 `providers` 배열에 추가한다.

```typescript
    IssueSessionService,
    RefreshTokensUseCase,
    LogoutUseCase,
    LogoutAllUseCase,
    ListSessionsUseCase,
    RevokeSessionUseCase,
    {
      provide: REFRESH_TOKEN_REPOSITORY,
      useClass: PrismaRefreshTokenRepository,
    },
    {
      provide: REFRESH_TOKEN_GENERATOR,
      useClass: CryptoRefreshTokenGenerator,
    },
```

**`TRANSACTION_RUNNER` 주입 (확인됨 — `src/outbox/outbox.module.ts:58`이 `exports: [TRANSACTION_RUNNER, OUTBOX_STORE]`로 내보낸다)**

`AuthModule`의 `imports` 배열에 `OutboxModule`을 추가한다. providers에 직접 등록하지 않는다 — 같은 토큰을 두 모듈이 각자 등록하면 인스턴스가 갈린다.

```typescript
  imports: [
    PassportModule,
    OutboxModule,
    JwtModule.registerAsync({
      // ... 기존 설정 그대로
    }),
  ],
```

순환 참조가 발생하면(`OutboxModule`이 `AuthModule`을 참조하는 경우) `forwardRef`가 아니라 `TRANSACTION_RUNNER`를 공용 모듈로 승격하는 방향을 검토하고, 판단이 필요하면 BLOCKED로 보고한다.

- [ ] **Step 2: 전체 테스트 통과 확인**

Run: `pnpm exec jest`
Expected: PASS — 전체 스위트 통과

- [ ] **Step 3: 빌드와 lint 확인**

Run: `pnpm exec nest build && pnpm lint:check`
Expected: 에러 0, 경고 0

- [ ] **Step 4: 실제 기동 후 수동 검증**

```bash
docker compose up -d
pnpm exec prisma migrate deploy
pnpm start:dev
```

다른 터미널에서 순서대로 실행해 결과를 확인한다.

```bash
# 1) 회원가입 + 로그인 — refreshToken 이 함께 오는지
curl -s -X POST localhost:3000/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"rt@example.com","password":"password123","name":"테스터"}'

LOGIN=$(curl -s -X POST localhost:3000/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"rt@example.com","password":"password123"}')
echo "$LOGIN"
# 기대: {"accessToken":"...","refreshToken":"..."}

RT=$(echo "$LOGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["refreshToken"])')
AT=$(echo "$LOGIN" | python3 -c 'import json,sys; print(json.load(sys.stdin)["accessToken"])')

# 2) 세션 목록 — current: true 가 하나인지
curl -s localhost:3000/auth/sessions -H "Authorization: Bearer $AT"
# 기대: [{"familyId":"...","createdAt":"...","current":true}]

# 3) 갱신 — 새 토큰 쌍이 오는지
REFRESHED=$(curl -s -X POST localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$RT\"}")
echo "$REFRESHED"
# 기대: 새 accessToken·refreshToken

# 4) 재사용 탐지 — 방금 쓴 토큰을 다시 제출
curl -s -X POST localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$RT\"}"
# 기대: {"statusCode":401,"code":"AUTH_REFRESH_TOKEN_REUSED",...}
# 앱 로그에 "리프레시 토큰 재사용 탐지 — 가족 폐기" warn 이 남는지 확인

# 5) 가족이 폐기됐으므로 3번에서 받은 새 토큰도 무효인지
NEW_RT=$(echo "$REFRESHED" | python3 -c 'import json,sys; print(json.load(sys.stdin)["refreshToken"])')
curl -s -X POST localhost:3000/auth/refresh \
  -H 'Content-Type: application/json' -d "{\"refreshToken\":\"$NEW_RT\"}"
# 기대: {"statusCode":401,"code":"AUTH_INVALID_REFRESH_TOKEN",...}
```

- [ ] **Step 5: Swagger 노출 확인**

`http://localhost:3000/docs`에서 auth 태그에 신규 5개 엔드포인트가 보이고, `TokenPairResponseDto`·`SessionResponseDto` 스키마가 노출되는지 확인한다.

- [ ] **Step 6: 커밋**

```bash
git add src/auth/auth.module.ts
git commit -m "[M15]feat: 리프레시 토큰 provider 배선

전체 흐름 수동 검증 완료 — 로그인 시 토큰 쌍 발급, 갱신 시 회전,
소비된 토큰 재제출 시 가족 전체 폐기와 전용 에러 코드 응답."
```

---

## Task 16: 문서 갱신

**Files:**
- Modify: `README.md`

**Interfaces:**
- Consumes: 없음
- Produces: 없음

- [ ] **Step 1: README API 표 갱신**

`### Auth` 표의 `POST /auth/login` 행 기능 설명을 `로그인, JWT accessToken + refreshToken 발급`으로 바꾸고, 표 끝에 5행을 추가한다.

```markdown
| `POST /auth/refresh` | 토큰 갱신(회전). 소비된 토큰 재제출 시 세션 전체 폐기 | 공개(리프레시 토큰 보유) |
| `POST /auth/logout` | 현재 세션 폐기(멱등) | 공개(리프레시 토큰 보유) |
| `POST /auth/logout-all` | 내 모든 세션 폐기 | 인증 |
| `GET /auth/sessions` | 내 활성 세션 목록(로그인 시각·`current`) | 인증(본인) |
| `DELETE /auth/sessions/:familyId` | 특정 세션 폐기(204) | 인증 + 세션 소유자 |
```

`PATCH /auth/password` 행 기능 설명에 `+ 전체 세션 폐기`를 덧붙인다.

- [ ] **Step 2: 에러 코드 안내 갱신**

`### 에러 응답 형식`의 컨텍스트별 정의 파일 표에서 Auth 행의 대표 코드에 `AUTH_REFRESH_TOKEN_REUSED`(401)를 추가한다.

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "[M15]docs: README API 표에 리프레시 토큰 엔드포인트 반영"
```

---

## 후속 작업 (이 계획의 범위 밖)

1. **프론트엔드 연동** — `web/lib/session.ts`의 쿠키 `maxAge`를 액세스 15분·리프레시 14일로 조정하고, BFF에 갱신 호출 로직을 추가한다. `web/`은 별도 서브모듈이므로 독립 작업으로 분리한다
2. **Sentry 캡처 배선** — `AUTH_REFRESH_TOKEN_REUSED`를 `level=warning`으로 캡처한다. 현재 4xx는 Sentry로 보내지 않으므로(M10) 예외 경로를 추가해야 한다. 스펙 §12 참조
3. **만료 토큰 정리** — Outbox의 `PUBLISHED` 행 정리와 함께 다룬다
4. **rate limit 가드 우선순위 개선** — `override ?? env`를 "env가 명시되면 env 우선"으로 바꾸면 login의 하드코딩 문제도 함께 풀린다. 기존 라우트 4곳에 영향이 있어 별도 작업이 필요하다
5. **학습 노트 §6 보강** — 리프레시 토큰 전략이 §6의 "스스로 점검" 질문으로만 있고 본문 서술이 없다. 이번 구현 내용으로 채운다
