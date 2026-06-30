# 카카오 OAuth 로그인 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 카카오 계정으로 로그인/가입하고, 백엔드가 우리 JWT를 발급해 FE httpOnly 쿠키에 담는다. 신규 유저는 역할 선택 후 가입 완료.

**Architecture:** FE가 카카오 콜백을 받아 code를 BE로 보내고, BE가 카카오와 교환·프로필 조회·`Account` find-or-create. 기존 유저는 즉시 우리 JWT, 신규는 단기 onboardingToken → FE 역할선택 → BE가 User+Account 생성·JWT. 쿠키 set은 항상 FE(현 구조 유지).

**Tech Stack:** NestJS · Prisma · @nestjs/jwt · Node 24 global fetch · Jest(BE) / Next.js 16 App Router · react-hook-form · zod · Vitest(FE).

**스펙:** `docs/superpowers/specs/frontend/2026-06-30-kakao-oauth-design.md`

## Global Constraints

- BE: NestJS DDD(domain/application/infrastructure/interface). `const enum` 기존 패턴. `as any` 금지. Swagger 필수(신규 라우트 `@ApiOperation`+성공 `@ApiResponse`, 4xx `ErrorResponseDto`). RateLimit `@RateLimit({ ipMax: 10 })`. 테스트 Jest, `Partial<Repo>` fake. 커밋 `feature/fix: 내용`.
- FE: `.ts`/`.tsx`, `"use client"` 최소. 매직스트링 금지(경로 `PAGE_ROUTES`/`API_ROUTES`, 카피 `MESSAGES`, 역할 `ROLE`). 폼 rhf+zod. 토큰 클라 직접 취급 금지(쿠키 set은 Route Handler). Vitest. pnpm.
- 보안: `KAKAO_CLIENT_SECRET`는 BE 서버 전용 env. `NEXT_PUBLIC_KAKAO_CLIENT_ID`만 FE 노출(공개 가능). onboardingToken은 단기(10분)·`typ` 한정.
- find-or-create 키 = `Account(provider, providerId)`. provider 상수 `AuthProvider.KAKAO`.
- 레포: BE=`../estate-server`, FE=`estate-web`.

**Before you start:** BE는 estate-server `feature/kakao-oauth`(origin/main 기준). FE는 estate-web `feature/fe-kakao-oauth`(origin/main 기준). Task 1~3 BE, Task 4~5 FE. Postgres 실행 중이어야 마이그레이션 가능(docker `estate-server-postgres-1`).

---

### Task 1: (BE) Account 모델 + User OAuth 확장 + 마이그레이션

**레포: `../estate-server`** (branch `feature/kakao-oauth`)

**Files:**
- Modify: `prisma/schema.prisma` (User.passwordHash nullable + Account 모델) + 마이그레이션
- Modify: `src/auth/domain/user.entity.ts`
- Create: `src/auth/domain/auth-provider.ts`
- Create: `src/auth/domain/account.entity.ts`
- Create: `src/auth/domain/account.repository.ts`
- Create: `src/auth/infrastructure/prisma-account.repository.ts`
- Modify: `src/auth/infrastructure/prisma-user.repository.ts` (passwordHash null 매핑)
- Create: `src/auth/domain/account.entity.spec.ts`

**Interfaces:**
- Produces: `AuthProvider = { KAKAO: 'KAKAO' } as const`; `type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider]`
- Produces: `User.createOAuth({ email, name, role }): User` (passwordHash=null)
- Produces: `UserProps.passwordHash: string | null`, getter `passwordHash(): string | null`
- Produces: `Account` 엔티티(`create({userId, provider, providerId})`·`reconstitute`·getters id/userId/provider/providerId)
- Produces: `AccountRepository { findByProvider(provider, providerId): Promise<Account|null>; save(account): Promise<Account> }`, Symbol `ACCOUNT_REPOSITORY`

- [ ] **Step 1: Prisma 스키마 변경** — `prisma/schema.prisma`

`User` 모델: `passwordHash String` → `passwordHash String?`, 그리고 관계 추가(`comments Comment[]` 등 옆):
```prisma
  accounts Account[]
```
파일에 Account 모델 추가(User 모델 뒤):
```prisma
model Account {
  id         String   @id @default(cuid())
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  provider   String // AuthProvider 값("KAKAO")
  providerId String // 소셜 회원번호
  createdAt  DateTime @default(now())

  @@unique([provider, providerId])
  @@index([userId])
}
```

- [ ] **Step 2: 마이그레이션 생성**

Run: `cd ../estate-server && npx prisma migrate dev --name add_account_and_nullable_password`
Expected: `prisma/migrations/*_add_account_and_nullable_password/migration.sql` 생성(passwordHash DROP NOT NULL + Account 테이블), 클라이언트 재생성.

- [ ] **Step 3: AuthProvider 상수** — `src/auth/domain/auth-provider.ts`

```ts
// 소셜 로그인 제공자(닫힌 집합). find-or-create 키의 일부.
export const AuthProvider = { KAKAO: 'KAKAO' } as const;
export type AuthProvider = (typeof AuthProvider)[keyof typeof AuthProvider];
```

- [ ] **Step 4: User 엔티티 OAuth 확장** — `src/auth/domain/user.entity.ts`

`UserProps`의 `passwordHash: string`를 `passwordHash: string | null`로. `create` 아래에 추가:
```ts
  // OAuth 가입: 비밀번호 없이 생성(passwordHash=null).
  static createOAuth(input: { email: string; name: string; role: Role }): User {
    if (!input.email) throw new DomainError('이메일은 필수입니다.');
    if (!input.name) throw new DomainError('이름은 필수입니다.');
    return new User({
      id: null,
      email: input.email,
      name: input.name,
      passwordHash: null,
      role: input.role,
    });
  }
```
`get passwordHash()` 반환 타입을 `string | null`로 변경.

- [ ] **Step 5: prisma-user 레포 null 매핑** — `src/auth/infrastructure/prisma-user.repository.ts`

`save`의 `data.passwordHash: user.passwordHash`는 이제 `string | null` 허용(Prisma optional). `reconstitute` 매핑의 `passwordHash: row.passwordHash`는 그대로(타입이 `string | null`로 자동). **추가 코드 변경 없이 타입만 통과** — 컴파일 확인만. (만약 `passwordHash: user.passwordHash!` 같은 non-null 단언이 있으면 제거.)

- [ ] **Step 6: Account 엔티티 실패 테스트** — `src/auth/domain/account.entity.spec.ts`

```ts
import { Account } from './account.entity';
import { AuthProvider } from './auth-provider';

describe('Account', () => {
  it('create: provider/providerId/userId를 보관하고 id는 null', () => {
    const a = Account.create({ userId: 'u1', provider: AuthProvider.KAKAO, providerId: 'k123' });
    expect(a.userId).toBe('u1');
    expect(a.provider).toBe('KAKAO');
    expect(a.providerId).toBe('k123');
    expect(a.id).toBeNull();
  });

  it('reconstitute: 저장된 행을 복원', () => {
    const a = Account.reconstitute({ id: 'a1', userId: 'u1', provider: AuthProvider.KAKAO, providerId: 'k123' });
    expect(a.id).toBe('a1');
  });
});
```

- [ ] **Step 7: 테스트 실패 확인**

Run: `cd ../estate-server && npm test -- account.entity`
Expected: FAIL (Account 모듈 없음)

- [ ] **Step 8: Account 엔티티** — `src/auth/domain/account.entity.ts`

```ts
import { AuthProvider } from './auth-provider';

interface AccountProps {
  id: string | null;
  userId: string;
  provider: AuthProvider;
  providerId: string;
}

export class Account {
  private constructor(private readonly props: AccountProps) {}

  static create(input: { userId: string; provider: AuthProvider; providerId: string }): Account {
    return new Account({ id: null, ...input });
  }

  static reconstitute(props: AccountProps): Account {
    return new Account(props);
  }

  get id(): string | null {
    return this.props.id;
  }
  get userId(): string {
    return this.props.userId;
  }
  get provider(): AuthProvider {
    return this.props.provider;
  }
  get providerId(): string {
    return this.props.providerId;
  }
}
```

- [ ] **Step 9: AccountRepository 포트** — `src/auth/domain/account.repository.ts`

```ts
import { Account } from './account.entity';
import { AuthProvider } from './auth-provider';

export const ACCOUNT_REPOSITORY = Symbol('ACCOUNT_REPOSITORY');

export interface AccountRepository {
  findByProvider(provider: AuthProvider, providerId: string): Promise<Account | null>;
  save(account: Account): Promise<Account>;
}
```

- [ ] **Step 10: Prisma Account 레포** — `src/auth/infrastructure/prisma-account.repository.ts`

```ts
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Account } from '../domain/account.entity';
import { AccountRepository } from '../domain/account.repository';
import { AuthProvider } from '../domain/auth-provider';

@Injectable()
export class PrismaAccountRepository implements AccountRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByProvider(provider: AuthProvider, providerId: string): Promise<Account | null> {
    const row = await this.prisma.account.findUnique({
      where: { provider_providerId: { provider, providerId } },
    });
    if (!row) return null;
    return Account.reconstitute({
      id: row.id,
      userId: row.userId,
      provider: row.provider as AuthProvider,
      providerId: row.providerId,
    });
  }

  async save(account: Account): Promise<Account> {
    const row = await this.prisma.account.create({
      data: { userId: account.userId, provider: account.provider, providerId: account.providerId },
    });
    return Account.reconstitute({
      id: row.id,
      userId: row.userId,
      provider: row.provider as AuthProvider,
      providerId: row.providerId,
    });
  }
}
```
> `where: { provider_providerId: {...} }`는 `@@unique([provider, providerId])`가 만드는 복합 unique 이름. 마이그레이션 후 Prisma Client가 이 키를 생성한다.

- [ ] **Step 11: 테스트·lint·build**

Run: `cd ../estate-server && npm test -- account.entity && npm run lint:check && npm run build`
Expected: 2 PASS, lint 클린, build 성공(Prisma Client 타입 포함).

- [ ] **Step 12: 커밋**

```bash
cd ../estate-server
git add prisma/ src/auth/
git commit -m "feature: Account 모델·User OAuth 확장·마이그레이션(카카오 기반)"
```

---

### Task 2: (BE) Kakao OAuth 클라이언트 + onboarding 토큰 + 에러

**레포: `../estate-server`**

**Files:**
- Modify: `src/config/config-keys.ts` (KakaoClientId/Secret)
- Modify: `src/auth/auth.errors.ts` (3개 에러 추가)
- Create: `src/auth/infrastructure/kakao-oauth.client.ts`
- Create: `src/auth/domain/kakao-oauth.ts` (포트 인터페이스)
- Create: `src/auth/infrastructure/onboarding-token.service.ts`
- Create: `src/auth/domain/onboarding-token.ts` (포트)
- Create: `src/auth/infrastructure/onboarding-token.service.spec.ts`

**Interfaces:**
- Produces: `KakaoProfile = { providerId: string; email: string | null; name: string }`
- Produces: `KakaoOAuth` 포트 `{ exchangeAndFetch(code, redirectUri): Promise<KakaoProfile> }`, Symbol `KAKAO_OAUTH`
- Produces: `OnboardingPayload = { providerId: string; email: string; name: string }`
- Produces: `OnboardingTokenIssuer` 포트 `{ issue(p: OnboardingPayload): Promise<string>; verify(token): Promise<OnboardingPayload> }`, Symbol `ONBOARDING_TOKEN`
- Produces: `AuthError.KAKAO_EMAIL_REQUIRED`(400), `AuthError.INVALID_ONBOARDING`(401)

- [ ] **Step 1: ConfigKey 추가** — `src/config/config-keys.ts`

`SentryDsn` 위/아래(enum 내부)에 추가:
```ts
  KakaoClientId = 'KAKAO_CLIENT_ID',
  KakaoClientSecret = 'KAKAO_CLIENT_SECRET',
```

- [ ] **Step 2: 에러 코드 추가** — `src/auth/auth.errors.ts`

`AuthError` 객체에 추가(`USER_NOT_FOUND` 뒤):
```ts
  KAKAO_EMAIL_REQUIRED: {
    code: 'AUTH_KAKAO_EMAIL_REQUIRED',
    status: HttpStatus.BAD_REQUEST,
    message: '카카오 이메일 제공 동의가 필요합니다.',
  },
  INVALID_ONBOARDING: {
    code: 'AUTH_INVALID_ONBOARDING',
    status: HttpStatus.UNAUTHORIZED,
    message: '가입 세션이 만료되었어요. 다시 시도해주세요.',
  },
```

- [ ] **Step 3: KakaoOAuth 포트** — `src/auth/domain/kakao-oauth.ts`

```ts
export const KAKAO_OAUTH = Symbol('KAKAO_OAUTH');

export interface KakaoProfile {
  providerId: string;
  email: string | null;
  name: string;
}

export interface KakaoOAuth {
  // 인가 code를 access token으로 교환하고 프로필을 조회한다.
  exchangeAndFetch(code: string, redirectUri: string): Promise<KakaoProfile>;
}
```

- [ ] **Step 4: KakaoOAuthClient 구현** — `src/auth/infrastructure/kakao-oauth.client.ts`

```ts
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ConfigKey } from '../../config/config-keys';
import { KakaoOAuth, KakaoProfile } from '../domain/kakao-oauth';

const TOKEN_URL = 'https://kauth.kakao.com/oauth/token';
const PROFILE_URL = 'https://kapi.kakao.com/v2/user/me';

@Injectable()
export class KakaoOAuthClient implements KakaoOAuth {
  constructor(private readonly config: ConfigService) {}

  async exchangeAndFetch(code: string, redirectUri: string): Promise<KakaoProfile> {
    const clientId = this.config.getOrThrow<string>(ConfigKey.KakaoClientId);
    const clientSecret = this.config.getOrThrow<string>(ConfigKey.KakaoClientSecret);

    const tokenRes = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        code,
      }),
    });
    if (!tokenRes.ok) throw new Error(`카카오 토큰 교환 실패: ${tokenRes.status}`);
    const token = (await tokenRes.json()) as { access_token: string };

    const profRes = await fetch(PROFILE_URL, {
      headers: { Authorization: `Bearer ${token.access_token}` },
    });
    if (!profRes.ok) throw new Error(`카카오 프로필 조회 실패: ${profRes.status}`);
    const p = (await profRes.json()) as {
      id: number;
      kakao_account?: { email?: string; profile?: { nickname?: string } };
    };

    return {
      providerId: String(p.id),
      email: p.kakao_account?.email ?? null,
      name: p.kakao_account?.profile?.nickname ?? '카카오사용자',
    };
  }
}
```

- [ ] **Step 5: OnboardingToken 포트** — `src/auth/domain/onboarding-token.ts`

```ts
export const ONBOARDING_TOKEN = Symbol('ONBOARDING_TOKEN');

export interface OnboardingPayload {
  providerId: string;
  email: string;
  name: string;
}

export interface OnboardingTokenIssuer {
  issue(payload: OnboardingPayload): Promise<string>;
  verify(token: string): Promise<OnboardingPayload>; // 실패 시 throw
}
```

- [ ] **Step 6: onboarding 토큰 실패 테스트** — `src/auth/infrastructure/onboarding-token.service.spec.ts`

```ts
import { JwtService } from '@nestjs/jwt';
import { OnboardingTokenService } from './onboarding-token.service';

const jwt = new JwtService({ secret: 'test-secret' });
const svc = new OnboardingTokenService(jwt);

describe('OnboardingTokenService', () => {
  it('issue→verify 왕복으로 payload 복원', async () => {
    const token = await svc.issue({ providerId: 'k1', email: 'a@b.com', name: '홍길동' });
    const p = await svc.verify(token);
    expect(p).toEqual({ providerId: 'k1', email: 'a@b.com', name: '홍길동' });
  });

  it('일반 access token(typ 없음)은 verify에서 거부', async () => {
    const wrong = await jwt.signAsync({ sub: 'u1', email: 'a@b.com' });
    await expect(svc.verify(wrong)).rejects.toBeDefined();
  });
});
```

- [ ] **Step 7: 테스트 실패 확인**

Run: `cd ../estate-server && npm test -- onboarding-token`
Expected: FAIL (서비스 없음)

- [ ] **Step 8: OnboardingTokenService** — `src/auth/infrastructure/onboarding-token.service.ts`

```ts
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { OnboardingPayload, OnboardingTokenIssuer } from '../domain/onboarding-token';

const TYP = 'kakao_onboarding';

@Injectable()
export class OnboardingTokenService implements OnboardingTokenIssuer {
  constructor(private readonly jwt: JwtService) {}

  issue(payload: OnboardingPayload): Promise<string> {
    return this.jwt.signAsync({ ...payload, typ: TYP }, { expiresIn: '10m' });
  }

  async verify(token: string): Promise<OnboardingPayload> {
    const decoded = await this.jwt.verifyAsync<OnboardingPayload & { typ?: string }>(token);
    if (decoded.typ !== TYP) throw new Error('onboarding 토큰이 아님');
    return { providerId: decoded.providerId, email: decoded.email, name: decoded.name };
  }
}
```

- [ ] **Step 9: 테스트·lint·build**

Run: `cd ../estate-server && npm test -- onboarding-token && npm run lint:check && npm run build`
Expected: 2 PASS, lint 클린, build 성공.

- [ ] **Step 10: 커밋**

```bash
cd ../estate-server
git add src/config/ src/auth/
git commit -m "feature: 카카오 OAuth 클라이언트·onboarding 토큰·에러코드 추가"
```

---

### Task 3: (BE) Kakao 로그인/가입완료 유스케이스 + 라우트

**레포: `../estate-server`**

**Files:**
- Create: `src/auth/application/kakao-login.use-case.ts`
- Create: `src/auth/application/complete-kakao-signup.use-case.ts`
- Create: `src/auth/application/kakao.use-cases.spec.ts`
- Create: `src/auth/interface/dto/kakao.dto.ts`
- Modify: `src/auth/interface/auth.controller.ts`
- Modify: `src/auth/auth.module.ts`

**Interfaces:**
- Consumes: `AccountRepository`(Task 1), `User.createOAuth`(Task 1), `KakaoOAuth`/`KakaoProfile`(Task 2), `OnboardingTokenIssuer`(Task 2), `UserRepository`(기존 `save`·`findByEmail`), `TokenIssuer`(기존), `AuthError.*`.
- Produces (REST): `POST /auth/kakao {code, redirectUri}` → `{ accessToken } | { onboardingToken }`; `POST /auth/kakao/complete {onboardingToken, role}` → `{ accessToken }`.

- [ ] **Step 1: 유스케이스 실패 테스트** — `src/auth/application/kakao.use-cases.spec.ts`

```ts
import { KakaoLoginUseCase } from './kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from './complete-kakao-signup.use-case';
import { AccountRepository } from '../domain/account.repository';
import { UserRepository } from '../domain/user.repository';
import { KakaoOAuth } from '../domain/kakao-oauth';
import { OnboardingTokenIssuer } from '../domain/onboarding-token';
import { TokenIssuer } from '../domain/token-issuer';
import { Account } from '../domain/account.entity';
import { User } from '../domain/user.entity';
import { AuthProvider } from '../domain/auth-provider';
import { Role } from '../domain/role.enum';

const tokenIssuer: TokenIssuer = { issue: () => Promise.resolve('ACCESS') };
const onboarding: OnboardingTokenIssuer = {
  issue: () => Promise.resolve('ONBOARD'),
  verify: () => Promise.resolve({ providerId: 'k1', email: 'a@b.com', name: '홍' }),
};

describe('KakaoLoginUseCase', () => {
  const kakao = (email: string | null): KakaoOAuth => ({
    exchangeAndFetch: () => Promise.resolve({ providerId: 'k1', email, name: '홍' }),
  });

  it('기존 Account면 accessToken 반환', async () => {
    const accounts: Partial<AccountRepository> = {
      findByProvider: () =>
        Promise.resolve(Account.reconstitute({ id: 'a1', userId: 'u1', provider: AuthProvider.KAKAO, providerId: 'k1' })),
    };
    const users: Partial<UserRepository> = {
      findById: () => Promise.resolve(User.reconstitute({ id: 'u1', email: 'a@b.com', name: '홍', passwordHash: null, role: Role.TENANT })),
    };
    const uc = new KakaoLoginUseCase(kakao('a@b.com'), accounts as AccountRepository, users as UserRepository, onboarding, tokenIssuer);
    const r = await uc.execute({ code: 'c', redirectUri: 'r' });
    expect(r).toEqual({ accessToken: 'ACCESS' });
  });

  it('신규면 onboardingToken 반환', async () => {
    const accounts: Partial<AccountRepository> = { findByProvider: () => Promise.resolve(null) };
    const uc = new KakaoLoginUseCase(kakao('a@b.com'), accounts as AccountRepository, {} as UserRepository, onboarding, tokenIssuer);
    const r = await uc.execute({ code: 'c', redirectUri: 'r' });
    expect(r).toEqual({ onboardingToken: 'ONBOARD' });
  });

  it('이메일 없으면 KAKAO_EMAIL_REQUIRED', async () => {
    const accounts: Partial<AccountRepository> = { findByProvider: () => Promise.resolve(null) };
    const uc = new KakaoLoginUseCase(kakao(null), accounts as AccountRepository, {} as UserRepository, onboarding, tokenIssuer);
    await expect(uc.execute({ code: 'c', redirectUri: 'r' })).rejects.toMatchObject({ code: 'AUTH_KAKAO_EMAIL_REQUIRED' });
  });
});

describe('CompleteKakaoSignupUseCase', () => {
  it('정상: User+Account 생성 후 accessToken', async () => {
    const savedAccounts: string[] = [];
    const accounts: Partial<AccountRepository> = {
      findByProvider: () => Promise.resolve(null),
      save: (a) => { savedAccounts.push(a.providerId); return Promise.resolve(Account.reconstitute({ id: 'a1', userId: 'u1', provider: AuthProvider.KAKAO, providerId: a.providerId })); },
    };
    const users: Partial<UserRepository> = {
      save: (u) => Promise.resolve(User.reconstitute({ id: 'u1', email: u.email, name: u.name, passwordHash: null, role: u.role })),
    };
    const uc = new CompleteKakaoSignupUseCase(onboarding, accounts as AccountRepository, users as UserRepository, tokenIssuer);
    const r = await uc.execute({ onboardingToken: 'ONBOARD', role: Role.OWNER });
    expect(r).toEqual({ accessToken: 'ACCESS' });
    expect(savedAccounts).toEqual(['k1']);
  });

  it('잘못된 role이면 INVALID_ROLE', async () => {
    const uc = new CompleteKakaoSignupUseCase(onboarding, {} as AccountRepository, {} as UserRepository, tokenIssuer);
    await expect(uc.execute({ onboardingToken: 'ONBOARD', role: 'ADMIN' as Role })).rejects.toMatchObject({ code: 'AUTH_INVALID_ROLE' });
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `cd ../estate-server && npm test -- kakao.use-cases`
Expected: FAIL (use-case 없음)

- [ ] **Step 3: KakaoLoginUseCase** — `src/auth/application/kakao-login.use-case.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { AuthProvider } from '../domain/auth-provider';
import { ACCOUNT_REPOSITORY, AccountRepository } from '../domain/account.repository';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { KAKAO_OAUTH, KakaoOAuth } from '../domain/kakao-oauth';
import { ONBOARDING_TOKEN, OnboardingTokenIssuer } from '../domain/onboarding-token';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

export type KakaoLoginResult = { accessToken: string } | { onboardingToken: string };

@Injectable()
export class KakaoLoginUseCase {
  constructor(
    @Inject(KAKAO_OAUTH) private readonly kakao: KakaoOAuth,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(ONBOARDING_TOKEN) private readonly onboarding: OnboardingTokenIssuer,
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(input: { code: string; redirectUri: string }): Promise<KakaoLoginResult> {
    const profile = await this.kakao.exchangeAndFetch(input.code, input.redirectUri);
    if (!profile.email) throw new AppException(AuthError.KAKAO_EMAIL_REQUIRED);

    const account = await this.accounts.findByProvider(AuthProvider.KAKAO, profile.providerId);
    if (account) {
      const user = await this.users.findById(account.userId);
      if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
      const accessToken = await this.tokenIssuer.issue({ sub: user.id!, email: user.email, role: user.role });
      return { accessToken };
    }

    const onboardingToken = await this.onboarding.issue({
      providerId: profile.providerId,
      email: profile.email,
      name: profile.name,
    });
    return { onboardingToken };
  }
}
```

- [ ] **Step 4: CompleteKakaoSignupUseCase** — `src/auth/application/complete-kakao-signup.use-case.ts`

```ts
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AppException } from '../../common/errors/app-exception';
import { AuthError } from '../auth.errors';
import { Role } from '../domain/role.enum';
import { AuthProvider } from '../domain/auth-provider';
import { Account } from '../domain/account.entity';
import { User } from '../domain/user.entity';
import { ACCOUNT_REPOSITORY, AccountRepository } from '../domain/account.repository';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { ONBOARDING_TOKEN, OnboardingTokenIssuer } from '../domain/onboarding-token';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

const ALLOWED: Role[] = [Role.OWNER, Role.TENANT];

@Injectable()
export class CompleteKakaoSignupUseCase {
  constructor(
    @Inject(ONBOARDING_TOKEN) private readonly onboarding: OnboardingTokenIssuer,
    @Inject(ACCOUNT_REPOSITORY) private readonly accounts: AccountRepository,
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(input: { onboardingToken: string; role: Role }): Promise<{ accessToken: string }> {
    if (!ALLOWED.includes(input.role)) throw new AppException(AuthError.INVALID_ROLE);

    let payload;
    try {
      payload = await this.onboarding.verify(input.onboardingToken);
    } catch {
      throw new AppException(AuthError.INVALID_ONBOARDING);
    }

    // 멱등: 이미 연결된 Account면 그 User로 발급.
    const existing = await this.accounts.findByProvider(AuthProvider.KAKAO, payload.providerId);
    if (existing) {
      const user = await this.users.findById(existing.userId);
      if (!user) throw new AppException(AuthError.USER_NOT_FOUND);
      return { accessToken: await this.tokenIssuer.issue({ sub: user.id!, email: user.email, role: user.role }) };
    }

    let user: User;
    try {
      user = await this.users.save(User.createOAuth({ email: payload.email, name: payload.name, role: input.role }));
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
        throw new AppException(AuthError.EMAIL_IN_USE);
      }
      throw e;
    }
    await this.accounts.save(Account.create({ userId: user.id!, provider: AuthProvider.KAKAO, providerId: payload.providerId }));
    return { accessToken: await this.tokenIssuer.issue({ sub: user.id!, email: user.email, role: user.role }) };
  }
}
```
> `UserRepository.findById`는 M6에서 추가됨(있음). `save`는 create 전용(기존). 신규 OAuth 유저 생성에 `save` 사용.

- [ ] **Step 5: DTO** — `src/auth/interface/dto/kakao.dto.ts`

```ts
import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsString, IsNotEmpty } from 'class-validator';
import { Role } from '../../domain/role.enum';

export class KakaoLoginDto {
  @ApiProperty() @IsString() @IsNotEmpty() code: string;
  @ApiProperty() @IsString() @IsNotEmpty() redirectUri: string;
}

export class CompleteKakaoDto {
  @ApiProperty() @IsString() @IsNotEmpty() onboardingToken: string;
  @ApiProperty({ enum: Role, enumName: 'Role' })
  @IsIn([Role.OWNER, Role.TENANT])
  role: Role;
}
```

- [ ] **Step 6: 컨트롤러 라우트** — `src/auth/interface/auth.controller.ts`

import 추가:
```ts
import { KakaoLoginUseCase } from '../application/kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from '../application/complete-kakao-signup.use-case';
import { KakaoLoginDto, CompleteKakaoDto } from './dto/kakao.dto';
```
생성자에 주입: `private readonly kakaoLogin: KakaoLoginUseCase,` `private readonly completeKakao: CompleteKakaoSignupUseCase,`
`login` 라우트 아래에 추가:
```ts
  @Post('kakao')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({ summary: '카카오 로그인(code 교환) — 기존 유저는 accessToken, 신규는 onboardingToken' })
  @ApiResponse({ status: 201, description: '{accessToken} 또는 {onboardingToken}' })
  @ApiResponse({ status: 400, type: ErrorResponseDto, description: '이메일 동의 필요 등' })
  kakaoLoginHandler(@Body() dto: KakaoLoginDto) {
    return this.kakaoLogin.execute(dto);
  }

  @Post('kakao/complete')
  @RateLimit({ ipMax: 10 })
  @ApiOperation({ summary: '카카오 신규 가입 완료(역할 선택)' })
  @ApiResponse({ status: 201, description: 'accessToken 반환' })
  @ApiResponse({ status: 401, type: ErrorResponseDto, description: 'onboarding 토큰 무효/만료' })
  @ApiResponse({ status: 409, type: ErrorResponseDto, description: '이메일 중복' })
  completeKakaoHandler(@Body() dto: CompleteKakaoDto) {
    return this.completeKakao.execute(dto);
  }
```

- [ ] **Step 7: 모듈 등록** — `src/auth/auth.module.ts`

import 후 providers 배열에 추가:
```ts
import { KakaoLoginUseCase } from './application/kakao-login.use-case';
import { CompleteKakaoSignupUseCase } from './application/complete-kakao-signup.use-case';
import { ACCOUNT_REPOSITORY } from './domain/account.repository';
import { KAKAO_OAUTH } from './domain/kakao-oauth';
import { ONBOARDING_TOKEN } from './domain/onboarding-token';
import { PrismaAccountRepository } from './infrastructure/prisma-account.repository';
import { KakaoOAuthClient } from './infrastructure/kakao-oauth.client';
import { OnboardingTokenService } from './infrastructure/onboarding-token.service';
```
providers에:
```ts
    KakaoLoginUseCase,
    CompleteKakaoSignupUseCase,
    { provide: ACCOUNT_REPOSITORY, useClass: PrismaAccountRepository },
    { provide: KAKAO_OAUTH, useClass: KakaoOAuthClient },
    { provide: ONBOARDING_TOKEN, useClass: OnboardingTokenService },
```

- [ ] **Step 8: 테스트·lint·build**

Run: `cd ../estate-server && npm test -- kakao.use-cases && npm run lint:check && npm run build`
Expected: 5 PASS, lint 클린, build 성공.

- [ ] **Step 9: 전체 스위트 회귀 확인 (M5 교훈: 인터페이스 변경 영향)**

Run: `cd ../estate-server && npm test 2>&1 | grep -E "Test Suites:|Tests:|FAIL "`
Expected: 전체 PASS. (User.passwordHash null화·UserRepository 변경이 기존 login/signup/profile 스펙을 깨지 않는지 확인. 깨지면 해당 스펙 fake 보강.)

- [ ] **Step 10: 커밋**

```bash
cd ../estate-server
git add src/auth/
git commit -m "feature: 카카오 로그인·가입완료 유스케이스·라우트(POST /auth/kakao·/complete)"
```

---

### Task 4: (FE) 카카오 버튼 + Route Handlers + 상수/메시지

**레포: `estate-web`** (branch `feature/fe-kakao-oauth`, origin/main 기준)

**Files:**
- Modify: `lib/constants.ts`
- Modify: `lib/messages.ts`
- Create: `lib/api/kakao.ts`
- Modify: `lib/api/index.ts`
- Create: `app/api/auth/kakao/route.ts`
- Create: `app/api/auth/kakao/complete/route.ts`
- Modify: `app/login/page.tsx` (카카오 버튼)
- Test: `lib/kakao-api.test.ts`

**Interfaces:**
- Produces: `PAGE_ROUTES.kakaoCallback="/auth/kakao/callback"`, `PAGE_ROUTES.roleSelect="/signup/role-select"`; `API_ROUTES.kakao="/api/auth/kakao"`, `API_ROUTES.kakaoComplete="/api/auth/kakao/complete"`; `KAKAO_AUTHORIZE_URL` 빌더.
- Produces: `backendKakaoLogin(code, redirectUri)`, `backendKakaoComplete(onboardingToken, role)` (서버 전용, Route Handler에서 호출).
- Produces: `MESSAGES.auth.kakao*`.

- [ ] **Step 1: 상수** — `lib/constants.ts`

`API_ROUTES`에 추가:
```ts
  kakao: "/api/auth/kakao",
  kakaoComplete: "/api/auth/kakao/complete",
```
`PAGE_ROUTES`에 추가:
```ts
  kakaoCallback: "/auth/kakao/callback",
  roleSelect: "/signup/role-select",
```
파일에 카카오 authorize URL 빌더 추가(공개 client id 사용):
```ts
/** 카카오 OAuth authorize URL. client id는 공개 가능(redirect용). */
export const KAKAO_CLIENT_ID = process.env.NEXT_PUBLIC_KAKAO_CLIENT_ID ?? "";
export function kakaoAuthorizeUrl(redirectUri: string, state: string): string {
  const q = new URLSearchParams({
    client_id: KAKAO_CLIENT_ID,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "account_email",
    state,
  });
  return `https://kauth.kakao.com/oauth/authorize?${q.toString()}`;
}
```

- [ ] **Step 2: 메시지** — `lib/messages.ts`

`MESSAGES.auth`에 키 추가:
```ts
    kakaoLogin: "카카오로 로그인",
    kakaoFailed: "카카오 로그인에 실패했어요. 잠시 후 다시 시도해주세요.",
    kakaoEmailRequired: "카카오 이메일 제공 동의가 필요합니다.",
```

- [ ] **Step 3: kakao API 모듈** — `lib/api/kakao.ts`

```ts
import { call } from "./client";
import { MESSAGES } from "../messages";
import type { SignupRole } from "../constants";

export type KakaoLoginResult = { accessToken?: string; onboardingToken?: string };

export const backendKakaoLogin = (code: string, redirectUri: string) =>
  call<KakaoLoginResult>("/auth/kakao", {
    method: "POST",
    body: JSON.stringify({ code, redirectUri }),
  }, { 400: MESSAGES.auth.kakaoEmailRequired });

export const backendKakaoComplete = (onboardingToken: string, role: SignupRole) =>
  call<{ accessToken: string }>("/auth/kakao/complete", {
    method: "POST",
    body: JSON.stringify({ onboardingToken, role }),
  }, { 409: MESSAGES.auth.emailInUse });
```
`lib/api/index.ts`에 `export * from "./kakao";` 추가.

- [ ] **Step 4: 실패 테스트** — `lib/kakao-api.test.ts`

```ts
import { vi } from "vitest";
import { backendKakaoLogin, backendKakaoComplete } from "@/lib/api";

afterEach(() => vi.unstubAllGlobals());

it("backendKakaoLogin: POST /auth/kakao body", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ onboardingToken: "o" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendKakaoLogin("c", "r");
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/kakao$/);
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ code: "c", redirectUri: "r" });
});

it("backendKakaoComplete: POST /auth/kakao/complete body", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ accessToken: "a" }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  await backendKakaoComplete("o", "OWNER");
  expect(String(fetchMock.mock.calls[0][0])).toMatch(/\/auth\/kakao\/complete$/);
  expect(JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body))).toEqual({ onboardingToken: "o", role: "OWNER" });
});
```

- [ ] **Step 5: RED 확인**

Run: `pnpm test -- kakao-api`
Expected: FAIL (export 없음)

- [ ] **Step 6: 로그인 code 교환 Route Handler** — `app/api/auth/kakao/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { backendKakaoLogin, ApiError } from "@/lib/api";
import { setSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const { code, redirectUri } = await req.json();
    const result = await backendKakaoLogin(code, redirectUri);
    if (result.accessToken) {
      await setSession(result.accessToken);
      return NextResponse.json({ next: "dashboard" });
    }
    return NextResponse.json({ next: "role-select", onboardingToken: result.onboardingToken });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```

- [ ] **Step 7: 가입완료 Route Handler** — `app/api/auth/kakao/complete/route.ts`

```ts
import { NextRequest, NextResponse } from "next/server";
import { backendKakaoComplete, ApiError } from "@/lib/api";
import { setSession } from "@/lib/session";

export async function POST(req: NextRequest) {
  try {
    const { onboardingToken, role } = await req.json();
    const { accessToken } = await backendKakaoComplete(onboardingToken, role);
    await setSession(accessToken);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const err = e as ApiError;
    return NextResponse.json({ message: err.message, status: err.status }, { status: err.status ?? 500 });
  }
}
```

- [ ] **Step 8: 로그인 페이지 카카오 버튼** — `app/login/page.tsx`

import에 추가: `import { kakaoAuthorizeUrl, PAGE_ROUTES } from "@/lib/constants";`
컴포넌트 안에 카카오 로그인 핸들러 + 버튼 추가(폼 아래). state는 난수, 세션스토리지에 저장:
```tsx
  function loginWithKakao() {
    const state = crypto.randomUUID();
    sessionStorage.setItem("kakao_state", state);
    const redirectUri = `${window.location.origin}${PAGE_ROUTES.kakaoCallback}`;
    window.location.href = kakaoAuthorizeUrl(redirectUri, state);
  }
```
폼 하단(닫는 `</form>` 뒤)에:
```tsx
      <button
        type="button"
        onClick={loginWithKakao}
        className="mt-3 h-[50px] w-full rounded-[14px] bg-[#FEE500] font-bold text-[15px] text-[#191600] grid place-items-center"
      >
        {MESSAGES.auth.kakaoLogin}
      </button>
```

- [ ] **Step 9: 테스트·빌드·lint**

Run: `pnpm test -- kakao-api && pnpm build && pnpm lint`
Expected: 2 PASS, 빌드 성공(`/api/auth/kakao*` 라우트 포함), lint 클린.

- [ ] **Step 10: 커밋**

```bash
git add lib/constants.ts lib/messages.ts lib/api/kakao.ts lib/api/index.ts app/api/auth/kakao app/login/page.tsx lib/kakao-api.test.ts
git commit -m "feature: 카카오 로그인 버튼·Route Handler·API 모듈 추가"
```

---

### Task 5: (FE) 콜백 페이지 + 역할 선택 페이지

**레포: `estate-web`**

**Files:**
- Create: `app/auth/kakao/callback/page.tsx`
- Create: `app/signup/role-select/page.tsx`
- Create: `components/auth/role-select-form.tsx`
- Test: `components/auth/role-select-form.test.tsx`

**Interfaces:**
- Consumes: `API_ROUTES.kakao`/`kakaoComplete`, `PAGE_ROUTES.roleSelect`/`dashboard`/`login`, `ROLE`, `MESSAGES`.
- Produces: 라우트 `/auth/kakao/callback`, `/signup/role-select`.

- [ ] **Step 1: 콜백 페이지** — `app/auth/kakao/callback/page.tsx`

```tsx
"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { API_ROUTES, PAGE_ROUTES } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export default function KakaoCallbackPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [error, setError] = useState<string | null>(null);
  const ran = useRef(false);

  useEffect(() => {
    if (ran.current) return;
    ran.current = true;
    const code = params.get("code");
    const state = params.get("state");
    const saved = sessionStorage.getItem("kakao_state");
    if (!code || !state || state !== saved) {
      setError(MESSAGES.auth.kakaoFailed);
      return;
    }
    sessionStorage.removeItem("kakao_state");
    const redirectUri = `${window.location.origin}${PAGE_ROUTES.kakaoCallback}`;
    fetch(API_ROUTES.kakao, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, redirectUri }),
    })
      .then(async (res) => {
        const json = await res.json();
        if (!res.ok) {
          setError(json.message ?? MESSAGES.auth.kakaoFailed);
          return;
        }
        if (json.next === "dashboard") {
          router.replace(PAGE_ROUTES.dashboard);
        } else {
          sessionStorage.setItem("kakao_onboarding", json.onboardingToken);
          router.replace(PAGE_ROUTES.roleSelect);
        }
      })
      .catch(() => setError(MESSAGES.auth.kakaoFailed));
  }, [params, router]);

  return (
    <main className="flex-1 grid place-items-center px-6">
      {error ? (
        <p className="text-[14px] text-danger">{error}</p>
      ) : (
        <p className="text-[14px] text-text-3">로그인 처리 중…</p>
      )}
    </main>
  );
}
```
> `useEffect` deps는 `[params, router]` — `params`는 안정적 객체(원시값 추출은 내부). `ran` ref로 StrictMode 중복 실행 방지.

- [ ] **Step 2: 역할 선택 폼 실패 테스트** — `components/auth/role-select-form.test.tsx`

```tsx
import { vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const replace = vi.fn();
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace }) }));

import { RoleSelectForm } from "@/components/auth/role-select-form";

beforeEach(() => {
  replace.mockReset();
  sessionStorage.setItem("kakao_onboarding", "tok");
});
afterEach(() => vi.unstubAllGlobals());

it("역할 선택 성공 시 대시보드로 이동", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })));
  render(<RoleSelectForm />);
  fireEvent.click(screen.getByText("건물주"));
  await waitFor(() => expect(replace).toHaveBeenCalledWith("/dashboard"));
});

it("실패 시 에러 메시지 표시", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ message: "가입 세션이 만료되었어요. 다시 시도해주세요." }), { status: 401 })));
  render(<RoleSelectForm />);
  fireEvent.click(screen.getByText("입주자"));
  await waitFor(() => expect(screen.getByText("가입 세션이 만료되었어요. 다시 시도해주세요.")).toBeInTheDocument());
});
```

- [ ] **Step 3: RED 확인**

Run: `pnpm test -- role-select-form`
Expected: FAIL (컴포넌트 없음)

- [ ] **Step 4: 역할 선택 폼** — `components/auth/role-select-form.tsx`

```tsx
"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { API_ROUTES, PAGE_ROUTES, ROLE, type SignupRole } from "@/lib/constants";
import { MESSAGES } from "@/lib/messages";

export function RoleSelectForm() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<SignupRole | null>(null);

  async function pick(role: SignupRole) {
    setError(null);
    setPending(role);
    const onboardingToken = sessionStorage.getItem("kakao_onboarding");
    if (!onboardingToken) {
      setError(MESSAGES.auth.kakaoFailed);
      setPending(null);
      return;
    }
    const res = await fetch(API_ROUTES.kakaoComplete, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ onboardingToken, role }),
    });
    if (res.ok) {
      sessionStorage.removeItem("kakao_onboarding");
      router.replace(PAGE_ROUTES.dashboard);
    } else {
      const json = await res.json().catch(() => ({}));
      setError(json.message ?? MESSAGES.auth.kakaoFailed);
      setPending(null);
    }
  }

  return (
    <div className="w-full max-w-sm">
      <h1 className="mb-6 text-[24px] font-extrabold tracking-tight text-text">역할 선택</h1>
      <div className="flex flex-col gap-3">
        <Button onClick={() => pick(ROLE.OWNER)} disabled={pending !== null}>건물주</Button>
        <Button variant="secondary" onClick={() => pick(ROLE.TENANT)} disabled={pending !== null}>입주자</Button>
      </div>
      {error && <p className="mt-3 text-[13px] text-danger">{error}</p>}
    </div>
  );
}
```

- [ ] **Step 5: 역할 선택 페이지** — `app/signup/role-select/page.tsx`

```tsx
import { RoleSelectForm } from "@/components/auth/role-select-form";

export default function RoleSelectPage() {
  return (
    <main className="flex-1 grid place-items-center px-6">
      <RoleSelectForm />
    </main>
  );
}
```

- [ ] **Step 6: 테스트·빌드·lint**

Run: `pnpm test -- role-select-form && pnpm test && pnpm build && pnpm lint`
Expected: role-select 2 PASS, 전체 PASS, 빌드 성공(`/auth/kakao/callback`·`/signup/role-select` 라우트), lint 클린.

- [ ] **Step 7: 커밋**

```bash
git add app/auth/kakao components/auth "app/signup/role-select"
git commit -m "feature: 카카오 콜백·역할 선택 화면"
```

---

## 마무리 (계획 외 후속)

- BE PR(estate-server `feature/kakao-oauth`)·FE PR(estate-web `feature/fe-kakao-oauth`). 본문에 스펙·플랜 첨부. **BE 먼저(또는 함께) 머지**.
- **사용자 수동 작업**: 카카오 개발자 콘솔 앱 등록(REST API 키·secret·redirect URI·이메일 동의항목) + env(BE `KAKAO_CLIENT_ID`/`KAKAO_CLIENT_SECRET`, FE `NEXT_PUBLIC_KAKAO_CLIENT_ID`). 설정 가이드 문서 별도 작성 권장.
- README 마일스톤/후속 표 F1(소셜 로그인) 갱신.
- 머지 후 web 서브모듈 포인터는 자동 갱신 워크플로가 처리.

## Self-Review 결과

- **스펙 커버리지:** §3 모델→Task 1 / §5.1 인프라(client·token·account)→Task 1·2 / §5.2 use-case→Task 3 / §5.3 라우트·에러·env→Task 2·3 / §6.1 페이지→Task 5 / §6.2 핸들러→Task 4 / §6.3 상수·메시지→Task 4 / §4 엣지(이메일 없음·충돌·onboarding·멱등)→Task 3 use-case + 테스트 / §5.4·§6.4 테스트→각 Task. 모두 매핑.
- **플레이스홀더:** 없음(전 step 코드/명령 포함).
- **타입 일관성:** `AuthProvider`(Task 1)→2·3 사용. `Account`/`AccountRepository`(Task 1)→3. `KakaoProfile`/`KakaoOAuth`(Task 2)→3. `OnboardingPayload`/`OnboardingTokenIssuer`(Task 2)→3. `User.createOAuth`(Task 1)→3. `KakaoLoginResult`(`{accessToken}|{onboardingToken}`) BE Task 3 = FE Task 4 `KakaoLoginResult`(accessToken?·onboardingToken?) 형태 일치. `backendKakaoLogin/Complete`(Task 4)→Route Handler 사용. `PAGE_ROUTES.kakaoCallback/roleSelect`·`API_ROUTES.kakao/kakaoComplete`(Task 4)→Task 5 사용.
- **주의(구현자):** Task 3 Step 9 전체 스위트 회귀 필수(User.passwordHash null화가 기존 auth 스펙에 영향 가능 — M5/M6에서 반복된 패턴). `UserRepository.findById`는 M6에서 추가됨(존재 가정 — 없으면 Task 1에 추가).
