# M0 — 프로젝트 기반 + JWT 인증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** docker-compose(Postgres·Redis·Kafka) 인프라와 Prisma 초기 스키마를 띄우고, DDD 레이어드 구조를 따르는 Auth 컨텍스트로 회원가입/로그인(JWT) 흐름을 동작시킨다.

**Architecture:** DDD 레이어드(interface → application → domain → infrastructure) 단방향 의존. 도메인은 `UserRepository`·`PasswordHasher`·`TokenIssuer` **인터페이스만** 알고, Prisma·bcrypt·JWT 구현은 infrastructure에 두고 DI로 주입한다(의존성 역전). 단일 NestJS 앱.

**Tech Stack:** NestJS 11, TypeScript, Prisma + PostgreSQL, @nestjs/jwt + passport-jwt, bcrypt, class-validator, Jest.

---

## 📍 전체 로드맵 (M0~M6 + 추후 F1·F2)

> 이 문서는 **M0**만 bite-sized로 상세화한다. M1~M6은 각 마일스톤 착수 시점에 같은 형식의 별도 plan(`docs/superpowers/plans/`)으로 작성한다. 아래는 그 청사진이다.

### 바운디드 컨텍스트 ↔ 디렉터리 매핑 (최종 형태)

```
src/
  prisma/                  공유 인프라: PrismaService·PrismaModule
  redis/                   공유 인프라: RedisModule (M1~)
  kafka/                   공유 인프라: KafkaModule producer (M3~)
  auth/                User, 인증, RBAC           [M0]
  property/                Building·Unit·Lease·InviteCode [M1]
  board/                   Post·Comment                [M2]
  chat/                    ChatRoom·Message            [M4]
  notification/            Notification                [M5]
  audit/                   AuditLog                    [M3]
각 컨텍스트 내부: interface/ · application/ · domain/ · infrastructure/
```

### 마일스톤 의존 순서

| 단계 | 산출물 | 선행 | 핵심 학습 |
|---|---|---|---|
| **M0** | 인프라 + Prisma + JWT 인증 (Auth) | — | Prisma 기초·마이그레이션, DDD 레이어 |
| **M1** | Property(건물/호실/입주) + 초대코드(Redis TTL) | M0 | Prisma 관계, Redis TTL, RolesGuard |
| **M2** | 게시판 CRUD + Redis read-through 캐시 | M1 | 캐시 무효화 패턴 |
| **M3** | Kafka 도입 + audit-worker(전체 이벤트 적재) | M2 | producer/consumer 첫걸음, 멱등 소비 |
| **M4** | 1:1 채팅 WS + Redis pub/sub + persistence-worker | M3 | WS+Redis+Kafka 통합, 파티션 키 |
| **M5** | notification-worker + WS 푸시 + 미읽음 카운트 | M4 | 다중 컨슈머 팬아웃 |
| **M6** | rate limit(userId+IP) · 보안 점검 · (선택)Outbox | M5 | 운영·보안 |
| **F1** *(추후)* | OAuth 소셜 로그인 (`AuthProvider` 매핑) | M6 | 외부 인증 연동 |
| **F2** *(추후)* | 채팅 메시지 자동 번역 (번역 어댑터) | M4·M6 | 외부 API 어댑터·i18n |

> 원칙(스펙 5.3): **레이어 두께를 컨텍스트 복잡도에 비례**시킨다. Board(M2)처럼 규칙 없는 CRUD는 application이 리포지토리를 직접 호출하는 얇은 레이어, Chat·Property처럼 불변식이 있는 컨텍스트는 도메인 레이어를 두텁게.

---

## M0 파일 구조

```
docker-compose.yml                                  Create  PG·Redis·Kafka(cp-kafka, KRaft)
.env.example / .env                                 Create  접속정보·JWT 시크릿
prisma/schema.prisma                                Create  User 모델 + Role enum
src/prisma/prisma.service.ts                        Create  PrismaClient 생명주기
src/prisma/prisma.module.ts                         Create  전역 PrismaModule
src/auth/domain/role.enum.ts                    Create  OWNER|TENANT|ADMIN
src/auth/domain/user.entity.ts                  Create  User 도메인 엔티티
src/auth/domain/user.repository.ts              Create  인터페이스 + DI 토큰
src/auth/domain/password-hasher.ts              Create  인터페이스 + DI 토큰
src/auth/domain/token-issuer.ts                 Create  인터페이스 + DI 토큰
src/auth/infrastructure/bcrypt-password-hasher.ts   Create  bcrypt 구현
src/auth/infrastructure/prisma-user.repository.ts   Create  Prisma 구현
src/auth/infrastructure/jwt-token.service.ts        Create  @nestjs/jwt 구현
src/auth/application/sign-up.use-case.ts        Create  회원가입 유스케이스
src/auth/application/login.use-case.ts          Create  로그인 유스케이스
src/auth/interface/dto/sign-up.dto.ts           Create  요청 DTO
src/auth/interface/dto/login.dto.ts             Create  요청 DTO
src/auth/interface/jwt.strategy.ts              Create  passport-jwt 전략
src/auth/interface/jwt-auth.guard.ts            Create  JWT 가드
src/auth/interface/current-user.decorator.ts   Create  @CurrentUser 파라미터 데코
src/auth/interface/auth.controller.ts           Create  /auth/signup·login·me
src/auth/auth.module.ts                     Create  컨텍스트 모듈 조립
src/app.module.ts                                   Modify  ConfigModule·Prisma·Auth 등록
src/main.ts                                         Modify  전역 ValidationPipe
test/auth.e2e-spec.ts                           Create  signup→login→me e2e
```

> **의존성 역전 메모:** `application/`·`domain/`은 `infrastructure/`의 클래스를 import 하지 않는다. 오직 `domain/`의 인터페이스(토큰)에만 의존하고, 구현 바인딩은 `auth.module.ts`의 provider에서 한다.

---

## Task 1: 의존성 설치 & 환경 스캐폴드

**Files:**
- Modify: `package.json` (의존성 추가 — npm이 자동 수정)
- Create: `.env.example`, `.env`

- [ ] **Step 1: 런타임 의존성 설치**

Run:
```bash
npm install @prisma/client @nestjs/config @nestjs/jwt @nestjs/passport passport passport-jwt bcrypt
```

- [ ] **Step 2: 개발 의존성 설치**

Run:
```bash
npm install -D prisma @types/passport-jwt @types/bcrypt
```

- [ ] **Step 3: `.env.example` 작성**

```bash
# Database
DATABASE_URL="postgresql://estate:estate@localhost:5432/estate?schema=public"
# JWT
JWT_SECRET="change-me-in-production"
JWT_EXPIRES_IN="1h"
# Infra (M1~)
REDIS_URL="redis://localhost:6379"
KAFKA_BROKERS="localhost:9092"
```

- [ ] **Step 4: 실제 `.env` 생성 (gitignore됨)**

Run:
```bash
cp .env.example .env
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .env.example
git commit -m "chore(m0): add prisma/jwt/bcrypt deps and env scaffold"
```

---

## Task 2: 인프라 docker-compose

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: `docker-compose.yml` 작성 (PG·Redis·Kafka(cp-kafka, KRaft))**

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: estate
      POSTGRES_PASSWORD: estate
      POSTGRES_DB: estate
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U estate"]
      interval: 5s
      timeout: 5s
      retries: 5

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

  kafka:
    image: confluentinc/cp-kafka:7.7.1
    ports: ["9092:9092"]
    environment:
      # KRaft 모드: 단일 노드가 broker+controller 겸임 (ZooKeeper 불필요)
      KAFKA_NODE_ID: 1
      KAFKA_PROCESS_ROLES: broker,controller
      KAFKA_CONTROLLER_QUORUM_VOTERS: "1@kafka:9093"
      KAFKA_LISTENERS: PLAINTEXT://0.0.0.0:9092,CONTROLLER://0.0.0.0:9093
      KAFKA_ADVERTISED_LISTENERS: PLAINTEXT://localhost:9092
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT
      KAFKA_CONTROLLER_LISTENER_NAMES: CONTROLLER
      KAFKA_INTER_BROKER_LISTENER_NAME: PLAINTEXT
      # 단일 노드라 복제 계수·ISR는 1
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: 1
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: 1
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: 0
      # KRaft 클러스터 식별자(임의 base64 UUID). 운영에선 `kafka-storage random-uuid`로 생성
      CLUSTER_ID: MkU3OEVBNTcwNTJENDM2Qk
    healthcheck:
      test: ["CMD", "kafka-broker-api-versions", "--bootstrap-server", "localhost:9092"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  pgdata:
```

- [ ] **Step 2: 인프라 기동 및 Postgres 헬스 확인**

Run:
```bash
docker compose up -d
docker compose ps
```
Expected: `postgres`·`kafka`가 `healthy`, redis `running`.

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(m0): add postgres/redis/kafka(kraft) docker-compose"
```

---

## Task 3: Prisma 초기 스키마 + 마이그레이션 + PrismaModule

**Files:**
- Create: `prisma/schema.prisma`
- Create: `src/prisma/prisma.service.ts`
- Create: `src/prisma/prisma.module.ts`

- [ ] **Step 1: `prisma/schema.prisma` 작성 (User + Role)**

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

enum Role {
  OWNER
  TENANT
  ADMIN
}

model User {
  id           String   @id @default(cuid())
  email        String   @unique
  passwordHash String
  name         String
  role         Role     @default(TENANT)
  createdAt    DateTime @default(now())
  updatedAt    DateTime @updatedAt
}
```

- [ ] **Step 2: 첫 마이그레이션 생성·적용 + 클라이언트 생성**

Run:
```bash
npx prisma migrate dev --name init_user
```
Expected: `prisma/migrations/<ts>_init_user/` 생성, "Your database is now in sync", `@prisma/client` 재생성.

- [ ] **Step 3: `src/prisma/prisma.service.ts` 작성**

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
```

- [ ] **Step 4: `src/prisma/prisma.module.ts` 작성 (전역)**

```typescript
import { Global, Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';

@Global()
@Module({
  providers: [PrismaService],
  exports: [PrismaService],
})
export class PrismaModule {}
```

- [ ] **Step 5: 컴파일 확인**

Run:
```bash
npx tsc --noEmit
```
Expected: 에러 없음.

- [ ] **Step 6: Commit**

```bash
git add prisma src/prisma
git commit -m "feat(m0): add Prisma schema(User/Role), migration, global PrismaModule"
```

---

## Task 4: Auth 도메인 레이어 (엔티티·인터페이스)

도메인은 순수 TS만 사용한다(NestJS·Prisma import 금지).

**Files:**
- Create: `src/auth/domain/role.enum.ts`
- Create: `src/auth/domain/user.entity.ts`
- Create: `src/auth/domain/user.repository.ts`
- Create: `src/auth/domain/password-hasher.ts`
- Create: `src/auth/domain/token-issuer.ts`
- Test: `src/auth/domain/user.entity.spec.ts`

- [ ] **Step 1: 실패 테스트 작성 — User 엔티티 불변식**

`src/auth/domain/user.entity.spec.ts`:
```typescript
import { User } from './user.entity';
import { Role } from './role.enum';

describe('User entity', () => {
  it('create()로 신규 유저를 만들면 기본 역할은 TENANT', () => {
    const user = User.create({
      email: 'a@test.com',
      name: '홍길동',
      passwordHash: 'hashed',
    });
    expect(user.email).toBe('a@test.com');
    expect(user.role).toBe(Role.TENANT);
    expect(user.id).toBeNull();
  });

  it('이메일이 비면 생성 시 예외', () => {
    expect(() =>
      User.create({ email: '', name: '홍길동', passwordHash: 'h' }),
    ).toThrow('email is required');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/auth/domain/user.entity.spec.ts`
Expected: FAIL — "Cannot find module './user.entity'".

- [ ] **Step 3: `role.enum.ts` 작성**

```typescript
export enum Role {
  OWNER = 'OWNER',
  TENANT = 'TENANT',
  ADMIN = 'ADMIN',
}
```

- [ ] **Step 4: `user.entity.ts` 작성**

```typescript
import { Role } from './role.enum';

interface UserProps {
  id: string | null;
  email: string;
  name: string;
  passwordHash: string;
  role: Role;
}

export class User {
  private constructor(private readonly props: UserProps) {}

  static create(input: { email: string; name: string; passwordHash: string; role?: Role }): User {
    if (!input.email) throw new Error('email is required');
    if (!input.name) throw new Error('name is required');
    return new User({
      id: null,
      email: input.email,
      name: input.name,
      passwordHash: input.passwordHash,
      role: input.role ?? Role.TENANT,
    });
  }

  static reconstitute(props: UserProps): User {
    return new User(props);
  }

  get id(): string | null { return this.props.id; }
  get email(): string { return this.props.email; }
  get name(): string { return this.props.name; }
  get role(): Role { return this.props.role; }
  get passwordHash(): string { return this.props.passwordHash; }
}
```

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/auth/domain/user.entity.spec.ts`
Expected: PASS (2 passed).

- [ ] **Step 6: 리포지토리/해셔/토큰 인터페이스 작성**

`src/auth/domain/user.repository.ts`:
```typescript
import { User } from './user.entity';

export const USER_REPOSITORY = Symbol('USER_REPOSITORY');

export interface UserRepository {
  findByEmail(email: string): Promise<User | null>;
  save(user: User): Promise<User>;
}
```

`src/auth/domain/password-hasher.ts`:
```typescript
export const PASSWORD_HASHER = Symbol('PASSWORD_HASHER');

export interface PasswordHasher {
  hash(plain: string): Promise<string>;
  compare(plain: string, hash: string): Promise<boolean>;
}
```

`src/auth/domain/token-issuer.ts`:
```typescript
import { Role } from './role.enum';

export const TOKEN_ISSUER = Symbol('TOKEN_ISSUER');

export interface TokenPayload {
  sub: string;
  email: string;
  role: Role;
}

export interface TokenIssuer {
  issue(payload: TokenPayload): Promise<string>;
}
```

- [ ] **Step 7: Commit**

```bash
git add src/auth/domain
git commit -m "feat(m0): auth domain layer (User entity + repo/hasher/token interfaces)"
```

---

## Task 5: Auth 인프라 레이어 (bcrypt·Prisma·JWT 구현)

**Files:**
- Create: `src/auth/infrastructure/bcrypt-password-hasher.ts`
- Create: `src/auth/infrastructure/prisma-user.repository.ts`
- Create: `src/auth/infrastructure/jwt-token.service.ts`
- Test: `src/auth/infrastructure/bcrypt-password-hasher.spec.ts`

- [ ] **Step 1: 실패 테스트 작성 — bcrypt 해셔**

`src/auth/infrastructure/bcrypt-password-hasher.spec.ts`:
```typescript
import { BcryptPasswordHasher } from './bcrypt-password-hasher';

describe('BcryptPasswordHasher', () => {
  const hasher = new BcryptPasswordHasher();

  it('hash한 값은 원문과 다르고 compare로 검증된다', async () => {
    const hash = await hasher.hash('secret123');
    expect(hash).not.toBe('secret123');
    expect(await hasher.compare('secret123', hash)).toBe(true);
    expect(await hasher.compare('wrong', hash)).toBe(false);
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/auth/infrastructure/bcrypt-password-hasher.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `bcrypt-password-hasher.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PasswordHasher } from '../domain/password-hasher';

@Injectable()
export class BcryptPasswordHasher implements PasswordHasher {
  private readonly rounds = 10;

  hash(plain: string): Promise<string> {
    return bcrypt.hash(plain, this.rounds);
  }

  compare(plain: string, hash: string): Promise<boolean> {
    return bcrypt.compare(plain, hash);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/auth/infrastructure/bcrypt-password-hasher.spec.ts`
Expected: PASS.

- [ ] **Step 5: `prisma-user.repository.ts` 작성 (도메인↔Prisma 매핑)**

```typescript
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';
import { UserRepository } from '../domain/user.repository';

@Injectable()
export class PrismaUserRepository implements UserRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByEmail(email: string): Promise<User | null> {
    const row = await this.prisma.user.findUnique({ where: { email } });
    if (!row) return null;
    return User.reconstitute({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role as Role,
    });
  }

  async save(user: User): Promise<User> {
    const row = await this.prisma.user.create({
      data: {
        email: user.email,
        name: user.name,
        passwordHash: user.passwordHash,
        role: user.role,
      },
    });
    return User.reconstitute({
      id: row.id,
      email: row.email,
      name: row.name,
      passwordHash: row.passwordHash,
      role: row.role as Role,
    });
  }
}
```

- [ ] **Step 6: `jwt-token.service.ts` 작성**

```typescript
import { Injectable } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { TokenIssuer, TokenPayload } from '../domain/token-issuer';

@Injectable()
export class JwtTokenService implements TokenIssuer {
  constructor(private readonly jwt: JwtService) {}

  issue(payload: TokenPayload): Promise<string> {
    return this.jwt.signAsync(payload);
  }
}
```

- [ ] **Step 7: 컴파일 확인 후 Commit**

Run: `npx tsc --noEmit`
Expected: 에러 없음.
```bash
git add src/auth/infrastructure
git commit -m "feat(m0): auth infra (bcrypt hasher, prisma repo, jwt token service)"
```

---

## Task 6: 회원가입 유스케이스 (application)

**Files:**
- Create: `src/auth/application/sign-up.use-case.ts`
- Test: `src/auth/application/sign-up.use-case.spec.ts`

- [ ] **Step 1: 실패 테스트 작성 (인메모리 가짜 의존성)**

`src/auth/application/sign-up.use-case.spec.ts`:
```typescript
import { SignUpUseCase } from './sign-up.use-case';
import { User } from '../domain/user.entity';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';

class FakeUserRepo implements UserRepository {
  private users: User[] = [];
  async findByEmail(email: string) {
    return this.users.find((u) => u.email === email) ?? null;
  }
  async save(user: User) {
    const saved = User.reconstitute({
      id: 'generated-id', email: user.email, name: user.name,
      passwordHash: user.passwordHash, role: user.role,
    });
    this.users.push(saved);
    return saved;
  }
}
const fakeHasher: PasswordHasher = {
  hash: async (p) => `hashed:${p}`,
  compare: async (p, h) => h === `hashed:${p}`,
};

describe('SignUpUseCase', () => {
  it('신규 이메일이면 비밀번호를 해시해 저장하고 유저를 반환', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    const user = await useCase.execute({ email: 'a@test.com', name: '길동', password: 'pw123456' });
    expect(user.id).toBe('generated-id');
    expect(user.passwordHash).toBe('hashed:pw123456');
  });

  it('이미 존재하는 이메일이면 예외', async () => {
    const repo = new FakeUserRepo();
    const useCase = new SignUpUseCase(repo, fakeHasher);
    await useCase.execute({ email: 'a@test.com', name: '길동', password: 'pw123456' });
    await expect(
      useCase.execute({ email: 'a@test.com', name: '철수', password: 'pw999999' }),
    ).rejects.toThrow('email already in use');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/auth/application/sign-up.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `sign-up.use-case.ts` 작성**

```typescript
import { ConflictException, Inject, Injectable } from '@nestjs/common';
import { User } from '../domain/user.entity';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';

export interface SignUpInput {
  email: string;
  name: string;
  password: string;
}

@Injectable()
export class SignUpUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  async execute(input: SignUpInput): Promise<User> {
    const existing = await this.users.findByEmail(input.email);
    if (existing) throw new ConflictException('email already in use');
    const passwordHash = await this.hasher.hash(input.password);
    const user = User.create({ email: input.email, name: input.name, passwordHash });
    return this.users.save(user);
  }
}
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/auth/application/sign-up.use-case.spec.ts`
Expected: PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/auth/application/sign-up.use-case.ts src/auth/application/sign-up.use-case.spec.ts
git commit -m "feat(m0): SignUpUseCase with duplicate-email guard"
```

---

## Task 7: 로그인 유스케이스 (application)

**Files:**
- Create: `src/auth/application/login.use-case.ts`
- Test: `src/auth/application/login.use-case.spec.ts`

- [ ] **Step 1: 실패 테스트 작성**

`src/auth/application/login.use-case.spec.ts`:
```typescript
import { LoginUseCase } from './login.use-case';
import { User } from '../domain/user.entity';
import { Role } from '../domain/role.enum';
import { UserRepository } from '../domain/user.repository';
import { PasswordHasher } from '../domain/password-hasher';
import { TokenIssuer } from '../domain/token-issuer';

const existing = User.reconstitute({
  id: 'u1', email: 'a@test.com', name: '길동',
  passwordHash: 'hashed:pw123456', role: Role.OWNER,
});
const repo: UserRepository = {
  findByEmail: async (email) => (email === 'a@test.com' ? existing : null),
  save: async (u) => u,
};
const hasher: PasswordHasher = {
  hash: async (p) => `hashed:${p}`,
  compare: async (p, h) => h === `hashed:${p}`,
};
const tokenIssuer: TokenIssuer = { issue: async (p) => `token-for-${p.sub}` };

describe('LoginUseCase', () => {
  it('이메일·비밀번호가 맞으면 토큰 발급', async () => {
    const useCase = new LoginUseCase(repo, hasher, tokenIssuer);
    const result = await useCase.execute({ email: 'a@test.com', password: 'pw123456' });
    expect(result.accessToken).toBe('token-for-u1');
  });

  it('없는 이메일이면 Unauthorized', async () => {
    const useCase = new LoginUseCase(repo, hasher, tokenIssuer);
    await expect(useCase.execute({ email: 'none@test.com', password: 'x' })).rejects.toThrow('invalid credentials');
  });

  it('비밀번호가 틀리면 Unauthorized', async () => {
    const useCase = new LoginUseCase(repo, hasher, tokenIssuer);
    await expect(useCase.execute({ email: 'a@test.com', password: 'wrong' })).rejects.toThrow('invalid credentials');
  });
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/auth/application/login.use-case.spec.ts`
Expected: FAIL — module 없음.

- [ ] **Step 3: `login.use-case.ts` 작성**

```typescript
import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { USER_REPOSITORY, UserRepository } from '../domain/user.repository';
import { PASSWORD_HASHER, PasswordHasher } from '../domain/password-hasher';
import { TOKEN_ISSUER, TokenIssuer } from '../domain/token-issuer';

export interface LoginInput {
  email: string;
  password: string;
}

@Injectable()
export class LoginUseCase {
  constructor(
    @Inject(USER_REPOSITORY) private readonly users: UserRepository,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    @Inject(TOKEN_ISSUER) private readonly tokenIssuer: TokenIssuer,
  ) {}

  async execute(input: LoginInput): Promise<{ accessToken: string }> {
    const user = await this.users.findByEmail(input.email);
    if (!user) throw new UnauthorizedException('invalid credentials');
    const ok = await this.hasher.compare(input.password, user.passwordHash);
    if (!ok) throw new UnauthorizedException('invalid credentials');
    const accessToken = await this.tokenIssuer.issue({
      sub: user.id!,
      email: user.email,
      role: user.role,
    });
    return { accessToken };
  }
}
```

> **보안 메모(스펙 6절):** 존재하지 않는 이메일과 비밀번호 불일치를 **같은 메시지("invalid credentials")** 로 처리해 이메일 존재 여부가 새지 않게 한다.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/auth/application/login.use-case.spec.ts`
Expected: PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/auth/application/login.use-case.ts src/auth/application/login.use-case.spec.ts
git commit -m "feat(m0): LoginUseCase issuing JWT, opaque auth errors"
```

---

## Task 8: 인터페이스 레이어 (DTO·JWT 전략·가드·컨트롤러) + 모듈 조립

**Files:**
- Create: `src/auth/interface/dto/sign-up.dto.ts`
- Create: `src/auth/interface/dto/login.dto.ts`
- Create: `src/auth/interface/jwt.strategy.ts`
- Create: `src/auth/interface/jwt-auth.guard.ts`
- Create: `src/auth/interface/current-user.decorator.ts`
- Create: `src/auth/interface/auth.controller.ts`
- Create: `src/auth/auth.module.ts`
- Modify: `src/app.module.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: DTO 2종 작성**

`src/auth/interface/dto/sign-up.dto.ts`:
```typescript
import { IsEmail, IsNotEmpty, MinLength } from 'class-validator';

export class SignUpDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  name: string;

  @MinLength(8)
  password: string;
}
```

`src/auth/interface/dto/login.dto.ts`:
```typescript
import { IsEmail, IsNotEmpty } from 'class-validator';

export class LoginDto {
  @IsEmail()
  email: string;

  @IsNotEmpty()
  password: string;
}
```

- [ ] **Step 2: JWT 전략 작성**

`src/auth/interface/jwt.strategy.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { TokenPayload } from '../domain/token-issuer';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(config: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: TokenPayload): TokenPayload {
    return payload;
  }
}
```

- [ ] **Step 3: 가드 + @CurrentUser 데코레이터 작성**

`src/auth/interface/jwt-auth.guard.ts`:
```typescript
import { Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {}
```

`src/auth/interface/current-user.decorator.ts`:
```typescript
import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { TokenPayload } from '../domain/token-issuer';

export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): TokenPayload => {
    return ctx.switchToHttp().getRequest().user;
  },
);
```

- [ ] **Step 4: 컨트롤러 작성 (`/auth/signup`, `/auth/login`, `/auth/me`)**

`src/auth/interface/auth.controller.ts`:
```typescript
import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { SignUpUseCase } from '../application/sign-up.use-case';
import { LoginUseCase } from '../application/login.use-case';
import { SignUpDto } from './dto/sign-up.dto';
import { LoginDto } from './dto/login.dto';
import { JwtAuthGuard } from './jwt-auth.guard';
import { CurrentUser } from './current-user.decorator';
import { TokenPayload } from '../domain/token-issuer';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly signUp: SignUpUseCase,
    private readonly login: LoginUseCase,
  ) {}

  @Post('signup')
  async signup(@Body() dto: SignUpDto) {
    const user = await this.signUp.execute(dto);
    return { id: user.id, email: user.email, name: user.name, role: user.role };
  }

  @Post('login')
  loginHandler(@Body() dto: LoginDto) {
    return this.login.execute(dto);
  }

  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentUser() user: TokenPayload) {
    return { id: user.sub, email: user.email, role: user.role };
  }
}
```

- [ ] **Step 5: `auth.module.ts` 작성 (DI 바인딩 = 의존성 역전 지점)**

`src/auth/auth.module.ts`:
```typescript
import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { AuthController } from './interface/auth.controller';
import { JwtStrategy } from './interface/jwt.strategy';
import { SignUpUseCase } from './application/sign-up.use-case';
import { LoginUseCase } from './application/login.use-case';
import { USER_REPOSITORY } from './domain/user.repository';
import { PASSWORD_HASHER } from './domain/password-hasher';
import { TOKEN_ISSUER } from './domain/token-issuer';
import { PrismaUserRepository } from './infrastructure/prisma-user.repository';
import { BcryptPasswordHasher } from './infrastructure/bcrypt-password-hasher';
import { JwtTokenService } from './infrastructure/jwt-token.service';

@Module({
  imports: [
    PassportModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: config.get<string>('JWT_EXPIRES_IN', '1h') },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    SignUpUseCase,
    LoginUseCase,
    JwtStrategy,
    { provide: USER_REPOSITORY, useClass: PrismaUserRepository },
    { provide: PASSWORD_HASHER, useClass: BcryptPasswordHasher },
    { provide: TOKEN_ISSUER, useClass: JwtTokenService },
  ],
})
export class AuthModule {}
```

- [ ] **Step 6: `src/app.module.ts` 수정 (ConfigModule·Prisma·Auth 등록, 기본 컨트롤러 제거)**

`src/app.module.ts` 전체를 다음으로 교체:
```typescript
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    AuthModule,
  ],
})
export class AppModule {}
```

- [ ] **Step 7: 기본 스타터 파일 제거 (사용 안 함)**

> 스타터 e2e(`test/app.e2e-spec.ts`)는 `GET / → "Hello World!"`를 검증하므로, AppController 삭제와 함께 제거해야 `npm run test:e2e`가 깨지지 않는다(Task 9의 `auth.e2e-spec.ts`로 대체).

Run:
```bash
git rm src/app.controller.ts src/app.controller.spec.ts src/app.service.ts test/app.e2e-spec.ts
```

- [ ] **Step 8: `src/main.ts` 수정 (전역 ValidationPipe)**

`src/main.ts` 전체를 다음으로 교체:
```typescript
import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
```

- [ ] **Step 9: 빌드 + 단위 테스트 전체 통과 확인**

Run:
```bash
npx tsc --noEmit && npx jest
```
Expected: 컴파일 에러 없음, 기존 단위 테스트(엔티티·해셔·유스케이스) 전부 PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(m0): auth interface layer (auth controller, JWT strategy/guard) + module wiring"
```

---

## Task 9: 회원가입→로그인→인증 조회 e2e

**Files:**
- Create: `test/auth.e2e-spec.ts`

> **선행:** `docker compose up -d`로 Postgres가 떠 있고 마이그레이션이 적용된 상태. e2e는 실제 DB에 쓰므로 매 실행 전 해당 유저를 정리한다.

- [ ] **Step 1: 실패 e2e 테스트 작성**

`test/auth.e2e-spec.ts`:
```typescript
import { Test } from '@nestjs/testing';
import { INestApplication, ValidationPipe } from '@nestjs/common';
import * as request from 'supertest';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/prisma/prisma.service';

describe('Auth (e2e)', () => {
  let app: INestApplication;
  let prisma: PrismaService;
  const email = `e2e_${Date.now()}@test.com`;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }));
    prisma = app.get(PrismaService);
    await app.init();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email } });
    await app.close();
  });

  it('signup → login → me 전체 흐름', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email, name: '길동', password: 'pw123456' })
      .expect(201)
      .expect((res) => expect(res.body.role).toBe('TENANT'));

    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'pw123456' })
      .expect(201);
    const token = login.body.accessToken;
    expect(typeof token).toBe('string');

    await request(app.getHttpServer())
      .get('/auth/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200)
      .expect((res) => expect(res.body.email).toBe(email));
  });

  it('토큰 없이 /auth/me는 401', async () => {
    await request(app.getHttpServer()).get('/auth/me').expect(401);
  });

  it('짧은 비밀번호 signup은 400', async () => {
    await request(app.getHttpServer())
      .post('/auth/signup')
      .send({ email: `short_${Date.now()}@test.com`, name: 'x', password: 'short' })
      .expect(400);
  });
});
```

- [ ] **Step 2: 인프라 확인 후 e2e 실행 (실패 가능성 점검)**

Run:
```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json
```
Expected: 처음 실행에서 통과해야 함. 만약 401/연결 에러가 나면 `.env`의 `DATABASE_URL`·`JWT_SECRET`과 마이그레이션 적용 여부를 점검.

- [ ] **Step 3: Commit**

```bash
git add test/auth.e2e-spec.ts
git commit -m "test(m0): auth e2e (signup/login/me, 401, validation)"
```

---

## Task 10: M0 마무리 검증 & README 상태 갱신

**Files:**
- Modify: `README.md` (M0 상태 표시)

- [ ] **Step 1: 전체 검증 (lint·단위·e2e)**

Run:
```bash
npm run lint && npx jest && npx jest --config ./test/jest-e2e.json
```
Expected: lint 통과, 모든 단위·e2e PASS.

- [ ] **Step 2: 수동 동작 확인 (서버 기동 후 curl)**

Run:
```bash
npm run start:dev   # 별도 터미널
curl -s -X POST localhost:3000/auth/signup -H 'Content-Type: application/json' -d '{"email":"owner@test.com","name":"건물주","password":"pw123456"}'
curl -s -X POST localhost:3000/auth/login  -H 'Content-Type: application/json' -d '{"email":"owner@test.com","password":"pw123456"}'
```
Expected: signup은 유저 JSON, login은 `{"accessToken":"..."}`.

- [ ] **Step 3: README M0 상태 한 줄 갱신**

`README.md`의 마일스톤 표 M0 행 끝에 ✅ 표기를 추가(예: `| **M0** | ... | Prisma 기초·마이그레이션 ✅ |`).

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(m0): mark M0 complete in milestone table"
```

---

## M0 완료 기준 (Definition of Done)

- [ ] `docker compose up -d`로 PG·Redis·Kafka 기동, Postgres·Kafka healthy
- [ ] `prisma migrate dev` 마이그레이션이 적용되고 `User` 테이블 존재
- [ ] 회원가입(`POST /auth/signup`) 동작, 비밀번호는 bcrypt 해시로만 저장(평문 미저장)
- [ ] 로그인(`POST /auth/login`)이 JWT 발급, 인증 오류는 이메일 존재 여부를 노출하지 않음
- [ ] 보호 엔드포인트(`GET /auth/me`)가 유효 토큰에서만 200, 무토큰 401
- [ ] 단위 테스트(엔티티·해셔·유스케이스) + e2e 전부 통과
- [ ] 도메인/애플리케이션 레이어가 Prisma·bcrypt·JWT를 직접 import 하지 않음(의존성 역전 유지)

---

## Self-Review 결과

- **스펙 커버리지:** M0 스펙("docker-compose + Prisma 초기 스키마 + Auth(JWT)", 검증="회원가입/로그인 동작, 마이그레이션 적용됨") → Task 1·2(인프라), Task 3(Prisma/마이그레이션), Task 4~9(인증) 으로 전부 커버. 스펙 5.2 레이어 구조(interface/application/domain/infrastructure)와 의존성 역전 → 디렉터리·DI 바인딩으로 반영. 보안 6절(인증 오류 불투명화, 민감정보 env) 반영.
- **범위 외(의도적):** RolesGuard(RBAC 가드)는 역할 기반 인가가 실제로 필요한 M1에서 도입. M0는 Role enum 정의 + JWT 인증까지만.
- **타입 일관성:** `TokenPayload{sub,email,role}`가 발급(JwtTokenService)·검증(JwtStrategy)·소비(@CurrentUser, /me)에서 동일. `User.reconstitute`/`User.create` 시그니처가 repo·use-case·test에서 일치. `accessToken` 키가 LoginUseCase·e2e에서 일치.
