# M1 — Property(건물·호실·입주) + 초대코드(Redis TTL) + RBAC Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **문서 규칙:** 이 계획은 예시 구현·테스트 코드를 싣지 않는다. 각 단계는 "무엇을 만들고 무엇을 검증하는지"와 핵심 시그니처를 산문으로 기술하고, 실제 코드는 구현 단계에서 작성한다. 실행/검증/커밋용 셸 명령만 코드 블록으로 남긴다.

**Goal:** 건물주(OWNER)가 건물→호실을 만들고 **초대코드를 발급**하면, 입주자(TENANT)가 코드를 입력해 **자신의 호실에 자동 연결(Lease 생성)** 되는 흐름을 만든다. 그 과정에서 Prisma 관계(Building→Unit→Lease), Redis TTL(초대코드 만료·단일 사용), RBAC(RolesGuard + 리소스 소유권 검사)를 익힌다.

**Architecture:** M0의 DDD 레이어드 구조를 그대로 따른다 — `interface → application → domain → infrastructure` 단방향, 도메인은 인터페이스만 알고 Prisma·Redis 구현은 infrastructure에 두고 DI로 주입(의존성 역전). Property 컨텍스트는 소유권·상태가 있어 도메인 레이어를 M0보다 약간 두텁게(엔티티에 `isOwnedBy` 같은 규칙) 가져간다. RBAC는 Auth 컨텍스트가 소유한다(스펙 5.1).

**Tech Stack:** NestJS 11, TypeScript, Prisma + PostgreSQL, **ioredis**(신규), class-validator, Jest.

**선행:** M0 완료(머지) 상태. `src/auth/`(JWT 인증·Role enum)와 전역 `PrismaModule`이 존재한다고 가정한다.

---

## 핵심 설계 결정 (M1 한정)

- **초대코드는 Redis 단독 저장(TTL 네이티브).** `invite:{code}` → `{unitId, issuedBy}` JSON을 `EX 24h`로 저장. 사용 시 **`GETDEL`(원자적 단일 사용)** 로 읽고 즉시 삭제 → Lease 생성. **InviteCode Postgres 테이블은 만들지 않는다.** 발급/사용 감사 이력은 M3 Kafka `membership-events` + audit-worker로 분리(스펙 4절). M1 학습 목표(Prisma 관계 + Redis TTL)에 정확히 집중하고 dual-write를 피한다.
- **만료/사용/존재하지 않음을 구분하지 않는다.** `GETDEL`이 `null`을 반환하면(만료·이미 사용·오타 무엇이든) 동일하게 **404**로 응답한다 — 어떤 코드가 "존재했었는지"를 누설하지 않는다(보안).
- **RBAC = 역할 가드 + 소유권 검사 이중.** `RolesGuard`는 JWT의 `role`만 본다. "이 건물이 내 것인가"는 역할로 판단 불가하므로 **유스케이스(application)에서 리소스 소유권을 검사**한다(스펙 6절).
- **OWNER 프로비저닝은 M1 범위 밖.** M0 회원가입은 기본 TENANT만 만든다. 누가 OWNER가 되는가(온보딩)는 별도 관심사라 M1에서 다루지 않는다. e2e·수동 검증에서는 **테스트가 DB에서 직접 role을 OWNER로 승격**시켜 RBAC를 검증한다.

---

## M1 파일 구조

```
src/redis/redis.service.ts                              Create  ioredis 생명주기 (전역)
src/redis/redis.module.ts                               Create  전역 RedisModule
src/auth/interface/roles.decorator.ts                   Create  @Roles 메타데이터
src/auth/interface/roles.guard.ts                       Create  RolesGuard (역할 검사)
src/property/domain/lease-status.enum.ts                Create  ACTIVE|ENDED
src/property/domain/building.entity.ts                  Create  Building 엔티티(+isOwnedBy)
src/property/domain/unit.entity.ts                      Create  Unit 엔티티
src/property/domain/lease.entity.ts                     Create  Lease 엔티티
src/property/domain/building.repository.ts              Create  인터페이스 + DI 토큰
src/property/domain/unit.repository.ts                  Create  인터페이스 + DI 토큰
src/property/domain/lease.repository.ts                 Create  인터페이스 + DI 토큰
src/property/domain/invite-code.store.ts                Create  인터페이스 + DI 토큰(Redis 추상화)
src/property/infrastructure/prisma-building.repository.ts  Create
src/property/infrastructure/prisma-unit.repository.ts      Create
src/property/infrastructure/prisma-lease.repository.ts     Create
src/property/infrastructure/redis-invite-code.store.ts     Create  GETDEL 단일 사용
src/property/application/create-building.use-case.ts    Create
src/property/application/create-unit.use-case.ts        Create  소유권 검사
src/property/application/issue-invite-code.use-case.ts  Create  소유권 검사 + Redis 발급
src/property/application/redeem-invite-code.use-case.ts Create  GETDEL + Lease 생성
src/property/application/list-my-buildings.use-case.ts  Create  얇은 조회
src/property/application/list-my-leases.use-case.ts     Create  얇은 조회
src/property/interface/dto/create-building.dto.ts       Create
src/property/interface/dto/create-unit.dto.ts           Create
src/property/interface/dto/redeem-invite.dto.ts         Create
src/property/interface/property.controller.ts           Create  /buildings · /units · /invite-codes · /me/leases
src/property/property.module.ts                         Create  컨텍스트 모듈 조립
prisma/schema.prisma                                    Modify  Building/Unit/Lease + LeaseStatus + User 역관계
src/app.module.ts                                       Modify  RedisModule·PropertyModule 등록
test/property.e2e-spec.ts                               Create  발급→가입→연결 + RBAC/만료/소유권 부정
```

> **의존성 역전 메모(M0와 동일):** `application/`·`domain/`은 `infrastructure/`를 import 하지 않는다. Prisma·Redis 구현 바인딩은 `property.module.ts`의 provider에서만 한다.

---

## Task 1: ioredis 의존성 + 전역 RedisModule

**Files:** Modify `package.json`(npm 자동), Create `src/redis/redis.service.ts`·`redis.module.ts`.

- [ ] **Step 1: ioredis 설치**

```bash
npm install ioredis
```

- [ ] **Step 2: `redis.service.ts` 작성 (PrismaService와 동일한 생명주기 패턴)**

`@Injectable() RedisService extends Redis(ioredis) implements OnModuleDestroy`. 생성자에서 `super(config.getOrThrow('REDIS_URL'))`. **장수 커넥션 위생**으로 `this.on('error', ...)`에 Logger 경고만 남겨 단절 시 프로세스 크래시를 막고 ioredis 자동 재연결에 맡긴다. `onModuleDestroy`에서 `quit()`.

- [ ] **Step 3: `redis.module.ts` 작성 (전역)**

`@Global() @Module` — `RedisService`를 provide·export.

- [ ] **Step 4: 컴파일 + Redis 연결 스모크 확인**

```bash
npx tsc --noEmit
docker compose exec -T redis redis-cli ping
```
Expected: tsc 에러 없음, `PONG`.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/redis
git commit -m "feat(m1): add ioredis + global RedisModule"
```

---

## Task 2: Prisma 스키마 확장 (Building/Unit/Lease) + 마이그레이션

**Files:** Modify `prisma/schema.prisma`.

- [ ] **Step 1: 모델·enum 추가 + User 역관계**

- 기존 `User` 모델에 역관계 두 줄 추가: `buildings Building[]`, `leases Lease[]`.
- `LeaseStatus` enum: ACTIVE·ENDED.
- `Building`: `id`(cuid), `ownerId` + `owner User @relation`, `name`, `address`, `createdAt`, `units Unit[]`.
- `Unit`: `id`(cuid), `buildingId` + `building Building @relation`, `name`(호수), `floor Int`, `createdAt`, `leases Lease[]`.
- `Lease`: `id`(cuid), `unitId` + `unit Unit @relation`, `tenantId` + `tenant User @relation`, `status LeaseStatus @default(ACTIVE)`, `startDate @default(now())`, `endDate DateTime?`, `createdAt`.

각 관계는 모델 쌍마다 1개씩이라 Prisma가 관계명을 자동 추론한다(명시 불필요).

- [ ] **Step 2: 마이그레이션 생성·적용 + 클라이언트 재생성**

```bash
npx prisma migrate dev --name add_property
```
Expected: `prisma/migrations/<ts>_add_property/` 생성, "Your database is now in sync", `@prisma/client` 재생성(`prisma.building`·`prisma.unit`·`prisma.lease` 사용 가능).

- [ ] **Step 3: 컴파일 확인** — `npx tsc --noEmit` → 에러 없음.

- [ ] **Step 4: Commit**

```bash
git add prisma
git commit -m "feat(m1): add Building/Unit/Lease schema + migration"
```

---

## Task 3: RBAC — @Roles 데코레이터 + RolesGuard (Auth 컨텍스트)

RBAC는 Auth 컨텍스트가 소유한다(스펙 5.1). Guard는 cross-cutting이라 별도 spec으로 분리한다(프로젝트 테스트 규칙).

**Files:** Create `src/auth/interface/roles.decorator.ts`·`roles.guard.ts`, Test `roles.guard.spec.ts`.

- [ ] **Step 1: `roles.decorator.ts` 작성**

`ROLES_KEY` 상수 + `Roles(...roles: Role[])` = `SetMetadata(ROLES_KEY, roles)`.

- [ ] **Step 2: 실패 테스트 작성 — RolesGuard**

가짜 `ExecutionContext`(request.user.role 주입)·`Reflector`(필요 역할 반환)로 검증: ① 필요 역할 메타데이터 없으면 통과(true). ② 역할 일치 시 통과. ③ 역할 부족 시 `ForbiddenException`.

- [ ] **Step 3: 테스트 실패 확인** — `npx jest src/auth/interface/roles.guard.spec.ts` → FAIL(module 없음).

- [ ] **Step 4: `roles.guard.ts` 작성**

`@Injectable() RolesGuard implements CanActivate`, `Reflector` 주입. `canActivate`: `reflector.getAllAndOverride<Role[]>(ROLES_KEY, [handler, class])` → 없거나 빈 배열이면 통과. `request.user`(TokenPayload) 없거나 `required.includes(user.role)`가 아니면 `ForbiddenException('insufficient role')`.

> **메모:** `@UseGuards(JwtAuthGuard, RolesGuard)` 순서로 써야 한다(JwtAuthGuard가 먼저 `request.user`를 채움). 클래스 참조만으로 Nest가 DI(Reflector 전역)로 인스턴스화하므로 별도 provider 등록 불필요. user가 없으면 403으로 fail-closed.

- [ ] **Step 5: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/auth/interface/roles.decorator.ts src/auth/interface/roles.guard.ts src/auth/interface/roles.guard.spec.ts
git commit -m "feat(m1): RBAC @Roles decorator + RolesGuard"
```

---

## Task 4: Property 도메인 레이어 (엔티티 + 인터페이스)

도메인은 순수 TS만 사용한다(NestJS·Prisma·ioredis import 금지).

**Files:** Create `lease-status.enum.ts`, `building.entity.ts`, `unit.entity.ts`, `lease.entity.ts`, `building.repository.ts`, `unit.repository.ts`, `lease.repository.ts`, `invite-code.store.ts` (모두 `src/property/domain/`), Test `building.entity.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — Building 불변식 + 소유권**

검증: ① `Building.create({ownerId,name,address})`로 만들면 `id`는 null, `isOwnedBy(ownerId)`는 true·다른 id는 false. ② `ownerId`가 비면 `'ownerId is required'` 예외.

- [ ] **Step 2: 테스트 실패 확인** — `npx jest src/property/domain/building.entity.spec.ts` → FAIL.

- [ ] **Step 3: `lease-status.enum.ts` 작성** — 문자열 enum ACTIVE·ENDED.

- [ ] **Step 4: `building.entity.ts` 작성**

private 생성자, 정적 `create({ownerId,name,address})`(ownerId/name 비면 예외, id=null), 정적 `reconstitute(props)`, 도메인 메서드 `isOwnedBy(userId): boolean`, 게터 `id`(`string|null`)·`ownerId`·`name`·`address`.

- [ ] **Step 5: `unit.entity.ts` 작성**

`create({buildingId,name,floor})`(buildingId/name 비면 예외), `reconstitute`, 게터 `id`·`buildingId`·`name`·`floor`.

- [ ] **Step 6: `lease.entity.ts` 작성**

`create({unitId,tenantId})`(둘 비면 예외, status 기본 `ACTIVE`), `reconstitute`, 게터 `id`·`unitId`·`tenantId`·`status`.

- [ ] **Step 7: 테스트 통과 확인** — 동일 Run → PASS (2 passed).

- [ ] **Step 8: 리포지토리 + InviteCodeStore 인터페이스 작성**

각 파일에 DI 토큰(Symbol) + 인터페이스.
- `building.repository.ts`: `BUILDING_REPOSITORY` + `BuildingRepository { save; findById(id): Promise<Building|null>; findByOwner(ownerId): Promise<Building[]> }`.
- `unit.repository.ts`: `UNIT_REPOSITORY` + `UnitRepository { save; findById(id): Promise<Unit|null> }`.
- `lease.repository.ts`: `LEASE_REPOSITORY` + `LeaseRepository { save; findByTenant(tenantId): Promise<Lease[]> }`.
- `invite-code.store.ts`: `INVITE_CODE_STORE` + 타입 `InviteCodePayload{unitId, issuedBy}`·`IssuedInvite{code, expiresInSec}` + `InviteCodeStore { issue(payload): Promise<IssuedInvite>; redeem(code): Promise<InviteCodePayload|null> }`(redeem은 원자적 GETDEL, 만료·사용·부재는 모두 null).

- [ ] **Step 9: Commit**

```bash
git add src/property/domain
git commit -m "feat(m1): property domain layer (Building/Unit/Lease + repo/store interfaces)"
```

---

## Task 5: Property 인프라 레이어 (Prisma 리포지토리 + Redis 초대코드 스토어)

**Files:** Create `prisma-building.repository.ts`, `prisma-unit.repository.ts`, `prisma-lease.repository.ts`, `redis-invite-code.store.ts` (모두 `src/property/infrastructure/`).

> 인프라 구현은 실제 DB/Redis가 필요하므로 단위 spec을 따로 두지 않고 **Task 9 e2e로 검증**한다(M0의 PrismaUserRepository와 동일 방침). 단위 테스트는 Task 6·7에서 인메모리 가짜로 커버.

- [ ] **Step 1~3: Prisma 리포지토리 3종 작성**

각 `@Injectable() ... implements XxxRepository`, `PrismaService` 주입, Prisma 행 ↔ 도메인 엔티티 매핑(`reconstitute`).
- Building: `save`(create), `findById`(findUnique), `findByOwner`(findMany where ownerId).
- Unit: `save`(create), `findById`(findUnique).
- Lease: `save`(create, `status`는 도메인 enum 그대로), `findByTenant`(findMany where tenantId). row.status는 `as LeaseStatus`.

- [ ] **Step 4: `redis-invite-code.store.ts` 작성 (GETDEL 단일 사용)**

`@Injectable() RedisInviteCodeStore implements InviteCodeStore`, `RedisService` 주입, 키 `invite:{code}`, TTL 상수 24h.
- `issue`: `crypto.randomBytes(9).toString('base64url')`로 코드 생성, `redis.set(key, JSON, 'EX', ttl)`, `{code, expiresInSec}` 반환.
- `redeem`: `redis.getdel(key)`(읽는 즉시 삭제 → 동시 요청도 한 번만 성공), 없으면 null, 있으면 JSON 파싱.

- [ ] **Step 5: 컴파일 확인 후 Commit**

```bash
npx tsc --noEmit
git add src/property/infrastructure
git commit -m "feat(m1): property infra (prisma building/unit/lease repos, redis invite store)"
```

---

## Task 6: 유스케이스 — CreateBuilding / CreateUnit (소유권 검사)

**Files:** Create `create-building.use-case.ts`·`create-unit.use-case.ts`, Test `create-unit.use-case.spec.ts`.

- [ ] **Step 1: `create-building.use-case.ts` 작성**

`@Injectable() CreateBuildingUseCase`, `@Inject(BUILDING_REPOSITORY)`. `execute({ownerId,name,address})` = `Building.create(...)` → `save`.

- [ ] **Step 2: 실패 테스트 작성 — CreateUnit 소유권**

가짜 building/unit repo로 검증: ① 건물 소유자가 호실 생성 → 저장(생성 id 반환). ② 소유자가 아니면 `ForbiddenException`. ③ 건물이 없으면 `NotFoundException`. (가짜는 `Promise.resolve` 반환 형태.)

- [ ] **Step 3: 테스트 실패 확인** — `npx jest src/property/application/create-unit.use-case.spec.ts` → FAIL.

- [ ] **Step 4: `create-unit.use-case.ts` 작성**

`@Inject(BUILDING_REPOSITORY)`·`@Inject(UNIT_REPOSITORY)`. `execute({ownerId,buildingId,name,floor})`: `buildings.findById` 없으면 `NotFoundException`, `building.isOwnedBy(ownerId)` 아니면 `ForbiddenException`, 통과 시 `Unit.create` → `save`.

- [ ] **Step 5: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 6: Commit**

```bash
git add src/property/application/create-building.use-case.ts src/property/application/create-unit.use-case.ts src/property/application/create-unit.use-case.spec.ts
git commit -m "feat(m1): CreateBuilding/CreateUnit use cases with ownership check"
```

---

## Task 7: 유스케이스 — IssueInviteCode / RedeemInviteCode (+ 조회)

**Files:** Create `issue-invite-code.use-case.ts`·`redeem-invite-code.use-case.ts`·`list-my-buildings.use-case.ts`·`list-my-leases.use-case.ts`, Test `issue-invite-code.use-case.spec.ts`·`redeem-invite-code.use-case.spec.ts`.

- [ ] **Step 1: 실패 테스트 작성 — IssueInviteCode 소유권**

가짜 unit/building repo + 가짜 invite store로 검증: ① 소유자가 발급 → `{code, expiresInSec}` 반환, store에 `{unitId, issuedBy}` 전달. ② 소유자 아니면 `ForbiddenException`. ③ 호실 없으면 `NotFoundException`.

- [ ] **Step 2: 테스트 실패 확인** — `npx jest src/property/application/issue-invite-code.use-case.spec.ts` → FAIL.

- [ ] **Step 3: `issue-invite-code.use-case.ts` 작성**

`@Inject` unit repo·building repo·invite store. `execute({ownerId,unitId})`: `units.findById` 없으면 `NotFoundException`, 그 `buildingId`로 `buildings.findById` 후 `isOwnedBy(ownerId)` 아니면 `ForbiddenException`, 통과 시 `invites.issue({unitId, issuedBy:ownerId})`.

- [ ] **Step 4: 테스트 통과 확인** — 동일 Run → PASS (3 passed).

- [ ] **Step 5: 실패 테스트 작성 — RedeemInviteCode**

가짜 invite store(특정 코드만 payload 반환)·캡처용 lease repo로 검증: ① 유효 코드면 입주자를 호실에 연결하는 `Lease(ACTIVE, unitId, tenantId)` 생성. ② 만료·사용·오타 코드(null)면 `NotFoundException`.

- [ ] **Step 6: 테스트 실패 확인** — `npx jest src/property/application/redeem-invite-code.use-case.spec.ts` → FAIL.

- [ ] **Step 7: `redeem-invite-code.use-case.ts` 작성**

`@Inject` invite store·lease repo. `execute({tenantId,code})`: `invites.redeem(code)`가 null이면 `NotFoundException('invalid or expired invite code')`(만료/사용/부재 불구분 — 존재 여부 미누설), 아니면 `Lease.create({unitId:payload.unitId, tenantId})` → `save`.

- [ ] **Step 8: 테스트 통과 확인** — 동일 Run → PASS (2 passed).

- [ ] **Step 9: 얇은 조회 유스케이스 2종 작성 (규칙 없는 읽기 → 레이어 얇게)**

- `ListMyBuildingsUseCase`: `@Inject(BUILDING_REPOSITORY)`, `execute(ownerId)` = `findByOwner`.
- `ListMyLeasesUseCase`: `@Inject(LEASE_REPOSITORY)`, `execute(tenantId)` = `findByTenant`.

- [ ] **Step 10: Commit**

```bash
git add src/property/application
git commit -m "feat(m1): IssueInviteCode/RedeemInviteCode + list use cases"
```

---

## Task 8: 인터페이스 레이어 (DTO·컨트롤러) + 모듈 조립

**Files:** Create `dto/create-building.dto.ts`·`dto/create-unit.dto.ts`·`dto/redeem-invite.dto.ts`·`property.controller.ts` (모두 `src/property/interface/`), `src/property/property.module.ts`. Modify `src/app.module.ts`.

- [ ] **Step 1: DTO 3종 작성**

`CreateBuildingDto`(`@IsNotEmpty name`·`address`), `CreateUnitDto`(`@IsNotEmpty name`, `@IsInt floor`), `RedeemInviteDto`(`@IsNotEmpty code`).

- [ ] **Step 2: `property.controller.ts` 작성**

`@Controller()`, 6개 유스케이스 주입. `@CurrentUser()`로 `user.sub`(ownerId/tenantId)·`user.role` 사용. 라우트:
- `POST /buildings` (OWNER) → 건물 생성, `{id,name,address}`.
- `GET /buildings` (OWNER) → 내 건물 목록.
- `POST /buildings/:buildingId/units` (OWNER) → 호실 생성(유스케이스가 소유권 재확인).
- `POST /units/:unitId/invite-codes` (OWNER) → `{code, expiresInSec}`.
- `POST /invite-codes/redeem` (인증) → Lease 생성, `{id,unitId,status}`.
- `GET /me/leases` (인증) → 내 Lease 목록.

OWNER 라우트는 `@UseGuards(JwtAuthGuard, RolesGuard)` + `@Roles(Role.OWNER)`, redeem·me는 `@UseGuards(JwtAuthGuard)`만. 가드·데코레이터·Role·TokenPayload는 `../../auth/...`에서 import.

- [ ] **Step 3: `property.module.ts` 작성 (DI 바인딩)**

`controllers: [PropertyController]`. `providers`: 6개 유스케이스 + 토큰→구현 바인딩(`BUILDING_REPOSITORY`→`PrismaBuildingRepository`, `UNIT_REPOSITORY`→`PrismaUnitRepository`, `LEASE_REPOSITORY`→`PrismaLeaseRepository`, `INVITE_CODE_STORE`→`RedisInviteCodeStore`).

> **메모:** `PrismaService`·`RedisService`는 전역 모듈 export라 별도 import 없이 주입. `JwtAuthGuard`·`RolesGuard`는 클래스 참조로 사용(JWT 전략은 AppModule이 로드한 AuthModule에서 이미 전역 등록됨).

- [ ] **Step 4: `src/app.module.ts` 수정** — imports에 `RedisModule`·`PropertyModule` 추가(기존 ConfigModule·PrismaModule·AuthModule 유지).

- [ ] **Step 5: 빌드 + 전체 단위 테스트 통과 확인**

```bash
npx tsc --noEmit && npx jest
```
Expected: 컴파일 에러 없음, M0·M1 단위 테스트 전부 PASS.

- [ ] **Step 6: Commit**

```bash
git add src/property/interface src/property/property.module.ts src/app.module.ts
git commit -m "feat(m1): property interface layer (controller, DTOs) + module wiring"
```

---

## Task 9: e2e — 발급→가입→연결 + RBAC/만료/소유권

**Files:** Create `test/property.e2e-spec.ts`.

> **선행:** `docker compose up -d`로 Postgres·Redis가 떠 있고 마이그레이션 적용된 상태. e2e는 실제 DB·Redis에 쓰므로 정리 로직을 둔다. OWNER 프로비저닝은 M1 범위 밖이라 테스트가 DB에서 직접 role을 승격시킨다.

- [ ] **Step 1: 실패 e2e 테스트 작성**

`beforeAll`: 앱 부팅 + ValidationPipe, owner/tenant signup, **owner를 prisma로 OWNER 승격 후** 양쪽 login(토큰 확보). 검증 케이스:
1. **전체 흐름:** owner가 `POST /buildings`→`/units`→`/invite-codes`(code 획득), tenant가 `/invite-codes/redeem`(201, unitId 일치), `GET /me/leases`에 해당 unitId 포함(자동 연결 검증).
2. **RBAC:** TENANT가 `POST /buildings` → 403.
3. **단일 사용·만료 불구분:** 없는 코드 redeem → 404.
4. **소유권:** tenant를 임시 OWNER 승격 후 owner 건물에 호실 생성 시도 → 403, 끝나면 TENANT로 원복.

`afterAll`: FK 순서(Lease→Unit→Building→User)로 정리. supertest 타입은 `getHttpServer() as App`, `res.body as {...}` 캐스팅.

- [ ] **Step 2: 인프라 확인 후 e2e 실행**

```bash
docker compose up -d
npx jest --config ./test/jest-e2e.json
```
Expected: 처음 실행에서 통과. 연결 에러 시 `.env`의 `DATABASE_URL`·`REDIS_URL`·`JWT_SECRET`과 마이그레이션 적용 여부 점검.

- [ ] **Step 3: Commit**

```bash
git add test/property.e2e-spec.ts
git commit -m "test(m1): property e2e (invite issue/redeem→lease, RBAC, single-use, ownership)"
```

---

## Task 10: M1 마무리 검증 & README 상태 갱신

**Files:** Modify `README.md`.

- [ ] **Step 1: 전체 검증 (lint·단위·e2e)**

```bash
npm run lint && npx jest && npx jest --config ./test/jest-e2e.json
```
Expected: lint 0 errors, 모든 단위·e2e PASS.

- [ ] **Step 2: 수동 동작 확인 (서버 기동 후 curl)**

> OWNER 프로비저닝은 M1 범위 밖이므로, 가입한 유저를 DB에서 OWNER로 승격한 뒤 로그인한다.

`npm run start:dev` 후: signup → `docker compose exec postgres psql`로 role을 OWNER 승격 → login으로 토큰 → `POST /buildings`가 `{id,name,address}` 반환 확인. (초대코드 발급 후 `redis-cli ttl invite:<code>`로 TTL=86400 확인 가능.)

- [ ] **Step 3: README M1 상태 한 줄 갱신** — 마일스톤 표 M1 행에 ✅ 표기 추가.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs(m1): mark M1 complete in milestone table"
```

---

## M1 완료 기준 (Definition of Done)

- [ ] `prisma migrate dev`로 `Building`·`Unit`·`Lease` 테이블 + 관계 생성됨
- [ ] OWNER가 `POST /buildings` → `/units` → `/invite-codes`로 초대코드 발급
- [ ] 초대코드가 Redis에 **TTL(24h)** 로 저장되고, redeem이 **GETDEL로 단일 사용** 처리 후 Lease 생성
- [ ] 입주자가 코드 사용 시 해당 **호실에 자동 연결**(`GET /me/leases`에 unitId 노출)
- [ ] **RBAC:** TENANT가 OWNER 전용 엔드포인트 호출 시 403
- [ ] **소유권 검사:** 다른 소유자의 건물에 호실/코드 생성 시도 시 403
- [ ] 이미 사용/만료/없는 코드 redeem 시 404(존재 여부 미누설)
- [ ] 단위 테스트(엔티티·RolesGuard·유스케이스) + e2e 전부 통과, lint 0 errors
- [ ] 도메인/애플리케이션 레이어가 Prisma·ioredis를 직접 import 하지 않음(의존성 역전 유지)

---

## Self-Review 결과

- **스펙 커버리지:** M1 스펙("Building/Unit/Lease + 초대코드(Redis TTL)", 검증="건물주가 코드 발급→입주자 가입 시 호실 자동 연결", 학습="Prisma 관계, Redis TTL, RolesGuard") → Task 2(관계 스키마), Task 3(RBAC), Task 5·7(Redis TTL 초대코드), Task 6·7(소유권), Task 9(전체 흐름 e2e)로 전부 커버. 스펙 6절 보안(RBAC + 소유권 이중, 코드 존재 여부 미누설) 반영.
- **범위 밖(의도적):** ① InviteCode Postgres 테이블 → Redis 단독, 감사 이력은 M3 audit-worker. ② `TenantJoined` 도메인 이벤트 발행 → Kafka 도입(M3) 전이라 M1은 Lease 생성까지만. ③ OWNER 온보딩(프로비저닝) → 테스트/수동검증은 DB 직접 승격. ④ rate limit → M6.
- **타입 일관성:** `InviteCodePayload{unitId, issuedBy}`가 발급·저장·사용에서 동일. `Building.isOwnedBy`가 CreateUnit·IssueInviteCode 소유권 검사에서 일관. 리포지토리 토큰이 domain 정의 ↔ module 바인딩 ↔ use-case 주입에서 일치. `LeaseStatus.ACTIVE`가 도메인·Prisma 양쪽 동일 문자열.
