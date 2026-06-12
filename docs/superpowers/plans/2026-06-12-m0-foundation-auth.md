# M0 — 프로젝트 기반 + JWT 인증 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **문서 규칙:** 이 계획은 예시 구현·테스트 코드를 싣지 않는다. 각 단계는 "무엇을 만들고 무엇을 검증하는지"를 산문으로 기술하고, 실제 코드는 구현 단계에서 작성한다. 실행/검증/커밋용 셸 명령만 코드 블록으로 남긴다.

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

**Files:** Modify `package.json`(npm 자동), Create `.env.example`·`.env`.

- [ ] **Step 1: 런타임 의존성 설치**

```bash
npm install @prisma/client @nestjs/config @nestjs/jwt @nestjs/passport passport passport-jwt bcrypt class-validator class-transformer
```

- [ ] **Step 2: 개발 의존성 설치**

```bash
npm install -D prisma @types/passport-jwt @types/bcrypt
```

- [ ] **Step 3: `.env.example` 작성**

다음 키를 둔다: `DATABASE_URL`(postgresql, **host 포트 5433** — 호스트 네이티브 postgres와 5432 충돌 회피), `JWT_SECRET`, `JWT_EXPIRES_IN`(예: `1h`), `REDIS_URL`(M1~), `KAFKA_BROKERS`(M3~, 예: `localhost:9092`).

- [ ] **Step 4: 실제 `.env` 생성 (gitignore됨)**

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

**Files:** Create `docker-compose.yml`.

- [ ] **Step 1: `docker-compose.yml` 작성 (PG·Redis·Kafka(cp-kafka, KRaft))**

세 서비스를 정의한다.
- **postgres**: `postgres:16-alpine`, user/pw/db = `estate`, **호스트 포트 5433 → 컨테이너 5432 매핑**(호스트 네이티브 postgres 충돌 회피), `pgdata` 볼륨, `pg_isready` healthcheck.
- **redis**: `redis:7-alpine`, 포트 6379.
- **kafka**: `confluentinc/cp-kafka:7.7.1`, 포트 9092. **KRaft 모드**(단일 노드가 broker+controller 겸임, ZooKeeper 불필요): `KAFKA_PROCESS_ROLES=broker,controller`, controller quorum/listener 설정, 단일 노드라 복제 계수·ISR·min-ISR = 1, 임의 base64 `CLUSTER_ID`, `kafka-broker-api-versions` healthcheck.

- [ ] **Step 2: 인프라 기동 및 헬스 확인**

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

**Files:** Create `prisma/schema.prisma`, `src/prisma/prisma.service.ts`, `src/prisma/prisma.module.ts`.

- [ ] **Step 1: `prisma/schema.prisma` 작성 (User + Role)**

`prisma-client-js` generator, `postgresql` datasource(`env("DATABASE_URL")`). **`Role` enum**: OWNER·TENANT·ADMIN. **`User` 모델**: `id`(cuid), `email`(unique), `passwordHash`, `name`, `role`(Role, default TENANT), `createdAt`/`updatedAt`.

- [ ] **Step 2: 첫 마이그레이션 생성·적용 + 클라이언트 생성**

```bash
npx prisma migrate dev --name init_user
```
Expected: `prisma/migrations/<ts>_init_user/` 생성, "Your database is now in sync", `@prisma/client` 재생성.

- [ ] **Step 3: `src/prisma/prisma.service.ts` 작성**

`PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy` — `onModuleInit`에서 `$connect()`, `onModuleDestroy`에서 `$disconnect()`. `@Injectable()`.

- [ ] **Step 4: `src/prisma/prisma.module.ts` 작성 (전역)**

`@Global() @Module` — `PrismaService`를 provide·export.

- [ ] **Step 5: 컴파일 확인**

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

**Files:** Create `role.enum.ts`, `user.entity.ts`, `user.repository.ts`, `password-hasher.ts`, `token-issuer.ts` (모두 `src/auth/domain/`), Test `user.entity.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — User 엔티티 불변식**

검증: ① `User.create({email,name,passwordHash})`로 만들면 기본 역할은 `TENANT`이고 `id`는 `null`. ② 이메일이 비면 `'email is required'` 예외.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/auth/domain/user.entity.spec.ts` → FAIL("Cannot find module './user.entity'").

- [ ] **Step 3: `role.enum.ts` 작성** — 문자열 enum OWNER·TENANT·ADMIN.

- [ ] **Step 4: `user.entity.ts` 작성**

private 생성자 + `props`. 정적 팩토리 `create({email, name, passwordHash, role?})`: email/name 비면 예외, `id=null`, `role` 기본 `TENANT`. 정적 `reconstitute(props)`(DB 행 복원용). 읽기 게터: `id`(`string|null`), `email`, `name`, `role`, `passwordHash`.

- [ ] **Step 5: 테스트 통과 확인**

Run: `npx jest src/auth/domain/user.entity.spec.ts` → PASS (2 passed).

- [ ] **Step 6: 리포지토리/해셔/토큰 인터페이스 작성**

각 파일에 DI 토큰(Symbol) + 인터페이스를 둔다.
- `user.repository.ts`: `USER_REPOSITORY` + `UserRepository { findByEmail(email): Promise<User|null>; save(user): Promise<User> }`.
- `password-hasher.ts`: `PASSWORD_HASHER` + `PasswordHasher { hash(plain): Promise<string>; compare(plain, hash): Promise<boolean> }`.
- `token-issuer.ts`: `TOKEN_ISSUER` + `TokenPayload { sub: string; email: string; role: Role }` + `TokenIssuer { issue(payload): Promise<string> }`.

- [ ] **Step 7: Commit**

```bash
git add src/auth/domain
git commit -m "feat(m0): auth domain layer (User entity + repo/hasher/token interfaces)"
```

---

## Task 5: Auth 인프라 레이어 (bcrypt·Prisma·JWT 구현)

**Files:** Create `bcrypt-password-hasher.ts`, `prisma-user.repository.ts`, `jwt-token.service.ts` (모두 `src/auth/infrastructure/`), Test `bcrypt-password-hasher.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — bcrypt 해셔**

검증: `hash()`한 값은 원문과 다르고, `compare(원문, 해시)`는 true, `compare(틀린값, 해시)`는 false.

- [ ] **Step 2: 테스트 실패 확인**

Run: `npx jest src/auth/infrastructure/bcrypt-password-hasher.spec.ts` → FAIL(module 없음).

- [ ] **Step 3: `bcrypt-password-hasher.ts` 작성**

`@Injectable() BcryptPasswordHasher implements PasswordHasher`, rounds=10, `bcrypt.hash`/`bcrypt.compare` 위임.

- [ ] **Step 4: 테스트 통과 확인**

Run: `npx jest src/auth/infrastructure/bcrypt-password-hasher.spec.ts` → PASS.

- [ ] **Step 5: `prisma-user.repository.ts` 작성 (도메인↔Prisma 매핑)**

`@Injectable() PrismaUserRepository implements UserRepository`, `PrismaService` 주입. `findByEmail`은 `prisma.user.findUnique({where:{email}})` → 없으면 null, 있으면 `User.reconstitute(...)`(role은 `as Role`). `save`는 `prisma.user.create(...)` 후 `reconstitute`.

> **리뷰 반영(구현 시):** `save`에서 동시 가입 TOCTOU 대비로 Prisma `P2002`(unique 위반)를 잡아 `ConflictException('email already in use')`로 변환한다(사전 중복체크와 같은 409 보장).

- [ ] **Step 6: `jwt-token.service.ts` 작성**

`@Injectable() JwtTokenService implements TokenIssuer`, `JwtService` 주입, `issue(payload)` = `jwt.signAsync(payload)`.

- [ ] **Step 7: 컴파일 확인 후 Commit**

```bash
npx tsc --noEmit
git add src/auth/infrastructure
git commit -m "feat(m0): auth infra (bcrypt hasher, prisma repo, jwt token service)"
```

---

## Task 6: 회원가입 유스케이스 (application)

**Files:** Create `src/auth/application/sign-up.use-case.ts`, Test `sign-up.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 (인메모리 가짜 의존성)**

인메모리 `FakeUserRepo` + 가짜 해셔(`hash`는 `hashed:${p}` 반환)로 검증: ① 신규 이메일이면 비밀번호를 해시해 저장하고 생성된 `id`·`passwordHash(hashed:pw...)`를 가진 유저 반환. ② 이미 존재하는 이메일이면 `'email already in use'` 예외.
> 테스트 가짜의 async 메서드는 `await`가 없으므로 `Promise.resolve()` 반환 형태로 작성(eslint `require-await` 회피).

- [ ] **Step 2: 테스트 실패 확인** — Run: `npx jest src/auth/application/sign-up.use-case.spec.ts` → FAIL.

- [ ] **Step 3: `sign-up.use-case.ts` 작성**

`@Injectable() SignUpUseCase`, `@Inject(USER_REPOSITORY)`·`@Inject(PASSWORD_HASHER)`. `execute({email,name,password})`: `findByEmail`로 중복 시 `ConflictException('email already in use')`, 아니면 해시 후 `User.create` → `save`.

- [ ] **Step 4: 테스트 통과 확인** — Run 동일 → PASS (2 passed).

- [ ] **Step 5: Commit**

```bash
git add src/auth/application/sign-up.use-case.ts src/auth/application/sign-up.use-case.spec.ts
git commit -m "feat(m0): SignUpUseCase with duplicate-email guard"
```

---

## Task 7: 로그인 유스케이스 (application)

**Files:** Create `src/auth/application/login.use-case.ts`, Test `login.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성**

가짜 repo/해셔/토큰발급기로 검증: ① 이메일·비밀번호가 맞으면 토큰 발급(`accessToken` = `token-for-<sub>`). ② 없는 이메일이면 `'invalid credentials'`. ③ 비밀번호 불일치도 `'invalid credentials'`(동일 메시지).

- [ ] **Step 2: 테스트 실패 확인** — Run: `npx jest src/auth/application/login.use-case.spec.ts` → FAIL.

- [ ] **Step 3: `login.use-case.ts` 작성**

`@Injectable() LoginUseCase`, `@Inject` repo·hasher·tokenIssuer. `execute({email,password})`: 유저 없거나 비번 불일치면 `UnauthorizedException('invalid credentials')`(같은 메시지), 통과 시 `tokenIssuer.issue({sub:user.id, email, role})` → `{ accessToken }`.

> **보안 메모(스펙 6절):** 존재하지 않는 이메일과 비밀번호 불일치를 **같은 메시지**로 처리해 이메일 존재 여부가 새지 않게 한다.

- [ ] **Step 4: 테스트 통과 확인** — Run 동일 → PASS (3 passed).

- [ ] **Step 5: Commit**

```bash
git add src/auth/application/login.use-case.ts src/auth/application/login.use-case.spec.ts
git commit -m "feat(m0): LoginUseCase issuing JWT, opaque auth errors"
```

---

## Task 8: 인터페이스 레이어 (DTO·JWT 전략·가드·컨트롤러) + 모듈 조립

**Files:** Create `dto/sign-up.dto.ts`, `dto/login.dto.ts`, `jwt.strategy.ts`, `jwt-auth.guard.ts`, `current-user.decorator.ts`, `auth.controller.ts` (모두 `src/auth/interface/`), `src/auth/auth.module.ts`. Modify `src/app.module.ts`, `src/main.ts`.

- [ ] **Step 1: DTO 2종 작성**

`SignUpDto`(`@IsEmail email`, `@IsNotEmpty name`, `@MinLength(8) password`), `LoginDto`(`@IsEmail email`, `@IsNotEmpty password`).

- [ ] **Step 2: JWT 전략 작성**

`JwtStrategy extends PassportStrategy(Strategy)` — Bearer 추출, `ignoreExpiration:false`, `secretOrKey`는 `config.getOrThrow('JWT_SECRET')`. `validate(payload)`는 `TokenPayload` 그대로 반환(→ `request.user`).

- [ ] **Step 3: 가드 + `@CurrentUser` 데코레이터 작성**

`JwtAuthGuard extends AuthGuard('jwt')`. `CurrentUser` 파라미터 데코레이터는 `request.user`(TokenPayload)를 반환(`getRequest<{ user: TokenPayload }>()`로 타입 지정).

- [ ] **Step 4: 컨트롤러 작성 (`/auth/signup`, `/auth/login`, `/auth/me`)**

`@Controller('auth') AuthController`, `SignUpUseCase`·`LoginUseCase` 주입.
- `POST signup` → 유저 생성 후 `{id,email,name,role}` 반환.
- `POST login` → `{accessToken}` 반환.
- `GET me` (`@UseGuards(JwtAuthGuard)`, `@CurrentUser()`) → `{id:sub, email, role}`.

- [ ] **Step 5: `auth.module.ts` 작성 (DI 바인딩 = 의존성 역전 지점)**

`imports`: `PassportModule`, `JwtModule.registerAsync`(secret=`getOrThrow('JWT_SECRET')`, `signOptions.expiresIn`=`JWT_EXPIRES_IN` 기본 `1h` — 타입은 `as JwtSignOptions`). `controllers`: `AuthController`. `providers`: `SignUpUseCase`·`LoginUseCase`·`JwtStrategy` + 토큰→구현 바인딩(`USER_REPOSITORY`→`PrismaUserRepository`, `PASSWORD_HASHER`→`BcryptPasswordHasher`, `TOKEN_ISSUER`→`JwtTokenService`).

- [ ] **Step 6: `src/app.module.ts` 수정**

`ConfigModule.forRoot({isGlobal:true})`, `PrismaModule`, `AuthModule`만 imports. 기본 컨트롤러/서비스 제거.

- [ ] **Step 7: 기본 스타터 파일 제거 (사용 안 함)**

> 스타터 e2e(`test/app.e2e-spec.ts`)는 `GET / → "Hello World!"`를 검증하므로, AppController 삭제와 함께 제거해야 `npm run test:e2e`가 깨지지 않는다(Task 9의 `auth.e2e-spec.ts`로 대체).

```bash
git rm src/app.controller.ts src/app.controller.spec.ts src/app.service.ts test/app.e2e-spec.ts
```

- [ ] **Step 8: `src/main.ts` 수정 (전역 ValidationPipe)**

`NestFactory.create` 후 `app.useGlobalPipes(new ValidationPipe({ whitelist:true, transform:true }))`, 포트 listen. floating promise 회피로 `void bootstrap()`.

- [ ] **Step 9: 빌드 + 단위 테스트 전체 통과 확인**

```bash
npx tsc --noEmit && npx jest
```
Expected: 컴파일 에러 없음, 단위 테스트(엔티티·해셔·유스케이스) 전부 PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(m0): auth interface layer (auth controller, JWT strategy/guard) + module wiring"
```

---

## Task 9: 회원가입→로그인→인증 조회 e2e

**Files:** Create `test/auth.e2e-spec.ts`.

> **선행:** `docker compose up -d`로 Postgres가 떠 있고 마이그레이션이 적용된 상태. e2e는 실제 DB에 쓰므로 매 실행 전후 해당 유저를 정리한다.

- [ ] **Step 1: 실패 e2e 테스트 작성**

`AppModule` 부팅 + 전역 ValidationPipe. 검증: ① `signup → login → me` 전체 흐름(signup 201·role TENANT, login 201·accessToken 문자열, me 200·email 일치). ② 토큰 없이 `/auth/me` → 401. ③ 짧은 비밀번호 signup → 400. ④ 이미 가입된 이메일 재signup → 409(리뷰 반영). `afterAll`에서 테스트 이메일 정리. (supertest 타입은 `getHttpServer() as App`, `res.body as {...}`로 캐스팅해 eslint no-unsafe-* 회피.)

- [ ] **Step 2: 인프라 확인 후 e2e 실행**

```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json
```
Expected: 통과. 401/연결 에러 시 `.env`의 `DATABASE_URL`·`JWT_SECRET`과 마이그레이션 적용 여부 점검.

- [ ] **Step 3: Commit**

```bash
git add test/auth.e2e-spec.ts
git commit -m "test(m0): auth e2e (signup/login/me, 401, validation)"
```

---

## Task 10: M0 마무리 검증 & README 상태 갱신

**Files:** Modify `README.md`.

- [ ] **Step 1: 전체 검증 (lint·단위·e2e)**

```bash
npm run lint && npx jest && npx jest --config ./test/jest-e2e.json
```
Expected: lint 0 errors, 모든 단위·e2e PASS.

- [ ] **Step 2: 수동 동작 확인 (서버 기동 후 curl)**

`npm run start:dev` 후 `POST /auth/signup`(유저 JSON 반환), `POST /auth/login`(`{accessToken}` 반환) 확인.

- [ ] **Step 3: README M0 상태 한 줄 갱신** — 마일스톤 표 M0 행에 ✅ 표기 추가.

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

- **스펙 커버리지:** M0 스펙("docker-compose + Prisma 초기 스키마 + Auth(JWT)", 검증="회원가입/로그인 동작, 마이그레이션 적용됨") → Task 1·2(인프라), Task 3(Prisma/마이그레이션), Task 4~9(인증)으로 전부 커버. 스펙 5.2 레이어 구조와 의존성 역전 → 디렉터리·DI 바인딩으로 반영. 보안 6절(인증 오류 불투명화, 민감정보 env) 반영.
- **범위 외(의도적):** RolesGuard(RBAC 가드)는 역할 기반 인가가 실제로 필요한 M1에서 도입. M0는 Role enum 정의 + JWT 인증까지만.
- **타입 일관성:** `TokenPayload{sub,email,role}`가 발급·검증·소비에서 동일. `User.reconstitute`/`User.create` 시그니처가 repo·use-case·test에서 일치. `accessToken` 키가 LoginUseCase·e2e에서 일치.
